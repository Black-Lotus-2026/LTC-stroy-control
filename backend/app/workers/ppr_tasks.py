"""Page analysis jobs with persisted leases and a recoverable DB outbox."""

import uuid

from app.db.session import SessionLocal
from app.models import PprAnalysis
from app.services.observation_basis import writable_project
from app.services.ppr_analysis import (
    LeaseLost,
    claim_analysis,
    pending_analysis_ids,
    process_analysis,
    safe_fail_analysis,
)
from app.workers.celery_app import celery_app


@celery_app.task(name="ppr.analyze", acks_late=True, reject_on_worker_lost=True)
def analyze_ppr_task(analysis_id):
    with SessionLocal() as db:
        ident = uuid.UUID(analysis_id)
        analysis = db.get(PprAnalysis, ident)
        if not analysis or not writable_project(db, analysis.project_id, lock=True):
            return {"status": "project_read_only"}
        token = claim_analysis(db, ident)
        if token is None:
            return {"status": "already_claimed"}
        try:
            return {"status": process_analysis(db, ident, token)}
        except LeaseLost:
            return {"status": "lease_lost"}
        except Exception as exc:
            safe_fail_analysis(db, ident, token, exc)
            return {"status": "FAILED"}


@celery_app.task(name="ppr.dispatch_pending")
def dispatch_pending_ppr_task():
    with SessionLocal() as db:
        identifiers = [
            identifier
            for identifier in pending_analysis_ids(db)
            if (analysis := db.get(PprAnalysis, identifier)) is not None
            and writable_project(db, analysis.project_id)
        ]
    published = 0
    for identifier in identifiers:
        try:
            analyze_ppr_task.delay(str(identifier))
            published += 1
        except Exception:
            # DB PENDING survives broker failure; next beat retries delivery.
            pass
    return {"published": published}
