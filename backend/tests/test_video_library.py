"""Saved recordings stay project-scoped and never expose filesystem paths."""

import uuid
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.api.v1.videos import list_videos
from app.core.config import settings
from app.models.enums import UserRole
from app.models.project import Project
from app.models.user import User
from app.models.video import VideoAsset
from tests import test_video_service
from tests.customer_control_testdata import customer_grant

sqlite_session = test_video_service.sqlite_session


def test_library_scope_media_and_missing_files(sqlite_session, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "media")
    root = settings.storage_local_root
    root.mkdir()
    media = root / "Camera 2.mp4"
    media.write_bytes(b"fixture")
    outside = tmp_path / "private.mp4"
    outside.write_bytes(b"private")
    project = Project(code="LIBRARY", name="Site", owner_username="owner")
    other = Project(code="OTHER", name="Other", owner_username="owner")
    sqlite_session.add_all([project, other])
    sqlite_session.flush()
    for owner, filename, path, state in [
        (project, "Camera 2.mp4", media, "READY"),
        (project, "missing.mp4", root / "missing.mp4", "READY"),
        (project, "private.mp4", outside, "READY"),
        (project, "failed.mp4", media, "FAILED"),
        (other, "other.mp4", media, "READY"),
    ]:
        sqlite_session.add(
            VideoAsset(
                project_id=owner.id,
                filename=filename,
                storage_key=str(path),
                start_timestamp=datetime(2026, 10, 19, 7, 19, 26, tzinfo=UTC),
                status=state,
            )
        )
    owner = User(username="owner", name="Owner", role=UserRole.MANAGER)
    admin = User(username="library-admin", name="Admin", role=UserRole.ADMIN)
    stranger = User(username="stranger", name="Other", role=UserRole.ADMIN)
    sqlite_session.add_all([owner, admin, stranger])
    customer_grant(sqlite_session, project, owner)
    customer_grant(sqlite_session, project, admin)
    sqlite_session.commit()
    videos = list_videos(project.id, sqlite_session, owner)
    assert len(videos) == 1
    assert videos[0].filename == "Camera 2.mp4"
    assert videos[0].media_url == f"/api/v1/videos/{videos[0].video_id}/media"
    assert videos[0].analysis_status == "PENDING"
    assert videos[0].analysis_error is None
    assert videos[0].analyzed_at is None
    assert "storage_key" not in videos[0].model_dump()
    assert str(root) not in str(videos)
    assert len(list_videos(project.id, sqlite_session, admin)) == 1
    with pytest.raises(HTTPException) as error:
        list_videos(project.id, sqlite_session, stranger)
    assert error.value.status_code == 404


def test_library_missing_project_and_symlink(sqlite_session, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_local_root", tmp_path / "media")
    root = settings.storage_local_root
    root.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"private")
    link = root / "escape.mp4"
    link.symlink_to(outside)
    project = Project(code="LINK", name="Site", owner_username="owner")
    sqlite_session.add(project)
    sqlite_session.flush()
    sqlite_session.add(
        VideoAsset(
            project_id=project.id,
            filename="escape.mp4",
            storage_key=str(link),
            start_timestamp=datetime.now(UTC),
            status="READY",
        )
    )
    admin = User(username="symlink-admin", name="Admin", role=UserRole.ADMIN)
    sqlite_session.add(admin)
    customer_grant(sqlite_session, project, admin)
    sqlite_session.commit()
    assert list_videos(project.id, sqlite_session, admin) == []
    with pytest.raises(HTTPException) as error:
        list_videos(uuid.uuid4(), sqlite_session, admin)
    assert error.value.status_code == 404


def test_library_http_requires_authentication(sqlite_session):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.v1.videos import router
    from app.db.session import get_db

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: sqlite_session
    with TestClient(app) as client:
        response = client.get("/api/v1/videos", params={"project_id": str(uuid.uuid4())})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
