"""CV background tasks: frame sampling and rule evaluation."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from celery import shared_task
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.project import Project
from app.models.schedule import ScheduleTask

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

        # This compatibility job receives one caller-provided frame without an
        # authenticated capture window or an approved coverage configuration.
        # It cannot establish a persisted compliance verdict. Saved-recording and
        # camera-source pipelines own the server-verified observation lifecycle.
        return []

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
