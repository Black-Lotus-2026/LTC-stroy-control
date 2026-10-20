"""R1 command behavior is checked independently from frontend visibility."""

from __future__ import annotations

import copy
import hashlib
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select

from app.models import Incident
from app.models.customer_control import (
    AssignmentArea,
    EvidenceAsset,
    IncidentBasis,
    IncidentEvidenceLink,
    OrganizationMembership,
    ProjectAssignment,
    ProjectRole,
    RemediationReview,
    RemediationSubmission,
)
from app.models.enums import IncidentStatus
from app.services.alert_service import VerificationResult, apply_verification
from tests import test_customer_control_http, test_customer_control_migration

customer_http = test_customer_control_http.customer_http
migration_postgres = test_customer_control_migration.migration_postgres


def _command(s, actor, action, version, *, incident=None, key=None, **fields):
    incident = incident or s.incidents["k1"]
    headers = {**s.headers(actor), "Idempotency-Key": str(key or uuid4())}
    return s.client.post(
        f"/api/v1/customer-control/incidents/{incident.id}/commands",
        headers=headers,
        json={"action": action, "expected_version": version, **fields},
    )


def _ok(response):
    assert response.status_code == 200, response.text
    return response.json()["incident"]


def _confirm(s, *, actor="manager"):
    return _command(
        s,
        actor,
        "confirm",
        1,
        responsible_participation_id=str(s.participations["k1"].id),
        assignee_assignment_id=str(s.assignments["foreman1"].id),
        area_id=str(s.area.id),
        remediation_due_at=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
        note="Customer confirmed an explicit synthetic observation",
    )


def _evidence(s, contractor="k1"):
    stream = io.BytesIO()
    Image.new("RGB", (32, 32), "green").save(stream, format="JPEG")
    content = stream.getvalue()
    path = s.root / "storage" / (uuid4().hex + ".jpg")
    path.write_bytes(content)
    with s.sessions() as db:
        asset = EvidenceAsset(
            project_id=s.projects["a"].id,
            owner_participation_id=s.participations[contractor].id,
            storage_key=str(path),
            media_type="image/jpeg",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            uploaded_by=s.users["foreman" + contractor[-1]].id,
        )
        db.add(asset)
        db.flush()
        db.add(
            IncidentEvidenceLink(
                incident_id=s.incidents[contractor].id,
                asset_id=asset.id,
                kind="remediation",
            )
        )
        db.commit()
        return asset.id


def _submission(s):
    with s.sessions() as db:
        return db.scalar(
            select(RemediationSubmission)
            .where(RemediationSubmission.incident_id == s.incidents["k1"].id)
            .order_by(RemediationSubmission.sequence.desc())
        )


def _ready_for_review(s):
    current = _ok(_confirm(s))
    current = _ok(_command(s, "foreman1", "start", current["row_version"]))
    evidence = _evidence(s)
    current = _ok(
        _command(
            s,
            "foreman1",
            "submit_remediation",
            current["row_version"],
            note="Work completed with a verified synthetic photograph",
            evidence_ids=[str(evidence)],
        )
    )
    return current, _submission(s)


def test_return_resubmit_and_customer_acceptance_preserve_basis_and_past_submissions(
    customer_http,
):
    s = customer_http
    with s.sessions() as db:
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == s.incidents["k1"].id)
        )
        original_basis = copy.deepcopy(basis.snapshot), basis.sha256
    current, first = _ready_for_review(s)
    assert current["status"] == "remediation_submitted"
    assert current["resolution_origin"] is None
    forbidden = _command(
        s,
        "foreman1",
        "accept_remediation",
        current["row_version"],
        submission_id=str(first.id),
        note="Self acceptance is forbidden",
    )
    assert forbidden.status_code == 403, forbidden.text
    current = _ok(
        _command(
            s,
            "manager",
            "return_remediation",
            current["row_version"],
            submission_id=str(first.id),
            note="Photograph does not demonstrate final repair",
        )
    )
    assert current["status"] == "in_progress"
    second_evidence = _evidence(s)
    current = _ok(
        _command(
            s,
            "foreman1",
            "submit_remediation",
            current["row_version"],
            note="Corrected repair and a new photograph",
            evidence_ids=[str(second_evidence)],
        )
    )
    second = _submission(s)
    assert second.sequence == 2
    assert second.id != first.id
    stale = _command(
        s,
        "manager",
        "accept_remediation",
        current["row_version"],
        submission_id=str(first.id),
        note="An old submission cannot be accepted",
    )
    assert stale.status_code == 409, stale.text
    current = _ok(
        _command(
            s,
            "manager2",
            "accept_remediation",
            current["row_version"],
            submission_id=str(second.id),
            note="Customer inspected the exact second submission",
        )
    )
    assert current["status"] == "resolved"
    assert current["resolution_origin"] == "customer_accepted"
    with s.sessions() as db:
        basis = db.scalar(
            select(IncidentBasis).where(IncidentBasis.incident_id == s.incidents["k1"].id)
        )
        assert (basis.snapshot, basis.sha256) == original_basis
        submissions = db.scalars(
            select(RemediationSubmission).order_by(RemediationSubmission.sequence)
        ).all()
        assert [row.sequence for row in submissions] == [1, 2]
        reviews = db.scalars(
            select(RemediationReview).order_by(RemediationReview.decided_at)
        ).all()
        assert [row.outcome for row in reviews] == ["returned", "accepted"]
        assert reviews[1].reviewer_user_id == s.users["manager2"].id
        assert db.get(Incident, s.incidents["k1"].id).resolved_at is not None


def test_commands_require_current_authority_version_and_idempotency(customer_http):
    s = customer_http
    incident = s.incidents["k1"]
    key = uuid4()
    fields = {
        "responsible_participation_id": str(s.participations["k1"].id),
        "assignee_assignment_id": str(s.assignments["foreman1"].id),
        "area_id": str(s.area.id),
        "remediation_due_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        "note": "Idempotent confirmation",
    }
    first = _command(s, "manager", "confirm", 1, key=key, **fields)
    current = _ok(first)
    replay = _command(s, "manager", "confirm", 1, key=key, **fields)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    assert replay.json()["event_id"] == first.json()["event_id"]
    conflict = _command(
        s, "manager", "confirm", 1, key=key, **{**fields, "note": "Changed command body"}
    )
    assert conflict.status_code == 409, conflict.text
    stale = _command(s, "foreman1", "start", 1)
    assert stale.status_code == 409, stale.text
    wrong_role = _command(s, "pto1", "start", current["row_version"])
    assert wrong_role.status_code == 403, wrong_role.text
    response = s.client.post(
        f"/api/v1/customer-control/incidents/{incident.id}/commands",
        headers=s.headers("foreman1"),
        json={"action": "start", "expected_version": current["row_version"]},
    )
    assert response.status_code == 422, response.text
    with s.sessions() as db:
        db.get(ProjectAssignment, s.assignments["manager"].id).status = "revoked"
        db.commit()
    replay_revoked = _command(s, "manager", "confirm", 1, key=key, **fields)
    assert replay_revoked.status_code == 404, replay_revoked.text


def test_customer_and_contractor_contexts_do_not_merge_or_allow_self_acceptance(
    customer_http,
):
    s = customer_http
    current, submission = _ready_for_review(s)
    with s.sessions() as db:
        member = OrganizationMembership(
            organization_id=s.participations["k1"].organization_id,
            user_id=s.users["manager2"].id,
        )
        db.add(member)
        db.flush()
        contractor = ProjectAssignment(
            participation_id=s.participations["k1"].id,
            membership_id=member.id,
            role=ProjectRole.CONTRACTOR_FOREMAN,
            scope_kind="areas",
        )
        db.add(contractor)
        db.flush()
        db.add(AssignmentArea(assignment_id=contractor.id, area_id=s.area.id))
        db.commit()
    path = f"/api/v1/customer-control/incidents/{s.incidents['k1'].id}/commands"
    payload = {
        "action": "accept_remediation",
        "expected_version": current["row_version"],
        "submission_id": str(submission.id),
        "note": "A contractor affiliation prevents acceptance",
    }
    headers = {
        **s.headers("manager2", assignment=contractor),
        "Idempotency-Key": str(uuid4()),
    }
    assert s.client.post(path, headers=headers, json=payload).status_code == 403
    headers = {**s.headers("manager2"), "Idempotency-Key": str(uuid4())}
    response = s.client.post(path, headers=headers, json=payload)
    assert response.status_code == 409, response.text
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RemediationReview)) == 0


def test_empty_foreign_evidence_and_cross_contractor_commands_are_rejected(customer_http):
    s = customer_http
    current = _ok(_confirm(s))
    current = _ok(_command(s, "foreman1", "start", current["row_version"]))
    for actor, evidence, expected in (
        ("foreman1", [], 422),
        ("foreman1", [str(_evidence(s, "k2"))], 404),
        ("foreman2", [str(_evidence(s, "k1"))], 404),
    ):
        response = _command(
            s,
            actor,
            "submit_remediation",
            current["row_version"],
            note="Submission must not widen access",
            evidence_ids=evidence,
        )
        assert response.status_code == expected, (actor, response.text)
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RemediationSubmission)) == 0
        assert db.get(Incident, s.incidents["k1"].id).status == IncidentStatus.IN_PROGRESS


def test_dispute_blocks_acceptance_and_requires_an_independent_customer_decision(
    customer_http,
):
    s = customer_http
    current, submission = _ready_for_review(s)
    response = s.client.post(
        f"/api/v1/customer-control/incidents/{s.incidents['k1'].id}/disputes",
        headers={**s.headers("foreman1"), "Idempotency-Key": str(uuid4())},
        json={
            "expected_version": current["row_version"],
            "reason": "wrong_detection",
            "note": "The original observation requires independent review",
            "evidence_ids": [],
        },
    )
    assert response.status_code in {200, 201}, response.text
    dispute = response.json()
    with s.sessions() as db:
        incident_version = db.get(Incident, s.incidents["k1"].id).row_version
    blocked = _command(
        s,
        "manager2",
        "accept_remediation",
        incident_version,
        submission_id=str(submission.id),
        note="Open dispute must prevent acceptance",
    )
    assert blocked.status_code == 409, blocked.text
    decision = {
        "expected_version": dispute["row_version"],
        "incident_expected_version": incident_version,
        "outcome": "rejected",
        "correction": "none",
        "note": "Independent customer inspected the original evidence",
    }
    path = f"/api/v1/customer-control/disputes/{dispute['id']}/decide"
    response = s.client.post(
        path,
        headers={**s.headers("manager"), "Idempotency-Key": str(uuid4())},
        json=decision,
    )
    assert response.status_code == 409, response.text
    response = s.client.post(
        path,
        headers={**s.headers("manager2"), "Idempotency-Key": str(uuid4())},
        json=decision,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "rejected"
    with s.sessions() as db:
        incident = db.get(Incident, s.incidents["k1"].id)
        assert incident.status == IncidentStatus.REMEDIATION_SUBMITTED
        incident_version = incident.row_version
    accepted = _ok(
        _command(
            s,
            "manager2",
            "accept_remediation",
            incident_version,
            submission_id=str(submission.id),
            note="Remediation accepted after independent dispute review",
        )
    )
    assert accepted["resolution_origin"] == "customer_accepted"


@pytest.mark.parametrize("outcome", ["passed", "failed", "unavailable"])
def test_camera_verification_never_substitutes_for_human_acceptance(
    customer_http, outcome
):
    s = customer_http
    _ready_for_review(s)
    with s.sessions() as db:
        incident = db.get(Incident, s.incidents["k1"].id)
        version = incident.row_version
        apply_verification(
            db, incident, VerificationResult(outcome, {"source": "synthetic"})
        )
        db.commit()
        assert incident.status == IncidentStatus.REMEDIATION_SUBMITTED
        assert incident.resolved_at is None
        assert incident.resolution_origin is None
        assert incident.row_version == version
        assert incident.verification_status == outcome


def test_verified_evidence_upload_is_idempotent_private_and_revocation_checked(
    customer_http,
):
    s = customer_http
    current = _ok(_confirm(s))
    stream = io.BytesIO()
    Image.new("RGB", (80, 60), "orange").save(stream, format="JPEG")
    contents = stream.getvalue()
    path = f"/api/v1/customer-control/incidents/{s.incidents['k1'].id}/evidence"
    key = str(uuid4())
    headers = {**s.headers("foreman1"), "Idempotency-Key": key}
    response = s.client.post(
        path,
        headers=headers,
        data={"expected_version": str(current["row_version"])},
        files={"file": ("remediation.jpg", contents, "image/jpeg")},
    )
    assert response.status_code == 201, response.text
    asset = response.json()
    replay = s.client.post(
        path,
        headers=headers,
        data={"expected_version": str(current["row_version"])},
        files={"file": ("remediation.jpg", contents, "image/jpeg")},
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == asset["id"]
    file_path = f"/api/v1/customer-control/evidence/{asset['id']}/file"
    allowed = s.client.get(file_path, headers=s.headers("foreman1"))
    assert allowed.status_code == 200
    assert hashlib.sha256(allowed.content).hexdigest() == asset["sha256"]
    assert s.client.get(file_path, headers=s.headers("foreman2")).status_code == 404
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(EvidenceAsset)) == 1
        db.get(ProjectAssignment, s.assignments["foreman1"].id).status = "revoked"
        db.commit()
    assert (
        s.client.get(
            file_path, headers={**s.headers("foreman1"), "Range": "bytes=0-9"}
        ).status_code
        == 404
    )


def test_last_active_customer_manager_cannot_be_revoked_without_replacement(
    customer_http,
):
    s = customer_http
    path = "/api/v1/customer-control/assignments/"

    def revoke(assignment):
        return s.client.post(
            path + str(assignment.id) + "/revoke",
            headers={**s.headers("manager"), "Idempotency-Key": str(uuid4())},
            json={
                "expected_version": assignment.row_version,
                "reason": "Isolated manager replacement QA",
            },
        )

    assert revoke(s.assignments["manager2"]).status_code == 200
    denied = revoke(s.assignments["manager"])
    assert denied.status_code == 409, denied.text
    assert denied.json()["detail"]["code"] == "LAST_MANAGER"
    with s.sessions() as db:
        assert db.get(ProjectAssignment, s.assignments["manager"].id).status == "active"


@pytest.mark.parametrize("customer_http", ["postgres"], indirect=True)
def test_postgres_two_tabs_accept_exactly_once(customer_http):
    s = customer_http
    current, submission = _ready_for_review(s)

    def accept(actor):
        return _command(
            s,
            actor,
            "accept_remediation",
            current["row_version"],
            submission_id=str(submission.id),
            note="Concurrent acceptance",
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(accept, ("manager", "manager2")))
    assert sorted(response.status_code for response in responses) == [200, 409], [
        response.text for response in responses
    ]
    with s.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RemediationReview)) == 1
        incident = db.get(Incident, s.incidents["k1"].id)
        assert incident.status == IncidentStatus.RESOLVED
        assert incident.resolution_origin == "customer_accepted"
