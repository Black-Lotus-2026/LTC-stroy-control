"""Схемы, общие для всего API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorDetail(BaseModel):
    code: str = Field(description="Машинный код ошибки, например INCIDENT_NOT_FOUND")
    message: str = Field(description="Человекочитаемое описание для интерфейса")
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """Единый формат ошибок API. Фронтенд разбирает только `error.code`."""

    error: ErrorDetail


class Pagination(BaseModel):
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=200)
    total: int = Field(ge=0)


class Page[T](BaseModel):
    """Страница списка. Все списочные ручки возвращают такой конверт.

    Голый массив в корне запрещён намеренно: добавить к нему счётчик
    потом можно только сломав всех, кто уже разобрал ответ.
    См. docs/decisions/0006-api-contract.md
    """

    items: list[T]
    pagination: Pagination

    @classmethod
    def of(cls, items: list[T], total: int, *, page: int, page_size: int) -> Page[T]:
        return cls(
            items=items,
            pagination=Pagination(page=page, page_size=page_size, total=total),
        )


# Описание ответа с ошибкой для OpenAPI. Подставляется в `responses` ручек,
# чтобы в схеме было видно: у ошибок тот же формат, что у всего остального.
ResponseSpec = dict[int | str, dict[str, Any]]

NOT_FOUND_RESPONSE: ResponseSpec = {
    404: {"model": ErrorResponse, "description": "Не найдено"}
}
CONFLICT_RESPONSE: ResponseSpec = {
    409: {"model": ErrorResponse, "description": "Конфликт состояния"}
}
VALIDATION_RESPONSE: ResponseSpec = {
    422: {"model": ErrorResponse, "description": "Некорректные параметры"}
}
