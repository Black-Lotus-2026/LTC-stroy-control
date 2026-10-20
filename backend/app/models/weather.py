"""Последний сохранённый ежедневный прогноз для объекта строительства."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin


class WeatherForecast(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "weather_forecasts"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    forecast_date: Mapped[date] = mapped_column(Date, index=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    provider: Mapped[str] = mapped_column(String(32))
    weather_code: Mapped[int | None] = mapped_column(Integer)
    temperature_min_c: Mapped[float | None] = mapped_column(Float)
    temperature_max_c: Mapped[float | None] = mapped_column(Float)
    precipitation_mm: Mapped[float | None] = mapped_column(Float)
    snowfall_cm: Mapped[float | None] = mapped_column(Float)
    wind_gust_kmh: Mapped[float | None] = mapped_column(Float)
    conditions: Mapped[list[str]] = mapped_column(JSONB, default=list)
    warnings: Mapped[list[str]] = mapped_column(JSONB, default=list)

    __table_args__ = (
        UniqueConstraint("project_id", "forecast_date", name="uq_weather_project_date"),
    )
