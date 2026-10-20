"""A selected-assignment inbox merges existing durable notification stores."""

import uuid

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models import Incident
from app.models.alert import AlertNotification
from app.models.customer_control import AuditEvent, NotificationOutbox, ProjectRole
from app.schemas.customer_control import NotificationDTO
from app.services.access_policy import incident_query, resolve_context
from app.services.customer_notifications import (
    alert_event_type,
    audit_visible,
    event_case,
)
from app.services.incident_workflow import aware

router = APIRouter(prefix="/customer-control", tags=["Уведомления"])


@router.get("/projects/{project_id}/notifications", response_model=list[NotificationDTO])
def notifications(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    limit: int = Query(50, ge=1, le=100),
):
    ctx = resolve_context(db, project_id, user)
    if ctx.is_demo:
        return []
    result = []
    if ctx.role in {ProjectRole.CUSTOMER_MANAGER, ProjectRole.CONTRACTOR_FOREMAN}:
        # Scope the resource before applying the limit, including legacy alerts.
        query = (
            select(AlertNotification)
            .join(
                Incident,
                Incident.id == AlertNotification.incident_id,
            )
            .where(
                AlertNotification.recipient_user_id == user.id,
                Incident.id.in_(incident_query(db, ctx).with_only_columns(Incident.id)),
            )
        )
        if ctx.role == ProjectRole.CONTRACTOR_FOREMAN:
            query = query.where(
                Incident.assignee_assignment_id == ctx.assignment.id,
                AlertNotification.kind != "candidate_review",
                ~AlertNotification.kind.startswith("reaction_overdue_"),
                ~AlertNotification.kind.startswith("review_overdue_"),
            )
        alerts = db.scalars(
            query.order_by(AlertNotification.created_at.desc()).limit(limit)
        )
        for row in alerts:
            result.append(
                NotificationDTO(
                    id=row.id,
                    event_type=alert_event_type(row.kind),
                    resource_id=row.incident_id,
                    incident_id=row.incident_id,
                    occurred_at=aware(row.created_at),
                    source="alert",
                    title=row.title,
                )
            )
    rows = db.execute(
        select(NotificationOutbox, AuditEvent)
        .join(
            AuditEvent,
            AuditEvent.id == NotificationOutbox.audit_id,
        )
        .where(
            NotificationOutbox.assignment_id == ctx.assignment.id,
            AuditEvent.project_id == project_id,
        )
        .order_by(AuditEvent.occurred_at.desc())
    )
    for notice, event in rows:
        if not audit_visible(db, ctx, event):
            continue
        case = event_case(db, event)
        result.append(
            NotificationDTO(
                id=notice.id,
                event_type=event.event_type,
                resource_id=event.resource_id,
                incident_id=case.id if case else None,
                occurred_at=aware(event.occurred_at),
                source="workflow",
                title="",
            )
        )
    return sorted(result, key=lambda row: (row.occurred_at, str(row.id)), reverse=True)[
        :limit
    ]
