"""Tests for VideoService and playback timeline synchronization."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.models.project import Project
from app.models.schedule import ScheduleTask
from app.models.video import VideoAsset
from app.services.video_service import VideoService


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def sqlite_session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_video_registration_and_sync(sqlite_session: Session) -> None:
    project = Project(code="PRJ-VID", name="Объект с камерами")
    sqlite_session.add(project)
    sqlite_session.commit()

    base_time = datetime(2026, 6, 15, 10, 0, 0, tzinfo=timezone.utc)

    # Schedule stage active on 2026-06-15
    stage = ScheduleTask(
        project_id=project.id,
        name="Выемка грунта котлована",
        order_index=1,
        planned_start=datetime(2026, 6, 15, 0, 0, 0, tzinfo=timezone.utc),
        planned_end=datetime(2026, 6, 20, 23, 59, 59, tzinfo=timezone.utc),
        duration_days=6,
    )
    sqlite_session.add(stage)
    sqlite_session.commit()

    service = VideoService(sqlite_session)
    asset = service.register_video(
        file_bytes=b"dummy video data",
        filename="site_demo.mp4",
        start_timestamp=base_time,
        project_id=project.id,
    )

    assert asset.id is not None
    assert asset.filename == "site_demo.mp4"

    # Playback offset 30 seconds -> within stage
    sync1 = service.sync_playback_time(asset.id, playback_seconds=30.0)
    assert sync1.active_stage_id == stage.id
    assert sync1.active_stage_name == "Выемка грунта котлована"
    assert sync1.is_out_of_schedule is False

    # Playback offset 10 days -> out of schedule
    sync2 = service.sync_playback_time(asset.id, playback_seconds=864000.0)
    assert sync2.is_out_of_schedule is True
    assert sync2.active_stage_id is None
