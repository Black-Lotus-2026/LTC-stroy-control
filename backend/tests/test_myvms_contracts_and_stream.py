"""Live-demo contracts, ephemeral effects, and withdrawal of an open stream."""

import itertools
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.api.v1 import live_demo
from app.core.config import settings
from app.core.security import create_access_token, decode_access_token
from app.db.base import Base
from app.main import app
from app.models import Project, User
from app.schemas.live_demo import (
    LiveDemoConfigDTO,
    LiveDemoObservationDTO,
    LiveDemoSessionDTO,
)
from tests import test_customer_control_http, test_myvms_live_demo

customer_http = test_customer_control_http.customer_http
live = test_myvms_live_demo.live
target = test_myvms_live_demo.target


def test_live_envelopes_are_published_from_the_same_pydantic_schemas(live):
    schemas = app.openapi()["paths"]
    for path, method, expected in (
        ("/api/v1/live-demo/config", "get", "LiveDemoConfigDTO"),
        ("/api/v1/live-demo/{channel}/analyze", "post", "LiveDemoObservationDTO"),
        ("/api/v1/live-demo/{channel}/session", "post", "LiveDemoSessionDTO"),
    ):
        response = schemas[path][method]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        assert response["$ref"].endswith("/" + expected)
    with pytest.raises(ValidationError):
        LiveDemoConfigDTO.model_validate(
            {
                "enabled": True,
                "cameras": [{"channel": 1024, "name": "unknown"}],
                "analysis_interval_ms": 2000,
            }
        )
    with pytest.raises(ValidationError):
        LiveDemoSessionDTO(media_url="https://foreign.invalid/stream", expires_in=300)
    with pytest.raises(ValidationError):
        LiveDemoObservationDTO.model_validate(
            {
                "channel": 1,
                "captured_at": "2026-10-20T10:00:00Z",
                "frame": "https://foreign.invalid/image",
                "analysis": None,
                "analysis_error": None,
                "inference_ms": 0,
            }
        )


def _files(root):
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in Path(root).rglob("*")
        if path.is_file()
    }


def test_live_inference_never_persists_any_business_row_or_evidence_file(live):
    s = live
    with s.sessions() as db:
        before = {
            table.name: db.scalar(select(func.count()).select_from(table))
            for table in Base.metadata.sorted_tables
        }
    roots = [
        settings.storage_local_root,
        settings.ppr_storage_root,
        settings.camera_view_storage_root,
    ]
    before_files = [_files(root) for root in roots]
    result = s.client.post(target(s, "1/analyze"), headers=s.headers("unassigned"))
    assert result.status_code == 200, result.text
    LiveDemoObservationDTO.model_validate(result.json())
    with s.sessions() as db:
        after = {
            table.name: db.scalar(select(func.count()).select_from(table))
            for table in Base.metadata.sorted_tables
        }
    assert before == after
    assert before_files == [_files(root) for root in roots]


@pytest.mark.parametrize("withdrawal", ["account", "project", "channel", "publication"])
def test_open_stream_withdrawal_closes_cleanly_before_the_next_chunk(
    live, monkeypatch, withdrawal
):
    s = live
    closed = []

    class Source(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"first-chunk"
            if withdrawal == "channel":
                monkeypatch.setattr(settings, "myvms_demo_channels", [2])
            elif withdrawal == "publication":
                monkeypatch.setattr(settings, "myvms_demo_enabled", False)
            else:
                with s.sessions() as db:
                    if withdrawal == "account":
                        db.get(User, s.users["unassigned"].id).is_active = False
                    else:
                        db.get(Project, s.projects["demo"].id).lifecycle = "archived"
                    db.commit()
            yield b"must-not-be-disclosed"

    @asynccontextmanager
    async def resource(channel, path):
        try:
            yield httpx.Response(
                200, stream=Source(), headers={"content-type": "video/mp4"}
            )
        finally:
            closed.append(True)

    monkeypatch.setattr(live_demo.myvms, "open_resource", resource)
    monkeypatch.setattr(live_demo, "SessionLocal", s.sessions)
    ticks = itertools.count(0, 6)
    monkeypatch.setattr(
        live_demo, "time", SimpleNamespace(time=time.time, monotonic=lambda: next(ticks))
    )
    issued = s.client.post(target(s, "1/session"), headers=s.headers("unassigned"))
    assert issued.status_code == 200, issued.text
    result = s.client.get(issued.json()["media_url"])
    assert result.status_code == 200
    assert result.content == b"first-chunk"
    assert closed == [True]


@pytest.mark.parametrize(
    "field,value",
    [
        ("purpose", "access"),
        ("aud", "other-audience"),
        ("sub", "another-user"),
        ("channel", 2),
        ("project_id", "00000000-0000-0000-0000-000000000000"),
        ("user_id", "00000000-0000-0000-0000-000000000000"),
    ],
)
def test_media_cookie_rejects_every_mismatched_binding_before_transport(
    live, monkeypatch, field, value
):
    s = live
    issued = s.client.post(target(s, "1/session"), headers=s.headers("unassigned"))
    claims = decode_access_token(issued.cookies.get("stroy_live_demo"))
    token = create_access_token(
        claims | {field: value}, expires_delta=timedelta(minutes=1)
    )
    monkeypatch.setattr(
        live_demo.myvms,
        "open_resource",
        lambda *args: pytest.fail("Invalid cookie opened transport"),
    )
    result = s.client.get(
        issued.json()["media_url"], headers={"Cookie": "stroy_live_demo=" + token}
    )
    assert result.status_code == 401, result.text


def test_expired_media_cookie_is_rejected_before_transport(live, monkeypatch):
    s = live
    issued = s.client.post(target(s, "1/session"), headers=s.headers("unassigned"))
    claims = decode_access_token(issued.cookies.get("stroy_live_demo"))
    token = create_access_token(claims, expires_delta=timedelta(minutes=-1))
    monkeypatch.setattr(
        live_demo.myvms,
        "open_resource",
        lambda *args: pytest.fail("Expired cookie opened transport"),
    )
    result = s.client.get(
        issued.json()["media_url"], headers={"Cookie": "stroy_live_demo=" + token}
    )
    assert result.status_code == 401, result.text
