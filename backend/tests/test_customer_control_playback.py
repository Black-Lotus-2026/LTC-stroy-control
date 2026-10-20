"""Native video streams use a scoped cookie and recheck current grants for Range."""

from datetime import timedelta
from uuid import uuid4

import pytest

from app.core.security import create_access_token, decode_access_token
from app.models import Project, VideoAsset
from app.models.customer_control import (
    CameraShare,
    OrganizationMembership,
    ProjectAssignment,
)
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http


def _session(s, actor="foreman1", video=None):
    video = video or s.videos["k1"]
    return s.client.post(
        f"/api/v1/videos/{video.id}/playback-session",
        headers={**s.headers(actor), "Idempotency-Key": str(uuid4())},
    )


@pytest.mark.parametrize("revoke_membership", [False, True])
def test_native_range_cookie_is_scoped_and_revocation_applies_to_every_read(
    customer_http,
    revoke_membership,
):
    s = customer_http
    video = s.videos["k1"]
    response = _session(s)
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"media_url", "expires_at"}
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert f"Path=/api/v1/videos/{video.id}/media" in cookie
    assert "Max-Age=600" in cookie
    raw = cookie.split(";", 1)[0].split("=", 1)[1]
    claims = decode_access_token(raw)
    assert claims["purpose"] == "video_playback" and claims["aud"] == "video-media"
    assert claims["assignment_id"] == str(s.assignments["foreman1"].id)
    media = response.json()["media_url"]
    read = s.client.get(media, headers={"Range": "bytes=0-7"})
    assert read.status_code == 206, read.text
    assert read.content == b"explicit"
    assert read.headers["content-range"].startswith("bytes 0-7/")
    assert s.client.head(media).status_code == 200
    assert (
        s.client.get(
            media,
            headers={
                "X-Project-Assignment": str(s.assignments["foreman2"].id),
            },
        ).status_code
        == 404
    )
    assert (
        s.client.get(
            f"/api/v1/videos/{s.videos['k2'].id}/media",
            headers={"Cookie": "stroy_playback=" + raw},
        ).status_code
        == 404
    )
    # The same signature is deliberately unusable as an ordinary access JWT.
    assert (
        s.client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer " + raw}
        ).status_code
        == 401
    )
    assert (
        s.client.get(f"/api/v1/incidents?project_id={video.project_id}").status_code
        == 401
    )
    with s.sessions() as db:
        if revoke_membership:
            db.get(
                OrganizationMembership, s.memberships["foreman1"].id
            ).status = "revoked"
        else:
            db.get(ProjectAssignment, s.assignments["foreman1"].id).status = "revoked"
        db.commit()
    for method in (s.client.get, s.client.head):
        denied = method(media, headers={"Range": "bytes=0-7"})
        assert denied.status_code == 404, denied.text


def test_playback_sessions_reject_wrong_audience_expiry_and_foreign_sources(
    customer_http,
):
    s = customer_http
    denied = _session(s, video=s.videos["k2"])
    assert denied.status_code == 404, denied.text
    response = _session(s)
    assert response.status_code == 200, response.text
    raw = response.headers["set-cookie"].split(";", 1)[0].split("=", 1)[1]
    claims = decode_access_token(raw)
    media = response.json()["media_url"]
    for altered, duration in (
        ({**claims, "aud": "another-purpose"}, timedelta(minutes=1)),
        (claims, timedelta(minutes=-1)),
    ):
        bad = create_access_token(altered, expires_delta=duration)
        denied = s.client.get(media, headers={"Cookie": "stroy_playback=" + bad})
        assert denied.status_code == 401, denied.text
    s.client.cookies.clear()
    assert s.client.get(f"{media}?token={raw}").status_code == 401


def test_demo_read_session_needs_no_assignment_or_domain_mutation(customer_http):
    s = customer_http
    with s.sessions() as db:
        video = VideoAsset(
            project_id=s.projects["demo"].id,
            filename="demo.mp4",
            storage_key=s.videos["k1"].storage_key,
            start_timestamp=s.videos["k1"].start_timestamp,
            status="READY",
        )
        db.add(video)
        db.flush()
        db.get(Project, s.projects["demo"].id).demo_manifest = {
            "video_ids": [str(video.id)],
        }
        db.commit()
    response = _session(s, actor="unassigned", video=video)
    assert response.status_code == 200, response.text
    assert (
        s.client.get(
            response.json()["media_url"], headers={"Range": "bytes=0-3"}
        ).status_code
        == 206
    )


def test_live_stream_rechecks_current_source_share(customer_http, monkeypatch):
    from app.api.v1.videos import _stream_access_current

    s = customer_http
    monkeypatch.setattr("app.api.v1.videos.SessionLocal", s.sessions)
    args = (
        s.projects["a"].id,
        s.camera.id,
        s.users["foreman1"].id,
        s.assignments["foreman1"].id,
    )
    assert not _stream_access_current(*args)
    with s.sessions() as db:
        share = CameraShare(
            project_id=s.projects["a"].id,
            camera_id=s.camera.id,
            participation_id=s.participations["k1"].id,
            area_id=s.area.id,
        )
        db.add(share)
        db.commit()
    assert _stream_access_current(*args)
    with s.sessions() as db:
        db.get(CameraShare, share.id).active = False
        db.commit()
    assert not _stream_access_current(*args)
