"""Project passports and explicitly authorized configuration."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession
from app.models.customer_control import (
    AssignmentArea,
    Organization,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ResponsibilityArea,
)
from app.models.enums import CameraStatus, UserRole, ZoneRiskLevel
from app.models.project import Camera, Project, ProjectInviteKey, Zone
from app.models.schedule import ScheduleTask
from app.models.user import User
from app.models.weather import WeatherForecast
from app.schemas.stroy_control import (
    CameraCreate,
    CameraItem,
    CameraUpdate,
    JoinByKeyRequest,
    JoinByKeyResponse,
    ProjectAlertSettings,
    ProjectAlertSettingsUpdate,
    ProjectCreate,
    ProjectInviteKeyCreate,
    ProjectInviteKeyItem,
    ProjectItem,
    ProjectUpdate,
    ZoneCreate,
    ZoneItem,
    ZoneUpdate,
)
from app.services.access_policy import (
    resolve_context,
    resource_query,
    resource_visible,
    visible_project_ids,
)
from app.services.management.context import require_project

router = APIRouter(prefix="/projects", tags=["Объекты и стройплощадки"])


def _configuration_project(db, project_id, user, *, write=False):
    try:
        project_id = uuid.UUID(str(project_id))
    except (ValueError, TypeError):
        raise HTTPException(404, "Объект строительства не найден") from None
    project = require_project(db, project_id, user, write=write)
    return project


@router.get("", response_model=list[ProjectItem])
def list_projects(db: DbSession, current_user: CurrentUser) -> list[ProjectItem]:
    projects = db.scalars(
        select(Project)
        .where(Project.id.in_(visible_project_ids(db, current_user)))
        .order_by(Project.created_at)
    )
    return [_project_item(db, project, current_user) for project in projects]


@router.post("", response_model=ProjectItem, status_code=status.HTTP_201_CREATED)
def create_project(
    data: ProjectCreate, db: DbSession, current_user: CurrentUser
) -> ProjectItem:
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Создание объекта требует действующего членства организации",
        },
    )


def _generate_invite_key() -> str:
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    part1 = "".join(secrets.choice(alphabet) for _ in range(4))
    part2 = "".join(secrets.choice(alphabet) for _ in range(4))
    return f"PRJ-{part1}-{part2}"


@router.post("/join-by-key", response_model=JoinByKeyResponse)
def join_by_key(
    data: JoinByKeyRequest, db: DbSession, current_user: CurrentUser
) -> JoinByKeyResponse:
    cleaned_key = data.key.strip().upper()
    invite = db.scalar(
        select(ProjectInviteKey).where(
            func.upper(ProjectInviteKey.key) == cleaned_key
        )
    )
    if not invite or not invite.is_active:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="Ключ приглашения не найден или был деактивирован",
        )
    now = datetime.now(UTC)
    if invite.expires_at:
        exp = invite.expires_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=UTC)
        if exp < now:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail="Срок действия данного ключа приглашения истёк",
            )
    if invite.max_uses is not None and invite.uses_count >= invite.max_uses:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Превышено максимальное количество использований этого ключа",
        )

    project = db.get(Project, invite.project_id)
    if not project or project.status == "archived":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Объект строительства недоступен или находится в архиве",
        )

    role_str = invite.role
    if role_str == "inspector":
        target_role = ProjectRole.CUSTOMER_MANAGER
        side = "customer"
    elif role_str in (ProjectRole.CUSTOMER_MANAGER.value, "customer_manager"):
        target_role = ProjectRole.CUSTOMER_MANAGER
        side = "customer"
    elif role_str in (ProjectRole.PROJECT_VIEWER.value, "project_viewer"):
        target_role = ProjectRole.PROJECT_VIEWER
        side = "customer"
    elif role_str in (ProjectRole.CONTRACTOR_FOREMAN.value, "contractor_foreman"):
        target_role = ProjectRole.CONTRACTOR_FOREMAN
        side = "contractor"
    elif role_str in (ProjectRole.PTO_ENGINEER.value, "pto_engineer"):
        target_role = ProjectRole.PTO_ENGINEER
        side = "contractor"
    else:
        target_role = ProjectRole.PROJECT_VIEWER
        side = "customer"

    scope_kind = "project" if side == "customer" else "areas"
    area = None

    if side == "customer":
        org = None
        if project.customer_organization_id:
            org = db.get(Organization, project.customer_organization_id)

        if not org:
            org = Organization(
                id=uuid.uuid4(),
                name=f"Служба заказчика ({project.name})",
                status="active",
            )
            db.add(org)
            db.flush()
            project.customer_organization_id = org.id

        party = db.scalar(
            select(ProjectOrganization).where(
                ProjectOrganization.project_id == project.id,
                ProjectOrganization.organization_id == org.id,
                ProjectOrganization.side == "customer",
            )
        )
        if not party:
            party = ProjectOrganization(
                id=uuid.uuid4(),
                project_id=project.id,
                organization_id=org.id,
                side="customer",
                status="active",
            )
            db.add(party)
            db.flush()
        elif party.status != "active":
            party.status = "active"

        member = db.scalar(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == org.id,
                OrganizationMembership.user_id == current_user.id,
            )
        )
        if not member:
            member = OrganizationMembership(
                id=uuid.uuid4(),
                organization_id=org.id,
                user_id=current_user.id,
                status="active",
                can_manage_members=(target_role == ProjectRole.CUSTOMER_MANAGER),
                can_create_projects=(target_role == ProjectRole.CUSTOMER_MANAGER),
            )
            db.add(member)
            db.flush()
        elif member.status != "active":
            member.status = "active"
        if target_role == ProjectRole.CUSTOMER_MANAGER:
            member.can_manage_members = True
            member.can_create_projects = True

    else:  # contractor
        party = db.scalar(
            select(ProjectOrganization).where(
                ProjectOrganization.project_id == project.id,
                ProjectOrganization.side == "contractor",
                ProjectOrganization.status == "active",
            )
        )
        if not party:
            org = Organization(
                id=uuid.uuid4(),
                name=f"Генподрядчик ({project.name})",
                status="active",
            )
            db.add(org)
            db.flush()
            party = ProjectOrganization(
                id=uuid.uuid4(),
                project_id=project.id,
                organization_id=org.id,
                side="contractor",
                status="active",
            )
            db.add(party)
            db.flush()
        else:
            org = db.get(Organization, party.organization_id)

        member = db.scalar(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == org.id,
                OrganizationMembership.user_id == current_user.id,
            )
        )
        if not member:
            member = OrganizationMembership(
                id=uuid.uuid4(),
                organization_id=org.id,
                user_id=current_user.id,
                status="active",
            )
            db.add(member)
            db.flush()
        elif member.status != "active":
            member.status = "active"

        area = db.scalar(
            select(ResponsibilityArea).where(
                ResponsibilityArea.project_id == project.id
            )
        )
        if not area:
            first_zone = db.scalar(select(Zone).where(Zone.project_id == project.id))
            if not first_zone:
                first_zone = Zone(
                    id=uuid.uuid4(),
                    project_id=project.id,
                    name="Основная площадка",
                    code=f"Z-{secrets.token_hex(2).upper()}",
                )
                db.add(first_zone)
                db.flush()
            area = ResponsibilityArea(
                id=uuid.uuid4(),
                project_id=project.id,
                name=f"Зона ответственности ({project.name})",
                zone_id=first_zone.id,
            )
            db.add(area)
            db.flush()

    assignment = db.scalar(
        select(ProjectAssignment).where(
            ProjectAssignment.participation_id == party.id,
            ProjectAssignment.membership_id == member.id,
            ProjectAssignment.role == target_role,
        )
    )
    if not assignment:
        assignment = ProjectAssignment(
            id=uuid.uuid4(),
            participation_id=party.id,
            membership_id=member.id,
            role=target_role,
            scope_kind=scope_kind,
            status="active",
        )
        db.add(assignment)
        db.flush()
    else:
        assignment.status = "active"
        assignment.scope_kind = scope_kind
        assignment.row_version += 1

    if scope_kind == "areas" and area:
        existing_link = db.scalar(
            select(AssignmentArea).where(
                AssignmentArea.assignment_id == assignment.id,
                AssignmentArea.area_id == area.id,
            )
        )
        if not existing_link:
            db.add(AssignmentArea(assignment_id=assignment.id, area_id=area.id))

    invite.uses_count += 1
    project.authorization_version += 1
    db.commit()

    return JoinByKeyResponse(
        success=True,
        message=f"Вы успешно подключены к объекту '{project.name}' в роли '{target_role.value}'",
        project_id=project.id,
        project_name=project.name,
        role=target_role.value,
        side=party.side,
        assignment_id=assignment.id,
        organization_id=org.id,
        organization_name=org.name,
    )


@router.post(
    "/{project_id}/invites",
    response_model=ProjectInviteKeyItem,
    status_code=status.HTTP_201_CREATED,
)
def create_project_invite(
    project_id: uuid.UUID,
    data: ProjectInviteKeyCreate,
    db: DbSession,
    current_user: CurrentUser,
) -> ProjectInviteKeyItem:
    project = _configuration_project(db, project_id, current_user, write=True)

    valid_roles = {
        ProjectRole.CUSTOMER_MANAGER.value,
        ProjectRole.CONTRACTOR_FOREMAN.value,
        ProjectRole.PTO_ENGINEER.value,
        ProjectRole.PROJECT_VIEWER.value,
        "inspector",
    }
    if data.role not in valid_roles:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"Недопустимая роль. Доступные роли: {', '.join(sorted(valid_roles))}",
        )

    for _ in range(10):
        candidate_key = _generate_invite_key()
        if not db.scalar(
            select(ProjectInviteKey).where(ProjectInviteKey.key == candidate_key)
        ):
            break
    else:
        candidate_key = f"PRJ-{uuid.uuid4().hex[:8].upper()}"

    expires_at = None
    if data.expires_in_days:
        expires_at = datetime.now(UTC) + timedelta(days=data.expires_in_days)

    invite = ProjectInviteKey(
        id=uuid.uuid4(),
        project_id=project.id,
        key=candidate_key,
        role=data.role,
        created_by_user_id=current_user.id,
        expires_at=expires_at,
        max_uses=data.max_uses,
        uses_count=0,
        is_active=True,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return invite


@router.get("/{project_id}/invites", response_model=list[ProjectInviteKeyItem])
def list_project_invites(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> list[ProjectInviteKeyItem]:
    project = _configuration_project(db, project_id, current_user, write=False)
    invites = list(
        db.scalars(
            select(ProjectInviteKey)
            .where(ProjectInviteKey.project_id == project.id)
            .order_by(ProjectInviteKey.created_at.desc())
        )
    )
    return invites


@router.delete("/{project_id}/invites/{invite_id}")
def delete_project_invite(
    project_id: uuid.UUID,
    invite_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
):
    project = _configuration_project(db, project_id, current_user, write=True)
    invite = db.scalar(
        select(ProjectInviteKey).where(
            ProjectInviteKey.id == invite_id,
            ProjectInviteKey.project_id == project.id,
        )
    )
    if not invite:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Ключ приглашения не найден")
    invite.is_active = False
    db.commit()
    return {"ok": True, "message": "Ключ приглашения успешно деактивирован"}



@router.get("/{project_id}", response_model=ProjectItem)
def get_project(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> ProjectItem:
    project = require_project(db, project_id, current_user)
    return _project_item(db, project, current_user)


@router.get("/{project_id}/alert-settings", response_model=ProjectAlertSettings)
def get_alert_settings(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> ProjectAlertSettings:
    project = require_project(db, project_id, current_user, permission="project.manage")
    return ProjectAlertSettings(
        project_id=project.id,
        owner_username=None,
        alert_error_deadline_minutes=project.alert_error_deadline_minutes,
        alert_warning_deadline_minutes=project.alert_warning_deadline_minutes,
        escalation_user_id=None,
    )


@router.put("/{project_id}/alert-settings", response_model=ProjectAlertSettings)
def update_alert_settings(
    project_id: uuid.UUID,
    data: ProjectAlertSettingsUpdate,
    db: DbSession,
    current_user: CurrentUser,
) -> ProjectAlertSettings:
    project = require_project(db, project_id, current_user, write=True, lock=True)
    if (
        data.owner_username != project.owner_username
        or data.escalation_user_id != project.escalation_user_id
    ):
        raise HTTPException(
            409,
            detail={
                "code": "WORKFLOW_UPGRADE_REQUIRED",
                "message": "Ответственные задаются действующими назначениями объекта",
            },
        )
    project.alert_error_deadline_minutes = data.alert_error_deadline_minutes
    project.alert_warning_deadline_minutes = data.alert_warning_deadline_minutes
    db.commit()
    return get_alert_settings(project_id, db, current_user)


@router.delete(
    "/{project_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None
)
def delete_project(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> None:
    require_project(db, project_id, current_user, write=True, lock=True)
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": (
                "Объекты архивируются после передачи нерешённых "
                "дел; физическое удаление недоступно"
            ),
        },
    )


@router.patch("/{project_id}", response_model=ProjectItem)
def update_project(
    project_id: uuid.UUID,
    data: ProjectUpdate,
    db: DbSession,
    current_user: CurrentUser,
) -> ProjectItem:
    project = require_project(db, project_id, current_user, write=True, lock=True)
    if data.status is not None and data.status != project.status:
        raise HTTPException(
            409,
            detail={
                "code": "WORKFLOW_UPGRADE_REQUIRED",
                "message": "Для архивирования используйте отдельную команду",
            },
        )
    if data.name is not None and data.name.strip():
        project.name = data.name.strip()
    if data.object_kind is not None and data.object_kind.strip():
        project.object_kind = data.object_kind.strip()
    if data.address is not None:
        new_address = data.address.strip() or None
        if new_address != project.address:
            project.address = new_address
            project.geocoded_address = None
            project.weather_location_name = None
            project.latitude = None
            project.longitude = None
            db.execute(delete(WeatherForecast).where(WeatherForecast.project_id == project.id))
    if data.code is not None and data.code.strip() != project.code:
        raise HTTPException(409, "Код объекта неизменяем")
    db.commit()
    return _project_item(db, project, current_user)


@router.get("/{project_id}/zones", response_model=list[ZoneItem])
def list_zones(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> list[ZoneItem]:
    return _project_item(
        db, require_project(db, project_id, current_user), current_user
    ).zones


@router.post(
    "/{project_id}/zones", response_model=ZoneItem, status_code=status.HTTP_201_CREATED
)
def create_zone(
    project_id: uuid.UUID, data: ZoneCreate, db: DbSession, current_user: CurrentUser
) -> ZoneItem:
    """Создать стройплощадку (участок/зону) внутри объекта."""
    _configuration_project(db, project_id, current_user, write=True)

    code = (
        data.code.strip()
        if data.code and data.code.strip()
        else f"ZN-{uuid.uuid4().hex[:4].upper()}"
    )

    zone = Zone(
        project_id=project_id,
        code=code,
        name=data.name.strip(),
        description=data.description.strip() if data.description else None,
        risk_level=ZoneRiskLevel.NORMAL,
        status="active",
    )
    db.add(zone)
    db.commit()
    db.refresh(zone)

    return ZoneItem(
        id=zone.id,
        project_id=zone.project_id,
        code=zone.code,
        name=zone.name,
        description=zone.description,
        status=zone.status,
    )


@router.patch("/{project_id}/zones/{zone_id}", response_model=ZoneItem)
def update_zone(
    project_id: uuid.UUID,
    zone_id: uuid.UUID,
    data: ZoneUpdate,
    db: DbSession,
    current_user: CurrentUser,
) -> ZoneItem:
    """Обновить стройплощадку (участок/зону)."""
    _configuration_project(db, project_id, current_user, write=True)
    zone = db.scalars(
        select(Zone).where(Zone.id == zone_id, Zone.project_id == project_id)
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Стройплощадка не найдена")

    if data.name is not None and data.name.strip():
        zone.name = data.name.strip()
    if data.code is not None and data.code.strip():
        zone.code = data.code.strip()
    if data.description is not None:
        zone.description = data.description.strip() if data.description.strip() else None
    if data.status is not None and data.status.strip():
        zone.status = data.status.strip()

    db.commit()
    db.refresh(zone)

    return ZoneItem(
        id=zone.id,
        project_id=zone.project_id,
        code=zone.code,
        name=zone.name,
        description=zone.description,
        status=zone.status,
    )


@router.delete(
    "/{project_id}/zones/{zone_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_zone(
    project_id: uuid.UUID,
    zone_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> None:
    require_project(db, project_id, current_user, write=True, lock=True)
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": (
                "Зона сохраняется для истории; архивируйте область " "ответственности"
            ),
        },
    )


@router.get("/{project_id}/cameras", response_model=list[CameraItem])
def list_cameras(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> list[CameraItem]:
    ctx = resolve_context(db, project_id, current_user, permission="camera.read")
    cameras = db.scalars(
        resource_query(db, ctx, "camera", Camera).order_by(Camera.created_at)
    )
    return [
        _camera_item(camera)
        for camera in cameras
        if resource_visible(db, ctx, "camera", camera.id)
    ]


@router.post(
    "/{project_id}/cameras",
    response_model=CameraItem,
    status_code=status.HTTP_201_CREATED,
)
def create_camera(
    project_id: uuid.UUID, data: CameraCreate, db: DbSession, current_user: CurrentUser
) -> CameraItem:
    """Подключить камеру к объекту строительства или конкретной площадке."""
    project = resolve_context(
        db, project_id, current_user, permission="camera.configure", write=True, lock=True
    ).project
    if data.zone_id:
        zone = db.get(Zone, data.zone_id)
        if not zone or zone.project_id != project.id:
            raise HTTPException(404, "Стройплощадка не найдена")

    raw_code = (
        data.code.strip()
        if data.code and data.code.strip()
        else f"CAM-{uuid.uuid4().hex[:4].upper()}"
    )
    code = raw_code
    existing = db.scalars(select(Camera).where(Camera.code == code)).first()
    if existing:
        code = f"{raw_code}-{uuid.uuid4().hex[:4].upper()}"

    camera = Camera(
        project_id=project.id,
        zone_id=data.zone_id,
        code=code,
        name=data.name.strip(),
        stream_url=data.stream_url.strip() if data.stream_url else None,
        status=CameraStatus.ONLINE if data.stream_url else CameraStatus.OFFLINE,
    )
    db.add(camera)
    db.commit()
    db.refresh(camera)

    return CameraItem(
        id=camera.id,
        project_id=camera.project_id,
        zone_id=camera.zone_id,
        code=camera.code,
        name=camera.name,
        stream_url=_stream_url(camera),
        status=camera.status.value
        if hasattr(camera.status, "value")
        else str(camera.status),
    )


@router.patch("/{project_id}/cameras/{camera_id}", response_model=CameraItem)
def update_camera(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    data: CameraUpdate,
    db: DbSession,
    current_user: CurrentUser,
) -> CameraItem:
    """Обновить настройки камеры (название, поток, зону, статус)."""
    project = resolve_context(
        db, project_id, current_user, permission="camera.configure", write=True, lock=True
    ).project
    camera = db.scalars(
        select(Camera).where(Camera.id == camera_id, Camera.project_id == project.id)
    ).first()
    if not camera:
        raise HTTPException(status_code=404, detail="Камера не найдена")
    if data.zone_id:
        zone = db.get(Zone, data.zone_id)
        if not zone or zone.project_id != project.id:
            raise HTTPException(404, "Стройплощадка не найдена")

    if data.name is not None:
        camera.name = data.name.strip()
    if data.code is not None:
        camera.code = data.code.strip()
    if data.stream_url is not None:
        clean_url = data.stream_url.strip()
        camera.stream_url = clean_url if clean_url else None
        camera.status = CameraStatus.ONLINE if camera.stream_url else CameraStatus.OFFLINE
    if "zone_id" in data.model_fields_set:
        camera.zone_id = data.zone_id
    if data.status is not None:
        camera.status = (
            CameraStatus.ONLINE
            if data.status.lower() == "online"
            else CameraStatus.OFFLINE
        )

    db.commit()
    db.refresh(camera)

    return CameraItem(
        id=camera.id,
        project_id=camera.project_id,
        zone_id=camera.zone_id,
        code=camera.code,
        name=camera.name,
        stream_url=_stream_url(camera),
        status=camera.status.value
        if hasattr(camera.status, "value")
        else str(camera.status),
    )


@router.delete(
    "/{project_id}/cameras/{camera_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_camera(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> None:
    resolve_context(
        db, project_id, current_user, permission="camera.configure", write=True, lock=True
    )
    camera = db.get(Camera, camera_id)
    if not camera or camera.project_id != project_id:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": (
                "Удаление камеры с доказательствами недоступно; "
                "задайте период отключения"
            ),
        },
    )


def _stream_url(camera: Camera) -> str | None:
    return (
        f"/api/v1/videos/proxy-stream?camera_id={camera.id}"
        if camera.stream_url
        else None
    )


def _camera_item(camera: Camera) -> CameraItem:
    return CameraItem(
        id=camera.id,
        project_id=camera.project_id,
        zone_id=camera.zone_id,
        code=camera.code,
        name=camera.name,
        stream_url=_stream_url(camera),
        status=camera.status.value,
    )


def _project_item(db: DbSession, project: Project, user) -> ProjectItem:
    from app.services.demo_publication import demo_ids

    ctx = resolve_context(db, project.id, user, permission="project.read")
    # Minimal passport is available to every assigned side. Embedded inventories are
    # customer-only; contractor sources use the separately checked source APIs.
    full = ctx.is_demo or (
        str(ctx.side) == "customer"
        and str(ctx.role) in {"customer_manager", "project_viewer"}
        and (ctx.assignment is None or ctx.assignment.scope_kind == "project")
    )
    zones = (
        list(db.scalars(select(Zone).where(Zone.project_id == project.id)))
        if full
        else []
    )
    cameras = (
        list(db.scalars(select(Camera).where(Camera.project_id == project.id)))
        if full
        else []
    )
    if ctx.is_demo:
        zones = [zone for zone in zones if zone.id in demo_ids(project, "zone")]
        cameras = [
            camera for camera in cameras if camera.id in demo_ids(project, "camera")
        ]
    count = (
        db.scalar(
            select(func.count(ScheduleTask.id)).where(
                ScheduleTask.project_id == project.id, ScheduleTask.status != "cancelled"
            )
        )
        if full and not ctx.is_demo
        else 0
    )
    return ProjectItem(
        id=project.id,
        code=project.code,
        name=project.name,
        address=project.address,
        object_kind=project.object_kind,
        status=project.status,
        owner_username=None,
        alert_error_deadline_minutes=project.alert_error_deadline_minutes,
        alert_warning_deadline_minutes=project.alert_warning_deadline_minutes,
        escalation_user_id=None,
        zones=[
            ZoneItem(
                id=z.id,
                project_id=z.project_id,
                code=z.code,
                name=z.name,
                description=z.description,
                status=z.status,
            )
            for z in zones
        ],
        cameras=[_camera_item(c) for c in cameras],
        stages_count=count or 0,
    )
