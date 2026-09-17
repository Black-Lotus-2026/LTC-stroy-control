"""Площадки."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbSession, PageParams
from app.schemas.common import NOT_FOUND_RESPONSE, Page
from app.schemas.project import ProjectDetail, ProjectRead, ProjectSettingsRead
from app.services import projects as service

router = APIRouter(prefix="/projects", tags=["Площадки"])


@router.get("", response_model=Page[ProjectRead], summary="Список площадок")
def list_projects(
    db: DbSession,
    page: PageParams,
    status: Annotated[str | None, Query(description="Фильтр по статусу")] = None,
) -> Page[ProjectRead]:
    items, total = service.list_projects(
        db, status=status, page=page.page, page_size=page.page_size
    )
    return Page.of(
        [ProjectRead.model_validate(item) for item in items],
        total,
        page=page.page,
        page_size=page.page_size,
    )


@router.get(
    "/{project_id}",
    response_model=ProjectDetail,
    responses=NOT_FOUND_RESPONSE,
    summary="Площадка с параметрами наблюдения",
)
def get_project(db: DbSession, project_id: uuid.UUID) -> ProjectDetail:
    project = service.get_project(db, project_id)
    zone_count, camera_count = service.project_counts(db, project_id)
    return ProjectDetail(
        **ProjectRead.model_validate(project).model_dump(),
        settings=(
            ProjectSettingsRead.model_validate(project.settings)
            if project.settings
            else None
        ),
        zone_count=zone_count,
        camera_count=camera_count,
    )
