"""API endpoints for Construction Objects (Projects), Construction Sites (Zones), and Cameras."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession
from app.models.enums import CameraStatus, ZoneRiskLevel
from app.models.project import Camera, Project, Zone
from app.models.schedule import ScheduleTask
from app.schemas.stroy_control import (
    CameraCreate,
    CameraItem,
    CameraUpdate,
    ProjectCreate,
    ProjectItem,
    ZoneCreate,
    ZoneItem,
)

router = APIRouter(prefix="/projects", tags=["Объекты и стройплощадки"])


@router.get("", response_model=list[ProjectItem])
def list_projects(db: DbSession) -> list[ProjectItem]:
    """Получить список всех объектов строительства с их площадками и камерами."""
    projects = (
        db.scalars(
            select(Project)
            .options(selectinload(Project.zones), selectinload(Project.cameras))
            .order_by(Project.created_at.asc())
        )
        .all()
    )

    result: list[ProjectItem] = []
    for p in projects:
        stage_count = (
            db.scalar(
                select(func.count(ScheduleTask.id)).where(
                    ScheduleTask.project_id == p.id
                )
            )
            or 0
        )
        result.append(
            ProjectItem(
                id=p.id,
                code=p.code,
                name=p.name,
                address=p.address,
                object_kind=p.object_kind,
                status=p.status,
                zones=[
                    ZoneItem(
                        id=z.id,
                        project_id=z.project_id,
                        code=z.code,
                        name=z.name,
                        description=z.description,
                        status=z.status,
                    )
                    for z in p.zones
                ],
                cameras=[
                    CameraItem(
                        id=c.id,
                        project_id=c.project_id,
                        zone_id=c.zone_id,
                        code=c.code,
                        name=c.name,
                        stream_url=c.stream_url,
                        status=c.status.value if hasattr(c.status, "value") else str(c.status),
                    )
                    for c in p.cameras
                ],
                stages_count=stage_count,
            )
        )
    return result


@router.post("", response_model=ProjectItem, status_code=status.HTTP_201_CREATED)
def create_project(data: ProjectCreate, db: DbSession) -> ProjectItem:
    """Создать новый объект строительства."""
    code = data.code.strip() if data.code and data.code.strip() else f"PRJ-{uuid.uuid4().hex[:6].upper()}"

    # Check unique code
    existing = db.scalars(select(Project).where(Project.code == code)).first()
    if existing:
        code = f"PRJ-{uuid.uuid4().hex[:6].upper()}"

    project = Project(
        code=code,
        name=data.name.strip(),
        address=data.address.strip() if data.address else None,
        object_kind=data.object_kind.strip() if data.object_kind else "Жильё",
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    return ProjectItem(
        id=project.id,
        code=project.code,
        name=project.name,
        address=project.address,
        object_kind=project.object_kind,
        status=project.status,
        zones=[],
        cameras=[],
        stages_count=0,
    )


@router.get("/{project_id}", response_model=ProjectItem)
def get_project(project_id: uuid.UUID, db: DbSession) -> ProjectItem:
    """Получить информацию об объекте строительства со стройплощадками."""
    project = (
        db.scalars(
            select(Project)
            .options(selectinload(Project.zones), selectinload(Project.cameras))
            .where(Project.id == project_id)
        )
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Объект строительства не найден")

    stage_count = (
        db.scalar(
            select(func.count(ScheduleTask.id)).where(
                ScheduleTask.project_id == project.id
            )
        )
        or 0
    )

    return ProjectItem(
        id=project.id,
        code=project.code,
        name=project.name,
        address=project.address,
        object_kind=project.object_kind,
        status=project.status,
        zones=[
            ZoneItem(
                id=z.id,
                project_id=z.project_id,
                code=z.code,
                name=z.name,
                description=z.description,
                status=z.status,
            )
            for z in project.zones
        ],
        cameras=[
            CameraItem(
                id=c.id,
                project_id=c.project_id,
                zone_id=c.zone_id,
                code=c.code,
                name=c.name,
                stream_url=c.stream_url,
                status=c.status.value if hasattr(c.status, "value") else str(c.status),
            )
            for c in project.cameras
        ],
        stages_count=stage_count,
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: DbSession) -> None:
    """Удалить объект строительства."""
    project = db.scalars(select(Project).where(Project.id == project_id)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Объект строительства не найден")
    db.delete(project)
    db.commit()


@router.get("/{project_id}/zones", response_model=list[ZoneItem])
def list_zones(project_id: uuid.UUID, db: DbSession) -> list[ZoneItem]:
    """Получить стройплощадки (зоны/участки) объекта."""
    zones = db.scalars(
        select(Zone).where(Zone.project_id == project_id).order_by(Zone.created_at.asc())
    ).all()
    return [
        ZoneItem(
            id=z.id,
            project_id=z.project_id,
            code=z.code,
            name=z.name,
            description=z.description,
            status=z.status,
        )
        for z in zones
    ]


@router.post("/{project_id}/zones", response_model=ZoneItem, status_code=status.HTTP_201_CREATED)
def create_zone(project_id: uuid.UUID, data: ZoneCreate, db: DbSession) -> ZoneItem:
    """Создать стройплощадку (участок/зону) внутри объекта."""
    project = db.scalars(select(Project).where(Project.id == project_id)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Объект строительства не найден")

    code = data.code.strip() if data.code and data.code.strip() else f"ZN-{uuid.uuid4().hex[:4].upper()}"

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


@router.get("/{project_id}/cameras", response_model=list[CameraItem])
def list_cameras(project_id: uuid.UUID, db: DbSession) -> list[CameraItem]:
    """Получить список камер объекта."""
    cameras = db.scalars(
        select(Camera).where(Camera.project_id == project_id).order_by(Camera.created_at.asc())
    ).all()
    return [
        CameraItem(
            id=c.id,
            project_id=c.project_id,
            zone_id=c.zone_id,
            code=c.code,
            name=c.name,
            stream_url=c.stream_url,
            status=c.status.value if hasattr(c.status, "value") else str(c.status),
        )
        for c in cameras
    ]


@router.post("/{project_id}/cameras", response_model=CameraItem, status_code=status.HTTP_201_CREATED)
def create_camera(project_id: uuid.UUID, data: CameraCreate, db: DbSession) -> CameraItem:
    """Подключить камеру к объекту строительства или конкретной площадке."""
    project = db.scalars(select(Project).where(Project.id == project_id)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Объект строительства не найден")

    code = data.code.strip() if data.code and data.code.strip() else f"CAM-{uuid.uuid4().hex[:4].upper()}"

    camera = Camera(
        project_id=project_id,
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
        stream_url=camera.stream_url,
        status=camera.status.value if hasattr(camera.status, "value") else str(camera.status),
    )


@router.patch("/{project_id}/cameras/{camera_id}", response_model=CameraItem)
def update_camera(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    data: CameraUpdate,
    db: DbSession,
) -> CameraItem:
    """Обновить настройки камеры (название, поток, зону, статус)."""
    camera = db.scalars(
        select(Camera).where(Camera.id == camera_id, Camera.project_id == project_id)
    ).first()
    if not camera:
        camera = db.scalars(select(Camera).where(Camera.id == camera_id)).first()
    if not camera:
        raise HTTPException(status_code=404, detail="Камера не найдена")

    if data.name is not None:
        camera.name = data.name.strip()
    if data.code is not None:
        camera.code = data.code.strip()
    if data.stream_url is not None:
        clean_url = data.stream_url.strip()
        camera.stream_url = clean_url if clean_url else None
        camera.status = CameraStatus.ONLINE if camera.stream_url else CameraStatus.OFFLINE
    if data.zone_id is not None:
        camera.zone_id = data.zone_id
    if data.status is not None:
        camera.status = CameraStatus.ONLINE if data.status.lower() == "online" else CameraStatus.OFFLINE

    db.commit()
    db.refresh(camera)

    return CameraItem(
        id=camera.id,
        project_id=camera.project_id,
        zone_id=camera.zone_id,
        code=camera.code,
        name=camera.name,
        stream_url=camera.stream_url,
        status=camera.status.value if hasattr(camera.status, "value") else str(camera.status),
    )


@router.delete("/{project_id}/cameras/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_camera(
    project_id: uuid.UUID,
    camera_id: uuid.UUID,
    db: DbSession,
) -> None:
    """Удалить камеру с объекта строительства."""
    camera = db.scalars(
        select(Camera).where(Camera.id == camera_id, Camera.project_id == project_id)
    ).first()
    if not camera:
        camera = db.scalars(select(Camera).where(Camera.id == camera_id)).first()
    if not camera:
        raise HTTPException(status_code=404, detail="Камера не найдена")

    db.delete(camera)
    db.commit()
