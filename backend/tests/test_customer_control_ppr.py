"""Engineer preparation, customer approval, immutable page provenance and releases."""

from __future__ import annotations

import hashlib
import io
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from pypdf import PdfReader, PdfWriter
from sqlalchemy import select

from app.core.config import settings
from app.models import PprAnalysis, PprPage, PprRequirement
from app.models.customer_control import (
    ControlRelease,
    OrganizationMembership,
    ProjectAssignment,
    ProjectRole,
    RequirementRevision,
)
from app.services.control_releases import release_at
from app.services.ppr_extraction import text_hash
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def _candidate(s, *, kind="equipment_required", suffix="one"):
    document = s.documents["k1"]
    quote = (
        "Для выполнения земляных работ запрещено присутствие экскаватора."
        if kind == "equipment_forbidden"
        else "Для выполнения земляных работ требуется экскаватор."
    )
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_page(PdfReader(settings.ppr_storage_root / document.storage_key).pages[1])
    writer.write(stream)
    page_bytes = stream.getvalue()
    page_key = f"k1/page-{suffix}.pdf"
    (settings.ppr_storage_root / page_key).write_bytes(page_bytes)
    with s.sessions() as db:
        analysis = db.scalar(
            select(PprAnalysis).where(PprAnalysis.document_id == document.id)
        )
        if analysis is None:
            analysis = PprAnalysis(
                project_id=s.projects["a"].id,
                document_id=document.id,
                document_sha256=document.sha256,
                status="COMPLETED",
                pages_total=2,
                pages_processed=2,
                provider="synthetic",
                model="explicit-regression-fixture",
            )
            db.add(analysis)
            db.flush()
            db.add(
                PprPage(
                    analysis_id=analysis.id,
                    page_number=2,
                    status="COMPLETED",
                    extraction_method="native_pdf",
                    text=quote,
                    text_sha256=text_hash(quote),
                    preview_key=page_key,
                    preview_media_type="application/pdf",
                    artifact_sha256=hashlib.sha256(page_bytes).hexdigest(),
                )
            )
        else:
            page = db.scalar(
                select(PprPage).where(
                    PprPage.analysis_id == analysis.id,
                    PprPage.page_number == 2,
                )
            )
            if quote not in page.text:
                page.text += "\n" + quote
                page.text_sha256 = text_hash(page.text)
        requirement = PprRequirement(
            project_id=s.projects["a"].id,
            document_id=document.id,
            analysis_id=analysis.id,
            document_sha256=document.sha256,
            page_number=2,
            fingerprint=hashlib.sha256(suffix.encode()).hexdigest(),
            title="Synthetic grounded excavator requirement",
            type=kind,
            equipment_class="excavator",
            quote=quote,
            quote_verified=True,
            detector_supported=True,
            active=False,
            extraction_method="native_pdf",
        )
        db.add(requirement)
        db.commit()
        return requirement, page_bytes


def _post(s, actor, path, body, *, key=None):
    return s.client.post(
        "/api/v1/customer-control" + path,
        headers={**s.headers(actor), "Idempotency-Key": str(key or uuid4())},
        json=body,
    )


def _revision(s, requirement):
    response = _post(
        s,
        "pto1",
        f"/requirements/{requirement.id}/revisions",
        {
            "area_id": str(s.area.id),
            "review_status": "verified",
            "note": "Engineer checked the exact quote on page two",
        },
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()


def _packet(s, revision):
    response = _post(
        s,
        "pto1",
        f"/projects/{s.projects['a'].id}/control-releases",
        {
            "base_release_id": None,
            "requirement_revision_ids": [revision["id"]],
            "limitations": [],
        },
    )
    assert response.status_code in {200, 201}, response.text
    packet = response.json()
    response = _post(
        s,
        "pto1",
        f"/control-releases/{packet['id']}/submit",
        {"expected_version": packet["row_version"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _approval(s, packet, *, at=None):
    with s.sessions() as db:
        manifest = db.get(ControlRelease, UUID(packet["id"])).manifest_sha256
    return {
        "expected_version": packet["row_version"],
        "manifest_sha256": manifest,
        "effective_from": (at or datetime.now(UTC) + timedelta(seconds=5)).isoformat(),
        "note": "Customer approved the exact manifest after inspecting grounded pages",
    }


def test_engineer_cannot_self_approve_and_release_applies_by_capture_time(customer_http):
    s = customer_http
    requirement, page_bytes = _candidate(s)
    revision = _revision(s, requirement)
    assert revision["citation"]["page_number"] == 2
    assert (
        revision["citation"]["page_artifact_sha256"]
        == hashlib.sha256(page_bytes).hexdigest()
    )
    packet = _packet(s, revision)
    with s.sessions() as db:
        assert release_at(db, s.projects["a"].id, datetime.now(UTC)) is None
        assert db.get(PprRequirement, requirement.id).active is False
    effective = datetime.now(UTC) + timedelta(seconds=10)
    approval = _approval(s, packet, at=effective)
    denied = _post(s, "pto1", f"/control-releases/{packet['id']}/approve", approval)
    assert denied.status_code == 403, denied.text
    response = _post(s, "manager", f"/control-releases/{packet['id']}/approve", approval)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "scheduled"
    with s.sessions() as db:
        assert (
            release_at(db, s.projects["a"].id, effective - timedelta(seconds=1)) is None
        )
        assert (
            str(release_at(db, s.projects["a"].id, effective + timedelta(seconds=1)).id)
            == packet["id"]
        )
        saved = db.get(RequirementRevision, UUID(revision["id"]))
        assert saved.citation["document_sha256"] == s.documents["k1"].sha256
        assert saved.submitted is True
    path = (
        f"/api/v1/projects/{s.projects['a'].id}/ppr-documents/"
        f"{s.documents['k1'].id}/pages/2/original"
    )
    allowed = s.client.get(path, headers=s.headers("pto1"))
    assert allowed.status_code == 200, allowed.text
    assert allowed.headers["x-ppr-page"] == "2"
    assert allowed.content == page_bytes
    assert s.client.get(path, headers=s.headers("foreman2")).status_code == 404


def test_two_packets_based_on_same_release_conflict_without_losing_other_requirements(
    customer_http,
):
    s = customer_http
    one, _ = _candidate(s, suffix="one")
    two, _ = _candidate(s, suffix="two")
    packet1, packet2 = _packet(s, _revision(s, one)), _packet(s, _revision(s, two))
    first = _post(
        s, "manager", f"/control-releases/{packet1['id']}/approve", _approval(s, packet1)
    )
    assert first.status_code == 200, first.text
    second = _post(
        s, "manager2", f"/control-releases/{packet2['id']}/approve", _approval(s, packet2)
    )
    assert second.status_code == 409, second.text


def test_returned_packet_requires_a_new_revision_and_preserves_original_quote(
    customer_http,
):
    s = customer_http
    candidate, _ = _candidate(s)
    revision = _revision(s, candidate)
    packet = _packet(s, revision)
    response = _post(
        s,
        "manager",
        f"/control-releases/{packet['id']}/return",
        {
            "expected_version": packet["row_version"],
            "note": "Clarify the scope before publication",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "changes_requested"
    old = _post(
        s,
        "pto1",
        f"/projects/{s.projects['a'].id}/control-releases",
        {
            "base_release_id": None,
            "requirement_revision_ids": [revision["id"]],
            "limitations": [],
        },
    )
    assert old.status_code == 409, old.text
    revised = _revision(s, candidate)
    assert revised["revision_no"] == 2
    assert revised["citation"]["quote"] == revision["citation"]["quote"]
    assert revised["id"] != revision["id"]


def test_contractor_authorship_cannot_be_erased_by_revocation_and_customer_reassignment(
    customer_http,
):
    s = customer_http
    candidate, _ = _candidate(s)
    packet = _packet(s, _revision(s, candidate))
    approval = _approval(s, packet)
    with s.sessions() as db:
        db.get(ProjectAssignment, s.assignments["pto1"].id).status = "revoked"
        membership = OrganizationMembership(
            organization_id=s.participations["customer_a"].organization_id,
            user_id=s.users["pto1"].id,
        )
        db.add(membership)
        db.flush()
        customer = ProjectAssignment(
            participation_id=s.participations["customer_a"].id,
            membership_id=membership.id,
            role=ProjectRole.CUSTOMER_MANAGER,
            scope_kind="project",
        )
        db.add(customer)
        db.commit()
    response = s.client.post(
        f"/api/v1/customer-control/control-releases/{packet['id']}/approve",
        headers={
            **s.headers("pto1", assignment=customer),
            "Idempotency-Key": str(uuid4()),
        },
        json=approval,
    )
    assert response.status_code == 409, response.text
    with s.sessions() as db:
        assert db.get(ControlRelease, UUID(packet["id"])).approved_by is None


def test_conflicting_requirements_in_the_same_scope_cannot_be_published(customer_http):
    s = customer_http
    required, _ = _candidate(s, suffix="required")
    forbidden, _ = _candidate(s, kind="equipment_forbidden", suffix="forbidden")
    revisions = [_revision(s, required), _revision(s, forbidden)]
    response = _post(
        s,
        "pto1",
        f"/projects/{s.projects['a'].id}/control-releases",
        {
            "base_release_id": None,
            "requirement_revision_ids": [row["id"] for row in revisions],
            "limitations": [],
        },
    )
    assert response.status_code in {200, 201}, response.text
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
    response = _post(
        s, "manager", f"/control-releases/{packet['id']}/approve", _approval(s, packet)
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "RULE_CONFLICT"
