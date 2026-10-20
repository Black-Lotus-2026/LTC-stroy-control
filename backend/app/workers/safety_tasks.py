"""Link retained server observations once responsibility is configured."""

from app.db.session import SessionLocal
from app.services.observation_basis import link_pending_safety_events
from app.workers.celery_app import celery_app


@celery_app.task(name="safety.link_pending")
def link_pending_safety_events_task():
    with SessionLocal() as db:
        result = link_pending_safety_events(db)
        db.commit()
        return result
