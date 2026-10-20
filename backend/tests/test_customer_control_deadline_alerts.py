"""Candidate reaction, contractor remediation, and customer review are separate SLAs."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import Incident
from app.models.alert import AlertNotification
from app.models.customer_control import ProjectDeadlinePolicy
from app.models.enums import IncidentStatus
from app.services.alert_service import assign_initial_alert, run_due_verifications
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


@pytest.mark.parametrize("approved_policy", [False, True])
def test_candidate_alert_uses_reviewers_and_only_an_approved_reaction_deadline(
    customer_http,
    approved_policy,
):
    s = customer_http
    detected = datetime.now(UTC)
    with s.sessions() as db:
        incident = db.get(Incident, s.incidents["k1"].id)
        incident.detected_at = detected
        if approved_policy:
            db.add(
                ProjectDeadlinePolicy(
                    project_id=incident.project_id,
                    version=1,
                    approved_by=s.users["manager"].id,
                    approved_assignment_id=s.assignments["manager"].id,
                    effective_from=detected - timedelta(minutes=1),
                    reaction_minutes=30,
                    remediation_minutes=120,
                    review_minutes=60,
                    reason="Explicit synthetic deadline decision",
                )
            )
        assign_initial_alert(db, incident, s.projects["a"])
        db.commit()
        notifications = list(db.scalars(select(AlertNotification)))
        assert {row.recipient_user_id for row in notifications} == {
            s.users["manager"].id,
            s.users["manager2"].id,
        }
        assert {row.kind for row in notifications} == {"candidate_review"}
        assert all(
            "требуется проверка заказчиком" in row.title.lower() for row in notifications
        )
        assert all("исправить" not in row.body.lower() for row in notifications)
        assert incident.remediation_due_at is None
        assert incident.review_due_at is None
        if approved_policy:
            assert incident.reaction_due_at.replace(tzinfo=UTC) == detected + timedelta(
                minutes=30
            )
            assert incident.sla_deadline == incident.reaction_due_at
        else:
            assert incident.reaction_due_at is None
            assert incident.sla_deadline is None


def test_three_overdue_notifications_are_deduplicated_without_cv_or_status_changes(
    customer_http,
):
    s = customer_http
    now = datetime.now(UTC)
    with s.sessions() as db:
        incident = db.get(Incident, s.incidents["k1"].id)
        incident.reaction_due_at = now - timedelta(minutes=1)
        incident.sla_deadline = incident.reaction_due_at
        for status, due_field, kind_prefix, recipients in (
            (
                IncidentStatus.PENDING,
                "reaction_due_at",
                "reaction_overdue_",
                {"manager", "manager2"},
            ),
            (
                IncidentStatus.CONFIRMED,
                "remediation_due_at",
                "remediation_overdue_",
                {"manager", "manager2", "foreman1"},
            ),
            (
                IncidentStatus.REMEDIATION_SUBMITTED,
                "review_due_at",
                "review_overdue_",
                {"manager", "manager2"},
            ),
        ):
            incident.status = status
            setattr(incident, due_field, now - timedelta(minutes=1))
            for _ in range(2):
                counts = run_due_verifications(
                    db,
                    now=now,
                    verifier=lambda *_: pytest.fail(
                        "An SLA is not a CV verification request"
                    ),
                )
                db.flush()
                assert counts == {"checked": 0, "resolved": 0, "escalated": 0}
            rows = list(
                db.scalars(
                    select(AlertNotification).where(
                        AlertNotification.kind.startswith(kind_prefix)
                    )
                )
            )
            assert {row.recipient_user_id for row in rows} == {
                s.users[name].id for name in recipients
            }
            assert len(rows) == len(recipients)
            assert all(len(row.kind) <= 32 for row in rows)
            assert incident.status == status
            assert incident.escalated_at is None
        # A new explicit deadline has a new receipt; old notices stay immutable.
        incident.review_due_at = now - timedelta(seconds=10)
        run_due_verifications(db, now=now)
        db.flush()
        assert (
            len(
                list(
                    db.scalars(
                        select(AlertNotification).where(
                            AlertNotification.kind.startswith("review_overdue_")
                        )
                    )
                )
            )
            == 4
        )
        db.commit()
