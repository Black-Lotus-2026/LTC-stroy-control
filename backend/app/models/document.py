"""Private project documents and their searchable text fragments."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ProjectDocument(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_documents"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(3))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    content: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint(
            "project_id", "sha256", "kind", name="uq_document_project_hash_kind"
        ),
    )


class DocumentChunk(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "document_chunks"

    document_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("project_documents.id", ondelete="CASCADE"),
        index=True,
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    locator: Mapped[str] = mapped_column(String(128))
    text: Mapped[str] = mapped_column(Text)

    document: Mapped[ProjectDocument] = relationship(back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("document_id", "ordinal", name="uq_document_chunk_ordinal"),
    )


class DocumentAnalysisRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Durable agent run: its inputs, cited proposals, progress and applications."""

    __tablename__ = "document_analysis_runs"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    stage_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
