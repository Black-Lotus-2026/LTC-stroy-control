"""Release retirement, exact source integrity and published API contracts."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.api.v1.ppr_control import snapshot_source
from app.core.config import settings
from app.main import app
from app.models import PprAnalysis, PprDocument, PprPage
from app.models.customer_control import AuditEvent, ControlRelease
from app.services.control_releases import release_at
from app.services.ppr_rules import citation_revision
from tests import test_customer_control_http, test_customer_control_ppr
from tests.test_customer_control_workflow import _confirm

customer_http = test_customer_control_http.customer_http
_post = test_customer_control_ppr._post


def test_published_openapi_has_unique_operation_ids():
    schema = app.openapi()
    ids = [
        operation["operationId"]
        for path in schema["paths"].values()
        for operation in path.values()
        if isinstance(operation, dict) and "operationId" in operation
    ]
    assert len(ids) == len(set(ids))
    assert (
        schema["components"]["schemas"]["CreateRevisionCommand"]["additionalProperties"]
        is False
    )
    assert (
        "remediation_submitted"
        in schema["components"]["schemas"]["IncidentStatus"]["enum"]
    )


def test_membership_and_assignment_selectors_must_describe_the_same_context(
    customer_http,
):
    s = customer_http
    forged = s.headers("manager") | {
        "X-Organization-Membership": str(s.memberships["pto1"].id),
    }
    for suffix in ("context", "incidents"):
        response = s.client.get(
            f"/api/v1/customer-control/projects/{s.projects['a'].id}/{suffix}",
            headers=forged,
        )
        assert response.status_code == 404, response.text
    response = s.client.get("/api/v1/auth/contexts", headers=forged)
    assert response.status_code == 200, response.text
    assert all(
        row["is_demo"] or row["assignment_id"] == str(s.assignments["manager"].id)
        for row in response.json()
    )


def test_notification_fanout_uses_recipient_memberships_not_actor_header(customer_http):
    s = customer_http
    original_headers = s.headers

    def scoped_headers(actor="manager", **kwargs):
        return original_headers(actor, **kwargs) | {
            "X-Organization-Membership": str(s.memberships[actor].id),
        }

    s.headers = scoped_headers
    confirmed = _confirm(s)
    assert confirmed.status_code == 200, confirmed.text
    response = s.client.get(
        f"/api/v1/customer-control/projects/{s.projects['a'].id}/notifications",
        headers=s.headers("foreman1"),
    )
    assert response.status_code == 200, response.text
    assert any(
        row["event_type"] == "incident.workflow_changed"
        and row["incident_id"] == str(s.incidents["k1"].id)
        for row in response.json()
    )


def test_original_ppr_integrity_is_checked_at_download(customer_http):
    s = customer_http
    doc = s.documents["k1"]
    path = f"/api/v1/projects/{s.projects['a'].id}/ppr-documents/{doc.id}/original"
    assert s.client.get(path, headers=s.headers("pto1")).status_code == 200
    (settings.ppr_storage_root / doc.storage_key).write_bytes(b"unexpected replacement")
    for method in (s.client.get, s.client.head):
        assert method(path, headers=s.headers("pto1")).status_code == 404


def test_retire_scheduled_release_restores_previous_control_and_retries_safely(
    customer_http,
):
    s = customer_http
    one, _ = test_customer_control_ppr._candidate(s)
    first = test_customer_control_ppr._packet(
        s, test_customer_control_ppr._revision(s, one)
    )
    response = _post(
        s,
        "manager",
        f"/control-releases/{first['id']}/approve",
        test_customer_control_ppr._approval(s, first, at=datetime.now(UTC)),
    )
    assert response.status_code == 200, response.text
    two, _ = test_customer_control_ppr._candidate(s, suffix="replacement")
    revision = test_customer_control_ppr._revision(s, two)
    response = _post(
        s,
        "pto1",
        f"/projects/{s.projects['a'].id}/control-releases",
        {
            "base_release_id": first["id"],
            "requirement_revision_ids": [revision["id"]],
            "limitations": [],
        },
    )
    assert response.status_code == 201, response.text
    packet = response.json()
    response = _post(
        s,
        "pto1",
        f"/control-releases/{packet['id']}/submit",
        {
            "expected_version": packet["row_version"],
        },
    )
    assert response.status_code == 200, response.text
    packet = response.json()
    future = datetime.now(UTC) + timedelta(hours=1)
    response = _post(
        s,
        "manager",
        f"/control-releases/{packet['id']}/approve",
        test_customer_control_ppr._approval(s, packet, at=future),
    )
    assert response.status_code == 200, response.text
    packet = response.json()
    body = {
        "expected_version": packet["row_version"],
        "note": "Customer cancelled the scheduled replacement before activation",
    }
    path = f"/control-releases/{packet['id']}/retire"
    for actor in ("foreman1", "pto1", "viewer"):
        assert _post(s, actor, path, body).status_code == 403
    key = uuid4()
    stopped = _post(s, "manager", path, body, key=key)
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["status"] == "cancelled"
    assert _post(s, "manager", path, body, key=key).json() == stopped.json()
    with s.sessions() as db:
        previous = db.get(ControlRelease, UUID(first["id"]))
        assert previous.effective_until is None
        assert (
            release_at(db, s.projects["a"].id, future + timedelta(days=1)).id
            == previous.id
        )


def test_event_dedup_survives_unrelated_release_and_retains_semantic_boundaries():
    source = {
        "kind": "equipment_required",
        "equipment_class": "excavator",
        "quote": "Требуется экскаватор",
        "scope_area_id": str(uuid4()),
        "document_id": str(uuid4()),
        "release_id": str(uuid4()),
        "rule_activated_at": datetime.now(UTC).isoformat(),
    }
    replacement_manifest = source | {
        "release_id": str(uuid4()),
        "manifest_sha256": "b" * 64,
    }
    assert citation_revision([source]) == citation_revision([replacement_manifest])
    for change in (
        {"kind": "equipment_forbidden"},
        {"scope_area_id": str(uuid4())},
        {"quote": "Требуются два экскаватора"},
    ):
        assert citation_revision([source]) != citation_revision([source | change])


def test_ambiguous_legacy_page_never_selects_a_new_analysis_silently(customer_http):
    s = customer_http
    requirement, _ = test_customer_control_ppr._candidate(s)
    with s.sessions() as db:
        page = db.scalar(
            select(PprPage).where(PprPage.analysis_id == requirement.analysis_id)
        )
        analysis = PprAnalysis(
            project_id=s.projects["a"].id,
            document_id=requirement.document_id,
            document_sha256=requirement.document_sha256,
            run_no=2,
            status="COMPLETED",
        )
        db.add(analysis)
        db.flush()
        db.add(
            PprPage(
                analysis_id=analysis.id,
                page_number=page.page_number,
                status="COMPLETED",
                text=page.text,
                text_sha256=page.text_sha256,
                preview_key=page.preview_key,
                preview_media_type=page.preview_media_type,
            )
        )
        db.commit()
        citation = {
            "requirement_id": str(requirement.id),
            "document_id": str(requirement.document_id),
            "document_sha256": requirement.document_sha256,
            "page_number": 2,
        }
        with pytest.raises(HTTPException) as ambiguous:
            snapshot_source(db, s.projects["a"].id, [citation], requirement.id)
        assert ambiguous.value.status_code == 404
        citation["analysis_id"] = str(requirement.analysis_id)
        assert (
            snapshot_source(
                db, s.projects["a"].id, [citation], requirement.id
            ).status_code
            == 200
        )


def test_architecture_customer_only_self_review_is_explicit_in_audit(customer_http):
    s = customer_http
    requirement, _ = test_customer_control_ppr._candidate(s)
    # This isolated source belongs solely to the customer. No contractor authorship.
    with s.sessions() as db:
        doc = db.get(PprDocument, requirement.document_id)
        doc.owner_participation_id = s.participations["customer_a"].id
        doc.uploaded_by_user_id = s.users["manager"].id
        db.commit()
    revision = _post(
        s,
        "manager",
        f"/requirements/{requirement.id}/revisions",
        {
            "area_id": str(s.area.id),
            "review_status": "verified",
            "note": "Customer engineer prepared this customer-only material",
        },
    )
    assert revision.status_code == 201, revision.text
    response = _post(
        s,
        "manager",
        f"/projects/{s.projects['a'].id}/control-releases",
        {
            "base_release_id": None,
            "requirement_revision_ids": [revision.json()["id"]],
            "limitations": [],
        },
    )
    assert response.status_code == 201, response.text
    packet = response.json()
    response = _post(
        s,
        "manager",
        f"/control-releases/{packet['id']}/submit",
        {
            "expected_version": packet["row_version"],
        },
    )
    assert response.status_code == 200, response.text
    packet = response.json()
    response = _post(
        s,
        "manager",
        f"/control-releases/{packet['id']}/approve",
        test_customer_control_ppr._approval(s, packet),
    )
    assert response.status_code == 200, response.text
    with s.sessions() as db:
        event = db.scalar(
            select(AuditEvent).where(
                AuditEvent.resource_id == UUID(packet["id"]),
                AuditEvent.event_type == "control.approved",
            )
        )
        assert "customer_self_review" in event.reason
