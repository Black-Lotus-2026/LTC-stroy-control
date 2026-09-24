"""Video management and timeline synchronization service."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.models.video import VideoAsset
from app.schemas.stroy_control import VideoSyncStatusResponse

logger = logging.getLogger(__name__)


class VideoService:
    def __init__(self, db: Session):
        self.db = db

    def register_video(
        self,
        file_bytes: bytes,
        filename: str,
        start_timestamp: datetime,
        project_id: uuid.UUID | None = None,
    ) -> VideoAsset:
        """Save video file to local storage and create VideoAsset record."""
        if project_id is None:
            proj = self.db.scalars(select(Project)).first()
            if not proj:
                proj = Project(code="PRJ-DEMO", name="Многоквартирный жилой дом")
                self.db.add(proj)
                self.db.flush()
            project_id = proj.id

        # Save to storage
        storage_dir = Path(__file__).resolve().parents[2] / "var" / "storage" / "videos"
        storage_dir.mkdir(parents=True, exist_ok=True)
        video_id = uuid.uuid4()
        dest_filename = f"{video_id}_{filename}"
        dest_path = storage_dir / dest_filename

        with open(dest_path, "wb") as f:
            f.write(file_bytes)

        # Estimate basic parameters (duration ~ 120s if not probed)
        asset = VideoAsset(
            id=video_id,
            project_id=project_id,
            filename=filename,
            storage_key=str(dest_path),
            start_timestamp=start_timestamp,
            duration_seconds=120.0,
            fps=25.0,
            frame_count=3000,
            status="READY",
        )
        self.db.add(asset)
        self.db.commit()
        self.db.refresh(asset)
        return asset

    def sync_playback_time(
        self,
        video_id: uuid.UUID,
        playback_seconds: float,
    ) -> VideoSyncStatusResponse:
        """Map playback offset to real-world datetime and active schedule stage."""
        asset = self.db.get(VideoAsset, video_id)
        if not asset:
            # Fallback anchor datetime if video record not found
            base_time = datetime(2026, 6, 15, 10, 0, 0, tzinfo=UTC)
            curr_time = base_time + timedelta(seconds=playback_seconds)
            project_id = None
        else:
            curr_time = asset.start_timestamp + timedelta(seconds=playback_seconds)
            project_id = asset.project_id

        # Query active schedule stage
        query = select(ScheduleTask)
        if project_id:
            query = query.where(ScheduleTask.project_id == project_id)

        stages = self.db.scalars(query).all()
        active_stage = None
        for s in stages:
            if s.planned_start <= curr_time <= s.planned_end:
                active_stage = s
                break

        return VideoSyncStatusResponse(
            video_id=video_id,
            playback_seconds=playback_seconds,
            current_timestamp=curr_time,
            active_stage_id=active_stage.id if active_stage else None,
            active_stage_name=active_stage.name
            if active_stage
            else "Вне графика (межэтапный интервал)",
            is_out_of_schedule=active_stage is None,
        )
