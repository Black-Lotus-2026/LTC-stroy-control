"""Single-agent генератор проверяемых отчётов по временной шкале.

Агент намеренно детерминированный: сейчас нет ключа LLM и реальных CV-логов,
поэтому он не выдумывает факты, а вызывает один инструмент выборки данных,
агрегирует записи и формирует объяснимый структурированный результат. Позже
шаблонный narrator можно заменить LLM, не меняя API и модель хранения.
"""

from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.models import ObservationCategory, ObservationLog, ObservationSeverity


@dataclass(frozen=True)
class TimelineEvent:
    id: uuid.UUID
    occurred_at: datetime
    source: str
    category: str
    event_type: str
    severity: str
    title: str
    description: str | None
    camera: str | None
    zone: str | None
    payload: dict


@dataclass(frozen=True)
class TimelineContext:
    project_name: str
    events: list[TimelineEvent]


@dataclass(frozen=True)
class AgentReport:
    title: str
    executive_summary: str
    content: dict
    source_log_count: int


class TimelineTool(Protocol):
    """Инструмент агента: отдаёт факты строго внутри запрошенного интервала."""

    def load(
        self, project_id: uuid.UUID, range_start: datetime, range_end: datetime
    ) -> TimelineContext: ...


class DatabaseTimelineTool:
    name = "timeline_search"

    def __init__(self, db: Session) -> None:
        self.db = db

    def load(
        self, project_id: uuid.UUID, range_start: datetime, range_end: datetime
    ) -> TimelineContext:
        from app.models import Project

        project = self.db.get(Project, project_id)
        project_name = project.name if project is not None else str(project_id)
        query = (
            select(ObservationLog)
            .where(
                ObservationLog.project_id == project_id,
                ObservationLog.occurred_at >= range_start,
                ObservationLog.occurred_at < range_end,
            )
            .options(
                joinedload(ObservationLog.camera),
                joinedload(ObservationLog.zone),
            )
            .order_by(ObservationLog.occurred_at.desc())
        )
        rows = self.db.scalars(query).all()
        events = [
            TimelineEvent(
                id=row.id,
                occurred_at=row.occurred_at,
                source=row.source.value,
                category=row.category.value,
                event_type=row.event_type,
                severity=row.severity.value,
                title=row.title,
                description=row.description,
                camera=row.camera.code if row.camera else None,
                zone=row.zone.code if row.zone else None,
                payload=row.payload,
            )
            for row in rows
        ]
        return TimelineContext(project_name=project_name, events=events)


class ConstructionReportAgent:
    """Один агент: получает интервал, вызывает timeline tool и строит сводку."""

    name = "construction-report-agent"
    version = "1.0"

    _section_definitions: tuple[tuple[str, str, set[str]], ...] = (
        ("camera_state", "Состояние камер", {"camera"}),
        ("confirmed_events", "Подтверждённые события", {"safety", "ppe"}),
        ("people_equipment", "Люди и техника", {"safety", "ppe", "equipment"}),
        ("observed_progress", "Наблюдаемый прогресс", {"progress"}),
        ("key_evidence", "Ключевые доказательства", set()),
        ("missing_data", "Недостающие данные", {"data"}),
    )

    def __init__(self, timeline_tool: TimelineTool) -> None:
        self.timeline_tool = timeline_tool

    def generate(
        self, project_id: uuid.UUID, range_start: datetime, range_end: datetime
    ) -> AgentReport:
        context = self.timeline_tool.load(project_id, range_start, range_end)
        events = context.events
        categories = Counter(event.category for event in events)
        critical = sum(
            event.severity == ObservationSeverity.CRITICAL.value for event in events
        )
        camera_issues = sum(
            event.category == ObservationCategory.CAMERA.value
            and event.severity != ObservationSeverity.INFO.value
            for event in events
        )
        confirmed = sum(event.payload.get("status") == "confirmed" for event in events)
        resolved = sum(event.payload.get("status") == "resolved" for event in events)

        sections = []
        for key, title, accepted_categories in self._section_definitions:
            if key == "key_evidence":
                selected = [e for e in events if e.payload.get("evidence_url")]
            elif key == "missing_data":
                selected = [
                    e
                    for e in events
                    if e.category in accepted_categories
                    or (
                        e.category == ObservationCategory.CAMERA.value
                        and e.severity != ObservationSeverity.INFO.value
                    )
                ]
            elif key == "confirmed_events":
                selected = [
                    e
                    for e in events
                    if e.category in accepted_categories
                    and e.payload.get("status")
                    in {"confirmed", "resolved", "in_progress"}
                ]
            else:
                selected = [e for e in events if e.category in accepted_categories]
            sections.append(
                {
                    "key": key,
                    "title": title,
                    "summary": self._section_summary(title, selected),
                    "items": [self._event_item(event) for event in selected[:20]],
                }
            )

        limitations = []
        if not events:
            limitations.append("За выбранный период журнал наблюдений пуст.")
        if camera_issues:
            limitations.append(
                "Зафиксировано проблем с доступностью или обзором камер: "
                f"{camera_issues}."
            )
        low_visibility = sum(_visibility_percent(event) < 60 for event in events)
        if low_visibility:
            limitations.append(
                f"Событий с видимостью ниже 60%: {low_visibility}; "
                "выводы требуют проверки."
            )

        title = f"Сводка по объекту «{context.project_name}»"
        summary = self._executive_summary(
            len(events), critical, camera_issues, confirmed, resolved, categories
        )
        return AgentReport(
            title=title,
            executive_summary=summary,
            source_log_count=len(events),
            content={
                "metrics": [
                    {"key": "events", "label": "События", "value": len(events)},
                    {
                        "key": "critical",
                        "label": "Критические",
                        "value": critical,
                    },
                    {
                        "key": "confirmed",
                        "label": "Подтверждено",
                        "value": confirmed,
                    },
                    {"key": "resolved", "label": "Устранено", "value": resolved},
                    {
                        "key": "camera_issues",
                        "label": "Проблемы камер",
                        "value": camera_issues,
                    },
                ],
                "sections": sections,
                "limitations": limitations,
                "trace": {
                    "agent": self.name,
                    "version": self.version,
                    "tools_used": ["timeline_search"],
                    "source_log_ids": [str(event.id) for event in events],
                    "range_start": range_start.isoformat(),
                    "range_end": range_end.isoformat(),
                },
            },
        )

    @staticmethod
    def _event_item(event: TimelineEvent) -> dict:
        return {
            "timestamp": event.occurred_at.isoformat(),
            "title": event.title,
            "details": event.description,
            "category": event.category,
            "severity": event.severity,
            "source": event.source,
            "camera": event.camera,
            "zone": event.zone,
            "evidence_url": event.payload.get("evidence_url"),
            "metadata": {
                "event_type": event.event_type,
                "confidence": event.payload.get("confidence"),
                "status": event.payload.get("status"),
                "visibility_percent": event.payload.get("visibility_percent"),
            },
        }

    @staticmethod
    def _section_summary(title: str, events: list[TimelineEvent]) -> str:
        if not events:
            return f"Раздел «{title}»: значимых записей за период нет."
        critical = sum(event.severity == "critical" for event in events)
        suffix = f", критических — {critical}" if critical else ""
        return f"Записей за период: {len(events)}{suffix}."

    @staticmethod
    def _executive_summary(
        total: int,
        critical: int,
        camera_issues: int,
        confirmed: int,
        resolved: int,
        categories: Counter[str],
    ) -> str:
        if total == 0:
            return "За выбранный период события не зарегистрированы."
        dominant = categories.most_common(1)[0][0]
        return (
            f"Обработано записей временной шкалы: {total}. "
            f"Критических событий: {critical}, подтверждено: {confirmed}, "
            f"устранено: {resolved}, проблем камер: {camera_issues}. "
            f"Наиболее частая категория: {dominant}."
        )


def _visibility_percent(event: TimelineEvent) -> int:
    value = event.payload.get("visibility_percent", 100)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 100
