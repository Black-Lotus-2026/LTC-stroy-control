"""Общий ограничитель запросов к публичному сервису геокодирования."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class GeocodingThrottle(Base):
    __tablename__ = "geocoding_throttle"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
