"""Only the explicit demo crosses tenants, and every writer sees it as immutable."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.api.v1.incidents import _incident_for_user, get_incidents, update_incident_status
from app.api.v1.projects import (
    create_project,
    delete_project,
    get_project,
    list_projects,
    update_project,
)
from app.api.v1.safety import project_access
from app.api.v1.videos import list_videos
from app.core.config import settings
from app.models import Incident, Project, User, UserRole, VideoAsset
from app.models.customer_control import IncidentBasis
from app.models.enums import IncidentCategory, IncidentType
from app.schemas.stroy_control import (
    IncidentStatusUpdateRequest,
    ProjectCreate,
    ProjectUpdate,
)
from app.services.incident_workflow import digest
from app.services.management.context import require_project
from app.services.project_access import is_shared_demo
from tests import test_video_service
from tests.customer_control_fixtures import customer

sqlite_session = test_video_service.sqlite_session


def test_only_designated_demo_is_shared_across_all_modules(
    sqlite_session, tmp_path, monkeypatch
):
    db = sqlite_session
    jury = User(username="jury", name="Jury", role=UserRole.ADMIN)
    viewer = User(username="viewer", name="Viewer", role=UserRole.VIEWER)
    demo = Project(
        code="MANAGEMENT-DEMO", name="Демонстрационный объект", kind="shared_demo"
    )
    own = Project(code="JURY", name="Jury private", owner_username="jury")
    foreign = Project(code="PRIVATE", name="Other private", owner_username="other")
    unowned = Project(code="OLD-TEST", name="Unassigned holding")
    db.add_all([jury, viewer, demo, own, foreign, unowned])
    db.flush()
    customer(db, own, jury)
    incidents = []
    for project in (demo, own, foreign, unowned):
        incident = Incident(
            code="INC-" + project.code,
            project_id=project.id,
            category=IncidentCategory.EQUIPMENT,
            type=IncidentType.EQUIPMENT_MISSING,
            title="Synthetic observation",
            dedup_key=project.code,
            first_seen_at=datetime.now(UTC),
            last_seen_at=datetime.now(UTC),
        )
        db.add(incident)
        incidents.append(incident)
    db.flush()
    snapshot = {
        "project_id": str(demo.id),
        "provenance": "legacy",
        "observed_from": incidents[0].first_seen_at.isoformat(),
        "observed_until": incidents[0].last_seen_at.isoformat(),
        "citations": [],
        "sources": [],
        "source_evidence_ids": [],
        "coverage": {"status": "unknown", "reasons": ["unknown_geometry"]},
        "limitations": ["Explicit synthetic demonstration observation"],
    }
    db.add(
        IncidentBasis(
            incident_id=incidents[0].id, snapshot=snapshot, sha256=digest(snapshot)
        )
    )
    demo.demo_manifest = {"incident_ids": [str(incidents[0].id)]}
    db.commit()
    assert {p.id for p in list_projects(db, jury)} == {demo.id, own.id}
    assert {p.id for p in list_projects(db, viewer)} == {demo.id}
    assert {i.id for i in get_incidents(db, jury, project_id=own.id, limit=50)} == {
        incidents[1].id
    }
    assert {i.id for i in get_incidents(db, jury, project_id=demo.id, limit=50)} == {
        incidents[0].id
    }
    assert _incident_for_user(db, incidents[0].id, jury).id == incidents[0].id
    assert is_shared_demo(demo) and not is_shared_demo(unowned)
    monkeypatch.setattr(settings, "storage_local_root", tmp_path)
    media = tmp_path / "camera.mp4"
    media.write_bytes(b"synthetic bytes")
    video = VideoAsset(
        project_id=demo.id,
        filename=media.name,
        storage_key=str(media),
        start_timestamp=datetime.now(UTC),
        status="READY",
    )
    db.add(video)
    db.flush()
    demo.demo_manifest = {**demo.demo_manifest, "video_ids": [str(video.id)]}
    db.commit()
    assert len(list_videos(demo.id, db, jury)) == 1
    assert require_project(db, demo.id, viewer).id == demo.id
    with pytest.raises(HTTPException) as unpublished_legacy:
        project_access(db, demo.id, viewer)
    assert unpublished_legacy.value.status_code == 409
    for user in (jury, viewer):
        for action in (
            lambda user=user: require_project(db, demo.id, user, write=True),
            lambda user=user: project_access(db, demo.id, user, manage=True),
            lambda user=user: delete_project(demo.id, db, user),
            lambda user=user: update_project(
                demo.id, ProjectUpdate(name="Changed"), db, user
            ),
            lambda user=user: update_incident_status(
                incidents[0].id, IncidentStatusUpdateRequest(status="confirmed"), db, user
            ),
        ):
            with pytest.raises(HTTPException) as denied:
                action()
            assert denied.value.status_code == 403
    assert db.get(Project, demo.id).name == "Демонстрационный объект"
    for project in (foreign, unowned):
        for action in (
            lambda project=project: list_videos(project.id, db, jury),
            lambda project=project: require_project(db, project.id, jury),
            lambda project=project: project_access(db, project.id, jury),
            lambda project=project: get_project(project.id, db, jury),
            lambda project=project: delete_project(project.id, db, jury),
        ):
            with pytest.raises(HTTPException) as denied:
                action()
            assert denied.value.status_code == 404
    with pytest.raises(HTTPException) as retired:
        create_project(
            ProjectCreate(name="Needs explicit organization membership"), db, jury
        )
    assert retired.value.status_code == 409
    assert (
        update_project(
            own.id, ProjectUpdate(name="Собственный объект жюри"), db, jury
        ).name
        == "Собственный объект жюри"
    )
