"""Management tasks use the existing default queue, with durable DB state."""

from sqlalchemy import select

from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models.management import ManagementRun
from app.services.management.orchestrator import execute_run
from app.workers.celery_app import celery_app


@celery_app.task(
    name="management.analyze", acks_late=True, soft_time_limit=100, time_limit=110
)
def analyze_management_run(run_id: str):
    return execute_run(run_id)


@celery_app.task(name="management.reap_expired")
def reap_expired_runs():
    from app.api.v1.management import expire_run

    with SessionLocal() as db:
        rows = db.scalars(
            select(ManagementRun).where(
                ManagementRun.status.in_(["queued", "running"]),
                ManagementRun.lease_expires_at <= utcnow(),
            )
        ).all()
        for run in rows:
            expire_run(db, run)
        return {"expired": len(rows)}
