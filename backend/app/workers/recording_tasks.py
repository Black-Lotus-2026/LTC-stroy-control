"""Explicit saved-recording analysis; CPU-heavy work uses the cv queue."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.project import Project
from app.models.video import VideoAsset
from app.schemas.recording_analysis import RecordingAnalysisResultDTO
from app.services.observation_basis import writable_project
from app.workers.celery_app import celery_app


@celery_app.task(bind=True, name="recording.analyze_saved")
def analyze_saved_recording_task(
    self, video_id: str, max_duration_seconds: float | None = None
):
    from app.services.recording_analysis import analyze_recording

    with SessionLocal() as db:
        asset = db.scalar(
            select(VideoAsset)
            .join(Project, Project.id == VideoAsset.project_id)
            .where(
                Project.kind != "shared_demo",
                Project.lifecycle == "active",
                VideoAsset.id == uuid.UUID(video_id),
            )
            .with_for_update()
        )
        if not asset or asset.status != "READY":
            return {"status": "not_ready"}
        if not writable_project(db, asset.project_id, lock=True):
            return {"status": "project_read_only"}
        if asset.analysis_status in {"RUNNING", "COMPLETED"}:
            return {"status": "already_claimed"}
        asset.analysis_status = "RUNNING"
        asset.analysis_updated_at = datetime.now(UTC)
        asset.analysis_error = None
        db.commit()

        def progress(value):
            if not writable_project(db, asset.project_id, lock=True):
                db.rollback()
                return
            asset.analysis_updated_at = datetime.now(UTC)
            db.commit()
            self.update_state(state="PROGRESS", meta=value)

        try:
            result = analyze_recording(
                db,
                asset.id,
                max_duration_seconds=max_duration_seconds,
                progress=progress,
            )
            writable_project(db, asset.project_id, lock=True)
            asset.analysis_result = RecordingAnalysisResultDTO.model_validate(
                result
            ).model_dump(mode="json")
            asset.analysis_updated_at = datetime.now(UTC)
            if result["status"] == "disabled" or result["prefix_only"]:
                asset.analysis_status = "PENDING"
            elif result["status"] == "partial":
                asset.analysis_status = "FAILED"
                asset.analysis_error = (
                    "Область ответственности не определена однозначно. "
                    "Положительные наблюдения сохранены как технический результат; "
                    "нормативные дела не созданы."
                    if result.get("technical_observations")
                    else f"Не обработано кадров: {result['failed_samples']}"
                )
            else:
                asset.analysis_status = "COMPLETED"
                asset.analyzed_at = datetime.now(UTC)
            db.commit()
            return result
        except Exception as exc:
            db.rollback()
            asset = db.get(VideoAsset, uuid.UUID(video_id))
            if asset and writable_project(db, asset.project_id, lock=True):
                asset.analysis_status = "FAILED"
                asset.analysis_error = f"Ошибка обработки записи: {type(exc).__name__}"
                asset.analysis_updated_at = datetime.now(UTC)
                db.commit()
            raise


def enqueue_pending_recordings(db, publish=None):
    """Claim durably before publishing; recover crashed/undelivered leases."""
    if (
        settings.construction_policy != "enforce"
        or not settings.construction_approved_classes
    ):
        return {"queued": 0}
    now = datetime.now(UTC)
    stale = or_(
        (VideoAsset.analysis_status == "RUNNING")
        & (VideoAsset.analysis_updated_at < now - timedelta(minutes=15)),
        (VideoAsset.analysis_status == "QUEUED")
        & (VideoAsset.analysis_updated_at < now - timedelta(hours=6)),
    )
    assets = list(
        db.scalars(
            select(VideoAsset)
            .join(Project, Project.id == VideoAsset.project_id)
            .where(
                Project.kind != "shared_demo",
                Project.lifecycle == "active",
                VideoAsset.status == "READY",
                or_(VideoAsset.analysis_status == "PENDING", stale),
            )
            .order_by(Project.id, VideoAsset.created_at)
            .limit(10)
            .with_for_update(skip_locked=True)
        )
    )
    identifiers = [asset.id for asset in assets]
    for asset in assets:
        asset.analysis_status = "QUEUED"
        asset.analysis_updated_at = now
    db.commit()
    publish = publish or analyze_saved_recording_task.delay
    queued = 0
    for identifier in identifiers:
        try:
            publish(str(identifier))
            queued += 1
        except Exception:
            asset = db.get(VideoAsset, identifier)
            if asset and asset.analysis_status == "QUEUED":
                asset.analysis_status = "PENDING"
                db.commit()
    return {"queued": queued}


@celery_app.task(name="recording.enqueue_pending")
def enqueue_pending_recordings_task():
    with SessionLocal() as db:
        return enqueue_pending_recordings(db)
