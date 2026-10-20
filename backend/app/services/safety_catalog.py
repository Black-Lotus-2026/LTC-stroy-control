"""Reviewed public catalogue snapshot, 2026-10-19. No automatic fine assignment."""

from sqlalchemy.orm import Session

from app.models.safety import SafetyDocument, SafetyRequirement, SafetySanction

DOCUMENTS = [
    dict(
        id="pot_883n",
        code="Приказ Минтруда России от 11.12.2020 № 883н",
        title="Правила по охране труда при строительстве, реконструкции и ремонте",
        url="https://www.consultant.ru/document/cons_doc_LAW_372506/",
        effective_from="2021-01-01",
        effective_to="2031-09-01",
        verified_at="2026-10-19",
        edition="29.04.2025",
        applicability_note=(
            "Срок продлён приказом № 287н. Применимость к работам и документам "
            "площадки подтверждает ответственный."
        ),
    ),
    dict(
        id="gost_124026",
        code="ГОСТ 12.4.026-2015",
        title="Цвета сигнальные, знаки безопасности и разметка сигнальная",
        url="https://protect.gost.ru/gost/details/48ce1502-aaad-40f9-a4c3-97f418febc92",
        effective_from="2017-03-01",
        effective_to=None,
        verified_at="2026-10-19",
        edition="Каталог Росстандарта, проверка 19.10.2026",
        applicability_note=(
            "Знаки не устанавливают запрет сами по себе. Есть поправка ИУС 10-2026; "
            "её содержание не подтверждено. Актуальность и применимость проверяет "
            "ответственный."
        ),
    ),
]
REQUIREMENTS = [
    dict(
        id="danger_zone",
        document_id="pot_883n",
        scenario="worker_danger_zone",
        clause="пп. 9–13",
        summary=(
            "Опасные зоны учитываются по организационно-технологической "
            "документации; на границах предусматриваются ограждения и знаки."
        ),
        applicability_note=(
            "Нужен утверждённый документ зоны и режим допуска. Присутствие человека "
            "само по себе не доказывает нарушение."
        ),
    ),
    dict(
        id="passage",
        document_id="pot_883n",
        scenario="vehicle_blocks_passage",
        clause="п. 9; п. 41",
        summary=(
            "Организация работ по документации; проходы не загромождаются "
            "складируемыми материалами и конструкциями."
        ),
        applicability_note=(
            "Пункт 41 не устанавливает универсальный запрет остановки техники. "
            "Возможная блокировка техникой проверяется по утверждённой схеме и "
            "локальному правилу вручную."
        ),
    ),
    dict(
        id="restricted_vehicle",
        document_id="pot_883n",
        scenario="vehicle_restricted_zone",
        clause="пп. 9, 38–39",
        summary=(
            "Схемы движения размещаются у въезда; дороги оснащаются знаками, "
            "регулирующими движение транспорта и строительных машин."
        ),
        applicability_note=(
            "Запрет для класса техники должен следовать из утверждённой схемы, знака "
            "или ППР. Полигон сам запрет не создаёт."
        ),
    ),
    dict(
        id="sign_p03",
        document_id="gost_124026",
        scenario="worker_danger_zone",
        clause="Приложение Е, таблица Е.1, P03",
        summary="Знак «Проход запрещён».",
        applicability_note=(
            "Справочное обозначение. Не доказывает наличие знака в кадре и не задаёт "
            "режим допуска."
        ),
    ),
    dict(
        id="sign_p12",
        document_id="gost_124026",
        scenario="vehicle_blocks_passage",
        clause="Приложение Е, таблица Е.1, P12",
        summary="Знак «Запрещается загромождать проходы и/или складировать».",
        applicability_note=(
            "Справочное обозначение. Требуется утверждённый проход и ручная проверка "
            "фактической блокировки."
        ),
    ),
]
CONDITIONS = (
    "Возможно предупреждение. Санкция применима только при "
    "установленном нарушении государственных требований охраны труда и "
    "составе правонарушения, кроме случаев ч. 2–4 ст. 5.27.1 и ч. 3 "
    "ст. 11.23. Ответственность устанавливает уполномоченный орган. "
    "Камера и локальный запрет сами по себе состав не доказывают."
)
SANCTIONS = [
    dict(
        id=f"koap_5271_1_{key}",
        code="КоАП РФ, ст. 5.27.1 ч. 1",
        title="Нарушение государственных нормативных требований охраны труда",
        url="https://www.consultant.ru/document/cons_doc_LAW_34661/88755cc3b9fd053aebba33b58078eb459aa5a1d8/",
        subject=subject,
        min_amount=low,
        max_amount=high,
        currency="RUB",
        conditions=CONDITIONS,
        verified_at="2026-10-19",
    )
    for key, subject, low, high in [
        ("official", "Должностное лицо", 2000, 5000),
        ("entrepreneur", "ИП", 2000, 5000),
        ("legal", "Юридическое лицо", 50000, 80000),
    ]
]


def seed_catalog(db: Session):
    for model, rows in [
        (SafetyDocument, DOCUMENTS),
        (SafetyRequirement, REQUIREMENTS),
        (SafetySanction, SANCTIONS),
    ]:
        for row in rows:
            if db.get(model, row["id"]) is None:
                values = dict(id=row["id"], data=row)
                if model is SafetyRequirement:
                    values.update(
                        document_id=row["document_id"], scenario=row["scenario"]
                    )
                db.add(model(**values))
    db.flush()


def catalog(db):
    return dict(
        documents=[v.data for v in db.query(SafetyDocument).order_by(SafetyDocument.id)],
        requirements=[
            v.data for v in db.query(SafetyRequirement).order_by(SafetyRequirement.id)
        ],
        sanctions=[v.data for v in db.query(SafetySanction).order_by(SafetySanction.id)],
    )
