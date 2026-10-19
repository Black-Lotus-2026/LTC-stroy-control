"""Versioned safety catalogue, camera zones, durable evidence and human review.

Revision ID: 20261019_1600
Revises: 20261016_1300
"""

import sqlalchemy as sa

from alembic import op

revision = "20261019_1600"
down_revision = "20261016_1300"
branch_labels = None
depends_on = None

# Frozen seed: future catalogue edits must use a new migration.
DOCUMENTS = [
    {
        "id": "pot_883n",
        "code": "Приказ Минтруда России от 11.12.2020 № 883н",
        "title": "Правила по охране труда при строительстве, " "реконструкции и ремонте",
        "url": "https://www.consultant.ru/document/cons_doc_LAW_372506/",
        "effective_from": "2021-01-01",
        "effective_to": "2031-09-01",
        "verified_at": "2026-10-19",
        "edition": "29.04.2025",
        "applicability_note": "Срок продлён приказом № 287н. "
        "Применимость к работам и документам "
        "площадки подтверждает ответственный.",
    },
    {
        "id": "gost_124026",
        "code": "ГОСТ 12.4.026-2015",
        "title": "Цвета сигнальные, знаки безопасности и разметка " "сигнальная",
        "url": "https://protect.gost.ru/gost/details/48ce1502-aaad-40f9-a4c3-97f418febc92",
        "effective_from": "2017-03-01",
        "effective_to": None,
        "verified_at": "2026-10-19",
        "edition": "Каталог Росстандарта, проверка 19.10.2026",
        "applicability_note": "Знаки не устанавливают запрет сами по "
        "себе. Есть поправка ИУС 10-2026; её "
        "содержание не подтверждено. "
        "Актуальность и применимость проверяет "
        "ответственный.",
    },
]

REQUIREMENTS = [
    {
        "id": "danger_zone",
        "document_id": "pot_883n",
        "scenario": "worker_danger_zone",
        "clause": "пп. 9–13",
        "summary": "Опасные зоны учитываются по "
        "организационно-технологической документации; на "
        "границах предусматриваются ограждения и знаки.",
        "applicability_note": "Нужен утверждённый документ зоны и "
        "режим допуска. Присутствие человека "
        "само по себе не доказывает нарушение.",
    },
    {
        "id": "passage",
        "document_id": "pot_883n",
        "scenario": "vehicle_blocks_passage",
        "clause": "п. 9; п. 41",
        "summary": "Организация работ по документации; проходы не "
        "загромождаются складируемыми материалами и "
        "конструкциями.",
        "applicability_note": "Пункт 41 не устанавливает "
        "универсальный запрет остановки "
        "техники. Возможная блокировка техникой "
        "проверяется по утверждённой схеме и "
        "локальному правилу вручную.",
    },
    {
        "id": "restricted_vehicle",
        "document_id": "pot_883n",
        "scenario": "vehicle_restricted_zone",
        "clause": "пп. 9, 38–39",
        "summary": "Схемы движения размещаются у въезда; дороги "
        "оснащаются знаками, регулирующими движение "
        "транспорта и строительных машин.",
        "applicability_note": "Запрет для класса техники должен "
        "следовать из утверждённой схемы, знака "
        "или ППР. Полигон сам запрет не "
        "создаёт.",
    },
    {
        "id": "sign_p03",
        "document_id": "gost_124026",
        "scenario": "worker_danger_zone",
        "clause": "Приложение Е, таблица Е.1, P03",
        "summary": "Знак «Проход запрещён».",
        "applicability_note": "Справочное обозначение. Не доказывает "
        "наличие знака в кадре и не задаёт "
        "режим допуска.",
    },
    {
        "id": "sign_p12",
        "document_id": "gost_124026",
        "scenario": "vehicle_blocks_passage",
        "clause": "Приложение Е, таблица Е.1, P12",
        "summary": "Знак «Запрещается загромождать проходы и/или " "складировать».",
        "applicability_note": "Справочное обозначение. Требуется "
        "утверждённый проход и ручная проверка "
        "фактической блокировки.",
    },
]

SANCTIONS = [
    {
        "id": "koap_5271_1_official",
        "code": "КоАП РФ, ст. 5.27.1 ч. 1",
        "title": "Нарушение государственных нормативных требований " "охраны труда",
        "url": "https://www.consultant.ru/document/cons_doc_LAW_34661/88755cc3b9fd053aebba33b58078eb459aa5a1d8/",
        "subject": "Должностное лицо",
        "min_amount": 2000,
        "max_amount": 5000,
        "currency": "RUB",
        "conditions": "Возможно предупреждение. Санкция применима "
        "только при установленном нарушении "
        "государственных требований охраны труда и "
        "составе правонарушения, кроме случаев ч. 2–4 "
        "ст. 5.27.1 и ч. 3 ст. 11.23. Ответственность "
        "устанавливает уполномоченный орган. Камера и "
        "локальный запрет сами по себе состав не "
        "доказывают.",
        "verified_at": "2026-10-19",
    },
    {
        "id": "koap_5271_1_entrepreneur",
        "code": "КоАП РФ, ст. 5.27.1 ч. 1",
        "title": "Нарушение государственных нормативных требований " "охраны труда",
        "url": "https://www.consultant.ru/document/cons_doc_LAW_34661/88755cc3b9fd053aebba33b58078eb459aa5a1d8/",
        "subject": "ИП",
        "min_amount": 2000,
        "max_amount": 5000,
        "currency": "RUB",
        "conditions": "Возможно предупреждение. Санкция применима "
        "только при установленном нарушении "
        "государственных требований охраны труда и "
        "составе правонарушения, кроме случаев ч. 2–4 "
        "ст. 5.27.1 и ч. 3 ст. 11.23. Ответственность "
        "устанавливает уполномоченный орган. Камера и "
        "локальный запрет сами по себе состав не "
        "доказывают.",
        "verified_at": "2026-10-19",
    },
    {
        "id": "koap_5271_1_legal",
        "code": "КоАП РФ, ст. 5.27.1 ч. 1",
        "title": "Нарушение государственных нормативных требований " "охраны труда",
        "url": "https://www.consultant.ru/document/cons_doc_LAW_34661/88755cc3b9fd053aebba33b58078eb459aa5a1d8/",
        "subject": "Юридическое лицо",
        "min_amount": 50000,
        "max_amount": 80000,
        "currency": "RUB",
        "conditions": "Возможно предупреждение. Санкция применима "
        "только при установленном нарушении "
        "государственных требований охраны труда и "
        "составе правонарушения, кроме случаев ч. 2–4 "
        "ст. 5.27.1 и ч. 3 ст. 11.23. Ответственность "
        "устанавливает уполномоченный орган. Камера и "
        "локальный запрет сами по себе состав не "
        "доказывают.",
        "verified_at": "2026-10-19",
    },
]


def upgrade():
    # Explicit immutable migration schema; no dependence on future ORM model changes.
    for name in ["safety_documents", "safety_sanctions"]:
        op.create_table(
            name,
            sa.Column("id", sa.String(80), primary_key=True),
            sa.Column("data", sa.JSON(), nullable=False),
        )
    op.create_table(
        "safety_requirements",
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column(
            "document_id",
            sa.String(80),
            sa.ForeignKey("safety_documents.id"),
            nullable=False,
        ),
        sa.Column("scenario", sa.String(50), nullable=False, index=True),
        sa.Column("data", sa.JSON(), nullable=False),
    )
    op.create_table(
        "safety_zones",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "camera_id",
            sa.UUID(),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("scenario", sa.String(50), nullable=False),
        sa.Column("polygon", sa.JSON(), nullable=False),
        sa.Column("site_basis", sa.Text(), nullable=False),
        sa.Column(
            "responsible_user_id", sa.UUID(), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("min_duration_seconds", sa.Float(), nullable=False),
        sa.Column("confidence_threshold", sa.Float(), nullable=False),
        sa.Column("allowed_classes", sa.JSON(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=False),
    )
    op.create_table(
        "safety_tracks",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "zone_id",
            sa.UUID(),
            sa.ForeignKey("safety_zones.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("touched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("first_jpeg", sa.LargeBinary(), nullable=True),
        sa.UniqueConstraint("zone_id", "source_id"),
    )
    op.create_table(
        "safety_frame_receipts",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "zone_id",
            sa.UUID(),
            sa.ForeignKey("safety_zones.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("image_sha256", sa.String(64), nullable=False),
        sa.Column("position_ms", sa.BigInteger(), nullable=False),
        sa.UniqueConstraint("zone_id", "source_id", "image_sha256"),
    )
    op.create_table(
        "safety_events",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            sa.UUID(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "camera_id",
            sa.UUID(),
            sa.ForeignKey("cameras.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "zone_id",
            sa.UUID(),
            sa.ForeignKey("safety_zones.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("scenario", sa.String(50), nullable=False),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("first_position_ms", sa.BigInteger(), nullable=False),
        sa.Column("last_position_ms", sa.BigInteger(), nullable=False),
        sa.Column("model_sha256", sa.String(64), nullable=False),
        sa.Column("evidence_sha256", sa.String(64), nullable=False),
        sa.Column("evidence_jpeg", sa.LargeBinary(), nullable=False),
        sa.Column("first_evidence_jpeg", sa.LargeBinary(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("reviewed_by", sa.UUID(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_comment", sa.Text(), nullable=True),
    )
    for table, rows in [
        ("safety_documents", DOCUMENTS),
        ("safety_requirements", REQUIREMENTS),
        ("safety_sanctions", SANCTIONS),
    ]:
        columns = [sa.column("id", sa.String), sa.column("data", sa.JSON)]
        if table == "safety_requirements":
            columns.extend(
                [sa.column("document_id", sa.String), sa.column("scenario", sa.String)]
            )
        records = [
            dict(
                id=r["id"],
                data=r,
                **(
                    {"document_id": r["document_id"], "scenario": r["scenario"]}
                    if table == "safety_requirements"
                    else {}
                ),
            )
            for r in rows
        ]
        op.bulk_insert(sa.table(table, *columns), records)


def downgrade():
    for table in [
        "safety_events",
        "safety_frame_receipts",
        "safety_tracks",
        "safety_zones",
        "safety_requirements",
        "safety_sanctions",
        "safety_documents",
    ]:
        op.drop_table(table)
