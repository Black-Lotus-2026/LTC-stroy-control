"""Подписи значений перечислений.

Забытая подпись не роняет ничего: в интерфейсе просто появляется голое
`equipment_insufficient`, и замечает это зритель демонстрации. Поэтому
проверка здесь.
"""

from app.models.enums import IncidentStatus
from app.services.dictionaries import build_dictionaries, missing_labels


def test_every_enum_value_has_a_label() -> None:
    gaps = missing_labels()
    assert gaps == {}, f"без подписи остались значения: {gaps}"


def test_priorities_are_ordered_by_severity() -> None:
    """Порядок значений в словаре — это порядок отображения. Приоритеты
    сортируются по важности, а не по тому, как объявлены в коде."""
    values = [v["value"] for v in build_dictionaries()["incident_priority"]["values"]]
    assert values == ["critical", "high", "medium", "low"]


def test_labels_cover_all_statuses() -> None:
    values = {v["value"] for v in build_dictionaries()["incident_status"]["values"]}
    assert values == {status.value for status in IncidentStatus}
