"""Legacy and byte-serving endpoints must use the same live assignment policy."""

from __future__ import annotations

from app.core.config import settings
from app.models import Incident, User
from app.models.alert import AlertNotification
from app.models.customer_control import OrganizationMembership
from app.services.alert_service import (
    VerificationResult,
    apply_verification,
    deliver_pending_emails,
)
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def test_anonymous_reports_and_raw_inference_are_closed(customer_http):
    state = customer_http
    project = state.projects["a"].id
    for route in (
        f"/api/v1/reports?project_id={project}",
        f"/api/v1/reports/schedules?project_id={project}",
        "/api/v1/videos/detector-status",
    ):
        assert state.client.get(route).status_code == 401
    assert (
        state.client.post(
            f"/api/v1/videos/detect-frame?project_id={project}",
            files={"file": ("frame.jpg", b"invalid", "image/jpeg")},
        ).status_code
        == 401
    )


def test_full_reports_and_control_configuration_do_not_leak_to_contractors(customer_http):
    state = customer_http
    project = state.projects["a"].id
    for name in ("foreman1", "pto1"):
        for route in (
            f"/api/v1/reports?project_id={project}",
            f"/api/v1/safety/projects/{project}/zones",
            f"/api/v1/schedule/stages?project_id={project}",
            f"/api/v1/projects/{project}/alert-settings",
        ):
            response = state.client.get(route, headers=state.headers(name))
            assert response.status_code == 403, (route, response.text)
    response = state.client.get("/api/v1/auth/admins", headers=state.headers("manager"))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "WORKFLOW_UPGRADE_REQUIRED"


def test_historical_photo_bytes_recheck_membership_on_head_and_range(customer_http):
    state = customer_http
    key = "snapshots/synthetic-private.jpg"
    path = settings.storage_local_root / key
    path.parent.mkdir(parents=True)
    path.write_bytes(b"synthetic-private-photo-bytes")
    incident_id = state.incidents["k1"].id
    with state.sessions() as db:
        incident = db.get(Incident, incident_id)
        incident.explanation = {"snapshot_url": "/media/" + key}
        db.commit()
    url = "/media/" + key
    for method in ("get", "head"):
        response = getattr(state.client, method)(url, headers=state.headers("manager"))
        assert response.status_code == 200, response.text
    response = state.client.get(
        url, headers={**state.headers("manager"), "Range": "bytes=0-4"}
    )
    assert response.status_code == 206
    assert response.content == b"synth"
    # Being the historical assignee or viewing the public card does not disclose
    # every private image within that case.
    assert state.client.get(url, headers=state.headers("foreman1")).status_code == 404
    with state.sessions() as db:
        membership = db.get(OrganizationMembership, state.memberships["manager"].id)
        membership.status = "revoked"
        db.commit()
    for method in ("get", "head"):
        response = getattr(state.client, method)(url, headers=state.headers("manager"))
        assert response.status_code == 404


def test_camera_proposal_and_positive_verification_do_not_accept_a_case(customer_http):
    state = customer_http
    with state.sessions() as db:
        incident = db.get(Incident, state.incidents["k1"].id)
        original_status = incident.status
        apply_verification(
            db, incident, VerificationResult("passed", {"synthetic": True})
        )
        db.commit()
        assert incident.status == original_status
        assert incident.resolved_at is None
        assert incident.verification_status == "passed"


def test_revoked_notification_recipient_is_not_delivered(customer_http, monkeypatch):
    state = customer_http
    monkeypatch.setattr(settings, "smtp_host", "synthetic.invalid")
    monkeypatch.setattr(settings, "smtp_from", "synthetic@example.invalid")

    def forbidden_send(*args, **kwargs):
        raise AssertionError("SMTP must not be contacted after access revocation")

    monkeypatch.setattr("app.services.alert_service.smtplib.SMTP", forbidden_send)
    with state.sessions() as db:
        membership = db.get(OrganizationMembership, state.memberships["foreman1"].id)
        membership.status = "revoked"
        user = db.get(User, state.users["foreman1"].id)
        user.email = "synthetic@example.invalid"
        alert = AlertNotification(
            incident_id=state.incidents["k1"].id,
            recipient_user_id=user.id,
            kind="synthetic",
            title="Private title",
            body="Private body",
        )
        db.add(alert)
        db.commit()
        result = deliver_pending_emails(db)
        assert result == {"sent": 0, "failed": 0}
        assert alert.email_status == "skipped"
