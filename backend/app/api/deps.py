"""Общие зависимости HTTP-слоя.

Псевдонимы через Annotated вместо `Depends(...)` в значениях по умолчанию:
так тип аргумента остаётся честным, а обработчик читается как обычная функция.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from app.db.session import get_db

DbSession = Annotated[Session, Depends(get_db)]

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


@dataclass(frozen=True)
class PageRequest:
    """Запрошенная страница списка."""

    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def page_request(
    page: Annotated[int, Query(ge=1, description="Номер страницы, начиная с 1")] = 1,
    page_size: Annotated[
        int, Query(ge=1, le=MAX_PAGE_SIZE, description="Записей на странице")
    ] = DEFAULT_PAGE_SIZE,
) -> PageRequest:
    return PageRequest(page=page, page_size=page_size)


PageParams = Annotated[PageRequest, Depends(page_request)]
