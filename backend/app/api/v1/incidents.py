import base64
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import or_, select

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.models.enums import (
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    UserRole,
)
from app.models.incident import Incident, IncidentEvent
from app.models.project import Camera, Project, Zone
from app.models.schedule import ScheduleTask
from app.schemas.alert import IncidentEventItem
from app.services.management.context import aware, require_project
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
from app.storage import get_storage
from app.services.alert_service import STREAM_LOOP, OPEN_STATUSES, assign_initial_alert, request_verification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["Инциденты и нарушения"])


def _normalize_status(val: str | IncidentStatus | None) -> IncidentStatus:
    if isinstance(val, IncidentStatus):
        return val
    raw = (val or "").strip().lower()
    if raw in ("confirmed", "подтверждено", "подтвержден"):
        return IncidentStatus.CONFIRMED
    if raw in ("false_positive", "проблемы нет", "ложное", "ложное срабатывание", "no_problem"):
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
        if (inc.priority and inc.priority.value == "critical") or str(exp.get("severity", "")).lower() == "error"
        else IncidentSeverity.WARNING
    )

    status_str = inc.status.value if hasattr(inc.status, "value") else str(inc.status)

    return IncidentResponse(
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

def _incident_for_user(db: DbSession, incident_id: uuid.UUID, user: CurrentUser) -> Incident:
    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Инцидент не найден")
    project = db.get(Project, incident.project_id)
    if user.role != UserRole.ADMIN and incident.assigned_user_id != user.id and (
        not project or project.owner_username != user.username
    ):
        raise HTTPException(status_code=404, detail="Инцидент не найден")
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
    """Обновить окно фиксации нарушений (в секундах)."""
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Требуются права администратора")
    settings.violation_evaluation_window_seconds = data.violation_evaluation_window_seconds
    return IncidentConfigResponse(
        violation_evaluation_window_seconds=settings.violation_evaluation_window_seconds
    )


@router.get("", response_model=list[IncidentResponse])
def get_incidents(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[IncidentResponse]:
    """Получить список зарегистрированных нарушений и алертов."""
    query = select(Incident).join(Project, Project.id == Incident.project_id)
    if project_id:
        project = db.get(Project, project_id)
        has_assigned = db.scalar(select(Incident.id).where(
            Incident.project_id == project_id,
            Incident.assigned_user_id == current_user.id,
        ))
        if not project or (
            current_user.role != UserRole.ADMIN
            and project.owner_username != current_user.username
            and not has_assigned
        ):
            raise HTTPException(status_code=404, detail="Объект не найден")
        query = query.where(Incident.project_id == project_id)
    if current_user.role != UserRole.ADMIN:
        query = query.where(or_(
            Project.owner_username == current_user.username,
            Incident.assigned_user_id == current_user.id,
        ))
    incidents = db.scalars(query.order_by(Incident.created_at.desc()).limit(limit)).all()
    return [_incident_to_response(inc) for inc in incidents]


@router.post("", response_model=IncidentResponse, status_code=201)
def create_incident(
    req: IncidentCreateRequest,
    db: DbSession,
    current_user: CurrentUser,
) -> IncidentResponse:
    """Зарегистрировать нарушение с фиксацией фотоснимков со всех подключенных камер (альбом ошибки)."""
    code = f"INC-{uuid.uuid4().hex[:8].upper()}"
    now = datetime.now(UTC)
    project = require_project(db, req.project_id, current_user, write=True, lock=True)
    captured_at = req.captured_at or now
    if captured_at > now + timedelta(seconds=30):
        raise HTTPException(422, "Время съёмки не может быть в будущем")
    for model, object_id in ((ScheduleTask, req.stage_id), (Zone, req.zone_id), (Camera, req.camera_id)):
        if object_id:
            obj = db.get(model, object_id)
            if not obj or obj.project_id != req.project_id:
                raise HTTPException(422, "Этап, зона и камера должны принадлежать объекту")
            if req.zone_id and getattr(obj, "zone_id", None) and obj.zone_id != req.zone_id:
                raise HTTPException(422, "Камера или этап относятся к другой зоне")
    if req.model_status != "valid" and req.discrepancy_type in ("MISSING_MANDATORY", "MISSING_RECOMMENDED", "UNCHARACTERISTIC_PRESENT"):
        raise HTTPException(422, "Модель недоступна: отсутствие техники не подтверждено")
    # a looping feed belongs to its camera: two cameras on recordings are two events
    loop = req.discrepancy_type == STREAM_LOOP
    if loop and not req.camera_id:
        raise HTTPException(422, "Событие о повторе видео относится к камере объекта")
    dedup_key = (
        f"{req.project_id}:{req.camera_id}:{req.discrepancy_type}"
        if loop
        else f"{req.project_id}:{req.zone_id}:{req.stage_id}:{req.machinery_type}:{req.discrepancy_type}"
    )
    previous = db.scalars(select(Incident).where(
        Incident.project_id == req.project_id, Incident.dedup_key == dedup_key,
        Incident.status.in_([IncidentStatus.PENDING, IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS]),
    )).first()
    observation_key = req.observation_key or captured_at.isoformat()
    if previous:
        exp = dict(previous.explanation or {})
        seen = exp.get("observation_keys", [])
        if observation_key not in seen:
            previous.first_seen_at = min(aware(previous.first_seen_at), captured_at)
            previous.last_seen_at = max(aware(previous.last_seen_at), captured_at)
            previous.observation_count += 1
            exp["observation_keys"] = (seen + [observation_key])[-100:]
            previous.explanation = exp
            db.commit()
        return _incident_to_response(previous)
    storage = get_storage()

    saved_album_photos: list[dict[str, Any]] = []
    primary_snapshot_url: str | None = None

    # 1. Process multi-camera album snapshots if supplied
    if req.album_snapshots and isinstance(req.album_snapshots, list):
        for idx, item in enumerate(req.album_snapshots):
            raw_b64 = item.get("snapshot_base64") or item.get("frame_snapshot_base64")
            cam_name = item.get("camera_name") or f"Камера {idx + 1}"
            is_prim = bool(item.get("is_primary", idx == 0))

            if raw_b64:
                try:
                    if "," in raw_b64:
                        raw_b64 = raw_b64.split(",", 1)[1]
                    img_bytes = base64.b64decode(raw_b64)
                    clean_cam = "".join(c for c in cam_name if c.isalnum() or c in "-_")
                    storage_key = f"snapshots/albums/{code.lower()}/cam_{idx}_{clean_cam}.jpg"
                    storage.save(storage_key, img_bytes)
                    pub_url = storage.public_url(storage_key)

                    saved_album_photos.append(
                        {
                            "url": pub_url,
                            "camera_name": cam_name,
                            "is_primary": is_prim,
                            "captured_at": captured_at.isoformat(),
                        }
                    )
                    if is_prim or primary_snapshot_url is None:
                        primary_snapshot_url = pub_url
                except Exception as e:
                    logger.warning("Failed to save album camera snapshot: %s", e)

    # 2. Process single frame snapshot if no multi-camera snapshots given
    if not saved_album_photos and req.frame_snapshot_base64:
        try:
            raw_b64 = req.frame_snapshot_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_b64)
            storage_key = f"snapshots/{code.lower()}.jpg"
            storage.save(storage_key, img_bytes)
            primary_snapshot_url = storage.public_url(storage_key)
            saved_album_photos.append(
                {
                    "url": primary_snapshot_url,
                    "camera_name": req.camera_name or "Основная камера",
                    "is_primary": True,
                    "captured_at": captured_at.isoformat(),
                }
            )
        except Exception as e:
            logger.warning("Failed to save incident primary snapshot: %s", e)

    priority = (
        IncidentPriority.CRITICAL
        if req.severity == IncidentSeverity.ERROR
        else IncidentPriority.MEDIUM
    )
    inc_type = (
        IncidentType.EQUIPMENT_UNEXPECTED
        if req.discrepancy_type == "UNCHARACTERISTIC_PRESENT"
        else IncidentType.EQUIPMENT_MISSING
    )

    incident = Incident(
        code=code,
        project_id=project.id,
        schedule_task_id=req.stage_id,
        zone_id=req.zone_id,
        camera_id=req.camera_id,
        category=(IncidentCategory.CAMERA if req.discrepancy_type.startswith("STREAM_") else IncidentCategory.EQUIPMENT),
        type=(
            IncidentType.CAMERA_VISIBILITY if loop
            else IncidentType.CAMERA_OFFLINE if req.discrepancy_type.startswith("STREAM_")
            else inc_type
        ),
        title=req.title,
        description=req.description,
        discrepancy_type=req.discrepancy_type,
        machinery_type=req.machinery_type,
        stage_probability=req.stage_probability,
        observation_count=req.observed_count or 1,
        priority=priority,
        status=IncidentStatus.PENDING,
        dedup_key=dedup_key,
        first_seen_at=captured_at,
        last_seen_at=captured_at,
        explanation={
            "observation_keys": [observation_key],
            "captured_at": captured_at.isoformat(),
            "rule_version": req.rule_version,
            "snapshot_url": primary_snapshot_url,
            "album_photos": saved_album_photos,
            "zone_name": req.zone_name,
            "camera_name": req.camera_name,
            "stage_name": req.stage_name,
            "description": req.description,
            "severity": req.severity.value if hasattr(req.severity, "value") else str(req.severity),
        },
    )
    db.add(incident)
    db.flush()
    if req.discrepancy_type != "STREAM_ONLINE":
        assign_initial_alert(db, incident, project)
    db.commit()
    db.refresh(incident)

    return _incident_to_response(incident)


@router.get("/{incident_id}/album", response_model=IncidentAlbumResponse)
def get_incident_album(
    incident_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
) -> IncidentAlbumResponse:
    """Получить альбом фотографий со всех камер для конкретной ошибки/инцидента."""
    incident = _incident_for_user(db, incident_id, current_user)

    resp = _incident_to_response(incident)
    return IncidentAlbumResponse(
        incident_id=resp.id,
        code=resp.code,
        title=resp.title or "Ошибка СМР",
        stage_name=resp.stage_name,
        severity=resp.severity.value if hasattr(resp.severity, "value") else str(resp.severity),
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
    """Вручную изменить статус инцидента."""
    incident = _incident_for_user(db, incident_id, current_user)
    project = db.get(Project, incident.project_id)
    can_update_unassigned = (
        incident.assigned_user_id is None
        and project is not None
        and project.owner_username == current_user.username
    )
    if current_user.role == UserRole.VIEWER or (
        current_user.role != UserRole.ADMIN
        and incident.assigned_user_id != current_user.id
        and not can_update_unassigned
    ):
        raise HTTPException(status_code=403, detail="Инцидент назначен другому пользователю")

    old_status = incident.status
    new_status = _normalize_status(data.status)
    if new_status == old_status and new_status != IncidentStatus.RESOLVED:
        return _incident_to_response(incident)
    if new_status == IncidentStatus.FALSE_POSITIVE and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Отклонить нарушение может администратор")
    if new_status == IncidentStatus.RESOLVED and incident.discrepancy_type == STREAM_LOOP:
        # nobody can rule out a loop in a minute: the administrator who saw the live picture closes it
        if current_user.role != UserRole.ADMIN:
            raise HTTPException(
                status_code=403,
                detail="Повтор видео снимает администратор, убедившись, что камера показывает площадку вживую",
            )
        now = datetime.now(UTC)
        incident.status = IncidentStatus.RESOLVED
        incident.resolved_at = now
        incident.verification_requested_at = None
        incident.verification_details = {
            **(incident.verification_details or {}),
            "resolution": "admin_confirmed_live",
            "resolved_by": current_user.name or current_user.username,
            "checked_at": now.isoformat(),
        }
        db.add(IncidentEvent(
            incident_id=incident.id, event_type=IncidentEventType.COMMENTED, user_id=current_user.id,
            comment="Администратор убедился, что камера показывает площадку вживую",
        ))
        db.add(IncidentEvent(
            incident_id=incident.id, event_type=IncidentEventType.STATUS_CHANGED, user_id=current_user.id,
            old_status=old_status, new_status=IncidentStatus.RESOLVED,
            comment=f"Видео живое: {old_status.value} -> resolved",
        ))
    elif new_status == IncidentStatus.RESOLVED:
        try:
            request_verification(db, incident, current_user)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    elif new_status in (IncidentStatus.IN_PROGRESS, IncidentStatus.CONFIRMED):
        if incident.status not in OPEN_STATUSES:
            raise HTTPException(status_code=409, detail="Инцидент уже закрыт")
        incident.status = new_status
    elif new_status == IncidentStatus.FALSE_POSITIVE:
        incident.status = new_status
        incident.resolved_at = datetime.now(UTC)
    else:
        raise HTTPException(status_code=422, detail="Недопустимый статус")
    exp = dict(incident.explanation or {})
    exp["is_manual_override"] = True
    incident.explanation = exp

    if new_status != IncidentStatus.RESOLVED:
        db.add(IncidentEvent(
            incident_id=incident.id,
            event_type=IncidentEventType.STATUS_CHANGED,
            old_status=old_status,
            new_status=new_status,
            user_id=current_user.id,
            comment=f"Ручная смена статуса: {old_status} -> {new_status}",
        ))
    db.commit()
    db.refresh(incident)

    return _incident_to_response(incident)
