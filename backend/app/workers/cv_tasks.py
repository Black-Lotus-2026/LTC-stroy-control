"""CV background tasks: frame sampling and rule evaluation."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.incident import Incident
from app.models.schedule import ScheduleTask
from app.services.detector import MachineryDetector
from app.services.rule_engine import RuleEngine

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

        # 1. Run YOLO inference
        detector = MachineryDetector()
        detections = detector.detect_frame(frame_bytes)

        # 2. Count detected machinery by Russian name and raw label
        detected_counts: dict[str, int] = {}
        for d in detections:
            detected_counts[d.label_ru] = detected_counts.get(d.label_ru, 0) + 1
            detected_counts[d.raw_label] = detected_counts.get(d.raw_label, 0) + 1

        # 3. Evaluate discrepancy rules
        engine = RuleEngine()
        probs = stage.machinery_probabilities or {}
        evaluations = engine.evaluate_stage_machinery(probs, detected_counts)

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

                # Persist incident
                inc_code = f"INC-{uuid.uuid4().hex[:6].upper()}"
                incident = Incident(
                    code=inc_code,
                    project_id=project_id,
                    schedule_task_id=stage.id,
                    title=f"Отклонение по технике: {ev.machinery_name}",
                    description=ev.description,
                    discrepancy_type=ev.discrepancy_type,
                    machinery_type=ev.machinery_name,
                    stage_probability=ev.stage_probability,
                    observed_count=ev.observed_count,
                    first_seen_at=datetime.now(UTC),
                    last_seen_at=datetime.now(UTC),
                    dedup_key=f"{stage.id}_{ev.machinery_name}_{ev.discrepancy_type}",
                )
                db.add(incident)

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
