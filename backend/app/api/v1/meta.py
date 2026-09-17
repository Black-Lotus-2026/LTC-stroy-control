"""Справочные данные для интерфейса.

Перечисления уезжают в API латиницей, а подписи для человека отдаются
отсюда: новый статус, добавленный в код бэкенда, появляется в интерфейсе
без правок фронтенда. Обоснование — docs/decisions/0006-api-contract.md
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.dictionaries import build_dictionaries

router = APIRouter(prefix="/meta", tags=["Справочные данные"])


class DictionaryValue(BaseModel):
    value: str = Field(description="То, что уходит в фильтры и хранится в базе")
    label: str = Field(description="Подпись для человека")


class Dictionary(BaseModel):
    title: str = Field(description="Название перечисления для интерфейса")
    values: list[DictionaryValue] = Field(
        description="В порядке отображения, а не объявления в коде"
    )


class DictionariesResponse(BaseModel):
    dictionaries: dict[str, Dictionary]


@router.get(
    "/dictionaries",
    response_model=DictionariesResponse,
    summary="Подписи значений перечислений",
)
def dictionaries() -> DictionariesResponse:
    return DictionariesResponse.model_validate(
        {"dictionaries": build_dictionaries()}
    )
