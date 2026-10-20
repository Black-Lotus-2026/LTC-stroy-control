"""Real auth and demo policy, mocked transport/model; no private VMS in tests."""

import base64
from contextlib import asynccontextmanager
from io import BytesIO
from types import SimpleNamespace

import anyio
import httpx
import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import SecretStr
from sqlalchemy import func, select

from app.api.v1 import videos
from app.core.config import settings
from app.models import Camera, Incident, Project
from app.services import myvms
from app.services.detector import DetectionResult
from tests import test_customer_control_http

customer_http = test_customer_control_http.customer_http
capture_from_vms = myvms.capture


def jpeg():
    buf = BytesIO()
    Image.new("RGB", (100, 60), "green").save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def live(monkeypatch, customer_http):
    monkeypatch.setattr(settings, "myvms_demo_enabled", True)
    monkeypatch.setattr(settings, "myvms_base_url", "http://vms.example:9786")
    monkeypatch.setattr(settings, "myvms_username", "fixture-user")
    monkeypatch.setattr(settings, "myvms_password", SecretStr("fixture-secret"))
    monkeypatch.setattr(settings, "myvms_demo_channels", [1, 2])
    state = customer_http
    state.frame = jpeg()
    state.calls = []

    async def capture(channel):
        state.calls.append(channel)
        return state.frame

    monkeypatch.setattr(myvms, "capture", capture)
    detector = SimpleNamespace(
        is_ready=True,
        status="ready",
        status_message="Synthetic test detector",
        compliance_enabled=False,
        evaluable_classes=[],
        sha256="fixture-sha",
    )

    def detect(image, stage_name, slicing):
        assert image.size == (100, 60)
        assert not slicing
        return [
            DetectionResult(
                0,
                "excavator",
                "Экскаватор",
                "MACHINERY_EXCAVATOR",
                0.9,
                0.1,
                0.2,
                0.7,
                0.8,
            )
        ]

    detector.detect_frame = detect
    state.detector = detector
    monkeypatch.setattr(videos, "get_machinery_detector", lambda: detector)
    monkeypatch.setattr(
        videos,
        "get_photo_vlm",
        lambda: pytest.fail("Live video must never invoke a photo VLM"),
    )
    return state


def target(s, action="config", project="demo"):
    return f"/api/v1/live-demo/{action}?project_id={s.projects[project].id}"


def test_auth_opt_in_channels_and_no_credentials(live):
    s = live
    assert s.client.get(target(s)).status_code == 401
    assert s.client.post(target(s, "1/analyze")).status_code == 401
    config = s.client.get(target(s), headers=s.headers("unassigned"))
    assert config.status_code == 200
    assert [c["channel"] for c in config.json()["cameras"]] == [1, 2]
    assert "fixture-secret" not in config.text
    assert "fixture-user" not in config.text
    assert "vms.example" not in config.text
    assert s.client.post(target(s, "0/analyze"), headers=s.headers()).status_code == 404
    assert not s.calls


def test_live_cannot_be_projected_onto_private_or_foreign_projects(live):
    for project in ("a", "b"):
        for action, method in (
            ("config", "get"),
            ("1/analyze", "post"),
            ("1/session", "post"),
        ):
            result = getattr(live.client, method)(
                target(live, action, project), headers=live.headers()
            )
            assert result.status_code == 404
    assert not live.calls


def test_demo_inference_uses_exact_frame_and_never_writes_project(live):
    s = live
    with s.sessions() as db:
        before = [
            db.scalar(select(func.count()).select_from(m))
            for m in (Project, Camera, Incident)
        ]
    response = s.client.post(target(s, "1/analyze"), headers=s.headers("unassigned"))
    assert response.status_code == 200
    result = response.json()
    assert base64.b64decode(result["frame"].split(",")[1]) == s.frame
    assert result["channel"] == 1 and result["captured_at"]
    assert result["analysis"]["detections"][0]["label_ru"] == "Экскаватор"
    assert result["analysis"]["source"] == "yolo"
    assert result["analysis_error"] is None
    assert "no-store" in response.headers["cache-control"]
    with s.sessions() as db:
        after = [
            db.scalar(select(func.count()).select_from(m))
            for m in (Project, Camera, Incident)
        ]
    assert before == after


def test_unavailable_model_is_not_an_empty_success(live):
    live.detector.is_ready = False
    live.detector.status_message = "Weights unavailable"
    response = live.client.post(target(live, "2/analyze"), headers=live.headers())
    assert response.status_code == 200
    result = response.json()
    assert result["frame"].startswith("data:image/jpeg;base64,")
    assert result["analysis"] is None
    assert result["analysis_error"] == "Weights unavailable"


def test_camera_failure_has_no_old_frame_or_false_detections(live, monkeypatch):
    async def offline(channel):
        raise HTTPException(502, "Камера сейчас недоступна")

    monkeypatch.setattr(myvms, "capture", offline)
    response = live.client.post(target(live, "2/analyze"), headers=live.headers())
    assert response.status_code == 502
    assert "frame" not in response.json()


def test_disabled_publication_blocks_all_media(live, monkeypatch):
    monkeypatch.setattr(settings, "myvms_demo_enabled", False)
    assert (
        live.client.get(target(live), headers=live.headers()).json()["enabled"] is False
    )
    for action in ("1/analyze", "1/session"):
        assert (
            live.client.post(target(live, action), headers=live.headers()).status_code
            == 404
        )
    assert (
        live.client.get(target(live, "1/stream"), headers=live.headers()).status_code
        == 404
    )


def test_media_cookie_scopes_and_rechecks_active_user(live, monkeypatch):
    @asynccontextmanager
    async def resource(channel, path):
        assert channel == 1 and path == "streaming/main.mp4"
        yield httpx.Response(
            200, content=b"synthetic-mp4", headers={"content-type": "video/mp4"}
        )

    monkeypatch.setattr(myvms, "open_resource", resource)
    s = live
    issued = s.client.post(target(s, "1/session"), headers=s.headers("unassigned"))
    assert issued.status_code == 200
    cookie = issued.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert "Path=/api/v1/live-demo/1/stream" in cookie
    media = s.client.get(issued.json()["media_url"])
    assert media.status_code == 200 and media.content == b"synthetic-mp4"
    assert "no-store" in media.headers["cache-control"]
    token = issued.cookies.get("stroy_live_demo")
    injected = {"Cookie": "stroy_live_demo=" + token}
    assert s.client.get(target(s, "2/stream"), headers=injected).status_code == 401
    assert s.client.get(target(s, "1/stream", "a"), headers=injected).status_code == 401
    # A media token is never accepted as a general access token.
    assert (
        s.client.get(target(s), headers={"Authorization": "Bearer " + token}).status_code
        == 401
    )
    with s.sessions() as db:
        user = db.get(type(s.users["unassigned"]), s.users["unassigned"].id)
        user.is_active = False
        db.commit()
    assert s.client.get(issued.json()["media_url"]).status_code == 401


def test_adapter_pins_host_keeps_auth_server_side_and_rejects_redirects(
    live, monkeypatch
):
    monkeypatch.setattr(myvms, "capture", capture_from_vms)
    requests = []
    status = [200]

    def handle(request):
        requests.append(request)
        return httpx.Response(
            status[0],
            content=live.frame,
            headers={
                "Content-Type": "image/jpeg",
                "Location": "http://127.0.0.1/secret",
            },
        )

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        myvms,
        "validated_capture_url",
        lambda url: (
            url.replace("vms.example", "93.184.216.34"),
            "vms.example:9786",
            "vms.example",
        ),
    )
    monkeypatch.setattr(
        myvms.httpx,
        "AsyncClient",
        lambda **kw: original_client(**kw, transport=httpx.MockTransport(handle)),
    )
    assert anyio.run(myvms.capture, 1) == live.frame
    req = requests[0]
    assert req.url.host == "93.184.216.34"
    assert req.headers["host"] == "vms.example:9786"
    assert req.headers["authorization"].startswith("Basic ")
    assert req.url.path == "/cameras/1/image"
    status[0] = 302
    with pytest.raises(HTTPException) as error:
        anyio.run(myvms.capture, 1)
    assert error.value.status_code == 502
    assert len(requests) == 2  # No request follows the redirect.


@pytest.mark.parametrize("problem", ["oversized", "wrong_mime", "truncated"])
def test_adapter_bounds_image_and_rejects_wrong_mime(live, monkeypatch, problem):
    monkeypatch.setattr(myvms, "capture", capture_from_vms)
    if problem == "oversized":
        monkeypatch.setattr(myvms, "MAX_FRAME_BYTES", 32)

    @asynccontextmanager
    async def resource(channel, path):
        yield httpx.Response(
            200,
            content=live.frame[:-2] if problem == "truncated" else live.frame,
            headers={
                "content-type": "text/html" if problem == "wrong_mime" else "image/jpeg"
            },
        )

    monkeypatch.setattr(myvms, "open_resource", resource)
    with pytest.raises(HTTPException) as error:
        anyio.run(myvms.capture, 1)
    assert error.value.status_code == 502
