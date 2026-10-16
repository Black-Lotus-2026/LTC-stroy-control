from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, time, timedelta

import pytest

from app.core.errors import ValidationError
from app.models import ReportPeriod, ReportScheduleFrequency
from app.services.report_agent import (
    AgentReport,
    ConstructionReportAgent,
    TimelineContext,
    TimelineEvent,
)
from app.services.report_llm import (
    LangChainOpenAIReportNarrator,
    LLMReportNarrative,
    LLMSectionNarrative,
    enhance_report_narrative,
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


class FakeNarrator:
    provider = "test-langchain"
    model_name = "fake-model"

    def generate(self, report: AgentReport) -> LLMReportNarrative:
        assert report.content["metrics"]
        return LLMReportNarrative(
            executive_summary="LLM-сводка только по переданным фактам.",
            section_summaries=[
                LLMSectionNarrative(
                    key="confirmed_events",
                    summary="Обнаружено одно подтверждённое событие.",
                )
            ],
            manager_actions=["Проверить критическое событие."],
        )


class FailingNarrator:
    provider = "test-langchain"
    model_name = "fake-model"

    def generate(self, report: AgentReport) -> LLMReportNarrative:
        raise TimeoutError("simulated timeout")


class RecordingChain:
    def __init__(self) -> None:
        self.facts: dict = {}

    def invoke(self, values: dict[str, str]) -> dict:
        self.facts = json.loads(values["facts_json"])
        return {
            "executive_summary": "Сводка.",
            "section_summaries": [],
            "manager_actions": [],
        }


def test_llm_changes_only_narrative_fields() -> None:
    base = ConstructionReportAgent(FakeTimelineTool([make_event()])).generate(
        uuid.uuid4(),
        datetime(2026, 9, 17, 8, 0, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 0, tzinfo=UTC),
    )

    result = enhance_report_narrative(base, enabled=True, narrator=FakeNarrator())

    assert result.executive_summary.startswith("LLM-")
    assert result.content["metrics"] == base.content["metrics"]
    assert result.content["trace"]["source_log_ids"] == base.content["trace"][
        "source_log_ids"
    ]
    assert result.content["trace"]["narrative"] == {
        "provider": "test-langchain",
        "model": "fake-model",
        "status": "completed",
    }
    assert result.content["manager_actions"] == [
        "Проверить критическое событие."
    ]


def test_llm_failure_keeps_template_report() -> None:
    base = ConstructionReportAgent(FakeTimelineTool([make_event()])).generate(
        uuid.uuid4(),
        datetime(2026, 9, 17, 8, 0, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 0, tzinfo=UTC),
    )

    result = enhance_report_narrative(
        base,
        enabled=True,
        narrator=FailingNarrator(),
    )

    assert result.executive_summary == base.executive_summary
    assert result.content["metrics"] == base.content["metrics"]
    assert result.content["trace"]["narrative"] == {
        "provider": "deterministic-template",
        "status": "fallback",
        "model": "fake-model",
        "fallback_reason": "TimeoutError",
    }


def test_missing_api_key_uses_template_fallback() -> None:
    base = ConstructionReportAgent(FakeTimelineTool([])).generate(
        uuid.uuid4(),
        datetime(2026, 9, 17, 8, 0, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 0, tzinfo=UTC),
    )

    result = enhance_report_narrative(base, enabled=True, api_key="")

    narrative_trace = result.content["trace"]["narrative"]
    assert narrative_trace["status"] == "fallback"
    assert narrative_trace["fallback_reason"] == "missing_api_key"


def test_langchain_payload_excludes_internal_ids_and_evidence_urls() -> None:
    event = make_event()
    base = ConstructionReportAgent(FakeTimelineTool([event])).generate(
        uuid.uuid4(),
        datetime(2026, 9, 17, 8, 0, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 0, tzinfo=UTC),
    )
    chain = RecordingChain()
    narrator = LangChainOpenAIReportNarrator(chain=chain, model_name="fake-model")

    narrator.generate(base)

    serialized = json.dumps(chain.facts)
    assert str(event.id) not in serialized
    assert "/media/test.jpg" not in serialized
    assert "trace" not in chain.facts


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
