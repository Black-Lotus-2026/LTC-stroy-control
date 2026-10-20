"""Сборка роутера версии v1.

Каждый ресурс живёт в своём модуле и подключается здесь одной строкой —
так видно весь состав API в одном месте.
"""

from fastapi import APIRouter

from app.api.v1 import (
    alerts,
    auth,
    documents,
    health,
    incidents,
    management,
    projects,
    reports,
    safety,
    schedule,
    videos,
    weather,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(alerts.router)
api_router.include_router(health.router)
api_router.include_router(reports.router)
api_router.include_router(projects.router)
api_router.include_router(weather.router)
api_router.include_router(documents.router)
api_router.include_router(schedule.router)
api_router.include_router(videos.router)
api_router.include_router(incidents.router)
api_router.include_router(management.router)

api_router.include_router(safety.router)
