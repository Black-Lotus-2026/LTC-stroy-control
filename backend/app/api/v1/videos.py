"""API endpoints for Video streams, uploads, and playback synchronization."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

import anyio
import httpx
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import DbSession
from app.models.project import Camera
from app.schemas.stroy_control import (
    DetectionBoxItem,
    FrameDetectionResponse,
    VideoStatus,
    VideoSyncStatusResponse,
    VideoUploadResponse,
)
from app.services.detector import MACHINERY_CLASSES, MachineryDetector
from app.services.video_service import VideoService

router = APIRouter(prefix="/videos", tags=["Видеоконтроль и камеры"])


@lru_cache(maxsize=1)
def get_machinery_detector() -> MachineryDetector:
    """Load the detector once and reuse it for periodic live-frame inference."""
    return MachineryDetector()


@router.get("/detector-status")
def detector_status() -> dict[str, Any]:
    """Return the real YOLO runtime/weights state without running inference."""
    detector = get_machinery_detector()
    return {
        "ready": detector.is_ready,
        "status": detector.status,
        "message": detector.status_message,
        "weights_path": str(detector.weights_path),
        "supported_classes": [value[0] for value in MACHINERY_CLASSES.values()],
    }


@router.post("/upload", response_model=VideoUploadResponse)
async def upload_video(
    db: DbSession,
    file: UploadFile = File(...),
    start_timestamp: str = Form(
        ..., description="Дата и время старта съемки (ISO 8601 или YYYY-MM-DD HH:MM:SS)"
    ),
    project_id: uuid.UUID | None = None,
) -> VideoUploadResponse:
    """Загрузить видеофайл для демонстрации с обязательным указанием времени старта съёмки."""
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
            detail=f"Неверный формат даты старта съемки: {e}. Используйте YYYY-MM-DD HH:MM:SS или ISO 8601",
        )

    content = await file.read()
    service = VideoService(db)
    asset = service.register_video(
        file_bytes=content,
        filename=file.filename,
        start_timestamp=parsed_dt,
        project_id=project_id,
    )

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
) -> VideoSyncStatusResponse:
    """Получить статус синхронизации и активный этап графика для текущего времени воспроизведения."""
    service = VideoService(db)
    return service.sync_playback_time(video_id, playback_seconds)


@router.get("/cameras")
def get_cameras(
    db: DbSession,
    project_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    """Получить список доступных камер площадки и их потоков."""
    query = select(Camera)
    if project_id:
        query = query.where(Camera.project_id == project_id)
    cameras = db.scalars(query).all()

    return [
        {
            "id": str(c.id),
            "code": c.code,
            "name": c.name,
            "project_id": str(c.project_id),
            "zone_id": str(c.zone_id) if c.zone_id else None,
            "stream_url": c.stream_url,
            "protocol": "RTSP" if "rtsp" in (c.stream_url or "").lower() else "HLS",
            "status": c.status.value if hasattr(c.status, "value") else str(c.status),
        }
        for c in cameras
    ]


@router.post("/detect-frame", response_model=FrameDetectionResponse)
async def detect_video_frame(
    file: UploadFile = File(...),
    stage_name: str | None = Form(None),
) -> FrameDetectionResponse:
    """Детектировать строительную технику на кадре видео с помощью AI / Computer Vision."""
    contents = await file.read()
    detector = get_machinery_detector()
    results = await anyio.to_thread.run_sync(
        detector.detect_frame, contents, stage_name, True
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
    )


@router.get("/proxy-stream")
async def proxy_camera_stream(
    url: str = Query(..., description="URL потока камеры (HTTP/HTTPS/MJPEG)")
):
    """Проксировать поток IP-камеры или VLC в обход CORS и самоподписанных SSL-сертификатов."""
    clean_url = url.strip()
    if not clean_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Поддерживаются только HTTP и HTTPS потоки (для RTSP используется нативное RTSP подключение)",
        )

    client = httpx.AsyncClient(
        verify=False,
        timeout=httpx.Timeout(connect=3.5, read=None, write=5.0, pool=5.0),
        trust_env=False,
    )

    try:
        req = client.build_request("GET", clean_url)
        r = await client.send(req, stream=True)
        r.raise_for_status()

        async def stream_generator():
            try:
                async for chunk in r.aiter_bytes():
                    yield chunk
            finally:
                await r.aclose()
                await client.aclose()

        headers = {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        }
        content_type = r.headers.get("content-type", "multipart/x-mixed-replace")

        return StreamingResponse(stream_generator(), media_type=content_type, headers=headers)
    except Exception as e:
        await client.aclose()
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось подключиться к камере по адресу {clean_url}: {e}",
        ) from e


@router.get("/check-stream")
async def check_camera_stream(
    url: str = Query(..., description="URL потока камеры для проверки связи")
):
    """Проверить доступность сетевой камеры (HTTP, HTTPS или RTSP) с диагностикой портов."""
    import socket
    from urllib.parse import urlparse

    clean_url = url.strip()
    p = urlparse(clean_url)
    host = p.hostname or "127.0.0.1"

    if clean_url.startswith("rtsp://"):
        port = p.port or 554
        try:
            s = socket.socket()
            s.settimeout(2.0)
            s.connect((host, port))
            s.close()
            return {
                "status": "online",
                "protocol": "RTSP",
                "host": host,
                "port": port,
                "url": clean_url,
                "message": f"RTSP порт {port} на {host} открыт и отвечает",
            }
        except Exception as err:
            return {
                "status": "offline",
                "protocol": "RTSP",
                "host": host,
                "port": port,
                "url": clean_url,
                "error": f"Ошибка подключения к RTSP: {err}",
            }
    elif clean_url.startswith(("http://", "https://")):
        port = p.port or (443 if clean_url.startswith("https") else 80)
        try:
            async with httpx.AsyncClient(
                verify=False, timeout=3.0, trust_env=False
            ) as client:
                resp = await client.get(clean_url)
                return {
                    "status": "online" if resp.status_code < 400 else "warning",
                    "protocol": "HTTP",
                    "host": host,
                    "port": port,
                    "url": clean_url,
                    "http_status": resp.status_code,
                    "content_type": resp.headers.get("content-type", ""),
                    "message": f"HTTP {resp.status_code} ({resp.headers.get('content-type', 'stream')})",
                }
        except Exception as err:
            # Check if RTSP port 8554 is open as suggestion
            rtsp_hint = None
            try:
                s = socket.socket()
                s.settimeout(0.5)
                s.connect((host, 8554))
                s.close()
                rtsp_hint = f"rtsp://{host}:8554/video"
            except Exception:
                pass

            return {
                "status": "offline",
                "protocol": "HTTP",
                "host": host,
                "port": port,
                "url": clean_url,
                "error": f"Ошибка HTTP подключения: {err}",
                "rtsp_hint": rtsp_hint,
                "suggestion": f"На хосте {host} обнаружен активный RTSP стрим порт 8554! Попробуйте: rtsp://{host}:8554/video" if rtsp_hint else "Проверьте IP-адрес, порт и включен ли видеопоток в VLC/камере",
            }
    return {"status": "unknown", "url": clean_url}
