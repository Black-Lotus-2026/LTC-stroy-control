"""История ракурса камеры: кто утвердил эталон, кто просил и кто согласовал перенос."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin, utcnow


class CameraViewEvent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "camera_view_events"

    camera_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="CASCADE"), index=True
    )
    # reference_set | reference_proposed | reference_rejected |
    # move_requested | move_approved | move_rejected | move_cancelled | move_completed |
    # move_expired
    kind: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    snapshot_key: Mapped[str | None] = mapped_column(String(512), default=None)
    until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
