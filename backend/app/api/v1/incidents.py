import logging
import uuid

from fastapi import APIRouter, HTTPException, Query

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.models.enums import (
    IncidentStatus,
)
from app.models.incident import Incident
from app.schemas.alert import IncidentEventItem
from app.schemas.stroy_control import (
    IncidentAlbumResponse,
    IncidentConfigResponse,
    IncidentConfigUpdate,
    IncidentCreateRequest,
    IncidentPhotoItem,
    IncidentResponse,
    IncidentSeverity,
    IncidentStatusUpdateRequest,
)
from app.services.management.context import require_project
from app.storage import get_storage  # noqa: F401

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["Инциденты и нарушения"])


def _normalize_status(val: str | IncidentStatus | None) -> IncidentStatus:
    if isinstance(val, IncidentStatus):
        return val
    raw = (val or "").strip().lower()
    if raw in ("confirmed", "подтверждено", "подтвержден"):
        return IncidentStatus.CONFIRMED
    if raw in (
        "false_positive",
        "проблемы нет",
        "ложное",
        "ложное срабатывание",
        "no_problem",
    ):
        return IncidentStatus.FALSE_POSITIVE
    if raw in ("in_progress", "в работе"):
        return IncidentStatus.IN_PROGRESS
    if raw in ("resolved", "устранено"):
        return IncidentStatus.RESOLVED
    if raw in ("pending", "ожидает обработки", "требует проверки"):
        return IncidentStatus.PENDING
    raise HTTPException(422, "Неизвестный статус инцидента")


def _incident_to_response(inc: Incident) -> IncidentResponse:
    exp = inc.explanation if isinstance(inc.explanation, dict) else {}
    snapshot_url = exp.get("snapshot_url")
    zone_name = exp.get("zone_name") or (inc.zone.name if inc.zone else None)
    camera_name = exp.get("camera_name") or (inc.camera.name if inc.camera else None)
    stage_name = inc.schedule_task.name if inc.schedule_task else exp.get("stage_name")

    raw_album = exp.get("album_photos", [])
    album_photos: list[IncidentPhotoItem] = []
    if isinstance(raw_album, list) and raw_album:
        for idx, item in enumerate(raw_album):
            if isinstance(item, dict):
                album_photos.append(
                    IncidentPhotoItem(
                        url=item.get("url", ""),
                        camera_name=item.get("camera_name") or f"Камера {idx + 1}",
                        is_primary=bool(item.get("is_primary", idx == 0)),
                        captured_at=item.get("captured_at"),
                    )
                )
    elif snapshot_url:
        album_photos.append(
            IncidentPhotoItem(
                url=snapshot_url,
                camera_name=camera_name or "Основная камера",
                is_primary=True,
                captured_at=inc.created_at.isoformat() if inc.created_at else None,
            )
        )

    # First photo is primary
    if album_photos and not snapshot_url:
        snapshot_url = album_photos[0].url

    sev = (
        IncidentSeverity.ERROR
        if (inc.priority and inc.priority.value == "critical")
        or str(exp.get("severity", "")).lower() == "error"
        else IncidentSeverity.WARNING
    )

    status_str = inc.status.value if hasattr(inc.status, "value") else str(inc.status)

    return IncidentResponse(
        ppr_requirements=[
            {
                **citation,
                "source_url": (
                    f"/api/v1/incidents/{inc.id}/ppr-sources/"
                    f"{citation['requirement_id']}"
                ),
            }
            for citation in exp.get("ppr_requirements", [])
        ],
        id=inc.id,
        code=inc.code,
        project_id=inc.project_id,
        zone_id=inc.zone_id,
        camera_id=inc.camera_id,
        first_seen_at=inc.first_seen_at,
        confidence=inc.confidence,
        stage_id=inc.schedule_task_id,
        stage_name=stage_name,
        zone_name=zone_name,
        camera_name=camera_name,
        title=inc.title,
        description=inc.description or exp.get("description"),
        severity=sev,
        discrepancy_type=inc.discrepancy_type or "MISSING_MANDATORY",
        machinery_type=inc.machinery_type or "Экскаватор",
        stage_probability=inc.stage_probability,
        status=status_str,
        assigned_user_id=inc.assigned_user_id,
        sla_deadline=inc.sla_deadline,
        verification_status=inc.verification_status,
        last_checked_at=inc.last_checked_at,
        escalated_at=inc.escalated_at,
        verification_details=inc.verification_details or {},
        observed_count=inc.observation_count,
        assignee_name=(
            (inc.assignee.name or inc.assignee.username) if inc.assignee else None
        ),
        frame_snapshot_url=snapshot_url,
        snapshot_url=snapshot_url,
        album_photos=album_photos,
        manual_override=bool(exp.get("is_manual_override", False)),
        created_at=inc.created_at,
    )


# --- Endpoints ---


def _incident_for_user(
    db: DbSession, incident_id: uuid.UUID, user: CurrentUser
) -> Incident:
    from app.services.access_policy import can_read_incident, resolve_context

    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    ctx = resolve_context(db, incident.project_id, user, permission="incident.read")
    if not can_read_incident(db, ctx, incident):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return incident


@router.get("/config", response_model=IncidentConfigResponse)
def get_incident_config() -> IncidentConfigResponse:
    """Получить текущее значение окна фиксации нарушений (в секундах)."""
    return IncidentConfigResponse(
        violation_evaluation_window_seconds=settings.violation_evaluation_window_seconds
    )


@router.patch("/config", response_model=IncidentConfigResponse)
def update_incident_config(
    data: IncidentConfigUpdate, current_user: CurrentUser
) -> IncidentConfigResponse:
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Настройки контроля изменяются в утверждаемом выпуске объекта",
        },
    )


@router.get("", response_model=list[IncidentResponse])
def get_incidents(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[IncidentResponse]:
    from app.services.access_policy import incident_query, resolve_context

    if project_id is None:
        raise HTTPException(422, "Выберите объект строительства")
    ctx = resolve_context(db, project_id, current_user, permission="incident.read")
    query = incident_query(db, ctx).order_by(Incident.created_at.desc()).limit(limit)
    return [_response_for_context(db, ctx, inc) for inc in db.scalars(query)]


@router.post("", response_model=IncidentResponse, status_code=201)
def create_incident(
    req: IncidentCreateRequest,
    db: DbSession,
    current_user: CurrentUser,
) -> IncidentResponse:
    require_project(
        db, req.project_id, current_user, write=True, permission="incident.confirm"
    )
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Используйте серверные команды процесса контроля",
        },
    )


@router.get("/{incident_id}/album", response_model=IncidentAlbumResponse)
def get_incident_album(
    incident_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> IncidentAlbumResponse:
    """Получить альбом фотографий со всех камер для конкретной ошибки/инцидента."""
    incident = _incident_for_user(db, incident_id, current_user)

    from app.services.access_policy import resolve_context

    ctx = resolve_context(
        db, incident.project_id, current_user, permission="incident.read"
    )
    resp = _response_for_context(db, ctx, incident)
    return IncidentAlbumResponse(
        incident_id=resp.id,
        code=resp.code,
        title=resp.title or "Ошибка СМР",
        stage_name=resp.stage_name,
        severity=resp.severity.value
        if hasattr(resp.severity, "value")
        else str(resp.severity),
        primary_photo_url=resp.snapshot_url,
        photos=resp.album_photos,
    )


@router.get("/{incident_id}/events", response_model=list[IncidentEventItem])
def get_incident_events(
    incident_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> list[IncidentEventItem]:
    incident = _incident_for_user(db, incident_id, current_user)
    return [
        IncidentEventItem(
            id=event.id,
            event_type=event.event_type.value,
            comment=event.comment,
            created_at=event.created_at,
            user_id=event.user_id,
        )
        for event in incident.events
    ]


@router.patch("/{incident_id}/status", response_model=IncidentResponse)
def update_incident_status(
    incident_id: uuid.UUID,
    data: IncidentStatusUpdateRequest,
    db: DbSession,
    current_user: CurrentUser,
) -> IncidentResponse:
    incident = _incident_for_user(db, incident_id, current_user)
    from app.services.access_policy import resolve_context

    resolve_context(db, incident.project_id, current_user, write=True)
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Используйте серверные команды процесса контроля",
        },
    )


def _response_for_context(db, ctx, incident: Incident) -> IncidentResponse:
    """Card visibility does not publish every historical image or source page."""
    response = _incident_to_response(incident)
    if ctx.side == "customer":
        return response

    from sqlalchemy import select

    from app.models.customer_control import (
        EvidenceAsset,
        EvidenceDisclosure,
        IncidentEvidenceLink,
        RequirementRevision,
    )
    from app.services.access_policy import resource_visible

    photos = []
    assets = db.scalars(
        select(EvidenceAsset)
        .join(IncidentEvidenceLink, IncidentEvidenceLink.asset_id == EvidenceAsset.id)
        .join(EvidenceDisclosure, EvidenceDisclosure.asset_id == EvidenceAsset.id)
        .where(
            IncidentEvidenceLink.incident_id == incident.id,
            EvidenceDisclosure.incident_id == incident.id,
            EvidenceDisclosure.project_id == ctx.project.id,
            EvidenceDisclosure.participation_id == ctx.participation.id,
            EvidenceDisclosure.active.is_(True),
        )
        .distinct()
    )
    for index, asset in enumerate(assets):
        if asset.media_type.startswith("image/"):
            photos.append(
                IncidentPhotoItem(
                    url=f"/api/v1/customer-control/evidence/{asset.id}/file",
                    camera_name="Опубликованное доказательство",
                    is_primary=index == 0,
                    captured_at=asset.captured_at.isoformat()
                    if asset.captured_at
                    else None,
                )
            )
    requirement_ids = set(
        db.scalars(
            select(RequirementRevision.requirement_id)
            .join(
                EvidenceDisclosure,
                EvidenceDisclosure.revision_id == RequirementRevision.id,
            )
            .where(
                EvidenceDisclosure.incident_id == incident.id,
                EvidenceDisclosure.participation_id == ctx.participation.id,
                EvidenceDisclosure.project_id == ctx.project.id,
                EvidenceDisclosure.active.is_(True),
            )
        )
    )
    camera_allowed = incident.camera_id and resource_visible(
        db, ctx, "camera", incident.camera_id
    )
    snapshot = photos[0].url if photos else None
    return response.model_copy(
        update={
            "camera_id": response.camera_id if camera_allowed else None,
            "camera_name": response.camera_name if camera_allowed else None,
            "verification_details": {},
            "ppr_requirements": [
                c
                for c in response.ppr_requirements
                if str(c.get("requirement_id")) in {str(i) for i in requirement_ids}
            ],
            "album_photos": photos,
            "snapshot_url": snapshot,
            "frame_snapshot_url": snapshot,
        }
    )
