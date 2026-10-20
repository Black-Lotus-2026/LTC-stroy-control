"""Celery entry point for project document agent runs."""

import asyncio

from app.services.document_plan_agent import execute_document_run
from app.workers.celery_app import celery_app


@celery_app.task(name="documents.analyze_plan", acks_late=True)
def analyze_document_plan(run_id: str):
    return asyncio.run(execute_document_run(run_id))
