"""Independent adversarial checks for review findings across current grants."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy import delete

from app.models import Camera, ScheduleTask, Zone
from app.models.customer_control import (
    AssignmentArea,
    CameraShare,
    ControlRelease,
    ControlReleaseItem,
    DocumentShare,
    ReleaseStatus,
    ResponsibilityArea,
)
from tests import test_customer_control_http, test_customer_control_workflow
from tests.customer_control_testdata import approved_requirement

customer_http = test_customer_control_http.customer_http


def test_published_camera_still_requires_the_actual_stage_scope(customer_http):
    s = customer_http
    project = s.projects["a"].id
    with s.sessions() as db:
        stage = ScheduleTask(
            project_id=project,
            zone_id=s.zone.id,
            name="Only stage in zone A",
            planned_start=datetime.now(UTC),
            planned_end=datetime.now(UTC) + timedelta(days=1),
        )
        other_zone = Zone(project_id=project, code="R1-OTHER", name="Other zone")
        db.add_all([stage, other_zone])
        db.flush()
        area = ResponsibilityArea(
            project_id=project,
            name="Stage-only scope",
            schedule_task_id=stage.id,
        )
        camera = Camera(
            project_id=project,
            zone_id=other_zone.id,
            code="R1-WRONG-CAMERA",
            name="Outside stage zone",
        )
        db.add_all([area, camera])
        db.flush()
        db.execute(
            delete(AssignmentArea).where(
                AssignmentArea.assignment_id == s.assignments["foreman1"].id
            )
        )
        db.add(
            AssignmentArea(assignment_id=s.assignments["foreman1"].id, area_id=area.id)
        )
        # A bad historical share must not become an authority to bypass actual scope.
        db.add(
            CameraShare(
                project_id=project,
                participation_id=s.participations["k1"].id,
                area_id=area.id,
                camera_id=camera.id,
                active=True,
            )
        )
        db.commit()
    response = s.client.get(
        f"/api/v1/projects/{project}/cameras", headers=s.headers("foreman1")
    )
    assert response.status_code == 200, response.text
    assert str(camera.id) not in response.text
    rejected = s.client.post(
        f"/api/v1/customer-control/projects/{project}/sources/camera/{camera.id}/shares",
        headers={**s.headers(), "Idempotency-Key": str(uuid4())},
        json={
            "participation_id": str(s.participations["k1"].id),
            "area_id": str(area.id),
        },
    )
    assert rejected.status_code == 422, rejected.text


def test_responsibility_transfer_requires_a_new_submission(customer_http):
    s = customer_http
    current, submission = test_customer_control_workflow._ready_for_review(s)
    response = s.client.post(
        f"/api/v1/customer-control/incidents/{s.incidents['k1'].id}/assignments",
        headers={**s.headers(), "Idempotency-Key": str(uuid4())},
        json={
            "expected_version": current["row_version"],
            "responsible_participation_id": str(s.participations["k2"].id),
            "assignee_assignment_id": str(s.assignments["foreman2"].id),
            "area_id": str(s.area.id),
            "note": "Responsibility transferred explicitly",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "confirmed"
    accept = test_customer_control_workflow._command(
        s,
        "manager2",
        "accept_remediation",
        response.json()["row_version"],
        submission_id=str(submission.id),
        note="Old contractor cannot satisfy new duty",
    )
    assert accept.status_code == 409, accept.text


def test_inherited_revision_does_not_disclose_another_contractors_draft(customer_http):
    s = customer_http
    with s.sessions() as db:
        base = approved_requirement(
            db,
            s.projects["a"],
            datetime.now(UTC),
            zone=s.zone,
            area=s.area,
            grants=SimpleNamespace(
                user=s.users["pto1"],
                participation=s.participations["k1"],
                assignment=s.assignments["pto1"],
            ),
        )
        base.release.approved_by = s.users["manager"].id
        base.release.approved_assignment_id = s.assignments["manager"].id
        draft = ControlRelease(
            project_id=s.projects["a"].id,
            sequence=2,
            status=ReleaseStatus.DRAFT,
            base_release_id=base.release.id,
            submitted_by=s.users["foreman2"].id,
            submitted_assignment_id=s.assignments["foreman2"].id,
            manifest_sha256="d" * 64,
        )
        db.add(draft)
        db.flush()
        db.add(ControlReleaseItem(release_id=draft.id, revision_id=base.revision.id))
        db.commit()
    response = s.client.get(
        f"/api/v1/customer-control/projects/{s.projects['a'].id}/control-releases",
        headers=s.headers("pto1"),
    )
    assert response.status_code == 200, response.text
    assert str(base.release.id) in response.text
    assert str(draft.id) not in response.text


def test_demo_audit_is_safe_without_a_synthetic_assignment(customer_http):
    s = customer_http
    response = s.client.get(
        f"/api/v1/customer-control/projects/{s.projects['demo'].id}/audit",
        headers=s.headers("unassigned"),
    )
    assert response.status_code == 200, response.text
    assert response.json() == []


def test_foreman_cannot_read_pto_draft_and_full_share_is_read_only(
    customer_http, monkeypatch
):
    s = customer_http
    project = s.projects["a"].id
    own_doc = s.documents["k1"].id
    foreign_doc = s.documents["k2"].id
    prefix = f"/api/v1/projects/{project}/ppr-documents"
    assert s.client.get(prefix, headers=s.headers("foreman1")).json() == []
    assert (
        s.client.get(
            f"{prefix}/{own_doc}/original", headers=s.headers("foreman1")
        ).status_code
        == 404
    )
    assert (
        s.client.get(
            f"{prefix}/{own_doc}/original", headers=s.headers("pto1")
        ).status_code
        == 200
    )
    with s.sessions() as db:
        db.add(
            DocumentShare(
                project_id=project,
                participation_id=s.participations["k1"].id,
                document_id=foreign_doc,
                area_id=s.area.id,
                read_kind="full",
                active=True,
            )
        )
        db.commit()
    shared = s.client.get(f"{prefix}/{foreign_doc}/original", headers=s.headers("pto1"))
    assert shared.status_code == 200, shared.text
    monkeypatch.setattr(
        "app.api.v1.ppr_documents.request_analysis",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("Read share started analysis")
        ),
    )
    response = s.client.post(
        f"{prefix}/{foreign_doc}/analyze",
        headers={**s.headers("pto1"), "Idempotency-Key": str(uuid4())},
    )
    assert response.status_code in (403, 404), response.text


def test_legacy_broad_report_is_denied_before_any_generation(customer_http, monkeypatch):
    s = customer_http
    monkeypatch.setattr(
        "app.api.v1.reports.generate_report",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("Broad report generated")
        ),
    )
    response = s.client.post(
        "/api/v1/reports/generate",
        headers=s.headers("pto1"),
        json={"project_id": str(s.projects["a"].id), "period": "day"},
    )
    assert response.status_code == 403, response.text
