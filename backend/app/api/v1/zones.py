"""Зоны площадки."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbSession, PageParams
from app.models.enums import ZoneRiskLevel
from app.schemas.common import NOT_FOUND_RESPONSE, Page
from app.schemas.project import ZoneRead
from app.services import projects as service

router = APIRouter(prefix="/zones", tags=["Зоны"])


@router.get("", response_model=Page[ZoneRead], summary="Список зон")
def list_zones(
    db: DbSession,
    page: PageParams,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
    risk_level: Annotated[
        list[ZoneRiskLevel] | None,
        Query(description="Можно повторять: ?risk_level=critical&risk_level=attention"),
    ] = None,
) -> Page[ZoneRead]:
    items, total = service.list_zones(
        db,
        project_id=project_id,
        risk_levels=risk_level,
        page=page.page,
        page_size=page.page_size,
    )
    counts = service.camera_counts_by_zone(db, [zone.id for zone in items])
    return Page.of(
        [
            ZoneRead.model_validate(zone).model_copy(
                update={"camera_count": counts.get(zone.id, 0)}
            )
            for zone in items
        ],
        total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get(
    "/{zone_id}",
    response_model=ZoneRead,
    responses=NOT_FOUND_RESPONSE,
    summary="Зона",
)
def get_zone(db: DbSession, zone_id: uuid.UUID) -> ZoneRead:
    zone = service.get_zone(db, zone_id)
    counts = service.camera_counts_by_zone(db, [zone.id])
    return ZoneRead.model_validate(zone).model_copy(
        update={"camera_count": counts.get(zone.id, 0)}
    )
