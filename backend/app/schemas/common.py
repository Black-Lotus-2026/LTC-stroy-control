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
    """Страница списка. Все списочные ручки возвращают такой конверт."""

    items: list[T]
    pagination: Pagination
