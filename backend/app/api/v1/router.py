"""Сборка роутера версии v1.

Каждый ресурс живёт в своём модуле и подключается здесь одной строкой —
так видно весь состав API в одном месте.
"""

from fastapi import APIRouter

from app.api.v1 import health

api_router = APIRouter()
api_router.include_router(health.router)

# По мере реализации сюда подключаются: projects, zones, cameras, schedule,
# rules, frames, detections, incidents, progress, analytics, reports.
