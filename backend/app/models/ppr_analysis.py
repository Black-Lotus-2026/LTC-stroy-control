"""Durable page-grounded PPR extraction, distinct from immutable originals."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PprAnalysis(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ppr_analyses"
    document_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("ppr_documents.id", ondelete="CASCADE"),
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    document_sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    pages_total: Mapped[int] = mapped_column(Integer, default=0)
    pages_processed: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(40), nullable=True)
    lease_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rendered_pdf_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    run_no: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    renderer_version: Mapped[str] = mapped_column(
        String(64), default="ppr-r1", server_default="ppr-r1"
    )
    __table_args__ = (UniqueConstraint("document_id", "run_no"),)


class PprPage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ppr_pages"
    __table_args__ = (UniqueConstraint("analysis_id", "page_number"),)
    analysis_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("ppr_analyses.id", ondelete="CASCADE"),
        index=True,
    )
    page_number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="PENDING")
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    extraction_method: Mapped[str] = mapped_column(String(30), default="native_pdf")
    text: Mapped[str] = mapped_column(Text, default="")
    text_sha256: Mapped[str] = mapped_column(String(64), default="")
    preview_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    preview_media_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    artifact_sha256: Mapped[str | None] = mapped_column(String(64))


class PprRequirement(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ppr_requirements"
    __table_args__ = (UniqueConstraint("analysis_id", "fingerprint"),)
    analysis_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("ppr_analyses.id", ondelete="CASCADE"),
        index=True,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("ppr_documents.id", ondelete="CASCADE"),
        index=True,
    )
    document_sha256: Mapped[str] = mapped_column(String(64))
    page_number: Mapped[int] = mapped_column(Integer)
    fingerprint: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(500))
    type: Mapped[str] = mapped_column(String(40))
    equipment_class: Mapped[str | None] = mapped_column(String(80), nullable=True)
    scope_text: Mapped[str] = mapped_column(Text, default="")
    quote: Mapped[str] = mapped_column(Text)
    quote_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    detector_supported: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    applicability: Mapped[str] = mapped_column(String(20), default="manual")
    stage_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    stage_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("schedule_tasks.id", ondelete="SET NULL"),
        nullable=True,
    )
    extraction_method: Mapped[str] = mapped_column(String(30))
    human_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
