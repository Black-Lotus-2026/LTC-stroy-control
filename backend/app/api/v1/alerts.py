"""Authenticated notification inbox."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.alert import AlertNotification
from app.models.incident import Incident
from app.schemas.alert import AlertNotificationItem

router = APIRouter(prefix="/alerts", tags=["Алерты"])


def _item(notification: AlertNotification, incident: Incident) -> AlertNotificationItem:
    return AlertNotificationItem(
        id=notification.id,
        incident_id=notification.incident_id,
        project_id=incident.project_id,
        incident_code=incident.code,
        incident_status=incident.status.value,
        assignee_name=incident.assignee.name if incident.assignee else None,
        sla_deadline=incident.sla_deadline,
        verification_status=incident.verification_status,
        escalated_at=incident.escalated_at,
        kind=notification.kind,
        title=notification.title,
        body=notification.body,
        created_at=notification.created_at,
        read_at=notification.read_at,
        email_status=notification.email_status,
    )


@router.get("", response_model=list[AlertNotificationItem])
def list_alerts(
    db: DbSession, current_user: CurrentUser, limit: int = Query(50, ge=1, le=100)
) -> list[AlertNotificationItem]:
    rows = db.execute(
        select(AlertNotification, Incident)
        .join(Incident, Incident.id == AlertNotification.incident_id)
        .where(AlertNotification.recipient_user_id == current_user.id)
        .order_by(AlertNotification.created_at.desc())
        .limit(limit)
    ).all()
    return [_item(notification, incident) for notification, incident in rows]


@router.patch("/{alert_id}/read", response_model=AlertNotificationItem)
def mark_alert_read(
    alert_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> AlertNotificationItem:
    notification = db.get(AlertNotification, alert_id)
    if not notification or notification.recipient_user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Алерт не найден")
    if not notification.read_at:
        notification.read_at = datetime.now(UTC)
        db.commit()
        db.refresh(notification)
    incident = db.get(Incident, notification.incident_id)
    return _item(notification, incident)
