"""Published MyVMS demo: ephemeral inference never writes project evidence."""

import base64
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from io import BytesIO

from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.api.deps import CurrentUser, DbSession, OptionalUser
from app.api.v1.videos import _detect_uploaded_image
from app.core.config import settings
from app.core.security import create_access_token, decode_access_token
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.live_demo import (
    LiveDemoCameraDTO,
    LiveDemoConfigDTO,
    LiveDemoObservationDTO,
    LiveDemoSessionDTO,
)
from app.services import myvms
from app.services.access_policy import resolve_context

router = APIRouter(prefix="/live-demo", tags=["Live-демонстрация MyVMS"])
_inference_slots = threading.BoundedSemaphore(2)
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}


def require_demo(db, project_id, user):
    ctx = resolve_context(db, project_id, user, permission="camera.read")
    if not ctx.is_demo or ctx.project.lifecycle != "active":
        raise HTTPException(404, "Live-демонстрация доступна в демо-объекте")
    return ctx


@router.get("/config", response_model=LiveDemoConfigDTO)
def config(project_id: uuid.UUID, db: DbSession, current_user: CurrentUser):
    require_demo(db, project_id, current_user)
    return LiveDemoConfigDTO(
        enabled=myvms.configured(),
        cameras=[
            LiveDemoCameraDTO(channel=i, name=f"Camera {i + 1}") for i in myvms.channels()
        ]
        if myvms.configured()
        else [],
        analysis_interval_ms=2000,
    )


@router.post("/{channel}/analyze", response_model=LiveDemoObservationDTO)
async def analyze(
    channel: int,
    project_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    response: Response,
):
    require_demo(db, project_id, current_user)
    myvms.require_channel(channel)
    if not _inference_slots.acquire(blocking=False):
        raise HTTPException(429, "Live-анализ занят; повторите через несколько секунд")
    try:
        frame = await myvms.capture(channel)
        captured_at = datetime.now(UTC)
        started = time.monotonic()
        try:
            analysis = await _detect_uploaded_image(
                UploadFile(file=BytesIO(frame), filename="live.jpg"), None, photo=False
            )
            result, error = analysis, None
        except HTTPException as exc:
            result, error = None, str(exc.detail)
        response.headers.update(PRIVATE)
        return LiveDemoObservationDTO(
            channel=channel,
            captured_at=captured_at,
            frame="data:image/jpeg;base64," + base64.b64encode(frame).decode(),
            analysis=result,
            analysis_error=error,
            inference_ms=round((time.monotonic() - started) * 1000),
        )
    finally:
        _inference_slots.release()


@router.post("/{channel}/session", response_model=LiveDemoSessionDTO)
def session(
    channel: int,
    project_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    response: Response,
):
    require_demo(db, project_id, current_user)
    myvms.require_channel(channel)
    lifetime = timedelta(minutes=5)
    path = f"{settings.api_v1_prefix}/live-demo/{channel}/stream"
    token = create_access_token(
        {
            "purpose": "myvms_live",
            "aud": "myvms-live",
            "sub": current_user.username,
            "user_id": str(current_user.id),
            "project_id": str(project_id),
            "channel": channel,
        },
        expires_delta=lifetime,
    )
    response.set_cookie(
        "stroy_live_demo",
        token,
        max_age=int(lifetime.total_seconds()),
        path=path,
        httponly=True,
        secure=settings.environment == "prod",
        samesite="strict",
    )
    response.headers.update(PRIVATE)
    return LiveDemoSessionDTO(media_url=f"{path}?project_id={project_id}", expires_in=300)


def stream_user(db, request, user, project_id, channel):
    if user is not None:
        return user, time.time() + 300
    if request.headers.get("authorization"):
        raise HTTPException(401, "Необходима авторизация")
    claims = decode_access_token(request.cookies.get("stroy_live_demo", "")) or {}
    if (
        claims.get("purpose") != "myvms_live"
        or claims.get("aud") != "myvms-live"
        or claims.get("project_id") != str(project_id)
        or claims.get("channel") != channel
    ):
        raise HTTPException(401, "Обновите сеанс просмотра live-камеры")
    try:
        user = db.get(User, uuid.UUID(claims["user_id"]))
        expiry = float(claims["exp"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(401, "Необходима авторизация") from None
    if user is None or not user.is_active or user.username != claims.get("sub"):
        raise HTTPException(401, "Необходима авторизация")
    return user, expiry


@router.get("/{channel}/stream")
async def stream(
    channel: int,
    project_id: uuid.UUID,
    request: Request,
    db: DbSession,
    current_user: OptionalUser,
):
    user, expiry = stream_user(db, request, current_user, project_id, channel)
    require_demo(db, project_id, user)
    myvms.require_channel(channel)
    # Enter before sending HTTP 200 so upstream failures have a useful JSON status.
    resource = myvms.open_resource(channel, "streaming/main.mp4")
    upstream = await resource.__aenter__()
    if not upstream.headers.get("content-type", "").startswith("video/mp4"):
        await resource.__aexit__(None, None, None)
        raise HTTPException(502, "MyVMS не вернул MP4-поток")
    user_id = user.id

    async def chunks():
        checked_at = time.monotonic()
        try:
            async for chunk in upstream.aiter_bytes():
                if time.time() >= expiry or not myvms.configured():
                    break
                if time.monotonic() - checked_at >= 5:
                    # A withdrawn publication or disabled account stops an open stream.
                    with SessionLocal() as current_db:
                        active = current_db.get(User, user_id)
                        if active is None or not active.is_active:
                            break
                        try:
                            require_demo(current_db, project_id, active)
                            myvms.require_channel(channel)
                        except HTTPException:
                            break
                    checked_at = time.monotonic()
                yield chunk
        finally:
            await resource.__aexit__(None, None, None)

    return StreamingResponse(chunks(), media_type="video/mp4", headers=PRIVATE)
