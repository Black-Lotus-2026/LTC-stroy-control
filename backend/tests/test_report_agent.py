from __future__ import annotations

import uuid
from datetime import UTC, datetime, time, timedelta

import pytest

from app.core.errors import ValidationError
from app.models import ReportPeriod, ReportScheduleFrequency
from app.services.report_agent import (
    ConstructionReportAgent,
    TimelineContext,
    TimelineEvent,
)
from app.services.report_service import calculate_next_run, resolve_report_window


class FakeTimelineTool:
    def __init__(self, events: list[TimelineEvent]) -> None:
        self.events = events

    def load(
        self, project_id: uuid.UUID, range_start: datetime, range_end: datetime
    ) -> TimelineContext:
        assert project_id
        assert range_start < range_end
        return TimelineContext(project_name="Тестовый объект", events=self.events)


def make_event(**overrides) -> TimelineEvent:
    values = {
        "id": uuid.uuid4(),
        "occurred_at": datetime(2026, 9, 17, 9, 0, tzinfo=UTC),
        "source": "cv",
        "category": "safety",
        "event_type": "danger_zone_entry",
        "severity": "critical",
        "title": "Вход в опасную зону",
        "description": "Человек пересёк границу зоны.",
        "camera": "CAM-03",
        "zone": "A-03",
        "payload": {
            "status": "confirmed",
            "confidence": 0.97,
            "evidence_url": "/media/test.jpg",
        },
    }
    values.update(overrides)
    return TimelineEvent(**values)


def test_agent_builds_auditable_report() -> None:
    events = [
        make_event(),
        make_event(
            category="camera",
            event_type="camera_offline",
            severity="warning",
            title="Камера вне сети",
            payload={"status": "in_progress", "visibility_percent": 0},
        ),
    ]
    agent = ConstructionReportAgent(FakeTimelineTool(events))

    result = agent.generate(
        uuid.uuid4(),
        datetime(2026, 9, 17, 8, 0, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 0, tzinfo=UTC),
    )

    assert result.source_log_count == 2
    assert "Обработано записей временной шкалы: 2" in result.executive_summary
    assert result.content["trace"]["tools_used"] == ["timeline_search"]
    assert len(result.content["trace"]["source_log_ids"]) == 2
    metrics = {item["key"]: item["value"] for item in result.content["metrics"]}
    assert metrics["critical"] == 1
    assert metrics["camera_issues"] == 1


@pytest.mark.parametrize(
    ("period", "expected_delta"),
    [
        (ReportPeriod.HOUR, timedelta(hours=1)),
        (ReportPeriod.DAY, timedelta(days=1)),
        (ReportPeriod.WEEK, timedelta(days=7)),
    ],
)
def test_resolve_report_window_presets(
    period: ReportPeriod, expected_delta: timedelta
) -> None:
    now = datetime(2026, 9, 17, 9, 30, tzinfo=UTC)
    start, end = resolve_report_window(period, now=now)
    assert end - start == expected_delta


def test_resolve_report_window_requires_timezone() -> None:
    with pytest.raises(ValidationError):
        resolve_report_window(
            ReportPeriod.CUSTOM,
            datetime(2026, 9, 17, 8, 0),
            datetime(2026, 9, 17, 9, 0, tzinfo=UTC),
        )


def test_daily_schedule_uses_project_timezone() -> None:
    result = calculate_next_run(
        ReportScheduleFrequency.DAILY,
        "Europe/Moscow",
        time(20, 5),
        None,
        now=datetime(2026, 9, 17, 16, 0, tzinfo=UTC),
    )
    assert result == datetime(2026, 9, 17, 17, 5, tzinfo=UTC)
