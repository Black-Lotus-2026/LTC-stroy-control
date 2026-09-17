"""Сборка роутера версии v1.

Каждый ресурс живёт в своём модуле и подключается здесь одной строкой —
так видно весь состав API в одном месте.
"""

from fastapi import APIRouter

from app.api.v1 import cameras, health, incidents, meta, projects, users, zones

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(meta.router)
api_router.include_router(projects.router)
api_router.include_router(zones.router)
api_router.include_router(cameras.router)
api_router.include_router(incidents.router)
api_router.include_router(users.router)

# По мере реализации сюда подключаются: schedule, rules, frames, detections,
# progress, analytics, reports.
