"""API endpoints for Video streams, uploads, and playback synchronization."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from time import monotonic
from typing import Annotated, Any

import anyio
import httpx
from fastapi import (
    APIRouter,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import ValidationError

from app.api.deps import CurrentUser, DbSession, OptionalUser
from app.core.config import settings
from app.core.security import create_access_token, decode_access_token
from app.db.session import SessionLocal
from app.models.project import Camera
from app.models.user import User
from app.models.video import VideoAsset
from app.schemas.recording_analysis import (
    PlaybackClaims,
    PlaybackSessionDTO,
    RecordingAnalysisResultDTO,
    SavedRecordingDTO,
)
from app.schemas.stroy_control import (
    DetectionBoxItem,
    FrameDetectionResponse,
    VideoStatus,
    VideoSyncStatusResponse,
    VideoUploadResponse,
)
from app.services.access_policy import resolve_context, resource_query, resource_visible
from app.services.detector import MACHINERY_CLASSES
from app.services.detector_provider import get_detector
from app.services.trained_detector import decode_image
from app.services.video_service import VideoProjectNotFound, VideoService, VideoTooLarge

router = APIRouter(prefix="/videos", tags=["Видеоконтроль и камеры"])


@router.get("", response_model=list[SavedRecordingDTO])
def list_videos(
    project_id: uuid.UUID, db: DbSession, current_user: CurrentUser
) -> list[SavedRecordingDTO]:
    """Saved recordings of the selected project, with browser-safe media URLs."""
    ctx = resolve_context(db, project_id, current_user, permission="video.read")
    root = settings.storage_local_root.resolve()
    result = []
    for asset in db.scalars(
        resource_query(db, ctx, "video", VideoAsset)
        .where(VideoAsset.status == "READY")
        .order_by(VideoAsset.start_timestamp.asc(), VideoAsset.filename.asc())
    ):
        if not resource_visible(db, ctx, "video", asset.id):
            continue
        try:
            path = _video_path(asset)
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        try:
            path.relative_to(root)
        except ValueError:
            continue
        if not path.is_file():
            continue
        result.append(
            SavedRecordingDTO.model_validate(
                {
                    "video_id": str(asset.id),
                    "camera_id": str(asset.camera_id) if asset.camera_id else None,
                    "filename": asset.filename,
                    "start_timestamp": asset.start_timestamp.replace(
                        tzinfo=UTC
                    ).isoformat(),
                    "duration_seconds": asset.duration_seconds,
                    "media_url": f"/api/v1/videos/{asset.id}/media",
                    "analysis_status": asset.analysis_status,
                    "analysis_error": asset.analysis_error,
                    "analyzed_at": asset.analyzed_at.replace(tzinfo=UTC).isoformat()
                    if asset.analyzed_at
                    else None,
                    "analysis_result": RecordingAnalysisResultDTO.model_validate(
                        asset.analysis_result
                    )
                    if asset.analysis_result
                    and ctx.side == "customer"
                    and (ctx.is_demo or ctx.assignment.scope_kind == "project")
                    else None,
                }
            )
        )
    return result


def get_machinery_detector():
    """Load the detector once and reuse it for periodic live-frame inference."""
    return get_detector()


@router.get("/detector-status")
def detector_status(current_user: CurrentUser) -> dict[str, Any]:
    """Return the real YOLO runtime/weights state without running inference."""
    detector = get_machinery_detector()
    return {
        "ready": detector.is_ready,
        "status": detector.status,
        "message": detector.status_message,
        "weights_path": str(detector.weights_path).replace("\\", "/").rsplit("/", 1)[-1]
        if detector.weights_path
        else None,
        "model_sha256": getattr(detector, "sha256", None),
        "quality_verified": getattr(detector, "quality_verified", False),
        "evaluable_classes": getattr(detector, "evaluable_classes", []),
        "supported_classes": [value[0] for value in MACHINERY_CLASSES.values()],
        **(
            {
                "profile": detector.profile,
                "policy": detector.policy,
                "weight_paths": {
                    name: Path(value).name
                    for name, value in detector.weight_paths.items()
                },
                "compliance_enabled": detector.compliance_enabled,
                "supported_classes": detector.supported_classes,
                "unsupported_classes": detector.unsupported_classes,
            }
            if hasattr(detector, "profile")
            else {}
        ),
    }


@router.post("/construction-frame")
async def construction_frame(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    """Compatibility frame upload: the same sole trained YOLO, never VLM."""
    resolve_context(db, project_id, current_user, permission="video.analyze", write=True)
    result = await _detect_uploaded_image(file, None, photo=False)
    return {
        "profile": "construction_trained",
        "physical_machine_count": None,
        **result.model_dump(),
    }


@router.post("/upload", response_model=VideoUploadResponse)
async def upload_video(
    db: DbSession,
    current_user: CurrentUser,
    file: Annotated[UploadFile, File()],
    start_timestamp: Annotated[str, Form()],
    project_id: Annotated[uuid.UUID, Query()],
    area_id: uuid.UUID | None = None,
    camera_id: uuid.UUID | None = None,
) -> VideoUploadResponse:
    """Загрузить запись с временем съёмки и проверенной областью."""
    ctx = resolve_context(
        db, project_id, current_user, permission="video.upload", write=True, lock=True
    )
    from app.services.access_policy import require_area

    area = require_area(db, ctx, area_id) if area_id else None
    if ctx.side == "contractor" and area is None:
        raise HTTPException(422, "Укажите область ответственности записи")
    if camera_id:
        camera = _stream_camera(db, camera_id, current_user)
        if area and area.zone_id and camera.zone_id != area.zone_id:
            raise HTTPException(422, "Камера не соответствует области записи")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Имя файла не указано")

    # Parse timestamp
    try:
        cleaned_ts = start_timestamp.replace("Z", "+00:00").strip()
        if "T" in cleaned_ts:
            parsed_dt = datetime.fromisoformat(cleaned_ts)
        else:
            parsed_dt = datetime.strptime(cleaned_ts, "%Y-%m-%d %H:%M:%S")
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=UTC)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail="Неверная дата старта: используйте ISO 8601 или YYYY-MM-DD HH:MM:SS",
        ) from e

    service = VideoService(db)
    try:
        asset = await anyio.to_thread.run_sync(
            lambda: service.register_video_stream(
                file.file,
                file.filename,
                parsed_dt,
                project_id,
                owner_participation_id=ctx.participation.id,
                area_id=area_id,
                camera_id=camera_id,
            )
        )
    except VideoTooLarge as exc:
        raise HTTPException(413, str(exc)) from exc
    except VideoProjectNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    return VideoUploadResponse(
        video_id=asset.id,
        filename=asset.filename,
        start_timestamp=asset.start_timestamp,
        duration_seconds=asset.duration_seconds,
        fps=asset.fps,
        status=VideoStatus.READY,
        message="Видео успешно загружено и синхронизировано с календарным планом",
    )


@router.get("/{video_id}/sync", response_model=VideoSyncStatusResponse)
def sync_video(
    video_id: uuid.UUID,
    playback_seconds: float,
    db: DbSession,
    current_user: CurrentUser,
) -> VideoSyncStatusResponse:
    """Синхронизировать воспроизведение с календарным планом."""
    asset = db.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, "Видеозапись не найдена")
    _video_for_user(db, asset, current_user)
    service = VideoService(db)
    return service.sync_playback_time(video_id, playback_seconds)


@router.get("/cameras")
def get_cameras(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    if project_id is None:
        raise HTTPException(422, "Выберите объект строительства")
    ctx = resolve_context(db, project_id, current_user, permission="camera.read")
    cameras = db.scalars(resource_query(db, ctx, "camera", Camera))
    return [
        dict(
            id=str(c.id),
            code=c.code,
            name=c.name,
            project_id=str(c.project_id),
            zone_id=str(c.zone_id) if c.zone_id else None,
            stream_url=f"/api/v1/videos/proxy-stream?camera_id={c.id}"
            if c.stream_url
            else None,
            protocol="RTSP" if (c.stream_url or "").startswith("rtsp:") else "HLS",
            status=c.status.value,
        )
        for c in cameras
        if resource_visible(db, ctx, "camera", c.id)
    ]


@router.post("/detect-frame", response_model=FrameDetectionResponse)
async def detect_video_frame(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    stage_name: str | None = Form(None),
) -> FrameDetectionResponse:
    """YOLO-only video/camera frame. This path can never invoke a VLM."""
    resolve_context(db, project_id, current_user, permission="video.analyze", write=True)
    return await _detect_uploaded_image(file, stage_name, photo=False)


def get_photo_vlm():
    from app.services.photo_vlm import get_photo_vlm as factory

    return factory()


@router.post("/detect-photo", response_model=FrameDetectionResponse)
async def detect_photo(
    db: DbSession,
    current_user: CurrentUser,
    project_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    stage_name: str | None = Form(None),
) -> FrameDetectionResponse:
    """Still photograph: same trained YOLO first; bounded VLM only on success+empty."""
    resolve_context(db, project_id, current_user, permission="video.analyze", write=True)
    return await _detect_uploaded_image(file, stage_name, photo=True)


async def _detect_uploaded_image(file, stage_name, *, photo):
    contents = await file.read(settings.max_image_upload_bytes + 1)
    if len(contents) > settings.max_image_upload_bytes:
        raise HTTPException(413, "Изображение превышает допустимый размер")
    try:
        image = await anyio.to_thread.run_sync(decode_image, contents)
    except ValueError as exc:
        raise HTTPException(400, "Нужен корректный одиночный кадр изображения") from exc
    detector = await anyio.to_thread.run_sync(get_machinery_detector)
    if not detector.is_ready:
        raise HTTPException(503, detector.status_message or "YOLO недоступна")
    try:
        results = await anyio.to_thread.run_sync(
            detector.detect_frame, image, stage_name, False
        )
    except Exception as exc:
        raise HTTPException(502, "Ошибка распознавания YOLO; повторите запрос") from exc
    if not detector.is_ready or detector.status in {"inference_error", "model_error"}:
        raise HTTPException(502, "Ошибка распознавания YOLO; повторите запрос")
    source = "yolo"
    fallback_status = "not_needed" if photo and results else "not_requested"
    fallback_message = None
    if photo and not results:
        try:
            fallback = await get_photo_vlm().detect(contents)
            fallback_status, fallback_message = fallback.status, fallback.message
            if fallback.status == "used" and fallback.detections:
                results, source = fallback.detections, "vlm"
        except Exception:
            fallback_status = "error"
            fallback_message = (
                "Дополнительная визуальная проверка недоступна; результат YOLO сохранён"
            )
    items = [
        DetectionBoxItem(
            class_id=r.class_id,
            raw_label=r.raw_label,
            label_ru=r.label_ru,
            canonical_code=r.canonical_code,
            confidence=round(r.confidence, 2),
            x1=r.x1,
            y1=r.y1,
            x2=r.x2,
            y2=r.y2,
            top=round(r.y1 * 100, 2),
            left=round(r.x1 * 100, 2),
            width=round((r.x2 - r.x1) * 100, 2),
            height=round((r.y2 - r.y1) * 100, 2),
        )
        for r in results
    ]

    return FrameDetectionResponse(
        timestamp=datetime.now(UTC).isoformat(),
        active_stage=stage_name,
        model_ready=detector.is_ready,
        detector_status=detector.status,
        message=detector.status_message,
        count=len(items),
        detections=items,
        source=source,
        model_sha256=getattr(detector, "sha256", None),
        fallback_status=fallback_status,
        fallback_message=fallback_message,
        compliance_enabled=source == "yolo"
        and getattr(detector, "compliance_enabled", False),
        evaluable_classes=getattr(detector, "evaluable_classes", [])
        if source == "yolo"
        else [],
    )


@router.get("/proxy-stream")
async def proxy_camera_stream(
    db: DbSession,
    current_user: CurrentUser,
    camera_id: uuid.UUID | None = None,
    url: str | None = None,
):
    """Proxy only a persisted, authorized camera. Pin the validated destination."""
    camera = _stream_camera(db, camera_id, current_user)
    ctx = resolve_context(db, camera.project_id, current_user, permission="camera.read")
    selected_assignment = ctx.assignment.id if ctx.assignment else None
    from app.services.camera_view import validated_capture_url

    try:
        pinned, host, hostname = validated_capture_url(camera.stream_url or "")
    except (ValueError, OSError):
        raise HTTPException(
            422, "Адрес камеры не разрешён серверной сетевой политикой"
        ) from None
    if not pinned.startswith(("http://", "https://")):
        raise HTTPException(422, "Поток требует HTTP(S) шлюза камеры")
    client = httpx.AsyncClient(
        verify=True,
        follow_redirects=False,
        timeout=httpx.Timeout(connect=3.5, read=30, write=5.0, pool=5.0),
        trust_env=False,
    )
    try:
        request = client.build_request(
            "GET", pinned, headers={"Host": host}, extensions={"sni_hostname": hostname}
        )
        upstream = await client.send(request, stream=True)
        upstream.raise_for_status()
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, "Поток камеры временно недоступен") from None

    async def chunks():
        checked_at = monotonic()
        try:
            async for chunk in upstream.aiter_bytes():
                if monotonic() - checked_at >= 5:
                    if not _stream_access_current(
                        camera.project_id,
                        camera.id,
                        current_user.id,
                        selected_assignment,
                    ):
                        break
                    checked_at = monotonic()
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        chunks(),
        media_type=upstream.headers.get("content-type", "application/octet-stream"),
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _stream_access_current(project_id, camera_id, user_id, assignment_id):
    """An already-open stream stops after its current assignment is withdrawn."""
    with SessionLocal() as current_db:
        user = current_db.get(User, user_id)
        if user is None or not user.is_active:
            return False
        if assignment_id:
            current_db.info["assignment_id"] = assignment_id
        try:
            ctx = resolve_context(current_db, project_id, user, permission="camera.read")
            return resource_visible(current_db, ctx, "camera", camera_id)
        except HTTPException:
            return False


@router.get("/check-stream")
async def check_camera_stream(
    db: DbSession,
    current_user: CurrentUser,
    camera_id: uuid.UUID | None = None,
    url: str | None = None,
):
    camera = _stream_camera(db, camera_id, current_user, configure=True)
    from app.services.camera_view import capture_frame

    frame = await anyio.to_thread.run_sync(capture_frame, camera)
    return {
        "status": "online" if frame else "offline",
        "camera_id": str(camera.id),
        "message": "Кадр получен" if frame else "Кадр не получен",
    }


def _stream_camera(
    db: DbSession, camera_id: uuid.UUID | None, user, *, configure=False
) -> Camera:
    if camera_id is None:
        raise HTTPException(
            409,
            detail={
                "code": "WORKFLOW_UPGRADE_REQUIRED",
                "message": "Выберите сохранённую камеру",
            },
        )
    camera = db.get(Camera, camera_id)
    if camera is None:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    ctx = resolve_context(
        db,
        camera.project_id,
        user,
        permission="camera.configure" if configure else "camera.read",
    )
    if not resource_visible(db, ctx, "camera", camera.id):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return camera


def _video_path(asset: VideoAsset) -> Path:
    root = settings.storage_local_root.resolve()
    raw = Path(asset.storage_key)
    path = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return path


def _video_for_user(db: DbSession, asset: VideoAsset, user):
    ctx = resolve_context(db, asset.project_id, user, permission="video.read")
    if not resource_visible(db, ctx, "video", asset.id):
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return ctx


@router.post("/{video_id}/playback-session", response_model=PlaybackSessionDTO)
def playback_session(
    video_id: uuid.UUID,
    db: DbSession,
    current_user: CurrentUser,
    response: Response,
    idempotency_key: Annotated[uuid.UUID, Header(alias="Idempotency-Key")],
):
    asset = db.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    ctx = _video_for_user(db, asset, current_user)
    if not _video_path(asset).is_file():
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    lifetime = timedelta(minutes=10)
    token = create_access_token(
        {
            "purpose": "video_playback",
            "aud": "video-media",
            "sub": current_user.username,
            "user_id": str(current_user.id),
            "assignment_id": str(ctx.assignment.id) if ctx.assignment else None,
            "project_id": str(asset.project_id),
            "video_id": str(asset.id),
            "request_key": str(idempotency_key),
        },
        expires_delta=lifetime,
    )
    claims = PlaybackClaims.model_validate(decode_access_token(token))
    path = f"/api/v1/videos/{video_id}/media"
    response.set_cookie(
        key="stroy_playback",
        value=token,
        max_age=int(lifetime.total_seconds()),
        path=path,
        httponly=True,
        secure=settings.environment == "prod",
        samesite="strict",
    )
    response.headers["Cache-Control"] = "private, no-store"
    return PlaybackSessionDTO(
        media_url=path, expires_at=datetime.fromtimestamp(claims.exp, UTC)
    )


def _playback_cookie_user(db, request, video_id):
    raw = request.cookies.get("stroy_playback", "")
    payload = decode_access_token(raw)
    try:
        claims = PlaybackClaims.model_validate(payload)
    except ValidationError:
        raise HTTPException(401, detail="Необходима авторизация") from None
    if claims.video_id != video_id:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    user = db.get(User, claims.user_id)
    if user is None or not user.is_active or user.username != claims.sub:
        raise HTTPException(401, detail="Необходима авторизация")
    selected = db.info.get("assignment_id")
    if selected is not None and selected != claims.assignment_id:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    if claims.assignment_id is not None:
        db.info["assignment_id"] = claims.assignment_id
    else:
        db.info.pop("assignment_id", None)
    return user, claims


@router.head("/{video_id}/media", include_in_schema=False)
@router.get("/{video_id}/media")
def video_media(
    video_id: uuid.UUID,
    request: Request,
    db: DbSession,
    current_user: OptionalUser,
):
    claims = None
    if current_user is None:
        if request.headers.get("authorization"):
            raise HTTPException(401, detail="Необходима авторизация")
        current_user, claims = _playback_cookie_user(db, request, video_id)
    asset = db.get(VideoAsset, video_id)
    if asset is None:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    _video_for_user(db, asset, current_user)
    if claims and claims.project_id != asset.project_id:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    path = _video_path(asset)
    if not path.is_file():
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
