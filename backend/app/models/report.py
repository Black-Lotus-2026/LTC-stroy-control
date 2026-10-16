"""Журнал наблюдений и отчёты, формируемые агентом."""

from __future__ import annotations

import uuid
from datetime import datetime, time

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, Time
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import (
    ObservationCategory,
    ObservationSeverity,
    ObservationSource,
    ReportPeriod,
    ReportScheduleFrequency,
    ReportStatus,
)
from app.models.project import Camera, Project, Zone
from app.models.user import User


class ObservationLog(UUIDPrimaryKeyMixin, Base):
    """Нормализованное событие с CCTV/CV/VLC или ручного ввода.

    Сырые форматы источников могут отличаться, но отчётный агент всегда
    читает одну временную шкалу. Исходные специфичные поля остаются в payload.
    """

    __tablename__ = "observation_logs"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), default=None
    )
    camera_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cameras.id", ondelete="SET NULL"), default=None
    )

    source: Mapped[ObservationSource] = mapped_column(enum_column(ObservationSource))
    category: Mapped[ObservationCategory] = mapped_column(
        enum_column(ObservationCategory), index=True
    )
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    severity: Mapped[ObservationSeverity] = mapped_column(
        enum_column(ObservationSeverity), default=ObservationSeverity.INFO
    )
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    title: Mapped[str] = mapped_column(String(256))
    description: Mapped[str | None] = mapped_column(Text, default=None)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    project: Mapped[Project] = relationship()
    zone: Mapped[Zone | None] = relationship()
    camera: Mapped[Camera | None] = relationship()

    __table_args__ = (
        Index("ix_observation_logs_project_occurred", "project_id", "occurred_at"),
        Index("ix_observation_logs_project_category", "project_id", "category"),
    )


class ReportSchedule(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Когда и за какой период автоматически строить отчёт."""

    __tablename__ = "report_schedules"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(128))
    frequency: Mapped[ReportScheduleFrequency] = mapped_column(
        enum_column(ReportScheduleFrequency)
    )
    report_period: Mapped[ReportPeriod] = mapped_column(enum_column(ReportPeriod))
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Moscow")
    run_at_local: Mapped[time] = mapped_column(Time, default=time(20, 5))
    weekday: Mapped[int | None] = mapped_column(Integer, default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )

    project: Mapped[Project] = relationship()

    __table_args__ = (Index("ix_report_schedules_due", "enabled", "next_run_at"),)


class GeneratedReport(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Неизменяемый результат одного запуска отчётного агента."""

    __tablename__ = "generated_reports"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("report_schedules.id", ondelete="SET NULL"),
        default=None,
    )
    requested_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), default=None
    )

    period: Mapped[ReportPeriod] = mapped_column(enum_column(ReportPeriod))
    range_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    range_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[ReportStatus] = mapped_column(
        enum_column(ReportStatus), default=ReportStatus.PENDING, index=True
    )

    agent_name: Mapped[str] = mapped_column(
        String(64), default="construction-report-agent"
    )
    agent_version: Mapped[str] = mapped_column(String(32), default="1.0")
    title: Mapped[str] = mapped_column(String(256))
    executive_summary: Mapped[str | None] = mapped_column(Text, default=None)
    content: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    source_log_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    error: Mapped[str | None] = mapped_column(Text, default=None)

    project: Mapped[Project] = relationship()
    schedule: Mapped[ReportSchedule | None] = relationship()
    requested_by: Mapped[User | None] = relationship()

    __table_args__ = (
        Index("ix_generated_reports_project_range", "project_id", "range_end"),
    )
