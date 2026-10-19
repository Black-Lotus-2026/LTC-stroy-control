"""CV background tasks: frame sampling and rule evaluation."""

from __future__ import annotations

import logging
import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.incident import Incident
from app.models.enums import IncidentCategory, IncidentPriority, IncidentStatus, IncidentType
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.services.detector_provider import get_detector
from app.services.rule_engine import RuleEngine
from app.services.alert_service import OPEN_STATUSES, assign_initial_alert

logger = logging.getLogger(__name__)


def process_video_frame_sync(
    frame_bytes: bytes,
    stage_id: uuid.UUID,
    project_id: uuid.UUID,
    camera_name: str = "CAM-01",
    db: Session | None = None,
) -> list[dict[str, Any]]:
    """Process a single sampled frame (0.2 FPS) through YOLO and RuleEngine."""
    should_close = False
    if db is None:
        db = SessionLocal()
        should_close = True

    try:
        stage = db.get(ScheduleTask, stage_id)
        if not stage:
            logger.warning("Stage %s not found for frame processing", stage_id)
            return []
        project = db.get(Project, project_id)
        if not project or stage.project_id != project_id:
            logger.warning("Project %s does not match stage %s", project_id, stage_id)
            return []

        # 1. Run YOLO inference
        detector = get_detector()
        detections = detector.detect_frame(frame_bytes)

        if hasattr(detector, "compliance_enabled") and not detector.compliance_enabled:
            logger.info("Construction shadow/not-ready frame: %s observations; no compliance changes", len(detections))
            return []

        # 2. Count detected machinery by Russian name and raw label
        detected_counts: dict[str, int] = {}
        for d in detections:
            detected_counts[d.label_ru] = detected_counts.get(d.label_ru, 0) + 1
            detected_counts[d.raw_label] = detected_counts.get(d.raw_label, 0) + 1

        # 3. Evaluate discrepancy rules
        engine = RuleEngine()
        probs = stage.machinery_probabilities or {}
        evaluations = (detector.evaluate_rules(probs, detections) if hasattr(detector, "evaluate_rules")
                       else engine.evaluate_stage_machinery(probs, detected_counts))

        violations: list[dict[str, Any]] = []
        for ev in evaluations:
            if ev.is_violation:
                violations.append(
                    {
                        "machinery_name": ev.machinery_name,
                        "stage_probability": ev.stage_probability,
                        "observed_count": ev.observed_count,
                        "severity": ev.severity,
                        "discrepancy_type": ev.discrepancy_type,
                        "description": ev.description,
                    }
                )

                dedup_key = f"{project_id}:{stage.id}:{ev.discrepancy_type}:{ev.machinery_name}"
                if db.get_bind().dialect.name == "postgresql":
                    lock_id = int.from_bytes(
                        hashlib.blake2b(dedup_key.encode(), digest_size=8).digest(),
                        "big", signed=True,
                    )
                    db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": lock_id})
                existing = db.scalar(select(Incident).where(
                    Incident.dedup_key == dedup_key,
                    Incident.status.in_(OPEN_STATUSES),
                ).with_for_update())
                if existing:
                    existing.observation_count += 1
                    existing.last_seen_at = datetime.now(UTC)
                    continue

                inc_code = f"INC-{uuid.uuid4().hex[:8].upper()}"
                incident = Incident(
                    code=inc_code,
                    project_id=project_id,
                    schedule_task_id=stage.id,
                    category=IncidentCategory.EQUIPMENT,
                    type=(IncidentType.EQUIPMENT_UNEXPECTED if ev.discrepancy_type == "UNCHARACTERISTIC_PRESENT" else IncidentType.EQUIPMENT_MISSING),
                    priority=(IncidentPriority.CRITICAL if ev.severity == "ERROR" else IncidentPriority.MEDIUM),
                    status=IncidentStatus.PENDING,
                    title=f"Отклонение по технике: {ev.machinery_name}",
                    description=ev.description,
                    discrepancy_type=ev.discrepancy_type,
                    machinery_type=ev.machinery_name,
                    stage_probability=ev.stage_probability,
                    observed_count=ev.observed_count,
                    first_seen_at=datetime.now(UTC),
                    last_seen_at=datetime.now(UTC),
                    dedup_key=dedup_key,
                    explanation={"severity": ev.severity.lower(), "camera_name": camera_name},
                )
                db.add(incident)
                db.flush()
                assign_initial_alert(db, incident, project)

        db.commit()
        return violations
    finally:
        if should_close:
            db.close()


@shared_task(name="cv.analyze_frame")
def analyze_frame_task(
    frame_bytes_b64: str, stage_id_str: str, project_id_str: str
) -> list[dict[str, Any]]:
    import base64

    frame_bytes = base64.b64decode(frame_bytes_b64)
    stage_id = uuid.UUID(stage_id_str)
    project_id = uuid.UUID(project_id_str)
    return process_video_frame_sync(frame_bytes, stage_id, project_id)
