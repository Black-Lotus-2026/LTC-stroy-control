"""Точка входа HTTP-приложения.

Запуск: uvicorn app.main:app --reload
Документация API: http://localhost:8000/docs
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.errors import register_exception_handlers
from app.core.logging import setup_logging
from app.storage import get_storage

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    setup_logging(logging.DEBUG if settings.debug else logging.INFO)
    logger.info("Запуск %s (окружение: %s)", settings.app_name, settings.environment)

    yield

    logger.info("Остановка %s", settings.app_name)


app = FastAPI(
    title=settings.app_name,
    description=(
        "Сервис поиска отклонений на строительных площадках: сопоставление "
        "техники, обнаруженной на кадрах с камер, с календарным планом работ."
    ),
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)
app.include_router(api_router, prefix=settings.api_v1_prefix)

# Кадры и доказательства отдаются как статика
if settings.storage_backend == "local":
    get_storage()
    app.mount(
        "/media",
        StaticFiles(directory=settings.storage_local_root),
        name="media",
    )


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": settings.app_name,
        "docs": "/docs",
        "health": f"{settings.api_v1_prefix}/health",
    }
