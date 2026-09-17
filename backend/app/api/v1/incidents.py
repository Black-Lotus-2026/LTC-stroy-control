"""Инциденты: лента, карточка и действия над ними.

Действия — отдельные ручки (`/assign`, `/status`, `/comment`), а не общий
PATCH. Каждая пишет строку в историю инцидента и имеет свои обязательные
параметры; из схемы должно быть видно, что отклонение требует причины.
См. docs/decisions/0006-api-contract.md
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import DbSession, PageParams
from app.db.base import utcnow
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.schemas.common import (
    CONFLICT_RESPONSE,
    NOT_FOUND_RESPONSE,
    VALIDATION_RESPONSE,
    Page,
    ResponseSpec,
)
from app.schemas.incident import (
    IncidentAssignRequest,
    IncidentCommentRequest,
    IncidentDetail,
    IncidentRead,
    IncidentStatusChangeRequest,
)
from app.services import incidents as service
from app.services.incidents import SORT_FIELDS, IncidentFilters

router = APIRouter(prefix="/incidents", tags=["Инциденты"])

ACTION_RESPONSES: ResponseSpec = {
    **NOT_FOUND_RESPONSE,
    **CONFLICT_RESPONSE,
    **VALIDATION_RESPONSE,
}


@router.get("", response_model=Page[IncidentRead], summary="Лента инцидентов")
def list_incidents(
    db: DbSession,
    page: PageParams,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
    zone_id: Annotated[uuid.UUID | None, Query()] = None,
    camera_id: Annotated[uuid.UUID | None, Query()] = None,
    assigned_user_id: Annotated[uuid.UUID | None, Query()] = None,
    status: Annotated[
        list[IncidentStatus] | None,
        Query(description="Можно повторять: ?status=pending&status=confirmed"),
    ] = None,
    category: Annotated[list[IncidentCategory] | None, Query()] = None,
    type: Annotated[list[IncidentType] | None, Query()] = None,  # noqa: A002
    priority: Annotated[list[IncidentPriority] | None, Query()] = None,
    only_open: Annotated[
        bool, Query(description="Только незакрытые: не устранённые и не отклонённые")
    ] = False,
    date_from: Annotated[
        datetime | None, Query(description="Нижняя граница времени первого наблюдения")
    ] = None,
    date_to: Annotated[datetime | None, Query()] = None,
    q: Annotated[
        str | None, Query(description="Поиск по коду и заголовку", max_length=128)
    ] = None,
    sort: Annotated[str, Query(pattern="|".join(SORT_FIELDS))] = "-first_seen_at",
) -> Page[IncidentRead]:
    filters = IncidentFilters(
        project_id=project_id,
        zone_id=zone_id,
        camera_id=camera_id,
        assigned_user_id=assigned_user_id,
        statuses=status or (),
        categories=category or (),
        types=type or (),
        priorities=priority or (),
        only_open=only_open,
        date_from=date_from,
        date_to=date_to,
        query=q,
    )
    items, total = service.list_incidents(
        db, filters, page=page.page, page_size=page.page_size, sort=sort
    )
    now = utcnow()
    return Page.of(
        [IncidentRead.from_model(item, now=now) for item in items],
        total,
        page=page.page,
        page_size=page.page_size,
    )


# Объявлено до /{incident_id}: иначе «by-code» пришёл бы на разбор как UUID.
@router.get(
    "/by-code/{code}",
    response_model=IncidentDetail,
    responses=NOT_FOUND_RESPONSE,
    summary="Инцидент по коду вида INC-247",
)
def get_incident_by_code(db: DbSession, code: str) -> IncidentDetail:
    return IncidentDetail.from_model(
        service.get_incident_by_code(db, code), now=utcnow()
    )


@router.get(
    "/{incident_id}",
    response_model=IncidentDetail,
    responses=NOT_FOUND_RESPONSE,
    summary="Инцидент с объяснением, историей и доказательствами",
)
def get_incident(db: DbSession, incident_id: uuid.UUID) -> IncidentDetail:
    return IncidentDetail.from_model(service.get_incident(db, incident_id), now=utcnow())


@router.post(
    "/{incident_id}/assign",
    response_model=IncidentDetail,
    responses=ACTION_RESPONSES,
    summary="Назначить ответственного",
)
def assign_incident(
    db: DbSession, incident_id: uuid.UUID, payload: IncidentAssignRequest
) -> IncidentDetail:
    incident = service.assign_incident(
        db,
        incident_id,
        user_id=payload.user_id,
        actor_user_id=payload.actor_user_id,
        comment=payload.comment,
    )
    return IncidentDetail.from_model(incident, now=utcnow())


@router.post(
    "/{incident_id}/status",
    response_model=IncidentDetail,
    responses=ACTION_RESPONSES,
    summary="Изменить статус, в том числе отклонить как ошибку распознавания",
)
def change_status(
    db: DbSession, incident_id: uuid.UUID, payload: IncidentStatusChangeRequest
) -> IncidentDetail:
    incident = service.change_status(
        db,
        incident_id,
        status=payload.status,
        actor_user_id=payload.actor_user_id,
        comment=payload.comment,
        reject_reason=payload.reject_reason,
    )
    return IncidentDetail.from_model(incident, now=utcnow())


@router.post(
    "/{incident_id}/comment",
    response_model=IncidentDetail,
    responses=ACTION_RESPONSES,
    summary="Добавить комментарий в историю",
)
def add_comment(
    db: DbSession, incident_id: uuid.UUID, payload: IncidentCommentRequest
) -> IncidentDetail:
    incident = service.add_comment(
        db, incident_id, text=payload.text, actor_user_id=payload.actor_user_id
    )
    return IncidentDetail.from_model(incident, now=utcnow())
