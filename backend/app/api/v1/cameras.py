"""Камеры."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbSession, PageParams
from app.models.enums import CameraStatus
from app.schemas.common import NOT_FOUND_RESPONSE, Page
from app.schemas.project import CameraRead
from app.services import projects as service

router = APIRouter(prefix="/cameras", tags=["Камеры"])


@router.get("", response_model=Page[CameraRead], summary="Список камер")
def list_cameras(
    db: DbSession,
    page: PageParams,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
    zone_id: Annotated[uuid.UUID | None, Query()] = None,
    status: Annotated[
        list[CameraStatus] | None,
        Query(description="Можно повторять: ?status=online&status=degraded"),
    ] = None,
) -> Page[CameraRead]:
    items, total = service.list_cameras(
        db,
        project_id=project_id,
        zone_id=zone_id,
        statuses=status,
        page=page.page,
        page_size=page.page_size,
    )
    return Page.of(
        [CameraRead.model_validate(item) for item in items],
        total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get(
    "/{camera_id}",
    response_model=CameraRead,
    responses=NOT_FOUND_RESPONSE,
    summary="Камера",
)
def get_camera(db: DbSession, camera_id: uuid.UUID) -> CameraRead:
    return CameraRead.model_validate(service.get_camera(db, camera_id))
