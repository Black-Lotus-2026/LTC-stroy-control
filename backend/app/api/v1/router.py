"""Сборка роутера версии v1.

Каждый ресурс живёт в своём модуле и подключается здесь одной строкой —
так видно весь состав API в одном месте.
"""

from fastapi import APIRouter

from app.api.v1 import (
    alerts,
    assignments,
    auth,
    camera_views,
    camera_workflow,
    collaboration,
    customer_control,
    customer_notifications,
    documents,
    health,
    incidents,
    live_demo,
    management,
    organizations,
    ppr_control,
    ppr_documents,
    projects,
    reports,
    safety,
    schedule,
    source_shares,
    videos,
    weather,
)

api_router = APIRouter()
api_router.include_router(customer_control.contexts_router)
api_router.include_router(customer_control.router)
api_router.include_router(customer_notifications.router)
api_router.include_router(organizations.router)
api_router.include_router(assignments.router)
api_router.include_router(source_shares.router)
api_router.include_router(collaboration.router)
api_router.include_router(auth.router)
api_router.include_router(alerts.router)
api_router.include_router(health.router)
api_router.include_router(reports.router)
api_router.include_router(projects.router)
api_router.include_router(weather.router)
api_router.include_router(documents.router)
api_router.include_router(camera_views.router)
api_router.include_router(camera_workflow.router)
api_router.include_router(ppr_documents.router)
api_router.include_router(ppr_documents.project_requirements_router)
api_router.include_router(schedule.router)
api_router.include_router(videos.router)
api_router.include_router(live_demo.router)
api_router.include_router(incidents.router)
api_router.include_router(management.router)

api_router.include_router(safety.router)

api_router.include_router(ppr_control.router)
