"""API генерации и планирования отчётов."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select

from app.api.deps import DbSession
from app.core.errors import NotFoundError
from app.models import GeneratedReport, Project, ReportSchedule
from app.schemas.report import (
    GeneratedReportResponse,
    ReportGenerateRequest,
    ReportScheduleCreate,
    ReportScheduleResponse,
    ReportScheduleUpdate,
)
from app.services.report_service import (
    calculate_next_run,
    default_period_for_frequency,
    generate_report,
)

router = APIRouter(prefix="/reports", tags=["Отчёты"])


@router.post(
    "/generate",
    response_model=GeneratedReportResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Сформировать отчёт за час, день, неделю или заданный интервал",
)
def create_report(payload: ReportGenerateRequest, db: DbSession) -> GeneratedReport:
    report = generate_report(
        db,
        project_id=payload.project_id,
        period=payload.period,
        range_start=payload.range_start,
        range_end=payload.range_end,
    )
    db.commit()
    db.refresh(report)
    return report


@router.get(
    "",
    response_model=list[GeneratedReportResponse],
    summary="История сформированных отчётов",
)
def list_reports(
    db: DbSession,
    project_id: Annotated[uuid.UUID, Query()],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[GeneratedReport]:
    query = (
        select(GeneratedReport)
        .where(GeneratedReport.project_id == project_id)
        .order_by(GeneratedReport.created_at.desc())
        .limit(limit)
    )
    return list(db.scalars(query).all())


@router.post(
    "/schedules",
    response_model=ReportScheduleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Настроить автоматический отчёт",
)
def create_schedule(payload: ReportScheduleCreate, db: DbSession) -> ReportSchedule:
    project = db.get(Project, payload.project_id)
    if project is None:
        raise NotFoundError(
            "Строительный объект не найден", {"project_id": str(payload.project_id)}
        )
    timezone = payload.timezone or project.timezone
    report_period = payload.report_period or default_period_for_frequency(
        payload.frequency
    )
    schedule = ReportSchedule(
        project_id=payload.project_id,
        name=payload.name,
        frequency=payload.frequency,
        report_period=report_period,
        timezone=timezone,
        run_at_local=payload.run_at_local,
        weekday=payload.weekday,
        enabled=payload.enabled,
        next_run_at=calculate_next_run(
            payload.frequency,
            timezone,
            payload.run_at_local,
            payload.weekday,
        ),
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    return schedule


@router.get(
    "/schedules",
    response_model=list[ReportScheduleResponse],
    summary="Расписания автоматических отчётов",
)
def list_schedules(
    db: DbSession, project_id: Annotated[uuid.UUID, Query()]
) -> list[ReportSchedule]:
    query = (
        select(ReportSchedule)
        .where(ReportSchedule.project_id == project_id)
        .order_by(ReportSchedule.created_at)
    )
    return list(db.scalars(query).all())


@router.patch(
    "/schedules/{schedule_id}",
    response_model=ReportScheduleResponse,
    summary="Включить, выключить или перенести расписание",
)
def update_schedule(
    schedule_id: uuid.UUID,
    payload: ReportScheduleUpdate,
    db: DbSession,
) -> ReportSchedule:
    schedule = db.get(ReportSchedule, schedule_id)
    if schedule is None:
        raise NotFoundError("Расписание отчёта не найдено", {"id": str(schedule_id)})
    if payload.enabled is not None:
        schedule.enabled = payload.enabled
    if payload.run_at_local is not None:
        schedule.run_at_local = payload.run_at_local
    if payload.weekday is not None:
        schedule.weekday = payload.weekday
    schedule.next_run_at = calculate_next_run(
        schedule.frequency,
        schedule.timezone,
        schedule.run_at_local,
        schedule.weekday,
    )
    db.commit()
    db.refresh(schedule)
    return schedule


@router.get(
    "/{report_id}",
    response_model=GeneratedReportResponse,
    summary="Получить сформированный отчёт",
)
def get_report(report_id: uuid.UUID, db: DbSession) -> GeneratedReport:
    report = db.get(GeneratedReport, report_id)
    if report is None:
        raise NotFoundError("Отчёт не найден", {"id": str(report_id)})
    return report
