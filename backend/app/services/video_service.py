"""Video management and timeline synchronization service."""

from __future__ import annotations

import logging
import math
import uuid
from io import BytesIO
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.models.video import VideoAsset
from app.schemas.stroy_control import VideoSyncStatusResponse
from app.core.config import settings

logger = logging.getLogger(__name__)


class VideoTooLarge(ValueError):
    pass


class VideoProjectNotFound(ValueError):
    pass


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
        """Compatibility helper; HTTP uploads stream from the spooled file."""
        return self.register_video_stream(
            BytesIO(file_bytes), filename, start_timestamp, project_id
        )

    def register_video_stream(self, stream, filename, start_timestamp, project_id=None):
        """Probe actual decodable video; never register corrupt bytes as READY."""
        import cv2

        if project_id is not None and self.db.get(Project, project_id) is None:
            raise VideoProjectNotFound("Объект не найден")
        if project_id is None:
            proj = self.db.scalars(select(Project)).first()
            if not proj:
                proj = Project(code="PRJ-DEMO", name="Многоквартирный жилой дом")
                self.db.add(proj)
                self.db.flush()
            project_id = proj.id

        name = Path(filename.replace("\\", "/")).name
        name = "".join(c for c in name if ord(c) >= 32).strip()
        name = name.encode("utf-8")[:180].decode("utf-8", errors="ignore")
        if not name or name in {".", ".."}:
            raise ValueError("Некорректное имя файла")
        storage_dir = settings.storage_local_root.resolve() / "videos"
        storage_dir.mkdir(parents=True, exist_ok=True)
        video_id = uuid.uuid4()
        dest_filename = f"{video_id}_{name}"
        dest_path = storage_dir / dest_filename

        try:
            written = 0
            with dest_path.open("xb") as output:
                while chunk := stream.read(1024 * 1024):
                    written += len(chunk)
                    if written > settings.max_video_upload_bytes:
                        raise VideoTooLarge("Видеофайл превышает допустимый размер")
                    output.write(chunk)
            capture = cv2.VideoCapture(str(dest_path))
            try:
                fps = float(capture.get(cv2.CAP_PROP_FPS))
                frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
                ok, frame = capture.read()
                if (
                    not capture.isOpened()
                    or not ok
                    or frame is None
                    or not math.isfinite(fps)
                    or not 0 < fps <= 1000
                    or frame_count <= 0
                ):
                    raise ValueError("Нужен корректный декодируемый видеофайл")
                duration = frame_count / fps
            finally:
                capture.release()
            asset = VideoAsset(
                id=video_id,
                project_id=project_id,
                filename=name,
                storage_key=str(dest_path),
                start_timestamp=start_timestamp,
                duration_seconds=duration,
                fps=fps,
                frame_count=frame_count,
                status="READY",
            )
            self.db.add(asset)
            self.db.commit()
            self.db.refresh(asset)
            return asset
        except Exception:
            self.db.rollback()
            dest_path.unlink(missing_ok=True)
            raise

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
