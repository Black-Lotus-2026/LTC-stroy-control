"""Постраничная выборка.

Один помощник на все списочные ручки: иначе счёт записей и срез страницы
пишутся в каждой заново, и рано или поздно где-то разъезжаются.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session


def paginate(
    db: Session, stmt: Select, *, page: int, page_size: int
) -> tuple[list[Any], int]:
    """Вернуть строки запрошенной страницы и общее число записей.

    Счёт делается по тому же запросу, обёрнутому в подзапрос: так любые
    фильтры и соединения учитываются автоматически, и счётчик не может
    разойтись с выдачей. `order_by(None)` перед счётом обязателен —
    PostgreSQL отвергает сортировку по колонке, не входящей в SELECT
    агрегата.
    """
    total = db.scalar(
        select(func.count()).select_from(stmt.order_by(None).subquery())
    )
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size))
    return list(rows.scalars().unique().all()), int(total or 0)
