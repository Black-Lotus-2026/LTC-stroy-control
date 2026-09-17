"""Проверки модели данных, не требующие базы.

Ловят самые дорогие ошибки: потерянную модель (её таблица просто не попадёт
в миграцию) и расхождение значений перечислений с тем, что ожидает фронтенд.
"""

from app.db.base import Base
from app.models import IncidentStatus, ObjectCategory, PPEStatus

EXPECTED_TABLES = {
    "projects",
    "project_settings",
    "zones",
    "cameras",
    "camera_health_events",
    "object_classes",
    "work_types",
    "schedule_tasks",
    "rule_sets",
    "work_requirements",
    "cost_rates",
    "frames",
    "analysis_runs",
    "detections",
    "incidents",
    "incident_events",
    "incident_evidence",
    "users",
    "observation_logs",
    "report_schedules",
    "generated_reports",
}


def test_all_models_registered() -> None:
    """Модель, забытая в app/models/__init__.py, молча выпадает из миграций."""
    assert set(Base.metadata.tables) >= EXPECTED_TABLES


def test_incident_has_dedup_and_explanation() -> None:
    """Два поля, без которых система теряет смысл: склейка повторов и
    объяснение вывода."""
    columns = Base.metadata.tables["incidents"].columns
    assert "dedup_key" in columns
    assert "explanation" in columns


def test_enum_values_are_lowercase_strings() -> None:
    """В API уходят значения, а не имена членов перечисления."""
    assert IncidentStatus.PENDING.value == "pending"
    assert ObjectCategory.EQUIPMENT.value == "equipment"


def test_ppe_status_is_three_valued() -> None:
    """«Каска не видна» и «каски нет» обязаны различаться."""
    assert {s.value for s in PPEStatus} == {"present", "not_visible", "absent"}


def test_report_keeps_agent_trace_and_source_range() -> None:
    columns = Base.metadata.tables["generated_reports"].columns
    assert {"range_start", "range_end", "content", "agent_version"} <= set(columns.keys())
