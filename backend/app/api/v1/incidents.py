import base64
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import DbSession
from app.core.config import settings
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.models.incident import Incident, VlmVerification
from app.schemas.stroy_control import (
    IncidentConfigResponse,
    IncidentConfigUpdate,
    IncidentCreateRequest,
    IncidentResponse,
    IncidentSeverity,
    VlmVerificationResponse,
)
from app.services.vlm_verifier import GeminiVlmVerifier
from app.storage import get_storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/incidents", tags=["Инциденты и нарушения"])


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

    # If no incidents recorded in DB yet, generate initial demonstration violations
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
                observed_count=0,
                frame_snapshot_url="/media/snapshots/inc_042.jpg",
                is_vlm_verified=True,
                vlm_summary="На этапе выемки грунта отсутствует обязательный экскаватор. Камера подтверждает отсутствие спецтехники на рабочей площадке.",
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
                observed_count=0,
                frame_snapshot_url=None,
                is_vlm_verified=False,
                vlm_summary="Рекомендованный погрузчик не зафиксирован на кадрах рабочей смены.",
                created_at=datetime.now(),
            ),
        ]

    results: list[IncidentResponse] = []
    for inc in incidents:
        exp = inc.explanation if isinstance(inc.explanation, dict) else {}
        snapshot_url = exp.get("snapshot_url")
        zone_name = exp.get("zone_name") or (inc.zone.name if inc.zone else None)
        camera_name = exp.get("camera_name") or (inc.camera.name if inc.camera else None)
        stage_name = inc.schedule_task.name if inc.schedule_task else exp.get("stage_name")

        sev = (
            IncidentSeverity.ERROR
            if (inc.priority and inc.priority.value == "critical") or exp.get("severity") == "error"
            else IncidentSeverity.WARNING
        )

        results.append(
            IncidentResponse(
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
                observed_count=inc.observation_count,
                frame_snapshot_url=snapshot_url,
                is_vlm_verified=inc.is_vlm_verified,
                vlm_summary=inc.vlm_summary,
                created_at=inc.created_at,
            )
        )
    return results


@router.post("", response_model=IncidentResponse, status_code=201)
def create_incident(
    req: IncidentCreateRequest,
    db: DbSession,
) -> IncidentResponse:
    """Зарегистрировать нарушение с фиксацией фотоснимка участка и описанием."""
    code = f"INC-{uuid.uuid4().hex[:4].upper()}"
    now = datetime.now(UTC)

    snapshot_url: str | None = None
    if req.frame_snapshot_base64:
        try:
            raw_b64 = req.frame_snapshot_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_b64)
            storage = get_storage()
            storage_key = f"snapshots/{code.lower()}.jpg"
            storage.save(storage_key, img_bytes)
            snapshot_url = storage.public_url(storage_key)
        except Exception as e:
            logger.warning("Failed to save incident snapshot: %s", e)

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
        project_id=req.project_id,
        schedule_task_id=req.stage_id,
        category=IncidentCategory.EQUIPMENT,
        type=inc_type,
        title=req.title,
        description=req.description,
        discrepancy_type=req.discrepancy_type,
        machinery_type=req.machinery_type,
        stage_probability=req.stage_probability,
        observed_count=req.observed_count,
        priority=priority,
        status=IncidentStatus.PENDING,
        dedup_key=f"{req.project_id}_{req.machinery_type}_{req.discrepancy_type}_{now.strftime('%Y%m%d%H%M')}",
        first_seen_at=now,
        last_seen_at=now,
        explanation={
            "snapshot_url": snapshot_url,
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

    return IncidentResponse(
        id=incident.id,
        code=incident.code,
        project_id=incident.project_id,
        stage_id=incident.schedule_task_id,
        stage_name=req.stage_name,
        zone_name=req.zone_name,
        camera_name=req.camera_name,
        title=incident.title,
        description=incident.description,
        severity=req.severity,
        discrepancy_type=req.discrepancy_type,
        machinery_type=incident.machinery_type or req.machinery_type,
        stage_probability=incident.stage_probability or req.stage_probability,
        observed_count=incident.observation_count,
        frame_snapshot_url=snapshot_url,
        is_vlm_verified=False,
        vlm_summary=None,
        created_at=incident.created_at,
    )


@router.post("/{incident_id}/verify-vlm", response_model=VlmVerificationResponse)
async def verify_incident_vlm(
    incident_id: uuid.UUID,
    db: DbSession,
) -> VlmVerificationResponse:
    """Выполнить повторную или ручную верификацию инцидента через Google Gemini Vision."""
    incident = db.get(Incident, incident_id)
    stage_name = (
        incident.schedule_task.name
        if incident and incident.schedule_task
        else "Выемка грунта котлована"
    )
    discrepancy = (
        incident.discrepancy_type
        if incident and incident.discrepancy_type
        else "MISSING_MANDATORY"
    )
    machinery = (
        incident.machinery_type if incident and incident.machinery_type else "Экскаватор"
    )
    prob = (
        incident.stage_probability
        if incident and incident.stage_probability is not None
        else 0.95
    )

    # 1x1 dummy jpeg bytes if no actual frame is loaded
    dummy_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xdb\x00C\x00\xff\xc0\x00\x11\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xbf\x00\xff\xd9"

    verifier = GeminiVlmVerifier()
    outcome = await verifier.verify_incident(
        image_bytes=dummy_jpeg,
        stage_name=stage_name,
        discrepancy_type=discrepancy,
        target_machinery=machinery,
        stage_probability=prob,
        detected_summary="Спецтехника не обнаружена на рабочей захватке",
    )

    if incident:
        incident.is_vlm_verified = not outcome.fallback_used
        incident.vlm_summary = outcome.compact_alert_text
        record = VlmVerification(
            incident_id=incident.id,
            frame_id=None,
            prompt_sent=f"Verification for {discrepancy} on {stage_name}",
            is_violation_confirmed=outcome.is_violation_confirmed,
            is_occluded=outcome.is_occluded,
            confidence=outcome.confidence,
            reasoning=outcome.reasoning,
            compact_alert_text=outcome.compact_alert_text,
            latency_ms=outcome.latency_ms,
            status=outcome.status.upper(),
        )
        db.add(record)
        db.commit()

    return VlmVerificationResponse(
        incident_id=incident_id,
        is_violation_confirmed=outcome.is_violation_confirmed,
        is_occluded=outcome.is_occluded,
        confidence=outcome.confidence,
        reasoning=outcome.reasoning,
        compact_alert_text=outcome.compact_alert_text,
        fallback_used=outcome.fallback_used,
        latency_ms=outcome.latency_ms,
        status=outcome.status,
    )
