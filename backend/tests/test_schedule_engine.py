"""Tests for ScheduleEngine and cascade delay shift."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.services.schedule_engine import ScheduleEngine, parse_date_value


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def sqlite_session() -> Session:
    """In-memory SQLite session for testing schedule engine logic."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_parse_date_value() -> None:
    dt1 = parse_date_value("2026-06-15")
    assert dt1.year == 2026
    assert dt1.month == 6
    assert dt1.day == 15

    dt2 = parse_date_value("15.06.2026")
    assert dt2.day == 15
    assert dt2.month == 6


def test_cascade_shift_math(sqlite_session: Session) -> None:
    project = Project(code="PRJ-TEST", name="Тестовый объект")
    sqlite_session.add(project)
    sqlite_session.commit()

    base_date = datetime(2026, 6, 1, 0, 0, 0, tzinfo=timezone.utc)
    t1 = ScheduleTask(
        project_id=project.id,
        name="Этап 1: Подготовка",
        order_index=1,
        planned_start=base_date,
        planned_end=base_date + timedelta(days=9),
        duration_days=10,
    )
    t2 = ScheduleTask(
        project_id=project.id,
        name="Этап 2: Выемка грунта",
        order_index=2,
        planned_start=base_date + timedelta(days=10),
        planned_end=base_date + timedelta(days=19),
        duration_days=10,
    )
    t3 = ScheduleTask(
        project_id=project.id,
        name="Этап 3: Фундамент",
        order_index=3,
        planned_start=base_date + timedelta(days=20),
        planned_end=base_date + timedelta(days=34),
        duration_days=15,
    )
    sqlite_session.add_all([t1, t2, t3])
    sqlite_session.commit()

    engine = ScheduleEngine(sqlite_session)
    # Delay stage 2 by 5 days -> stage 3 should shift forward by 5 days; stage 1 remains untouched
    res = engine.cascade_shift(t2.id, delay_days=5)

    assert res.shifted_stage_count == 1
    sqlite_session.refresh(t1)
    sqlite_session.refresh(t2)
    sqlite_session.refresh(t3)

    # t1 unchanged
    assert t1.planned_start.date() == base_date.date()
    # t3 shifted forward by 5 days: was day 20, now day 25
    expected_start = (base_date + timedelta(days=25)).date()
    expected_end = (base_date + timedelta(days=39)).date()
    assert t3.planned_start.date() == expected_start
    assert t3.planned_end.date() == expected_end
    assert t3.duration_days == 15
