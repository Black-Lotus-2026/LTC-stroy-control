"""Календарный план работ."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import enum_column
from app.models.enums import ScheduleTaskStatus
from app.models.project import Project, Zone
from app.models.reference import WorkType


class ScheduleTask(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Работа календарного плана: вид работ, привязанный к зоне и срокам.

    Отличие от WorkType принципиальное: WorkType — это «Разработка грунта»
    вообще, ScheduleTask — «Разработка грунта в зоне A-03 с 08:00 до 17:00
    16 сентября». Правила задаются на вид работ, а проверяются на задачу.
    """

    __tablename__ = "schedule_tasks"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    zone_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("zones.id", ondelete="SET NULL"), default=None
    )
    work_type_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("work_types.id", ondelete="SET NULL"),
        default=None,
    )

    # Название из плана. Может отличаться от названия вида работ, поэтому
    # хранится отдельно, а не берётся по ссылке.
    name: Mapped[str] = mapped_column(String(512))

    planned_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    planned_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    status: Mapped[ScheduleTaskStatus] = mapped_column(
        enum_column(ScheduleTaskStatus), default=ScheduleTaskStatus.PLANNED
    )

    # Плановый прогресс на текущий момент и наблюдаемый факт. Оба в долях 0..1.
    planned_progress: Mapped[float | None] = mapped_column(Float, default=None)
    actual_progress: Mapped[float | None] = mapped_column(Float, default=None)

    project: Mapped[Project] = relationship()
    zone: Mapped[Zone | None] = relationship()
    work_type: Mapped[WorkType | None] = relationship()

    def __repr__(self) -> str:
        return f"<ScheduleTask {self.name[:40]}>"
