"""Проверки разбора справочника видов работ.

Тесты идут по настоящему файлу организаторов, который лежит в репозитории:
обе особенности этого файла — коды, съеденные Excel, и строки без номера —
воспроизводятся только на нём, а синтетический пример их бы не поймал.
"""

from datetime import date, datetime
from pathlib import Path

import pytest

from app.services.work_catalog import (
    _restore_code_from_date,
    parse_work_catalog,
)

CATALOG_PATH = Path("data/work_catalog.xlsx")

pytestmark = pytest.mark.skipif(
    not CATALOG_PATH.exists(),
    reason="Справочник организаторов недоступен в этом окружении",
)


@pytest.fixture(scope="module")
def report():
    return parse_work_catalog(CATALOG_PATH)


def test_excel_date_is_converted_back_to_code() -> None:
    """Код «10.1.» сохранён в файле как 10 января — разворачиваем обратно."""
    assert _restore_code_from_date(datetime(2025, 1, 10)) == "10.1."
    assert _restore_code_from_date(date(2025, 3, 10)) == "10.3."
    assert _restore_code_from_date(date(2025, 1, 12)) == "12.1."


def test_all_rows_are_parsed(report) -> None:
    assert report.total == 377
    assert report.skipped_rows == 0


def test_damaged_codes_are_recovered(report) -> None:
    """В файле 19 кодов второго уровня превращены Excel в даты."""
    assert report.recovered_codes == 19
    recovered = [item for item in report.items if item.code_recovered_from_date]
    assert {item.code for item in recovered} >= {"10.1.", "10.2.", "12.1."}


def test_two_root_sections(report) -> None:
    roots = [item for item in report.items if item.parent_index is None]
    assert len(roots) == 2
    assert roots[0].name == "Подготовка территории"
    assert roots[1].name == "Выполнение строительно-монтажных работ"


def test_rows_without_code_become_children_of_previous_coded_row(report) -> None:
    """250 строк из 377 не имеют номера: иерархия восстанавливается по
    предыдущей пронумерованной строке, иначе они потеряли бы место в дереве."""
    assert report.rows_without_code == 250

    by_name = {item.name: item for item in report.items}
    child = by_name["Вынос сетей: теплосеть (ЦТП)"]
    assert child.code is None

    parent = report.items[child.parent_index]
    assert parent.code == "10.2."
    assert child.level == parent.level + 1


def test_every_item_except_roots_has_a_parent(report) -> None:
    orphans = [
        item
        for item in report.items
        if item.parent_index is None and item.level > 1
    ]
    assert orphans == []


def test_applicability_columns_are_read(report) -> None:
    """Колонки-галочки — это разметка «для каких типов объектов работа»."""
    first = report.items[0]
    assert "Жильё" in first.applicable_to
    assert "Дороги" in first.applicable_to
