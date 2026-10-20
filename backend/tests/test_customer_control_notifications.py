"""The selected assignment receives only currently readable case/source notices."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.models.alert import AlertNotification
from app.models.customer_control import (
    AuditEvent,
    IncidentComment,
    IncidentEvidenceLink,
    NotificationOutbox,
    ProjectAssignment,
)
from app.services.access_policy import resolve_context
from app.services.incident_workflow import audit
from tests import test_customer_control_http, test_customer_control_workflow

customer_http = test_customer_control_http.customer_http


def test_inbox_filters_current_resources_before_limit_and_rechecks_revocation(
    customer_http,
):
    s = customer_http
    at = datetime.now(UTC)
    with s.sessions() as db:
        for contractor in ("k1", "k2"):
            event = AuditEvent(
                project_id=s.projects["a"].id,
                organization_id=s.participations["customer_a"].organization_id,
                actor_user_id=s.users["manager"].id,
                event_type="incident.workflow_changed",
                resource_id=s.incidents[contractor].id,
                occurred_at=at + timedelta(seconds=int(contractor[-1])),
            )
            db.add(event)
            db.flush()
            # A stale/overbroad outbox is never sufficient authority to read.
            db.add(
                NotificationOutbox(
                    audit_id=event.id, assignment_id=s.assignments["foreman1"].id
                )
            )
        db.add(
            AlertNotification(
                incident_id=s.incidents["k1"].id,
                recipient_user_id=s.users["foreman1"].id,
                kind="remediation_overdue_test",
                title="Own assigned deadline",
                body="Synthetic approved notice",
                created_at=at,
            )
        )
        db.commit()
    path = f"/api/v1/customer-control/projects/{s.projects['a'].id}/notifications"
    headers = s.headers("foreman1")
    result = s.client.get(path + "?limit=1", headers=headers)
    assert result.status_code == 200, result.text
    assert len(result.json()) == 1
    assert result.json()[0]["incident_id"] == str(s.incidents["k1"].id)
    whole = s.client.get(path, headers=headers).json()
    assert {row["source"] for row in whole} == {"alert", "workflow"}
    assert all(row["incident_id"] != str(s.incidents["k2"].id) for row in whole)
    with s.sessions() as db:
        db.get(ProjectAssignment, s.assignments["foreman1"].id).status = "revoked"
        db.commit()
    assert s.client.get(path, headers=headers).status_code == 404


def test_commands_publish_foreman_receipts_once_without_pto_operational_notices(
    customer_http,
):
    s = customer_http
    current, _ = test_customer_control_workflow._ready_for_review(s)
    assert current["status"] == "remediation_submitted"
    path = f"/api/v1/customer-control/projects/{s.projects['a'].id}/notifications"
    foreman = s.client.get(path, headers=s.headers("foreman1"))
    assert foreman.status_code == 200, foreman.text
    assert any(row["event_type"] == "incident.workflow_changed" for row in foreman.json())
    assert s.client.get(path, headers=s.headers("pto1")).json() == []
    with s.sessions() as db:
        before = db.scalar(select(func.count()).select_from(NotificationOutbox))
    assert s.client.get(path, headers=s.headers("foreman1")).status_code == 200
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(NotificationOutbox)) == before


def test_pto_receives_only_current_document_source_events(customer_http):
    s = customer_http
    with s.sessions() as db:
        db.info["assignment_id"] = s.assignments["manager"].id
        ctx = resolve_context(db, s.projects["a"].id, s.users["manager"])
        audit(db, ctx, "document.uploaded", s.documents["k1"].id)
        audit(db, ctx, "document.uploaded", s.documents["k2"].id)
        db.commit()
    path = f"/api/v1/customer-control/projects/{s.projects['a'].id}/notifications"
    response = s.client.get(path, headers=s.headers("pto1"))
    assert response.status_code == 200, response.text
    assert [row["resource_id"] for row in response.json()] == [str(s.documents["k1"].id)]
    assert s.client.get(path, headers=s.headers("foreman1")).json() == []


def test_readable_case_does_not_publish_foreign_evidence_or_private_comments(
    customer_http,
):
    s = customer_http
    foreign_evidence = test_customer_control_workflow._evidence(s, "k2")
    with s.sessions() as db:
        db.add(
            IncidentEvidenceLink(
                incident_id=s.incidents["k1"].id,
                asset_id=foreign_evidence,
            )
        )
        comment = IncidentComment(
            incident_id=s.incidents["k1"].id,
            author_user_id=s.users["foreman2"].id,
            author_assignment_id=s.assignments["foreman2"].id,
            participation_id=s.participations["k2"].id,
            document_context=True,
            note="A private document discussion",
        )
        db.add(comment)
        db.flush()
        db.info["assignment_id"] = s.assignments["manager"].id
        ctx = resolve_context(db, s.projects["a"].id, s.users["manager"])
        for event_type, resource in (
            ("evidence.appended", foreign_evidence),
            ("incident.commented", comment.id),
        ):
            event = audit(db, ctx, event_type, resource)
            assert not db.scalar(
                select(NotificationOutbox.id).where(
                    NotificationOutbox.audit_id == event.id,
                    NotificationOutbox.assignment_id == s.assignments["foreman1"].id,
                )
            )
            # A stale delivery row must be checked again by the reading API.
            db.add(
                NotificationOutbox(
                    audit_id=event.id, assignment_id=s.assignments["foreman1"].id
                )
            )
        db.commit()
    path = f"/api/v1/customer-control/projects/{s.projects['a'].id}/notifications"
    response = s.client.get(path, headers=s.headers("foreman1"))
    assert response.status_code == 200, response.text
    assert response.json() == []
