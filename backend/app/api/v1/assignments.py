"""Customer controlled areas, assignments, revocation and project lifecycle."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.api.v1.customer_control import Key
from app.models import Incident, Project, ProjectSettings, ScheduleTask, User, Zone
from app.models.customer_control import (
    AssignmentArea,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ResponsibilityArea,
)
from app.schemas.customer_control import (
    ArchiveProjectCommand,
    AssignmentDTO,
    AssignmentSetupDTO,
    CreateAreaCommand,
    CreateAssignmentCommand,
    EndParticipationCommand,
    MemberOptionDTO,
    MembershipRevokeCommand,
    NamedOptionDTO,
    ParticipationOptionDTO,
    ProjectDTO,
    RestoreProjectCommand,
    RevokeCommand,
)
from app.services.access_policy import fail, require_area, resolve_context
from app.services.incident_workflow import (
    OPEN,
    audit,
    check_version,
    receipt,
    save_receipt,
)

router = APIRouter(prefix="/customer-control", tags=["Назначения и области"])


@router.get(
    "/projects/{project_id}/assignment-options", response_model=AssignmentSetupDTO
)
def assignment_options(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    from app.models.customer_control import Organization

    ctx = resolve_context(db, project_id, user, "assignment.manage")
    parties = list(
        db.scalars(
            select(ProjectOrganization).where(
                ProjectOrganization.project_id == project_id,
                ProjectOrganization.status == "active",
            )
        )
    )
    members = db.execute(
        select(OrganizationMembership, User)
        .join(User, User.id == OrganizationMembership.user_id)
        .where(
            OrganizationMembership.organization_id.in_(
                [p.organization_id for p in parties]
            ),
            OrganizationMembership.status == "active",
            User.is_active.is_(True),
        )
    ).all()
    return AssignmentSetupDTO(
        project=ctx.project,
        participations=[
            ParticipationOptionDTO(
                id=p.id,
                organization_id=p.organization_id,
                side=p.side,
                name=organization.name,
            )
            for p in parties
            if (organization := db.get(Organization, p.organization_id))
        ],
        members=[
            MemberOptionDTO(
                id=m.id, user_id=u.id, organization_id=m.organization_id, name=u.name
            )
            for m, u in members
        ],
        areas=[
            NamedOptionDTO(id=a.id, name=a.name)
            for a in db.scalars(
                select(ResponsibilityArea).where(
                    ResponsibilityArea.project_id == project_id
                )
            )
        ],
        assignments=list(
            db.scalars(
                select(ProjectAssignment).where(
                    ProjectAssignment.participation_id.in_([p.id for p in parties])
                )
            )
        ),
        zones=[
            NamedOptionDTO(id=z.id, name=z.name)
            for z in db.scalars(select(Zone).where(Zone.project_id == project_id))
        ],
        stages=[
            NamedOptionDTO(id=t.id, name=t.name)
            for t in db.scalars(
                select(ScheduleTask).where(ScheduleTask.project_id == project_id)
            )
        ],
    )


@router.post(
    "/projects/{project_id}/areas", response_model=NamedOptionDTO, status_code=201
)
def create_area(
    project_id: uuid.UUID,
    data: CreateAreaCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(
        db, project_id, user, "assignment.manage", write=True, lock=True
    )
    zone = db.get(Zone, data.zone_id) if data.zone_id else None
    task = db.get(ScheduleTask, data.schedule_task_id) if data.schedule_task_id else None
    if not zone and not task:
        fail("VALIDATION_ERROR", 422, "Укажите зону или этап")
    if (
        (data.zone_id and (not zone or zone.project_id != project_id))
        or (data.schedule_task_id and (not task or task.project_id != project_id))
        or (zone and task and task.zone_id and task.zone_id != zone.id)
    ):
        fail(
            "VALIDATION_ERROR",
            422,
            "Зона и этап должны относиться к объекту и друг другу",
        )
    route, payload = f"projects/{project_id}/areas", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        area = db.get(ResponsibilityArea, replay.resource_id)
    else:
        area = ResponsibilityArea(
            id=uuid.uuid4(),
            project_id=project_id,
            name=data.name.strip(),
            zone_id=data.zone_id,
            schedule_task_id=data.schedule_task_id,
        )
        db.add(area)
        event = audit(db, ctx, "area.created", area.id)
        save_receipt(db, ctx, route, key, cid, payload, area.id, event.id)
        db.commit()
    if not area:
        fail("RESOURCE_NOT_FOUND", 404)
    return NamedOptionDTO(id=area.id, name=area.name)


@router.post(
    "/projects/{project_id}/assignments", response_model=AssignmentDTO, status_code=201
)
def grant_assignment(
    project_id: uuid.UUID,
    data: CreateAssignmentCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(
        db, project_id, user, "assignment.manage", write=True, lock=True
    )
    party, member = (
        db.get(ProjectOrganization, data.participation_id),
        db.get(OrganizationMembership, data.membership_id),
    )
    if (
        not party
        or party.project_id != project_id
        or party.status != "active"
        or not member
        or member.status != "active"
        or member.organization_id != party.organization_id
    ):
        fail("RESOURCE_NOT_FOUND", 404)
    if (
        (
            data.role == ProjectRole.CUSTOMER_MANAGER
            and (party.side != "customer" or data.scope.kind != "project")
        )
        or (data.role == ProjectRole.CONTRACTOR_FOREMAN and party.side != "contractor")
        or (party.side == "contractor" and data.scope.kind != "areas")
    ):
        fail("VALIDATION_ERROR", 422, "Роль и область несовместимы со стороной")
    areas = data.scope.area_ids if data.scope.kind == "areas" else []
    for area_id in areas:
        require_area(db, ctx, area_id)
    route, payload = f"projects/{project_id}/assignments", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return db.get(ProjectAssignment, replay.resource_id)
    assignment = db.scalar(
        select(ProjectAssignment).where(
            ProjectAssignment.participation_id == party.id,
            ProjectAssignment.membership_id == member.id,
            ProjectAssignment.role == data.role,
        )
    )
    if assignment:
        if assignment.status == "active":
            fail(
                "VERSION_CONFLICT", 409, "Назначение уже действует; сначала отзовите его"
            )
        assignment.status, assignment.scope_kind = "active", data.scope.kind
        assignment.row_version += 1
        for link in db.scalars(
            select(AssignmentArea).where(AssignmentArea.assignment_id == assignment.id)
        ):
            db.delete(link)
        db.flush()
    else:
        assignment = ProjectAssignment(
            id=uuid.uuid4(),
            participation_id=party.id,
            membership_id=member.id,
            role=data.role,
            scope_kind=data.scope.kind,
            status="active",
        )
        db.add(assignment)
        db.flush()
    for area_id in dict.fromkeys(areas):
        db.add(AssignmentArea(assignment_id=assignment.id, area_id=area_id))
    ctx.project.authorization_version += 1
    event = audit(db, ctx, "assignment.granted", assignment.id)
    save_receipt(db, ctx, route, key, cid, payload, assignment.id, event.id)
    db.commit()
    return assignment


def ensure_manager_remains(db, project_id, excluded):
    if db.get(Project, project_id).lifecycle != "active":
        return
    count = db.scalar(
        select(func.count(ProjectAssignment.id))
        .join(
            ProjectOrganization,
            ProjectOrganization.id == ProjectAssignment.participation_id,
        )
        .join(
            OrganizationMembership,
            OrganizationMembership.id == ProjectAssignment.membership_id,
        )
        .join(User, User.id == OrganizationMembership.user_id)
        .where(
            ProjectOrganization.project_id == project_id,
            ProjectOrganization.status == "active",
            ProjectOrganization.side == "customer",
            ProjectAssignment.role == ProjectRole.CUSTOMER_MANAGER,
            ProjectAssignment.status == "active",
            OrganizationMembership.status == "active",
            User.is_active.is_(True),
            ProjectAssignment.id.not_in(excluded),
        )
    )
    if not count:
        fail(
            "LAST_MANAGER",
            409,
            "Сначала назначьте другого управляющего или архивируйте объект",
        )


@router.post("/assignments/{assignment_id}/revoke", response_model=AssignmentDTO)
def revoke_assignment(
    assignment_id: uuid.UUID,
    data: RevokeCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    assignment = db.get(ProjectAssignment, assignment_id)
    party = (
        db.get(ProjectOrganization, assignment.participation_id) if assignment else None
    )
    if not party or not assignment:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(
        db, party.project_id, user, "assignment.manage", write=True, lock=True
    )
    route, payload = f"assignments/{assignment_id}/revoke", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if replay:
        return assignment
    check_version(assignment, data.expected_version)
    ensure_manager_remains(db, ctx.project.id, [assignment.id])
    assignment.status, assignment.row_version = "revoked", assignment.row_version + 1
    ctx.project.authorization_version += 1
    for case in db.scalars(
        select(Incident).where(
            Incident.project_id == ctx.project.id,
            Incident.assignee_assignment_id == assignment.id,
            Incident.status.in_(OPEN),
        )
    ):
        case.assignee_assignment_id = None
        case.row_version += 1
        audit(db, ctx, "incident.assigned", case.id, "Назначение отозвано; срок сохранён")
    event = audit(db, ctx, "assignment.revoked", assignment.id, data.reason)
    save_receipt(db, ctx, route, key, cid, payload, assignment.id, event.id)
    db.commit()
    return assignment


@router.post("/projects/{project_id}/archive", response_model=ProjectDTO)
def archive_project(
    project_id: uuid.UUID,
    data: ArchiveProjectCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "project.manage", lock=True)
    if ctx.is_demo:
        fail("DEMO_READ_ONLY")
    route, payload = f"projects/{project_id}/archive", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(ctx.project, data.expected_version)
        if ctx.project.lifecycle != "active":
            fail("PROJECT_ARCHIVED", 409)
        open_count = (
            db.scalar(
                select(func.count())
                .select_from(Incident)
                .where(Incident.project_id == project_id, Incident.status.in_(OPEN))
            )
            or 0
        )
        if open_count and not data.acknowledge_open_cases:
            fail(
                "INVALID_TRANSITION",
                409,
                (
                    "Подтвердите архивирование с незавершёнными делами; приёмка не "
                    "будет зафиксирована"
                ),
            )
        ctx.project.lifecycle = "archived"
        ctx.project.row_version += 1
        settings_row = db.get(ProjectSettings, project_id)
        if settings_row:
            settings_row.observation_enabled = False
        event = audit(db, ctx, "project.archived", project_id, data.reason)
        save_receipt(db, ctx, route, key, cid, payload, project_id, event.id)
        db.commit()
    return ctx.project


@router.post("/projects/{project_id}/restore", response_model=ProjectDTO)
def restore_project(
    project_id: uuid.UUID,
    data: RestoreProjectCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    ctx = resolve_context(db, project_id, user, "project.manage", lock=True)
    if ctx.is_demo:
        fail("DEMO_READ_ONLY")
    route, payload = f"projects/{project_id}/restore", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        check_version(ctx.project, data.expected_version)
        if ctx.project.lifecycle != "archived":
            fail("INVALID_TRANSITION", 409)
        ctx.project.lifecycle = "active"
        ensure_manager_remains(db, project_id, [])
        ctx.project.row_version += 1
        # Observation remains disabled until an explicit current-source configuration.
        event = audit(db, ctx, "project.restored", project_id, data.reason)
        save_receipt(db, ctx, route, key, cid, payload, project_id, event.id)
        db.commit()
    return ctx.project


@router.post("/memberships/{membership_id}/revoke")
def revoke_membership(
    membership_id: uuid.UUID,
    data: MembershipRevokeCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    from app.api.v1.organizations import member_ctx, membership_context, org_audit

    member = db.get(OrganizationMembership, membership_id)
    if not member:
        fail("RESOURCE_NOT_FOUND", 404)
    membership_context(db, user, member.organization_id, manage=True, lock=False)
    # Lock affected projects before membership, in the same order as workflow commands.
    affected = db.execute(
        select(ProjectAssignment, ProjectOrganization)
        .join(
            ProjectOrganization,
            ProjectOrganization.id == ProjectAssignment.participation_id,
        )
        .where(
            ProjectAssignment.membership_id == member.id,
            ProjectAssignment.status == "active",
        )
    ).all()
    for project_id in sorted({p.project_id for _, p in affected}):
        db.scalar(select(Project).where(Project.id == project_id).with_for_update())
        ensure_manager_remains(
            db, project_id, [a.id for a, p in affected if p.project_id == project_id]
        )
    admin = membership_context(db, user, member.organization_id, manage=True)
    ctx = member_ctx(user, admin)
    route, payload = f"memberships/{member.id}/revoke", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        member.status = "revoked"
        from app.models.customer_control import Invitation

        for invitation in db.scalars(
            select(Invitation).where(
                Invitation.organization_id == member.organization_id,
                Invitation.recipient_user_id == member.user_id,
                Invitation.status == "pending",
            )
        ):
            invitation.status = "revoked"
        for assignment, party in affected:
            assignment.status = "revoked"
            assignment.row_version += 1
            project = db.get(Project, party.project_id)
            if not project:
                fail("RESOURCE_NOT_FOUND", 404)
            project.authorization_version += 1
            for case in db.scalars(
                select(Incident).where(
                    Incident.project_id == project.id,
                    Incident.assignee_assignment_id == assignment.id,
                    Incident.status.in_(OPEN),
                )
            ):
                case.assignee_assignment_id = None
                case.row_version += 1
        event = org_audit(db, user, admin, "membership.revoked", member.id)
        save_receipt(db, ctx, route, key, cid, payload, member.id, event.id)
        db.commit()
    return {"id": member.id, "status": member.status}


@router.post("/participations/{participation_id}/end")
def end_participation(
    participation_id: uuid.UUID,
    data: EndParticipationCommand,
    db: DbSession,
    user: CurrentUser,
    idempotency_key: Key = None,
):
    from app.models.customer_control import ParticipationPeriod

    party = db.get(ProjectOrganization, participation_id)
    if not party:
        fail("RESOURCE_NOT_FOUND", 404)
    ctx = resolve_context(
        db, party.project_id, user, "participation.manage", write=True, lock=True
    )
    if party.side != "contractor":
        fail("ACTION_FORBIDDEN")
    route, payload = f"participations/{party.id}/end", data.model_dump(mode="json")
    replay, key, cid = receipt(db, ctx, route, idempotency_key, payload)
    if not replay:
        if db.scalar(
            select(Incident.id)
            .where(
                Incident.project_id == party.project_id,
                Incident.responsible_participation_id == party.id,
                Incident.status.in_(OPEN),
            )
            .limit(1)
        ):
            fail(
                "INVALID_TRANSITION",
                409,
                "Сначала передайте открытые дела другому действующему участию",
            )
        party.status = "ended"
        from app.models.customer_control import Invitation

        for invitation in db.scalars(
            select(Invitation).where(
                Invitation.project_id == party.project_id,
                Invitation.organization_id == party.organization_id,
                Invitation.status == "pending",
            )
        ):
            invitation.status = "revoked"
        for period in db.scalars(
            select(ParticipationPeriod).where(
                ParticipationPeriod.participation_id == party.id,
                ParticipationPeriod.ended_at.is_(None),
            )
        ):
            period.ended_at = datetime.now(UTC)
        for assignment in db.scalars(
            select(ProjectAssignment).where(
                ProjectAssignment.participation_id == party.id,
                ProjectAssignment.status == "active",
            )
        ):
            assignment.status = "revoked"
            assignment.row_version += 1
        ctx.project.authorization_version += 1
        event = audit(db, ctx, "participation.ended", party.id, data.reason)
        save_receipt(db, ctx, route, key, cid, payload, party.id, event.id)
        db.commit()
    return {"id": party.id, "status": party.status}
