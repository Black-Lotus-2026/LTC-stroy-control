"""PTO document context, immutable comments, deadlines and revocable scope reports."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.models import Incident
from app.models.customer_control import (
    DeadlinePause,
    EvidenceDisclosure,
    IncidentComment,
    IncidentRequirementLink,
    OrganizationMembership,
)
from tests import test_customer_control_http, test_customer_control_ppr
from tests.test_customer_control_workflow import _confirm, _ok

customer_http = test_customer_control_http.customer_http


def _post(s, actor, path, body, *, key=None):
    return s.client.post(
        "/api/v1/customer-control" + path,
        headers={**s.headers(actor), "Idempotency-Key": str(key or uuid4())},
        json=body,
    )


@pytest.fixture
def document_case(customer_http):
    s = customer_http
    candidate, _ = test_customer_control_ppr._candidate(s)
    revision = test_customer_control_ppr._revision(s, candidate)
    with s.sessions() as db:
        for party, incident in (("k1", s.incidents["k1"]), ("k2", s.incidents["k2"])):
            db.add(
                IncidentRequirementLink(
                    incident_id=incident.id, revision_id=UUID(revision["id"])
                )
            )
            db.add(
                EvidenceDisclosure(
                    project_id=s.projects["a"].id,
                    incident_id=incident.id,
                    participation_id=s.participations[party].id,
                    area_id=s.area.id,
                    revision_id=UUID(revision["id"]),
                )
            )
        db.commit()
    return s, revision


def test_pto_reads_only_own_document_context_and_comments_idempotently(document_case):
    s, revision = document_case
    headers = s.headers("pto1")
    response = s.client.get(
        f"/api/v1/customer-control/projects/{s.projects['a'].id}/document-cases",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()] == [str(s.incidents["k1"].id)]
    detail = response.json()[0]
    assert set(detail) == {
        "id",
        "code",
        "row_version",
        "visible_citations",
        "comments",
        "can_dispute",
    }
    assert detail["visible_citations"][0]["requirement_revision_id"] == revision["id"]
    assert (
        s.client.get(
            f"/api/v1/customer-control/incidents/{s.incidents['k1'].id}", headers=headers
        ).status_code
        == 403
    )
    assert (
        s.client.get(
            f"/api/v1/customer-control/incidents/{s.incidents['k2'].id}/document-context",
            headers=headers,
        ).status_code
        == 404
    )
    key = uuid4()
    path = f"/incidents/{s.incidents['k1'].id}/comments"
    body = {
        "expected_version": detail["row_version"],
        "note": "Engineer explained the exact page and quote",
    }
    first = _post(s, "pto1", path, body, key=key)
    assert first.status_code == 201, first.text
    replay = _post(s, "pto1", path, body, key=key)
    assert replay.status_code == 201 and replay.json()["id"] == first.json()["id"]
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(IncidentComment)) == 1
        assert db.scalar(select(IncidentComment)).document_context is True


def test_scope_report_contains_only_current_assignment_and_revocation_closes_snapshot(
    customer_http,
):
    s = customer_http
    now = datetime.now(UTC)
    response = _post(
        s,
        "foreman1",
        f"/projects/{s.projects['a'].id}/reports",
        {
            "kind": "operations",
            "from_at": (now - timedelta(days=7)).isoformat(),
            "until_at": (now + timedelta(days=1)).isoformat(),
        },
    )
    assert response.status_code == 201, response.text
    report = response.json()
    assert [row["id"] for row in report["incidents"]] == [str(s.incidents["k1"].id)]
    assert report["requirements"] == []
    path = f"/api/v1/customer-control/reports/{report['id']}"
    assert s.client.get(path, headers=s.headers("foreman1")).status_code == 200
    assert s.client.get(path, headers=s.headers("foreman2")).status_code == 404
    with s.sessions() as db:
        db.get(OrganizationMembership, s.memberships["foreman1"].id).status = "revoked"
        db.commit()
    assert s.client.get(path, headers=s.headers("foreman1")).status_code == 404


def test_pto_exports_document_registry_without_operational_case_payload(document_case):
    s, revision = document_case
    now = datetime.now(UTC)
    body = {
        "kind": "documents",
        "from_at": (now - timedelta(days=1)).isoformat(),
        "until_at": (now + timedelta(days=1)).isoformat(),
    }
    path = f"/projects/{s.projects['a'].id}/reports"
    response = _post(s, "pto1", path, body)
    assert response.status_code == 201, response.text
    assert response.json()["incidents"] == []
    assert [row["id"] for row in response.json()["requirements"]] == [revision["id"]]
    denied = _post(s, "pto1", path, {**body, "kind": "operations"})
    assert denied.status_code == 403, denied.text


def test_customer_deadline_policy_and_reasoned_pause_never_rewrite_basis(customer_http):
    s = customer_http
    policy_path = f"/projects/{s.projects['a'].id}/deadline-policies"
    policy = {
        "reaction_minutes": 45,
        "remediation_minutes": 720,
        "review_minutes": 90,
        "reason": "Customer explicitly approved the local test deadlines",
    }
    assert _post(s, "foreman1", policy_path, policy).status_code == 403
    approved = _post(s, "manager", policy_path, policy)
    assert approved.status_code == 201, approved.text
    current = _ok(_confirm(s))
    original_due = datetime.fromisoformat(current["remediation_due_at"])
    pause_body = {
        "expected_version": current["row_version"],
        "until": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        "reason": "Customer records a justified one-hour pause",
    }
    path = f"/incidents/{s.incidents['k1'].id}/deadline-pauses"
    assert _post(s, "foreman1", path, pause_body).status_code == 403
    key = uuid4()
    first = _post(s, "manager", path, pause_body, key=key)
    assert first.status_code == 200, first.text
    changed = datetime.fromisoformat(first.json()["remediation_due_at"])
    assert 3590 <= (changed - original_due).total_seconds() <= 3600
    replay = _post(s, "manager", path, pause_body, key=key)
    assert replay.status_code == 200 and replay.json() == first.json()
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(DeadlinePause)) == 1
        assert db.get(Incident, s.incidents["k1"].id).resolution_origin is None
