"""Original per-project PPR documents; bytes live outside public media."""

from __future__ import annotations

import uuid

from sqlalchemy import BigInteger, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PprDocument(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "ppr_documents"
    __table_args__ = (UniqueConstraint("series_id", "version_no"),)

    series_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("document_series.id", ondelete="RESTRICT")
    )
    area_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("responsibility_areas.id", ondelete="RESTRICT")
    )
    version_no: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("ppr_documents.id", ondelete="RESTRICT")
    )
    owner_participation_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("project_organizations.id", ondelete="RESTRICT")
    )
    uploaded_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    media_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_key: Mapped[str] = mapped_column(String(200))
    uploaded_by: Mapped[str] = mapped_column(String(128))
    preview_kind: Mapped[str] = mapped_column(String(16))
    display_text: Mapped[str | None] = mapped_column(Text, nullable=True)
