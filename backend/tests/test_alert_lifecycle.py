"""The alert lifecycle uses durable assignments and checks the deadline once."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.db.base import Base
from app.api.v1.incidents import create_incident, get_incidents, update_incident_status
from app.models.alert import AlertNotification
from app.models.enums import IncidentCategory, IncidentPriority, IncidentStatus, IncidentType, UserRole
from app.models.incident import Incident, IncidentEvent
from app.models.project import Project
from app.models.user import User
from app.schemas.stroy_control import IncidentCreateRequest, IncidentStatusUpdateRequest
from app.services.alert_service import (
    VerificationResult,
    assign_initial_alert,
    deliver_pending_emails,
    request_verification,
    run_due_verifications,
)


@compiles(JSONB, "sqlite")
def compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def setup_alert(db: Session, *, deadline_minutes: int = 120) -> tuple[Incident, User, User]:
    owner = User(username="foreman", name="Ответственный", role=UserRole.MANAGER)
    chief = User(username="chief", name="Руководитель", role=UserRole.ADMIN)
    db.add_all([owner, chief])
    db.flush()
    project = Project(
        code="PRJ-ALERT", name="Объект", owner_username=owner.username,
        escalation_user_id=chief.id, alert_error_deadline_minutes=deadline_minutes,
    )
    db.add(project)
    db.flush()
    incident = Incident(
        code="INC-ALERT", project_id=project.id,
        category=IncidentCategory.EQUIPMENT, type=IncidentType.EQUIPMENT_MISSING,
        title="Нет экскаватора", discrepancy_type="MISSING_MANDATORY",
        machinery_type="Экскаватор", status=IncidentStatus.PENDING,
        priority=IncidentPriority.CRITICAL, dedup_key="alert-test",
        first_seen_at=datetime.now(UTC), last_seen_at=datetime.now(UTC),
    )
    db.add(incident)
    db.flush()
    assign_initial_alert(db, incident, project)
    db.commit()
    return incident, owner, chief


def test_assignment_and_verified_resolution(db: Session) -> None:
    incident, owner, _ = setup_alert(db)
    assert incident.assigned_user_id == owner.id
    assert incident.sla_deadline - incident.first_seen_at == timedelta(hours=2)
    assert [(n.kind, n.recipient_user_id) for n in db.scalars(select(AlertNotification))] == [
        ("assigned", owner.id)
    ]

    request_verification(db, incident, owner)
    assert incident.status == IncidentStatus.IN_PROGRESS
    result = run_due_verifications(db, verifier=lambda _db, _incident: VerificationResult("passed"))
    db.commit()

    assert result == {"checked": 1, "resolved": 1, "escalated": 0}
    assert incident.status == IncidentStatus.RESOLVED
    assert {n.kind for n in db.scalars(select(AlertNotification))} == {"assigned", "verified"}
    assert run_due_verifications(db, verifier=lambda *_: pytest.fail("closed incident rechecked"))["checked"] == 0


@pytest.mark.parametrize("outcome", ["failed", "unavailable"])
def test_expired_issue_escalates_only_once(db: Session, outcome: str) -> None:
    incident, owner, chief = setup_alert(db, deadline_minutes=1)
    due_at = datetime.now(UTC) + timedelta(minutes=2)
    result = run_due_verifications(
        db, now=due_at, verifier=lambda _db, _incident: VerificationResult(outcome)
    )
    db.commit()

    assert result == {"checked": 1, "resolved": 0, "escalated": 1}
    assert incident.status == IncidentStatus.PENDING
    assert incident.verification_status == outcome
    assert {(n.kind, n.recipient_user_id) for n in db.scalars(select(AlertNotification))} == {
        ("assigned", owner.id), ("escalated", chief.id)
    }
    assert run_due_verifications(db, now=due_at + timedelta(minutes=1))["checked"] == 0
    assert len(list(db.scalars(select(IncidentEvent)))) == 4


def test_early_failed_check_waits_for_deadline(db: Session) -> None:
    incident, owner, chief = setup_alert(db)
    request_verification(db, incident, owner)
    before_deadline = datetime.now(UTC) + timedelta(minutes=1)
    first = run_due_verifications(
        db, now=before_deadline,
        verifier=lambda _db, _incident: VerificationResult("failed"),
    )
    db.commit()
    assert first["escalated"] == 0
    assert incident.escalated_at is None

    second = run_due_verifications(
        db, now=before_deadline + timedelta(hours=3),
        verifier=lambda _db, _incident: VerificationResult("failed"),
    )
    db.commit()
    assert second["escalated"] == 1
    assert db.scalar(select(AlertNotification).where(
        AlertNotification.recipient_user_id == chief.id
    )).kind == "escalated"


def test_email_delivery_uses_recipient_profile(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    _, owner, _ = setup_alert(db)
    owner.email = "foreman@example.test"
    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("smtp.example.test", 587, 10)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def starttls(self):
            pass

        def send_message(self, message):
            sent.append(message)

    monkeypatch.setattr("app.services.alert_service.settings.smtp_host", "smtp.example.test")
    monkeypatch.setattr("app.services.alert_service.settings.smtp_from", "alerts@example.test")
    monkeypatch.setattr("app.services.alert_service.smtplib.SMTP", FakeSMTP)

    assert deliver_pending_emails(db) == {"sent": 1, "failed": 0}
    assert sent[0]["To"] == owner.email
    assert deliver_pending_emails(db) == {"sent": 0, "failed": 0}


def test_incident_api_deduplicates_and_scopes_to_owner(db: Session) -> None:
    existing, owner, _ = setup_alert(db)
    outsider = User(username="outsider", name="Другой", role=UserRole.MANAGER)
    db.add(outsider)
    db.commit()
    request = IncidentCreateRequest(
        project_id=existing.project_id, title="Лишняя техника", description="Нарушение",
        discrepancy_type="UNCHARACTERISTIC_PRESENT", machinery_type="Самосвал",
    )
    first = create_incident(request, db, owner)
    second = create_incident(request, db, owner)
    assert first.id == second.id
    assert second.observed_count == 2
    assert len(list(db.scalars(select(AlertNotification)))) == 2
    assert {item.id for item in get_incidents(db, owner, existing.project_id, 50)} == {
        existing.id, first.id
    }
    assert get_incidents(db, outsider, None, 50) == []
    with pytest.raises(HTTPException) as denied:
        update_incident_status(
            first.id, IncidentStatusUpdateRequest(status="in_progress"), db, outsider
        )
    assert denied.value.status_code == 404

    project = db.get(Project, existing.project_id)
    project.owner_username = outsider.username
    db.commit()
    assert {item.id for item in get_incidents(db, owner, existing.project_id, 50)} == {
        existing.id, first.id
    }
    update_incident_status(
        first.id, IncidentStatusUpdateRequest(status="in_progress"), db, owner
    )
