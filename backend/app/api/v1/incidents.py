import base64
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import DbSession
from app.core.config import settings
from app.models.enums import (
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.models.incident import Incident, IncidentEvent
from app.models.project import Project
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
    return IncidentStatus.PENDING


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
        if (inc.priority and inc.priority.value == "critical") or exp.get("severity") == "error"
        else IncidentSeverity.WARNING
    )

    status_str = inc.status.value if hasattr(inc.status, "value") else str(inc.status)

    return IncidentResponse(
        id=inc.id,
        code=inc.code,
        project_id=inc.project_id,
        stage_id=inc.schedule_task_id,
        stage_name=stage_name,
        zone_name=zone_name,
        camera_name=camera_name,
        title=inc.title,
        description=inc.description or exp.get("description"),
        severity=sev,
        discrepancy_type=inc.discrepancy_type or "MISSING_MANDATORY",
        machinery_type=inc.machinery_type or "Экскаватор",
        stage_probability=inc.stage_probability or 0.85,
        status=status_str,
        observed_count=inc.observation_count,
        frame_snapshot_url=snapshot_url,
        snapshot_url=snapshot_url,
        album_photos=album_photos,
        manual_override=bool(exp.get("is_manual_override", False)),
        created_at=inc.created_at,
    )


# --- Endpoints ---

@router.get("/config", response_model=IncidentConfigResponse)
def get_incident_config() -> IncidentConfigResponse:
    """Получить текущее значение окна фиксации нарушений (в секундах)."""
    return IncidentConfigResponse(
        violation_evaluation_window_seconds=settings.violation_evaluation_window_seconds
    )


@router.patch("/config", response_model=IncidentConfigResponse)
def update_incident_config(data: IncidentConfigUpdate) -> IncidentConfigResponse:
    """Обновить окно фиксации нарушений (в секундах)."""
    settings.violation_evaluation_window_seconds = data.violation_evaluation_window_seconds
    return IncidentConfigResponse(
        violation_evaluation_window_seconds=settings.violation_evaluation_window_seconds
    )


@router.get("", response_model=list[IncidentResponse])
def get_incidents(
    db: DbSession,
    project_id: uuid.UUID | None = None,
    limit: int = 50,
) -> list[IncidentResponse]:
    """Получить список зарегистрированных нарушений и алертов."""
    query = select(Incident).order_by(Incident.created_at.desc()).limit(limit)
    if project_id:
        query = query.where(Incident.project_id == project_id)

    incidents = db.scalars(query).all()

    if not incidents:
        return [
            IncidentResponse(
                id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
                code="INC-042",
                project_id=project_id or uuid.uuid4(),
                stage_id=None,
                stage_name="Выемка грунта котлована под фундамент",
                zone_name="A-03 · Котлован",
                camera_name="CAM-03",
                title="Отсутствует обязательная техника: Экскаватор",
                description="На этапе выемки грунта котлована за 30 сек не зафиксирован обязательный экскаватор. Нарушение регламента работ.",
                severity=IncidentSeverity.ERROR,
                discrepancy_type="MISSING_MANDATORY",
                machinery_type="Экскаватор",
                stage_probability=0.96,
                status="pending",
                observed_count=0,
                frame_snapshot_url="/media/snapshots/inc_042.jpg",
                snapshot_url="/media/snapshots/inc_042.jpg",
                album_photos=[
                    IncidentPhotoItem(
                        url="/media/snapshots/inc_042.jpg",
                        camera_name="CAM-03 · Котлован (основной ракурс)",
                        is_primary=True,
                    ),
                    IncidentPhotoItem(
                        url="/media/snapshots/inc_042_cam2.jpg",
                        camera_name="CAM-01 · Въезд на стройплощадку",
                        is_primary=False,
                    ),
                ],
                created_at=datetime.now(),
            ),
            IncidentResponse(
                id=uuid.UUID("22222222-2222-2222-2222-222222222222"),
                code="INC-043",
                project_id=project_id or uuid.uuid4(),
                stage_id=None,
                stage_name="Выемка грунта котлована под фундамент",
                zone_name="A-03 · Котлован",
                camera_name="CAM-03",
                title="Отсутствует рекомендованная техника: Погрузчик",
                description="Рекомендованный погрузчик не зафиксирован в течение 30 сек. Рекомендуется привлечь технику для соблюдения темпа.",
                severity=IncidentSeverity.WARNING,
                discrepancy_type="MISSING_RECOMMENDED",
                machinery_type="Погрузчик",
                stage_probability=0.72,
                status="pending",
                observed_count=0,
                frame_snapshot_url=None,
                snapshot_url=None,
                album_photos=[],
                created_at=datetime.now(),
            ),
        ]

    return [_incident_to_response(inc) for inc in incidents]


@router.post("", response_model=IncidentResponse, status_code=201)
def create_incident(
    req: IncidentCreateRequest,
    db: DbSession,
) -> IncidentResponse:
    """Зарегистрировать нарушение с фиксацией фотоснимков со всех подключенных камер (альбом ошибки)."""
    code = f"INC-{uuid.uuid4().hex[:4].upper()}"
    now = datetime.now(UTC)
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
                            "captured_at": now.isoformat(),
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
                    "captured_at": now.isoformat(),
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

    target_project_id = req.project_id
    if target_project_id:
        proj = db.get(Project, target_project_id)
        if not proj:
            target_project_id = None
    if not target_project_id:
        proj = db.scalars(select(Project)).first()
        if proj:
            target_project_id = proj.id
        else:
            proj = Project(code="PRJ-DEFAULT", name="Объект строительства")
            db.add(proj)
            db.flush()
            target_project_id = proj.id

    incident = Incident(
        code=code,
        project_id=target_project_id,
        schedule_task_id=req.stage_id,
        category=IncidentCategory.EQUIPMENT,
        type=inc_type,
        title=req.title,
        description=req.description,
        discrepancy_type=req.discrepancy_type,
        machinery_type=req.machinery_type,
        stage_probability=req.stage_probability,
        observation_count=req.observed_count or 1,
        priority=priority,
        status=IncidentStatus.PENDING,
        dedup_key=f"{target_project_id}_{req.machinery_type}_{req.discrepancy_type}_{now.strftime('%Y%m%d%H%M%S')}",
        first_seen_at=now,
        last_seen_at=now,
        explanation={
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
    db.commit()
    db.refresh(incident)

    return _incident_to_response(incident)


@router.get("/{incident_id}/album", response_model=IncidentAlbumResponse)
def get_incident_album(
    incident_id: uuid.UUID,
    db: DbSession,
) -> IncidentAlbumResponse:
    """Получить альбом фотографий со всех камер для конкретной ошибки/инцидента."""
    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Инцидент не найден")

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


@router.patch("/{incident_id}/status", response_model=IncidentResponse)
def update_incident_status(
    incident_id: uuid.UUID,
    data: IncidentStatusUpdateRequest,
    db: DbSession,
) -> IncidentResponse:
    """Вручную изменить статус инцидента."""
    incident = db.get(Incident, incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Инцидент не найден")

    old_status = incident.status
    new_status = _normalize_status(data.status)

    incident.status = new_status
    exp = dict(incident.explanation or {})
    exp["is_manual_override"] = True
    incident.explanation = exp

    event = IncidentEvent(
        incident_id=incident.id,
        event_type=IncidentEventType.STATUS_CHANGED,
        old_status=old_status,
        new_status=new_status,
        comment=f"Ручная смена статуса: {old_status} -> {new_status}",
    )
    db.add(event)
    db.commit()
    db.refresh(incident)

    return _incident_to_response(incident)
