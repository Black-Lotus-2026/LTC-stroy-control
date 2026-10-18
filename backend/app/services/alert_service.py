"""Incident assignment, deadline verification and notification delivery."""

from __future__ import annotations

import logging
import smtplib
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from functools import lru_cache
from typing import Callable

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.alert import AlertNotification
from app.models.enums import IncidentEventType, IncidentStatus, UserRole
from app.models.incident import Incident, IncidentEvent
from app.models.project import Camera, Project
from app.models.user import User
from app.services.detector import MachineryDetector
from app.services.rule_engine import to_russian_machinery_name

logger = logging.getLogger(__name__)
OPEN_STATUSES = (IncidentStatus.PENDING, IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS)
# A camera feeding a recording in a loop. The browser finds it over several passes of the
# recording; a recheck of a minute cannot rule it out, so the server never closes it by itself.
STREAM_LOOP = "STREAM_LOOP"


@dataclass
class VerificationResult:
    outcome: str  # passed, failed, unavailable
    details: dict = field(default_factory=dict)


def responsible_for_project(db: Session, project: Project) -> User | None:
    if project.owner_username:
        owner = db.scalar(
            select(User).where(
                User.username == project.owner_username, User.is_active.is_(True)
            )
        )
        if owner:
            return owner
    return db.scalar(
        select(User)
        .where(User.role == UserRole.ADMIN, User.is_active.is_(True))
        .order_by(User.created_at, User.id)
    )


def escalation_for_project(db: Session, project: Project) -> User | None:
    if project.escalation_user_id:
        user = db.get(User, project.escalation_user_id)
        if user and user.is_active and user.role == UserRole.ADMIN:
            return user
    return db.scalar(
        select(User)
        .where(User.role == UserRole.ADMIN, User.is_active.is_(True))
        .order_by(User.created_at, User.id)
    )


def queue_notification(
    db: Session,
    *,
    incident: Incident,
    recipient: User | None,
    kind: str,
    title: str,
    body: str,
) -> AlertNotification | None:
    if recipient is None:
        logger.warning("No recipient for incident %s (%s)", incident.id, kind)
        return None
    existing = db.scalar(
        select(AlertNotification).where(
            AlertNotification.incident_id == incident.id,
            AlertNotification.recipient_user_id == recipient.id,
            AlertNotification.kind == kind,
        )
    )
    if existing:
        return existing
    notification = AlertNotification(
        incident_id=incident.id,
        recipient_user_id=recipient.id,
        kind=kind,
        title=title,
        body=body,
    )
    db.add(notification)
    return notification


def assign_initial_alert(db: Session, incident: Incident, project: Project) -> None:
    """Set deadline once and create a durable alert in the same transaction."""
    recipient = responsible_for_project(db, project)
    incident.assigned_user_id = recipient.id if recipient else None
    minutes = (
        project.alert_error_deadline_minutes
        if incident.priority.value == "critical"
        else project.alert_warning_deadline_minutes
    )
    incident.sla_deadline = datetime.now(UTC) + timedelta(minutes=minutes)
    db.flush()
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=IncidentEventType.DETECTED,
            comment="Нарушение выявлено аналитикой",
        )
    )
    if recipient:
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.ASSIGNED,
                user_id=recipient.id,
                comment=f"Ответственный: {recipient.name}; срок: {incident.sla_deadline.isoformat()}",
            )
        )
    queue_notification(
        db,
        incident=incident,
        recipient=recipient,
        kind="assigned",
        title=f"{incident.code}: {incident.title}",
        body=f"Объект «{project.name}». Исправить до {incident.sla_deadline:%d.%m.%Y %H:%M} UTC.",
    )


def request_verification(db: Session, incident: Incident, user: User) -> None:
    if incident.status not in OPEN_STATUSES:
        raise ValueError("Инцидент уже закрыт")
    incident.verification_status = "requested"
    incident.verification_requested_at = datetime.now(UTC)
    if incident.status == IncidentStatus.PENDING:
        incident.status = IncidentStatus.IN_PROGRESS
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=IncidentEventType.COMMENTED,
            user_id=user.id,
            comment="Ответственный сообщил об исправлении; запрошена повторная проверка",
        )
    )


def _capture_frame(camera: Camera) -> bytes | None:
    """Read one current frame from an HTTP/MJPEG or RTSP camera."""
    import cv2

    url = camera.stream_url or ""
    if not url.startswith(("http://", "https://", "rtsp://")):
        return None
    capture = cv2.VideoCapture(
        url,
        cv2.CAP_FFMPEG,
        [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000],
    )
    try:
        if not capture.isOpened():
            return None
        ok, frame = capture.read()
        if not ok:
            return None
        encoded, image = cv2.imencode(".jpg", frame)
        return image.tobytes() if encoded else None
    finally:
        capture.release()


@lru_cache(maxsize=1)
def _detector() -> MachineryDetector:
    return MachineryDetector()


def verify_incident(db: Session, incident: Incident) -> VerificationResult:
    """Recheck all configured cameras over the normal observation window."""
    if incident.discrepancy_type == STREAM_LOOP:
        return VerificationResult("unavailable", {"reason": "loop_needs_admin", "checked_at": datetime.now(UTC).isoformat()})
    if (incident.discrepancy_type or "").startswith("VIEW_"):
        # a camera view is checked against its approved reference, not by machinery
        from app.services.camera_view import verify_view_incident

        return verify_view_incident(db, incident)
    cameras = list(
        db.scalars(
            select(Camera).where(
                Camera.project_id == incident.project_id,
                Camera.stream_url.is_not(None),
            )
        ).all()
    )
    if not cameras:
        return VerificationResult("unavailable", {"reason": "no_live_cameras"})
    detector = _detector()
    if not detector.is_ready and not (incident.discrepancy_type or "").startswith("STREAM_"):
        return VerificationResult("unavailable", {"reason": "detector_not_ready"})

    observed: set[str] = set()
    working: set[str] = set()
    samples = 3
    for sample in range(samples):
        for camera in cameras:
            try:
                frame = _capture_frame(camera)
                if frame is None:
                    continue
                working.add(str(camera.id))
                if not (incident.discrepancy_type or "").startswith("STREAM_"):
                    for detection in detector.detect_frame(frame):
                        if detection.confidence >= 0.6:
                            observed.add(to_russian_machinery_name(detection.label_ru))
            except Exception:
                logger.exception("Camera recheck failed: %s", camera.id)
        if sample < samples - 1:
            time.sleep(max(1, settings.violation_evaluation_window_seconds / (samples - 1)))

    details = {
        "working_cameras": len(working),
        "configured_cameras": len(cameras),
        "observed_machinery": sorted(observed),
        "checked_at": datetime.now(UTC).isoformat(),
    }
    issue = incident.discrepancy_type or ""
    if issue.startswith("STREAM_"):
        if len(working) == len(cameras):
            return VerificationResult("passed", details)
        return VerificationResult("unavailable", details)

    target = to_russian_machinery_name(incident.machinery_type or "")
    present = target in observed
    if issue in {"MISSING_MANDATORY", "MISSING_RECOMMENDED"} and present:
        return VerificationResult("passed", details)
    if issue == "UNCHARACTERISTIC_PRESENT" and present:
        return VerificationResult("failed", details)
    if len(working) != len(cameras):
        return VerificationResult("unavailable", details)
    if issue in {"MISSING_MANDATORY", "MISSING_RECOMMENDED"}:
        return VerificationResult("failed", details)
    if issue == "UNCHARACTERISTIC_PRESENT":
        return VerificationResult("passed", details)
    return VerificationResult("unavailable", {**details, "reason": "unsupported_issue"})


def apply_verification(
    db: Session,
    incident: Incident,
    result: VerificationResult,
    *,
    now: datetime | None = None,
) -> None:
    now = now or datetime.now(UTC)
    incident.last_checked_at = now
    incident.verification_requested_at = None
    incident.verification_status = result.outcome
    incident.verification_details = result.details
    project = db.get(Project, incident.project_id)
    assignee = db.get(User, incident.assigned_user_id) if incident.assigned_user_id else None
    if result.outcome == "passed":
        old_status = incident.status
        incident.status = IncidentStatus.RESOLVED
        incident.resolved_at = now
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.AUTO_RESOLVED,
                old_status=old_status,
                new_status=IncidentStatus.RESOLVED,
                comment="Повторная проверка камер: нарушение не подтвердилось",
            )
        )
        queue_notification(
            db, incident=incident, recipient=assignee, kind="verified",
            title=f"{incident.code}: исправление подтверждено",
            body="Повторная проверка камер завершена; инцидент закрыт.",
        )
        return

    event_type = (
        IncidentEventType.VERIFICATION_FAILED
        if result.outcome == "failed"
        else IncidentEventType.VERIFICATION_UNAVAILABLE
    )
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=event_type,
            comment=(
                "Повторная проверка: нарушение сохраняется"
                if result.outcome == "failed"
                else "Повторная проверка: данных с камер недостаточно"
            ),
        )
    )
    deadline = incident.sla_deadline
    if deadline and deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=UTC)
    if deadline and now >= deadline and incident.escalated_at is None:
        incident.escalated_at = now
        chief = escalation_for_project(db, project) if project else None
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.ESCALATED,
                user_id=chief.id if chief else None,
                comment="Срок истёк; эскалация руководителю",
            )
        )
        queue_notification(
            db, incident=incident, recipient=chief, kind="escalated",
            title=f"Просрочен {incident.code}: {incident.title}",
            body=(
                "Нарушение сохраняется после повторной проверки."
                if result.outcome == "failed"
                else "Срок истёк, но проверить устранение по камерам не удалось."
            ),
        )


def run_due_verifications(
    db: Session,
    *,
    now: datetime | None = None,
    verifier: Callable[[Session, Incident], VerificationResult] = verify_incident,
) -> dict[str, int]:
    now = now or datetime.now(UTC)
    due = list(
        db.scalars(
            select(Incident)
            .where(
                Incident.status.in_(OPEN_STATUSES),
                or_(
                    Incident.verification_requested_at.is_not(None),
                    (Incident.sla_deadline <= now) & Incident.escalated_at.is_(None),
                ),
            )
            .with_for_update(skip_locked=True)
            .limit(2)
        ).all()
    )
    counts = {"checked": 0, "resolved": 0, "escalated": 0}
    for incident in due:
        try:
            result = verifier(db, incident)
        except Exception:
            logger.exception("Verification failed for incident %s", incident.id)
            result = VerificationResult("unavailable", {"reason": "verification_error"})
        apply_verification(db, incident, result, now=now)
        counts["checked"] += 1
        counts["resolved"] += int(result.outcome == "passed")
        counts["escalated"] += int(incident.escalated_at == now)
    return counts


def deliver_pending_emails(db: Session) -> dict[str, int]:
    if not settings.smtp_host or not settings.smtp_from:
        return {"sent": 0, "failed": 0}
    pending = list(
        db.scalars(
            select(AlertNotification)
            .where(AlertNotification.email_status == "pending", AlertNotification.email_attempts < 3)
            .order_by(AlertNotification.created_at)
            .with_for_update(skip_locked=True)
            .limit(30)
        ).all()
    )
    counts = {"sent": 0, "failed": 0}
    for notification in pending:
        recipient = notification.recipient
        if not recipient.email:
            notification.email_status = "skipped"
            continue
        message = EmailMessage()
        message["From"] = settings.smtp_from
        message["To"] = recipient.email
        message["Subject"] = notification.title
        message.set_content(notification.body)
        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as client:
                if settings.smtp_starttls:
                    client.starttls()
                if settings.smtp_username:
                    password = settings.smtp_password.get_secret_value() if settings.smtp_password else ""
                    client.login(settings.smtp_username, password)
                client.send_message(message)
            notification.email_status = "sent"
            notification.email_sent_at = datetime.now(UTC)
            counts["sent"] += 1
        except Exception as exc:
            notification.email_attempts += 1
            notification.email_error = str(exc)[:256]
            if notification.email_attempts >= 3:
                notification.email_status = "failed"
            logger.exception("Alert email delivery failed: %s", notification.id)
            counts["failed"] += 1
    return counts
