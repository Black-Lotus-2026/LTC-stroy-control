"""Вспомогательные типы колонок."""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy import Enum as SAEnum


def enum_column(enum_cls: type[StrEnum]) -> SAEnum:
    """Колонка-перечисление: VARCHAR вместо нативного типа PostgreSQL.

    `values_callable` заставляет SQLAlchemy хранить значения (``"pending"``),
    а не имена членов (``"PENDING"``) — иначе то, что лежит в базе, не
    совпадало бы с тем, что уходит в JSON API.

    `validate_strings` включает проверку на стороне приложения: записать
    значение вне перечисления не получится. CHECK-ограничение в базе
    намеренно не создаётся — иначе каждый новый статус требовал бы миграции,
    ради которой это решение и принималось.
    """
    return SAEnum(
        enum_cls,
        native_enum=False,
        length=32,
        values_callable=lambda e: [member.value for member in e],
        validate_strings=True,
    )
