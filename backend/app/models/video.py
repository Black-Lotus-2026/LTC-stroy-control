"""Видеозаписи и потоки камер площадки."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.project import Camera, Project


class VideoAsset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Загруженный видеофайл или архив видеопотока с точной временной меткой старта съёмки."""

    __tablename__ = "video_assets"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    camera_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="SET NULL"), default=None
    )

    filename: Mapped[str] = mapped_column(String(256))
    storage_key: Mapped[str] = mapped_column(Text)

    # Точная дата и время начала записи видео для синхронизации с календарным планом
    start_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    fps: Mapped[float] = mapped_column(Float, default=25.0)
    frame_count: Mapped[int] = mapped_column(Integer, default=0)

    # UPLOADED, EXTRACTING, READY, FAILED
    status: Mapped[str] = mapped_column(
        String(32), default="UPLOADED", server_default="UPLOADED"
    )

    project: Mapped[Project] = relationship()
    camera: Mapped[Camera | None] = relationship()

    def __repr__(self) -> str:
        return f"<VideoAsset {self.filename} {self.start_timestamp:%Y-%m-%d %H:%M:%S}>"
