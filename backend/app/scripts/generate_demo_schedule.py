"""Generate standard reference demo schedule for 'Многоквартирный жилой дом'.

Generates data/demo_schedule_single_object.xlsx with realistic sequential
construction stages, planned start/end dates, durations, and matching catalog items.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from openpyxl import Workbook


def generate_demo_schedule(output_path: Path | None = None) -> Path:
    """Generate Excel schedule file with 9 sequential stages."""
    if output_path is None:
        # Default locations to search/create
        candidates = [
            Path("/app/data/demo_schedule_single_object.xlsx"),
            Path(__file__).resolve().parents[2] / "data" / "demo_schedule_single_object.xlsx",
            Path(__file__).resolve().parents[3] / "data" / "demo_schedule_single_object.xlsx",
            Path("data/demo_schedule_single_object.xlsx"),
        ]
        for c in candidates:
            if c.parent.exists():
                output_path = c
                break
        if output_path is None:
            output_path = Path("data/demo_schedule_single_object.xlsx")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    base_date = date(2026, 4, 18)

    stages_data = [
        {
            "order_index": 1,
            "name": "Подготовка территории и площадки строительства",
            "duration_days": 14,
            "matched_catalog_name": "Подготовка территории",
            "primary_machinery": "Каток, Погрузчик",
        },
        {
            "order_index": 2,
            "name": "Выемка грунта котлована под фундамент",
            "duration_days": 21,
            "matched_catalog_name": "Выемка грунта котлована",
            "primary_machinery": "Экскаватор, Самосвал, Бульдозер",
        },
        {
            "order_index": 3,
            "name": "Устройство бетонной подготовки и фундаментной плиты",
            "duration_days": 25,
            "matched_catalog_name": "Устройство фундаментов",
            "primary_machinery": "Автобетоносмеситель, Автокран",
        },
        {
            "order_index": 4,
            "name": "Устройство монолитных конструкций подземной части",
            "duration_days": 30,
            "matched_catalog_name": "Монтаж сборных железобетонных конструкций",
            "primary_machinery": "Башенный кран, Автобетоносмеситель",
        },
        {
            "order_index": 5,
            "name": "Возведение монолитного каркаса 1-9 этажей",
            "duration_days": 60,
            "matched_catalog_name": "Возведение монолитных конструкций",
            "primary_machinery": "Башенный кран, Автобетоносмеситель",
        },
        {
            "order_index": 6,
            "name": "Кладка наружных стен и внутренних перегородок",
            "duration_days": 40,
            "matched_catalog_name": "Каменные работы",
            "primary_machinery": "Башенный кран, Погрузчик",
        },
        {
            "order_index": 7,
            "name": "Монтаж кровли и гидроизоляция",
            "duration_days": 25,
            "matched_catalog_name": "Устройство кровли",
            "primary_machinery": "Башенный кран, Автокран",
        },
        {
            "order_index": 8,
            "name": "Фасадные работы и монтаж оконных блоков",
            "duration_days": 35,
            "matched_catalog_name": "Фасадные работы",
            "primary_machinery": "Автокран, Погрузчик",
        },
        {
            "order_index": 9,
            "name": "Благоустройство прилегающей территории и проездов",
            "duration_days": 20,
            "matched_catalog_name": "Благоустройство территории",
            "primary_machinery": "Автогрейдер, Каток, Самосвал",
        },
    ]

    current_start = base_date
    rows = []

    for stage in stages_data:
        duration = stage["duration_days"]
        current_end = current_start + timedelta(days=duration - 1)
        rows.append(
            {
                "№ п/п": stage["order_index"],
                "Наименование этапа": stage["name"],
                "Дата начала": current_start.isoformat(),
                "Дата окончания": current_end.isoformat(),
                "Длительность (дней)": duration,
                "Эталонный вид работ (справочник)": stage["matched_catalog_name"],
                "Характерная спецтехника": stage["primary_machinery"],
            }
        )
        current_start = current_end + timedelta(days=1)

    wb = Workbook()
    ws = wb.active
    ws.title = "График работ"
    headers = list(rows[0].keys())
    ws.append(headers)
    for r in rows:
        ws.append([r[h] for h in headers])
    wb.save(output_path)
    print(f"Demo schedule created successfully at: {output_path}")
    return output_path


if __name__ == "__main__":
    generate_demo_schedule()
