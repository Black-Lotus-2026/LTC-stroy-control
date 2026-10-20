"""Approved, append-only project SLA policy. Unknown legacy dates stay unknown."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models.customer_control import ProjectDeadlinePolicy


def policy_at(db, project_id, at=None):
    return db.scalar(
        select(ProjectDeadlinePolicy)
        .where(
            ProjectDeadlinePolicy.project_id == project_id,
            ProjectDeadlinePolicy.effective_from <= (at or datetime.now(UTC)),
        )
        .order_by(ProjectDeadlinePolicy.version.desc())
    )


def apply_detection_deadline(db, incident):
    if incident.workflow_version != 2:
        return
    now = incident.detected_at or datetime.now(UTC)
    incident.detected_at = now
    policy = policy_at(db, incident.project_id, now)
    if policy and incident.reaction_due_at is None:
        incident.reaction_due_at = now + timedelta(minutes=policy.reaction_minutes)
