"""Служебные ручки состояния сервиса.

Нужны не для интерфейса, а для проверки, что развёрнутая система жива
целиком: API, база, брокер. Первое, что стоит открыть после запуска.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from app.api.deps import DbSession
from app.core.config import settings
from app.workers.celery_app import celery_app

router = APIRouter(tags=["Служебные"])


class HealthResponse(BaseModel):
    status: str
    app: str
    environment: str


class ReadinessResponse(BaseModel):
    status: str
    database: str
    broker: str


@router.get("/health", response_model=HealthResponse, summary="Жив ли процесс API")
def health() -> HealthResponse:
    return HealthResponse(
        status="ok", app=settings.app_name, environment=settings.environment
    )


@router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Доступны ли база и брокер",
)
def ready(db: DbSession) -> ReadinessResponse:
    try:
        db.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # noqa: BLE001 - наружу отдаём причину, а не падаем
        database = f"error: {exc.__class__.__name__}"

    try:
        # ping() опрашивает живых воркеров; пустой ответ означает, что брокер
        # доступен, но ни один воркер не подключён.
        replies = celery_app.control.ping(timeout=0.5)
        broker = "ok" if replies else "no workers"
    except Exception as exc:  # noqa: BLE001
        broker = f"error: {exc.__class__.__name__}"

    status = "ok" if database == "ok" and broker == "ok" else "degraded"
    return ReadinessResponse(status=status, database=database, broker=broker)
