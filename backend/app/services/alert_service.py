"""Incident assignment, deadline verification and notification delivery."""

from __future__ import annotations

import hashlib
import logging
import smtplib
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.alert import AlertNotification
from app.models.enums import IncidentEventType, IncidentStatus
from app.models.incident import Incident, IncidentEvent
from app.models.project import Camera, Project
from app.models.user import User
from app.services.detector_provider import get_detector
from app.services.rule_engine import to_russian_machinery_name

logger = logging.getLogger(__name__)
OPEN_STATUSES = (
    IncidentStatus.PENDING,
    IncidentStatus.CONFIRMED,
    IncidentStatus.IN_PROGRESS,
    IncidentStatus.REMEDIATION_SUBMITTED,
)
# A camera feeding a recording in a loop. The browser finds it over several passes of the
# recording; a short recheck cannot establish that the live feed is authentic.
STREAM_LOOP = "STREAM_LOOP"


@dataclass
class VerificationResult:
    outcome: str  # passed, failed, unavailable
    details: dict = field(default_factory=dict)


def reviewers_for_project(db: Session, project: Project) -> list[User]:
    """Current customer reviewers receive candidates while assignments stay active."""
    from app.models.customer_control import (
        OrganizationMembership,
        ProjectAssignment,
        ProjectOrganization,
        ProjectRole,
    )

    return list(
        db.scalars(
            select(User)
            .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
            .join(
                ProjectAssignment,
                ProjectAssignment.membership_id == OrganizationMembership.id,
            )
            .join(
                ProjectOrganization,
                ProjectOrganization.id == ProjectAssignment.participation_id,
            )
            .where(
                User.is_active.is_(True),
                OrganizationMembership.status == "active",
                OrganizationMembership.organization_id
                == project.customer_organization_id,
                ProjectOrganization.project_id == project.id,
                ProjectOrganization.side == "customer",
                ProjectOrganization.status == "active",
                ProjectAssignment.status == "active",
                ProjectAssignment.role == ProjectRole.CUSTOMER_MANAGER,
            )
            .order_by(ProjectAssignment.created_at, ProjectAssignment.id)
        ).unique()
    )


def responsible_for_project(db: Session, project: Project) -> User | None:
    """Default triage belongs to an active customer manager, never a global admin."""
    return next(iter(reviewers_for_project(db, project)), None)


def escalation_for_project(db: Session, project: Project) -> User | None:
    candidate = (
        db.get(User, project.escalation_user_id) if project.escalation_user_id else None
    )
    if candidate:
        from app.models.customer_control import (
            ProjectAssignment,
            ProjectOrganization,
            ProjectRole,
        )
        from app.services.access_policy import assignment_query

        authorized = (
            db.execute(
                assignment_query(candidate).where(
                    ProjectOrganization.project_id == project.id,
                    ProjectOrganization.side == "customer",
                    ProjectAssignment.role == ProjectRole.CUSTOMER_MANAGER,
                )
            ).first()
            if candidate.is_active
            else None
        )
        if authorized:
            return candidate
    return responsible_for_project(db, project)


def queue_notification(
    db: Session,
    *,
    incident: Incident,
    recipient: User | None,
    kind: str,
    title: str,
    body: str,
) -> AlertNotification | None:
    if recipient is None or not notification_access(db, incident, recipient):
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
    if incident.workflow_version == 2:
        from app.services.deadlines import apply_detection_deadline

        apply_detection_deadline(db, incident)
        incident.sla_deadline = incident.reaction_due_at
        reviewers = reviewers_for_project(db, project)
        incident.assigned_user_id = reviewers[0].id if reviewers else None
        db.flush()
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.DETECTED,
                comment="Кандидат аналитики: требуется проверка заказчиком",
            )
        )
        due = (
            f" Проверить до {incident.reaction_due_at:%d.%m.%Y %H:%M} UTC."
            if incident.reaction_due_at
            else " Срок проверки не установлен."
        )
        for recipient in reviewers:
            queue_notification(
                db,
                incident=incident,
                recipient=recipient,
                kind="candidate_review",
                title=f"{incident.code}: требуется проверка заказчиком",
                body=f"Объект «{project.name}». Требуется проверка заказчиком.{due}",
            )
        return
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
                comment=(
                    f"Ответственный: {recipient.name}; "
                    f"срок: {incident.sla_deadline.isoformat()}"
                ),
            )
        )
    queue_notification(
        db,
        incident=incident,
        recipient=recipient,
        kind="assigned",
        title=f"{incident.code}: {incident.title}",
        body=(
            f"Объект «{project.name}». "
            f"Исправить до {incident.sla_deadline:%d.%m.%Y %H:%M} UTC."
        ),
    )


def request_verification(db: Session, incident: Incident, user: User) -> None:
    if incident.status not in OPEN_STATUSES:
        raise ValueError("Инцидент уже закрыт")
    incident.verification_status = "queued"
    incident.verification_requested_at = datetime.now(UTC)
    db.add(
        IncidentEvent(
            incident_id=incident.id,
            event_type=IncidentEventType.COMMENTED,
            user_id=user.id,
            comment="Ответственный сообщил об исправлении; запрошена повторная проверка",
        )
    )


def _capture_frame(camera: Camera) -> bytes | None:
    """Read only a validated, DNS-pinned camera target with bounded network reads."""
    from app.services.camera_view import capture_frame

    return capture_frame(camera)


def _detector():
    return get_detector()


def verify_incident(db: Session, incident: Incident) -> VerificationResult:
    """Recheck all configured cameras over the normal observation window."""
    if incident.discrepancy_type == STREAM_LOOP:
        return VerificationResult(
            "unavailable",
            {"reason": "loop_needs_admin", "checked_at": datetime.now(UTC).isoformat()},
        )
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
    equipment = not (incident.discrepancy_type or "").startswith("STREAM_")
    reference_features = {}
    if equipment:
        from app.services.camera_view import (
            features_from_image,
            load_view_image,
            move_active,
        )

        if any(move_active(camera) for camera in cameras):
            return VerificationResult("unavailable", {"reason": "camera_move_active"})
        if db.scalar(
            select(Incident.id).where(
                Incident.camera_id.in_([camera.id for camera in cameras]),
                Incident.discrepancy_type == STREAM_LOOP,
                Incident.status.in_(OPEN_STATUSES),
            )
        ):
            return VerificationResult("unavailable", {"reason": "camera_loop_unresolved"})
        for camera in cameras:
            if camera.view_reference_key:
                try:
                    reference_features[camera.id] = features_from_image(
                        load_view_image(camera.view_reference_key)
                    )
                except Exception:
                    return VerificationResult(
                        "unavailable", {"reason": "camera_reference_unavailable"}
                    )
    detector = _detector()
    if (
        not (incident.discrepancy_type or "").startswith("STREAM_")
        and hasattr(detector, "compliance_enabled")
        and (
            not detector.compliance_enabled
            or not detector.can_evaluate(incident.machinery_type or "")
        )
    ):
        return VerificationResult(
            "unavailable", {"reason": "construction_shadow_or_unapproved_class"}
        )
    if not detector.is_ready and not (incident.discrepancy_type or "").startswith(
        "STREAM_"
    ):
        return VerificationResult("unavailable", {"reason": "detector_not_ready"})

    observed: set[str] = set()
    working: set[str] = set()
    construction_inference_failed = False
    camera_view_invalid = False
    samples = 3
    for sample in range(samples):
        for camera in cameras:
            try:
                frame = _capture_frame(camera)
                if frame is None:
                    continue
                if camera.id in reference_features:
                    from app.services.camera_view import (
                        MATCH_OK,
                        compare,
                        features_from_image,
                    )

                    if (
                        compare(
                            reference_features[camera.id], features_from_image(frame)
                        ).match
                        < MATCH_OK
                    ):
                        camera_view_invalid = True
                        continue
                working.add(str(camera.id))
                if not (incident.discrepancy_type or "").startswith("STREAM_"):
                    for detection in detector.detect_frame(frame):
                        if detection.confidence >= 0.6:
                            observed.add(to_russian_machinery_name(detection.label_ru))
                            if hasattr(detector, "compliance_enabled"):
                                observed.update(
                                    (detection.raw_label, detection.canonical_code)
                                )
            except Exception:
                if hasattr(detector, "compliance_enabled"):
                    construction_inference_failed = True
                logger.exception("Camera recheck failed: %s", camera.id)
        if sample < samples - 1:
            time.sleep(
                max(1, settings.violation_evaluation_window_seconds / (samples - 1))
            )

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

    if construction_inference_failed:
        return VerificationResult(
            "unavailable", {**details, "reason": "construction_inference_failed"}
        )
    if camera_view_invalid:
        return VerificationResult(
            "unavailable", {**details, "reason": "camera_view_not_verified"}
        )

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
    assignee = (
        db.get(User, incident.assigned_user_id) if incident.assigned_user_id else None
    )
    if result.outcome == "passed":
        db.add(
            IncidentEvent(
                incident_id=incident.id,
                event_type=IncidentEventType.COMMENTED,
                comment=(
                    "Техническая проверка пройдена; требуется приёмка "
                    "заказчиком конкретной подачи"
                ),
            )
        )
        queue_notification(
            db,
            incident=incident,
            recipient=assignee,
            kind="verified",
            title=f"{incident.code}: техническая проверка пройдена",
            body=(
                "Камера дала положительный результат. Приёмка "
                "устранения остаётся решением заказчика."
            ),
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
    if incident.workflow_version == 2:
        return
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
            db,
            incident=incident,
            recipient=chief,
            kind="escalated",
            title=f"Просрочен {incident.code}: {incident.title}",
            body=(
                "Нарушение сохраняется после повторной проверки."
                if result.outcome == "failed"
                else "Срок истёк, но проверить устранение по камерам не удалось."
            ),
        )


def notify_overdue_deadlines(db: Session, *, now: datetime) -> int:
    """Notify the responsible side for each SLA without changing case decisions."""
    from app.models.customer_control import DeadlinePause

    queued = 0
    projects = list(
        db.scalars(
            select(Project)
            .where(
                Project.kind != "shared_demo",
                Project.lifecycle == "active",
            )
            .order_by(Project.id)
            .with_for_update(skip_locked=True)
        )
    )
    for project in projects:
        cases = db.scalars(
            select(Incident)
            .where(
                Incident.project_id == project.id,
                Incident.workflow_version == 2,
                or_(
                    (Incident.status == IncidentStatus.PENDING)
                    & (Incident.reaction_due_at <= now),
                    Incident.status.in_(
                        (IncidentStatus.CONFIRMED, IncidentStatus.IN_PROGRESS)
                    )
                    & (Incident.remediation_due_at <= now),
                    (Incident.status == IncidentStatus.REMEDIATION_SUBMITTED)
                    & (Incident.review_due_at <= now),
                ),
            )
            .with_for_update(skip_locked=True)
        )
        reviewers = reviewers_for_project(db, project)
        for incident in cases:
            recipients = list(reviewers)
            if incident.status == IncidentStatus.PENDING:
                deadline, name, label = (
                    incident.reaction_due_at,
                    "reaction",
                    "Просрочена проверка кандидата заказчиком",
                )
            elif incident.status == IncidentStatus.REMEDIATION_SUBMITTED:
                deadline, name, label = (
                    incident.review_due_at,
                    "review",
                    "Просрочена приёмка устранения заказчиком",
                )
            else:
                if db.scalar(
                    select(DeadlinePause.id).where(
                        DeadlinePause.incident_id == incident.id,
                        DeadlinePause.until > now,
                    )
                ):
                    continue
                deadline, name, label = (
                    incident.remediation_due_at,
                    "remediation",
                    "Просрочено устранение",
                )
                assignee = (
                    db.get(User, incident.assigned_user_id)
                    if incident.assigned_user_id
                    else None
                )
                if assignee and assignee.id not in {user.id for user in recipients}:
                    recipients.append(assignee)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=UTC)
            suffix = hashlib.sha256(deadline.isoformat().encode()).hexdigest()[:10]
            kind = f"{name}_overdue_{suffix}"
            for recipient in recipients:
                previous = db.scalar(
                    select(AlertNotification.id).where(
                        AlertNotification.incident_id == incident.id,
                        AlertNotification.recipient_user_id == recipient.id,
                        AlertNotification.kind == kind,
                    )
                )
                if (
                    queue_notification(
                        db,
                        incident=incident,
                        recipient=recipient,
                        kind=kind,
                        title=f"{incident.code}: {label.lower()}",
                        body=(
                            f"Объект «{project.name}». {label}. "
                            f"Срок: {deadline:%d.%m.%Y %H:%M} UTC."
                        ),
                    )
                    and previous is None
                ):
                    queued += 1
    return queued


def run_due_verifications(
    db: Session,
    *,
    now: datetime | None = None,
    verifier: Callable[[Session, Incident], VerificationResult] = verify_incident,
) -> dict[str, int]:
    now = now or datetime.now(UTC)
    notify_overdue_deadlines(db, now=now)
    due = list(
        db.scalars(
            select(Incident)
            .where(
                Incident.project_id.in_(
                    select(Project.id).where(
                        Project.kind != "shared_demo", Project.lifecycle == "active"
                    )
                ),
                Incident.status.in_(OPEN_STATUSES),
                or_(
                    Incident.verification_requested_at.is_not(None),
                    (Incident.workflow_version == 1)
                    & (Incident.sla_deadline <= now)
                    & Incident.escalated_at.is_(None),
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
        # Camera results never constitute customer acceptance.
        counts["resolved"] += 0
        counts["escalated"] += int(incident.escalated_at == now)
    return counts


def deliver_pending_emails(db: Session) -> dict[str, int]:
    if not settings.smtp_host or not settings.smtp_from:
        return {"sent": 0, "failed": 0}
    pending = list(
        db.scalars(
            select(AlertNotification)
            .where(
                AlertNotification.email_status == "pending",
                AlertNotification.email_attempts < 3,
            )
            .order_by(AlertNotification.created_at)
            .with_for_update(skip_locked=True)
            .limit(30)
        ).all()
    )
    counts = {"sent": 0, "failed": 0}
    for notification in pending:
        recipient = notification.recipient
        incident = db.get(Incident, notification.incident_id)
        if incident is None or not notification_access(db, incident, recipient):
            notification.email_status = "skipped"
            continue
        if not recipient.email:
            notification.email_status = "skipped"
            continue
        message = EmailMessage()
        message["From"] = settings.smtp_from
        message["To"] = recipient.email
        message["Subject"] = notification.title
        message.set_content(notification.body)
        try:
            with smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=10
            ) as client:
                if settings.smtp_starttls:
                    client.starttls()
                if settings.smtp_username:
                    password = (
                        settings.smtp_password.get_secret_value()
                        if settings.smtp_password
                        else ""
                    )
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


def notification_access(db: Session, incident: Incident, user: User) -> bool:
    """Delivery chooses one active assignment and rechecks the current resource."""
    from fastapi import HTTPException

    from app.models.customer_control import ProjectOrganization
    from app.services.access_policy import (
        assignment_query,
        can_read_incident,
        resolve_context,
    )

    if user is None or not user.is_active:
        return False
    saved = db.info.pop("assignment_id", None)
    saved_membership = db.info.pop("membership_id", None)
    try:
        for assignment, _, _ in db.execute(
            assignment_query(user).where(
                ProjectOrganization.project_id == incident.project_id
            )
        ).all():
            db.info["assignment_id"] = assignment.id
            try:
                ctx = resolve_context(
                    db, incident.project_id, user, permission="incident.read"
                )
                if can_read_incident(db, ctx, incident):
                    return True
            except HTTPException:
                continue
        return False
    finally:
        db.info.pop("assignment_id", None)
        if saved is not None:
            db.info["assignment_id"] = saved
        if saved_membership is not None:
            db.info["membership_id"] = saved_membership
