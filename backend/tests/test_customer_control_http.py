"""Independent R1 checks through the complete ASGI application and real JWTs."""

from __future__ import annotations

import hashlib
import io
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from sqlalchemy import create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import create_access_token
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Camera, Incident, PprDocument, Project, User, UserRole, Zone
from app.models.customer_control import (
    AssignmentArea,
    DocumentSeries,
    DocumentShare,
    EvidenceDisclosure,
    IncidentBasis,
    Organization,
    OrganizationMembership,
    ParticipationPeriod,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ResponsibilityArea,
)
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.models.video import VideoAsset
from tests.test_customer_control_migration import migration_postgres  # noqa: F401


@compiles(JSONB, "sqlite")
def _jsonb_sqlite(type_, compiler, **kwargs):
    return "JSON"


def _pdf_bytes():
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_blank_page(width=220, height=220)
    writer.write(stream)
    return stream.getvalue()


@pytest.fixture
def customer_http(tmp_path, monkeypatch, request):
    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "storage")
    monkeypatch.setattr(settings, "ppr_storage_root", tmp_path / "documents")
    monkeypatch.setattr(settings, "camera_view_storage_root", tmp_path / "camera-views")
    settings.storage_local_root.mkdir()
    settings.ppr_storage_root.mkdir()
    if getattr(request, "param", None) == "postgres":
        postgres = request.getfixturevalue("migration_postgres")
        postgres.migrate("head")
        engine = postgres.engine
    else:
        engine = create_engine(
            "sqlite://",
            poolclass=StaticPool,
            connect_args={"check_same_thread": False},
        )

        @event.listens_for(engine, "connect")
        def _foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    state = SimpleNamespace(sessions=sessions, engine=engine, root=tmp_path)
    with sessions() as db:
        organizations = {
            name: Organization(name=name)
            for name in ("customer_a", "customer_b", "k1", "k2")
        }
        db.add_all(organizations.values())
        users = {
            name: User(username="r1-" + name, name=name, role=UserRole.ADMIN)
            for name in (
                "manager",
                "manager2",
                "manager_b",
                "foreman1",
                "foreman2",
                "pto1",
                "viewer",
                "unassigned",
            )
        }
        db.add_all(users.values())
        db.flush()
        projects = {
            "a": Project(
                code="R1-A",
                name="Private A",
                customer_organization_id=organizations["customer_a"].id,
                authorization_version=2,
            ),
            "b": Project(
                code="R1-B",
                name="Private B",
                customer_organization_id=organizations["customer_b"].id,
                authorization_version=2,
            ),
            "demo": Project(
                code="MANAGEMENT-DEMO",
                name="Immutable demo",
                kind="shared_demo",
                authorization_version=2,
            ),
        }
        db.add_all(projects.values())
        db.flush()
        participations = {
            "customer_a": ProjectOrganization(
                project_id=projects["a"].id,
                organization_id=organizations["customer_a"].id,
                side="customer",
            ),
            "customer_b": ProjectOrganization(
                project_id=projects["b"].id,
                organization_id=organizations["customer_b"].id,
                side="customer",
            ),
            "k1": ProjectOrganization(
                project_id=projects["a"].id,
                organization_id=organizations["k1"].id,
                side="contractor",
            ),
            "k2": ProjectOrganization(
                project_id=projects["a"].id,
                organization_id=organizations["k2"].id,
                side="contractor",
            ),
        }
        db.add_all(participations.values())
        zone = Zone(
            project_id=projects["a"].id, code="R1-SHARED-ZONE", name="Overlapping zone"
        )
        db.add(zone)
        db.flush()
        area = ResponsibilityArea(
            project_id=projects["a"].id,
            name="Shared responsibility geography",
            zone_id=zone.id,
        )
        db.add(area)
        db.flush()
        grants = {
            "manager": ("customer_a", ProjectRole.CUSTOMER_MANAGER),
            "manager2": ("customer_a", ProjectRole.CUSTOMER_MANAGER),
            "manager_b": ("customer_b", ProjectRole.CUSTOMER_MANAGER),
            "foreman1": ("k1", ProjectRole.CONTRACTOR_FOREMAN),
            "foreman2": ("k2", ProjectRole.CONTRACTOR_FOREMAN),
            "pto1": ("k1", ProjectRole.PTO_ENGINEER),
            "viewer": ("customer_a", ProjectRole.PROJECT_VIEWER),
        }
        memberships, assignments = {}, {}
        for name, (org, role) in grants.items():
            membership = OrganizationMembership(
                organization_id=organizations[org].id, user_id=users[name].id
            )
            db.add(membership)
            db.flush()
            assignment = ProjectAssignment(
                participation_id=participations[org].id,
                membership_id=membership.id,
                role=role,
                scope_kind="areas" if org.startswith("k") else "project",
            )
            db.add(assignment)
            db.flush()
            if org.startswith("k"):
                db.add(AssignmentArea(assignment_id=assignment.id, area_id=area.id))
            memberships[name], assignments[name] = membership, assignment
        for participation in participations.values():
            db.add(ParticipationPeriod(participation_id=participation.id))
        at = datetime(2026, 10, 19, 10, tzinfo=UTC)
        incidents, documents, videos = {}, {}, {}
        for contractor in ("k1", "k2"):
            incident = Incident(
                code="R1-CASE-" + contractor,
                project_id=projects["a"].id,
                zone_id=zone.id,
                area_id=area.id,
                title="Private event " + contractor,
                category=IncidentCategory.EQUIPMENT,
                type=IncidentType.EQUIPMENT_MISSING,
                status=IncidentStatus.PENDING,
                priority=IncidentPriority.MEDIUM,
                dedup_key="r1-private-" + contractor,
                first_seen_at=at,
                last_seen_at=at,
                origin_participation_id=participations[contractor].id,
                responsible_participation_id=participations[contractor].id,
                assignee_assignment_id=assignments["foreman" + contractor[-1]].id,
                assigned_user_id=users["foreman" + contractor[-1]].id,
                explanation={"summary": "Synthetic regression observation"},
            )
            db.add(incident)
            db.flush()
            db.add(
                EvidenceDisclosure(
                    project_id=projects["a"].id,
                    participation_id=participations[contractor].id,
                    incident_id=incident.id,
                    area_id=area.id,
                )
            )
            basis = {
                "schema_version": 1,
                "project_id": str(projects["a"].id),
                "observed_from": at.isoformat(),
                "observed_until": at.isoformat(),
                "source_evidence_ids": [],
                "provenance": "legacy",
                "citations": [],
                "coverage": {"status": "unknown", "reasons": ["unknown_geometry"]},
                "limitations": ["Synthetic regression observation"],
            }
            db.add(
                IncidentBasis(
                    incident_id=incident.id,
                    snapshot=basis,
                    sha256=hashlib.sha256(contractor.encode()).hexdigest(),
                )
            )
            series = DocumentSeries(
                project_id=projects["a"].id,
                owner_participation_id=participations[contractor].id,
                title="Private series " + contractor,
            )
            db.add(series)
            db.flush()
            content = _pdf_bytes()
            key = contractor + "/original.pdf"
            path = settings.ppr_storage_root / key
            path.parent.mkdir()
            path.write_bytes(content)
            document = PprDocument(
                project_id=projects["a"].id,
                owner_participation_id=participations[contractor].id,
                series_id=series.id,
                area_id=area.id,
                filename="Private " + contractor + ".pdf",
                media_type="application/pdf",
                size_bytes=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
                storage_key=key,
                uploaded_by=contractor,
                preview_kind="pdf",
            )
            db.add(document)
            video_path = settings.storage_local_root / (contractor + ".mp4")
            video_path.write_bytes(
                b"explicit synthetic video bytes " + contractor.encode()
            )
            video = VideoAsset(
                project_id=projects["a"].id,
                area_id=area.id,
                owner_participation_id=participations[contractor].id,
                filename=contractor + ".mp4",
                storage_key=str(video_path),
                start_timestamp=at,
                status="READY",
            )
            db.add(video)
            incidents[contractor], documents[contractor], videos[contractor] = (
                incident,
                document,
                video,
            )
        camera = Camera(
            project_id=projects["a"].id,
            zone_id=zone.id,
            code="R1-CAMERA",
            name="Customer camera",
        )
        db.add(camera)
        db.commit()
    state.users, state.projects, state.participations = users, projects, participations
    state.assignments, state.memberships = assignments, memberships
    state.incidents, state.documents, state.videos = incidents, documents, videos
    state.area, state.zone, state.camera = area, zone, camera

    def headers(actor="manager", *, assignment=None, claims=None):
        token = create_access_token({"sub": users[actor].username, **(claims or {})})
        result = {"Authorization": "Bearer " + token}
        selected = assignment if assignment is not None else assignments.get(actor)
        if selected is not None:
            result["X-Project-Assignment"] = str(getattr(selected, "id", selected))
        return result

    def session():
        with sessions() as db:
            yield db

    state.headers = headers
    previous_overrides = app.dependency_overrides.copy()
    app.dependency_overrides[get_db] = session
    try:
        with TestClient(app) as client:
            state.client = client
            yield state
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        engine.dispose()


def test_customer_tenant_ids_and_global_legacy_admin_never_grant_access(customer_http):
    s = customer_http
    foreign = s.projects["b"].id
    for path in (
        f"/projects/{foreign}",
        f"/projects/{foreign}/zones",
        f"/projects/{foreign}/ppr-documents",
        f"/incidents?project_id={foreign}",
        f"/videos?project_id={foreign}",
    ):
        response = s.client.get("/api/v1" + path, headers=s.headers())
        assert response.status_code == 404, (path, response.text)
        assert "Private B" not in response.text
    assert (
        s.client.get(
            f"/api/v1/projects/{s.projects['a'].id}", headers=s.headers("unassigned")
        ).status_code
        == 404
    )
    forged = s.headers(
        "foreman1",
        assignment=s.assignments["manager"],
        claims={
            "role": "customer_manager",
            "organization_id": str(s.participations["customer_a"].organization_id),
        },
    )
    assert (
        s.client.get(f"/api/v1/projects/{s.projects['a'].id}", headers=forged).status_code
        == 404
    )


def test_overlapping_contractor_areas_do_not_share_private_cases_documents_or_recordings(
    customer_http,
):
    s = customer_http
    project = s.projects["a"].id
    headers = s.headers("foreman1")
    cases = s.client.get(f"/api/v1/incidents?project_id={project}", headers=headers)
    assert cases.status_code == 200, cases.text
    assert [row["id"] for row in cases.json()] == [str(s.incidents["k1"].id)]
    documents = s.client.get(
        f"/api/v1/projects/{project}/ppr-documents", headers=s.headers("pto1")
    )
    assert documents.status_code == 200, documents.text
    assert [row["id"] for row in documents.json()] == [str(s.documents["k1"].id)]
    assert (
        s.client.get(f"/api/v1/projects/{project}/ppr-documents", headers=headers).json()
        == []
    )
    recordings = s.client.get(f"/api/v1/videos?project_id={project}", headers=headers)
    assert recordings.status_code == 200, recordings.text
    assert [row["video_id"] for row in recordings.json()] == [str(s.videos["k1"].id)]
    for path in (
        f"/incidents/{s.incidents['k2'].id}/album",
        f"/projects/{project}/ppr-documents/{s.documents['k2'].id}/original",
        f"/videos/{s.videos['k2'].id}/media",
    ):
        response = s.client.get("/api/v1" + path, headers=headers)
        assert response.status_code == 404, (path, response.text)


def test_revocation_closes_old_jwt_assignment_original_range_and_assignee(customer_http):
    s = customer_http
    headers = s.headers("foreman1")
    with s.sessions() as db:
        db.add(
            DocumentShare(
                project_id=s.projects["a"].id,
                participation_id=s.participations["k1"].id,
                area_id=s.area.id,
                document_id=s.documents["k1"].id,
                read_kind="full",
                active=True,
            )
        )
        db.commit()
    original = (
        f"/api/v1/projects/{s.projects['a'].id}/ppr-documents/"
        f"{s.documents['k1'].id}/original"
    )
    assert s.client.get(original, headers=headers).status_code == 200
    with s.sessions() as db:
        db.get(ProjectAssignment, s.assignments["foreman1"].id).status = "revoked"
        db.commit()
    for path in (
        original,
        f"/api/v1/incidents/{s.incidents['k1'].id}/album",
        f"/api/v1/videos/{s.videos['k1'].id}/media",
    ):
        response = s.client.get(path, headers={**headers, "Range": "bytes=0-15"})
        assert response.status_code == 404, (path, response.text)


def test_ppr_engineer_and_foreman_cannot_change_control_camera_or_accept_legacy_status(
    customer_http,
):
    s = customer_http
    for actor in ("pto1", "foreman1", "viewer"):
        headers = s.headers(actor)
        response = s.client.patch(
            f"/api/v1/projects/{s.projects['a'].id}/cameras/{s.camera.id}",
            json={"stream_url": "http://127.0.0.1/unauthorized"},
            headers=headers,
        )
        assert response.status_code == 403, (actor, response.text)
        response = s.client.patch(
            "/api/v1/incidents/config",
            json={"violation_evaluation_window_seconds": 1},
            headers=headers,
        )
        assert response.status_code in {403, 409}
        response = s.client.patch(
            f"/api/v1/incidents/{s.incidents['k1'].id}/status",
            json={"status": "resolved"},
            headers=headers,
        )
        assert response.status_code in {403, 404, 409}
    with s.sessions() as db:
        assert db.get(Camera, s.camera.id).stream_url is None
        assert db.get(Incident, s.incidents["k1"].id).status == IncidentStatus.PENDING


def test_shared_demo_writes_have_no_database_or_file_side_effects(customer_http):
    s = customer_http
    demo = s.projects["demo"].id
    before_files = sorted(
        path.relative_to(s.root) for path in s.root.rglob("*") if path.is_file()
    )
    headers = s.headers()
    for method, path, body in (
        ("post", f"/projects/{demo}/zones", {"name": "Must not exist"}),
        ("post", f"/projects/{demo}/cameras", {"name": "Must not exist"}),
        ("patch", f"/projects/{demo}", {"name": "Must not change"}),
    ):
        response = getattr(s.client, method)("/api/v1" + path, json=body, headers=headers)
        assert response.status_code == 403, (path, response.text)
    response = s.client.post(
        f"/api/v1/projects/{demo}/ppr-documents",
        headers=headers,
        files={"file": ("blocked.pdf", _pdf_bytes(), "application/pdf")},
    )
    assert response.status_code == 403, response.text
    with s.sessions() as db:
        assert db.get(Project, demo).name == "Immutable demo"
        assert list(db.scalars(select(Zone).where(Zone.project_id == demo))) == []
        assert (
            list(db.scalars(select(PprDocument).where(PprDocument.project_id == demo)))
            == []
        )
    assert (
        sorted(path.relative_to(s.root) for path in s.root.rglob("*") if path.is_file())
        == before_files
    )


def test_private_storage_has_no_static_anonymous_or_range_gateway(customer_http):
    s = customer_http
    secret = settings.storage_local_root / "r1-secret.bin"
    secret.write_bytes(b"private evidence must remain inaccessible")
    for method in ("get", "head"):
        response = getattr(s.client, method)(
            "/media/r1-secret.bin", headers={"Range": "bytes=0-10"}
        )
        assert response.status_code in {401, 403, 404}, response.status_code
        assert b"private evidence" not in response.content


def test_untrusted_stream_url_and_raw_inference_are_rejected_before_network_access(
    customer_http, monkeypatch
):
    import app.api.v1.videos as videos_api

    s = customer_http

    def forbidden_network(*args, **kwargs):
        pytest.fail("An untrusted stream URL reached the network")

    monkeypatch.setattr(videos_api.httpx, "get", forbidden_network)
    for path in (
        "/api/v1/videos/proxy-stream?url=http://169.254.169.254/latest/meta-data",
        "/api/v1/videos/check-stream?url=http://127.0.0.1:8000/private",
    ):
        assert s.client.get(path, headers=s.headers("foreman1")).status_code in {
            403,
            409,
            422,
        }
