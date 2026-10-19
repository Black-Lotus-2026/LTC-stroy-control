"""Versioned safety catalogue and camera-coordinate candidate event evidence."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin, utcnow


class SafetyDocument(Base):
    __tablename__ = "safety_documents"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class SafetyRequirement(Base):
    __tablename__ = "safety_requirements"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("safety_documents.id"))
    scenario: Mapped[str] = mapped_column(String(50), index=True)
    data: Mapped[dict] = mapped_column(JSON)


class SafetySanction(Base):
    __tablename__ = "safety_sanctions"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)


class SafetyZone(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "safety_zones"
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    camera_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("cameras.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    scenario: Mapped[str] = mapped_column(String(50))
    polygon: Mapped[list] = mapped_column(JSON)
    site_basis: Mapped[str] = mapped_column(Text)
    responsible_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    min_duration_seconds: Mapped[float] = mapped_column(Float, default=3)
    confidence_threshold: Mapped[float] = mapped_column(Float, default=0.5)
    allowed_classes: Mapped[list] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))


class SafetyTrack(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "safety_tracks"
    __table_args__ = (UniqueConstraint("zone_id", "source_id"),)
    zone_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("safety_zones.id", ondelete="CASCADE")
    )
    source_id: Mapped[str] = mapped_column(String(120))
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    touched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    first_jpeg: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)


class SafetyFrameReceipt(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "safety_frame_receipts"
    __table_args__ = (UniqueConstraint("zone_id", "source_id", "image_sha256"),)
    zone_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("safety_zones.id", ondelete="CASCADE")
    )
    source_id: Mapped[str] = mapped_column(String(120))
    image_sha256: Mapped[str] = mapped_column(String(64))
    position_ms: Mapped[int] = mapped_column(BigInteger)


class SafetyEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "safety_events"
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    camera_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("cameras.id", ondelete="SET NULL"), nullable=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("safety_zones.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(20), default="candidate")
    scenario: Mapped[str] = mapped_column(String(50))
    source_id: Mapped[str] = mapped_column(String(120))
    first_position_ms: Mapped[int] = mapped_column(BigInteger)
    last_position_ms: Mapped[int] = mapped_column(BigInteger)
    model_sha256: Mapped[str] = mapped_column(String(64))
    evidence_sha256: Mapped[str] = mapped_column(String(64))
    evidence_jpeg: Mapped[bytes] = mapped_column(LargeBinary)
    first_evidence_jpeg: Mapped[bytes] = mapped_column(LargeBinary)
    snapshot: Mapped[dict] = mapped_column(JSON)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
