"""HTTP-level project/camera/video boundaries for separate jury workspaces."""

from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.v1.projects import router as projects_router
from app.api.v1.videos import router as videos_router
from app.db.base import Base
from app.db.session import get_db
from app.models import Camera, Project, User, UserRole, Zone
from app.models.video import VideoAsset
from tests.customer_control_fixtures import customer
from tests.test_video_service import compile_jsonb_sqlite  # noqa: F401


def test_auth_project_scoping_and_no_camera_fallback(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine, expire_on_commit=False)
    with sessions() as db:
        user = User(username="jury-a", name="A", role=UserRole.MANAGER)
        a = Project(code="A", name="A", owner_username="jury-a")
        b = Project(code="B", name="B", owner_username="jury-b")
        demo = Project(
            code="MANAGEMENT-DEMO", name="Демонстрационный объект", owner_username=None
        )
        db.add_all([user, a, b, demo])
        db.flush()
        za = Zone(project_id=a.id, code="ZA", name="A")
        zb = Zone(project_id=b.id, code="ZB", name="B")
        db.add_all([za, zb])
        db.flush()
        ca = Camera(project_id=a.id, zone_id=za.id, code="CA", name="A")
        cb = Camera(project_id=b.id, zone_id=zb.id, code="CB", name="B")
        cd = Camera(project_id=demo.id, code="CD", name="Demo")
        video = VideoAsset(
            project_id=b.id,
            filename="private.mp4",
            storage_key=str(tmp_path / "private.mp4"),
            start_timestamp=datetime.now(UTC),
            status="READY",
        )
        db.add_all([ca, cb, cd, video])
        db.flush()
        demo.kind = "shared_demo"
        demo.demo_manifest = {"camera_ids": [str(cd.id)]}
        customer(db, a, user)
        db.commit()

    app = FastAPI()
    app.include_router(projects_router, prefix="/api/v1")
    app.include_router(videos_router, prefix="/api/v1")

    def session():
        with sessions() as db:
            yield db

    app.dependency_overrides[get_db] = session
    with TestClient(app) as client:
        for path in [
            f"/projects/{a.id}/zones",
            f"/projects/{a.id}/cameras",
            "/videos/cameras",
            f"/videos/{video.id}/sync?playback_seconds=0",
        ]:
            assert client.get("/api/v1" + path).status_code == 401
        assert (
            client.post(
                f"/api/v1/projects/{a.id}/cameras", json={"name": "No auth"}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/api/v1/videos/upload",
                params={"project_id": str(a.id)},
                files={"file": ("test.mp4", b"invalid")},
                data={"start_timestamp": "2026-10-19T10:00:00Z"},
            ).status_code
            == 401
        )
        app.dependency_overrides[get_current_user] = lambda: user
        for path in [
            f"/projects/{b.id}/zones",
            f"/projects/{b.id}/cameras",
            f"/videos/{video.id}/sync?playback_seconds=0",
        ]:
            assert client.get("/api/v1" + path).status_code == 404
        assert client.get("/api/v1/videos/cameras").status_code == 422
        assert {
            c["id"]
            for c in client.get(f"/api/v1/videos/cameras?project_id={a.id}").json()
        } == {str(ca.id)}
        assert {
            c["id"]
            for c in client.get(f"/api/v1/videos/cameras?project_id={demo.id}").json()
        } == {str(cd.id)}
        for project_id in [str(b.id), "invalid", str(uuid4())]:
            response = client.patch(
                f"/api/v1/projects/{project_id}/cameras/{cb.id}",
                json={"name": "Cross-project edit"},
            )
            assert response.status_code in {404, 422}
        assert (
            client.patch(
                f"/api/v1/projects/{a.id}/cameras/{cb.id}",
                json={"name": "Cross-project edit"},
            ).status_code
            == 404
        )
        assert (
            client.delete(f"/api/v1/projects/invalid/cameras/{cb.id}").status_code == 422
        )
        assert (
            client.post(
                f"/api/v1/projects/{a.id}/cameras",
                json={"name": "Wrong zone", "zone_id": str(zb.id)},
            ).status_code
            == 404
        )
        assert (
            client.patch(
                f"/api/v1/projects/{a.id}/cameras/{ca.id}", json={"zone_id": str(zb.id)}
            ).status_code
            == 404
        )
        assert (
            client.post(
                "/api/v1/videos/upload",
                params={"project_id": str(b.id)},
                files={"file": ("private.mp4", b"invalid")},
                data={"start_timestamp": "2026-10-19T10:00:00Z"},
            ).status_code
            == 404
        )
        assert (
            client.post(
                "/api/v1/videos/upload",
                files={"file": ("test.mp4", b"invalid")},
                data={"start_timestamp": "2026-10-19T10:00:00Z"},
            ).status_code
            == 422
        )
        assert (
            client.post(
                f"/api/v1/projects/{demo.id}/zones", json={"name": "Demo zone"}
            ).status_code
            == 403
        )
        assert (
            client.post(
                f"/api/v1/projects/{a.id}/cameras",
                json={"name": "Own new camera", "zone_id": str(za.id)},
            ).status_code
            == 201
        )
    with sessions() as db:
        assert db.get(Camera, cb.id).name == "B"
        assert db.get(Camera, ca.id).zone_id == za.id
    engine.dispose()
