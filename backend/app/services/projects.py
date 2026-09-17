"""Выборки по площадке, зонам и камерам.

Логика живёт здесь, а не в обработчиках HTTP: те же функции вызываются из
Celery-задач и из консоли, без поднятого веб-сервера.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.core.errors import NotFoundError
from app.models.enums import CameraStatus, ZoneRiskLevel
from app.models.project import Camera, Project, Zone
from app.services.pagination import paginate


def list_projects(
    db: Session, *, status: str | None = None, page: int, page_size: int
) -> tuple[list[Project], int]:
    stmt = select(Project).order_by(Project.name)
    if status:
        stmt = stmt.where(Project.status == status)
    return paginate(db, stmt, page=page, page_size=page_size)


def get_project(db: Session, project_id: uuid.UUID) -> Project:
    stmt = select(Project).options(selectinload(Project.settings)).where(
        Project.id == project_id
    )
    project = db.scalars(stmt).first()
    if project is None:
        raise NotFoundError(
            f"Площадка {project_id} не найдена", code="PROJECT_NOT_FOUND"
        )
    return project


def project_counts(db: Session, project_id: uuid.UUID) -> tuple[int, int]:
    """Число зон и камер площадки одним обращением на каждое.

    Считается запросом, а не длиной коллекции: выгружать все камеры ради
    одного числа на обзорном экране незачем.
    """
    zones = db.scalar(
        select(func.count(Zone.id)).where(Zone.project_id == project_id)
    )
    cameras = db.scalar(
        select(func.count(Camera.id)).where(Camera.project_id == project_id)
    )
    return int(zones or 0), int(cameras or 0)


def list_zones(
    db: Session,
    *,
    project_id: uuid.UUID | None = None,
    risk_levels: Sequence[ZoneRiskLevel] | None = None,
    page: int,
    page_size: int,
) -> tuple[list[Zone], int]:
    stmt = select(Zone).order_by(Zone.code)
    if project_id is not None:
        stmt = stmt.where(Zone.project_id == project_id)
    if risk_levels:
        stmt = stmt.where(Zone.risk_level.in_(list(risk_levels)))
    return paginate(db, stmt, page=page, page_size=page_size)


def camera_counts_by_zone(
    db: Session, zone_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Сколько камер в каждой зоне.

    Отдельным запросом по уже выбранной странице зон, а не соединением с
    группировкой: группировка ломает подсчёт общего числа записей в
    постраничной выборке, а выигрыш — один запрос из двух.
    """
    if not zone_ids:
        return {}
    rows = db.execute(
        select(Camera.zone_id, func.count(Camera.id))
        .where(Camera.zone_id.in_(list(zone_ids)))
        .group_by(Camera.zone_id)
    )
    return {zone_id: count for zone_id, count in rows if zone_id is not None}


def get_zone(db: Session, zone_id: uuid.UUID) -> Zone:
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise NotFoundError(f"Зона {zone_id} не найдена", code="ZONE_NOT_FOUND")
    return zone


def list_cameras(
    db: Session,
    *,
    project_id: uuid.UUID | None = None,
    zone_id: uuid.UUID | None = None,
    statuses: Sequence[CameraStatus] | None = None,
    page: int,
    page_size: int,
) -> tuple[list[Camera], int]:
    stmt = (
        select(Camera).options(selectinload(Camera.zone)).order_by(Camera.code)
    )
    if project_id is not None:
        stmt = stmt.where(Camera.project_id == project_id)
    if zone_id is not None:
        stmt = stmt.where(Camera.zone_id == zone_id)
    if statuses:
        stmt = stmt.where(Camera.status.in_(list(statuses)))
    return paginate(db, stmt, page=page, page_size=page_size)


def get_camera(db: Session, camera_id: uuid.UUID) -> Camera:
    stmt = (
        select(Camera).options(selectinload(Camera.zone)).where(Camera.id == camera_id)
    )
    camera = db.scalars(stmt).first()
    if camera is None:
        raise NotFoundError(f"Камера {camera_id} не найдена", code="CAMERA_NOT_FOUND")
    return camera
