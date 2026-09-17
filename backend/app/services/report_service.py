"""Сценарии генерации отчётов и расчёта расписаний."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError, ValidationError
from app.db.base import utcnow
from app.models import (
    GeneratedReport,
    Project,
    ReportPeriod,
    ReportSchedule,
    ReportScheduleFrequency,
    ReportStatus,
)
from app.services.report_agent import ConstructionReportAgent, DatabaseTimelineTool

MAX_REPORT_RANGE = timedelta(days=31)


def resolve_report_window(
    period: ReportPeriod,
    range_start: datetime | None = None,
    range_end: datetime | None = None,
    *,
    now: datetime | None = None,
) -> tuple[datetime, datetime]:
    end = _aware_utc(range_end or now or utcnow(), "range_end")
    if period == ReportPeriod.CUSTOM:
        if range_start is None:
            raise ValidationError("range_start обязателен для произвольного периода")
        start = _aware_utc(range_start, "range_start")
    else:
        delta = {
            ReportPeriod.HOUR: timedelta(hours=1),
            ReportPeriod.DAY: timedelta(days=1),
            ReportPeriod.WEEK: timedelta(days=7),
        }[period]
        start = end - delta

    if start >= end:
        raise ValidationError("Начало периода должно быть раньше окончания")
    if end - start > MAX_REPORT_RANGE:
        raise ValidationError("Максимальный период одного отчёта — 31 день")
    return start, end


def generate_report(
    db: Session,
    *,
    project_id: uuid.UUID,
    period: ReportPeriod,
    range_start: datetime | None = None,
    range_end: datetime | None = None,
    schedule_id: uuid.UUID | None = None,
    requested_by_user_id: uuid.UUID | None = None,
) -> GeneratedReport:
    project = db.get(Project, project_id)
    if project is None:
        raise NotFoundError(
            "Строительный объект не найден", {"project_id": str(project_id)}
        )

    start, end = resolve_report_window(period, range_start, range_end)
    report = GeneratedReport(
        project_id=project_id,
        schedule_id=schedule_id,
        requested_by_user_id=requested_by_user_id,
        period=period,
        range_start=start,
        range_end=end,
        status=ReportStatus.GENERATING,
        title=f"Сводка по объекту «{project.name}»",
        started_at=utcnow(),
    )
    db.add(report)
    db.flush()

    try:
        agent = ConstructionReportAgent(DatabaseTimelineTool(db))
        result = agent.generate(project_id, start, end)
        report.title = result.title
        report.executive_summary = result.executive_summary
        report.content = result.content
        report.source_log_count = result.source_log_count
        report.agent_name = agent.name
        report.agent_version = agent.version
        report.status = ReportStatus.COMPLETED
        report.completed_at = utcnow()
    except Exception as exc:  # noqa: BLE001 - ошибка сохраняется в аудите запуска
        report.status = ReportStatus.FAILED
        report.error = f"{exc.__class__.__name__}: {exc}"
        report.completed_at = utcnow()
    db.flush()
    return report


def default_period_for_frequency(frequency: ReportScheduleFrequency) -> ReportPeriod:
    return {
        ReportScheduleFrequency.HOURLY: ReportPeriod.HOUR,
        ReportScheduleFrequency.DAILY: ReportPeriod.DAY,
        ReportScheduleFrequency.WEEKLY: ReportPeriod.WEEK,
    }[frequency]


def calculate_next_run(
    frequency: ReportScheduleFrequency,
    timezone: str,
    run_at_local: time,
    weekday: int | None,
    *,
    now: datetime | None = None,
) -> datetime:
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValidationError("Неизвестный часовой пояс", {"timezone": timezone}) from exc

    current = _aware_utc(now or utcnow(), "now").astimezone(zone)
    if frequency == ReportScheduleFrequency.HOURLY:
        candidate = current.replace(minute=0, second=0, microsecond=0) + timedelta(
            hours=1
        )
    elif frequency == ReportScheduleFrequency.DAILY:
        candidate = datetime.combine(current.date(), run_at_local, tzinfo=zone)
        if candidate <= current:
            candidate += timedelta(days=1)
    else:
        target_weekday = 0 if weekday is None else weekday
        days_ahead = (target_weekday - current.weekday()) % 7
        candidate = datetime.combine(
            current.date() + timedelta(days=days_ahead), run_at_local, tzinfo=zone
        )
        if candidate <= current:
            candidate += timedelta(days=7)
    return candidate.astimezone(UTC)


def run_due_report_schedules(
    db: Session, *, now: datetime | None = None
) -> dict[str, int]:
    current = _aware_utc(now or utcnow(), "now")
    query = (
        select(ReportSchedule)
        .where(
            ReportSchedule.enabled.is_(True),
            ReportSchedule.next_run_at <= current,
        )
        .with_for_update(skip_locked=True)
    )
    schedules = db.scalars(query).all()
    completed = 0
    failed = 0
    for schedule in schedules:
        report = generate_report(
            db,
            project_id=schedule.project_id,
            period=schedule.report_period,
            range_end=current,
            schedule_id=schedule.id,
        )
        schedule.last_run_at = current
        schedule.next_run_at = calculate_next_run(
            schedule.frequency,
            schedule.timezone,
            schedule.run_at_local,
            schedule.weekday,
            now=current,
        )
        if report.status == ReportStatus.COMPLETED:
            completed += 1
        else:
            failed += 1
    return {"due": len(schedules), "completed": completed, "failed": failed}


def _aware_utc(value: datetime, field: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValidationError(
            f"{field} должен содержать часовой пояс",
            {"example": "2026-09-17T12:00:00+03:00"},
        )
    return value.astimezone(UTC)
