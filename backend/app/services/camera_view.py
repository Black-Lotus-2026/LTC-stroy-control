"""Ракурс камеры: утверждённый эталон, сравнение кадров и согласование переноса.

Сравнение то же, что в браузере (src/sverka/lib/view.ts). Кадр уменьшается до
64×36, и сравниваются контуры: модуль градиента яркости почти не зависит от
освещения, туч и вечера. Кадр делится на 4×3 клетки, в каждой считается
нормированная корреляция контуров, и берётся медиана: надпись камеры с часами
или самосвал перед объективом занимают несколько клеток и оценку не тянут.
«Совпадение» — медиана при сдвиге не больше точки (дрожание мачты). Поиск лучшего
сдвига в пределах ±8 × ±5 точек говорит, куда повернули камеру: если кадр
совпадает только со сдвигом, ракурс сместился.

Кто что решает. Система только сравнивает и сообщает. Эталон утверждает
администратор; ответственный за объект может лишь предложить новый ракурс или
попросить перенос камеры. Утверждённый новый ракурс закрывает события о смещении
этой камеры: смещение согласовано.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import numpy as np
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.camera_view import CameraViewEvent
from app.models.enums import (
    IncidentCategory,
    IncidentEventType,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
    UserRole,
)
from app.models.incident import Incident, IncidentEvent
from app.models.project import Camera, Project
from app.models.user import User
from app.services.alert_service import (
    OPEN_STATUSES,
    VerificationResult,
    assign_initial_alert,
    queue_notification,
)
from app.storage import get_storage

logger = logging.getLogger(__name__)

VIEW_W, VIEW_H = 64, 36
MAX_DX, MAX_DY = 8, 5
TILES_X, TILES_Y = 4, 3
JITTER = 1
# Не ниже MATCH_OK — ракурс совпадает; ниже MATCH_BAD — не совпадает; между ними — без изменений.
MATCH_OK = 0.6
MATCH_BAD = 0.45
VIEW_CHANGED = "VIEW_CHANGED"
VIEW_MOVE_OVERDUE = "VIEW_MOVE_OVERDUE"
VIEW_TYPES = (VIEW_CHANGED, VIEW_MOVE_OVERDUE)
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_MOVE = timedelta(days=7)


class ViewError(ValueError):
    """Ошибка запроса о ракурсе; status — HTTP-код для ответа."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ViewFeatures:
    mag: np.ndarray


@dataclass(frozen=True)
class ViewMatch:
    match: float
    best: float
    dx: int
    dy: int


# --- Сравнение кадров ---

def gray_from_image(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        small = im.convert("L").resize((VIEW_W, VIEW_H), Image.Resampling.BILINEAR)
    return np.asarray(small, dtype=np.float32)


def features(gray: np.ndarray) -> ViewFeatures:
    gx = gray[1:-1, 2:] - gray[1:-1, :-2]
    gy = gray[2:, 1:-1] - gray[:-2, 1:-1]
    return ViewFeatures(mag=np.hypot(gx, gy))


def features_from_image(data: bytes) -> ViewFeatures:
    return features(gray_from_image(data))


def _ncc(a: np.ndarray, b: np.ndarray) -> float:
    a0 = a - a.mean()
    b0 = b - b.mean()
    den = float(np.sqrt((a0 * a0).sum() * (b0 * b0).sum()))
    return float((a0 * b0).sum() / den) if den > 1e-6 else 0.0


def _tiles(h: int, w: int) -> list[tuple[int, int, int, int]]:
    ys = [round(h * i / TILES_Y) for i in range(TILES_Y + 1)]
    xs = [round(w * j / TILES_X) for j in range(TILES_X + 1)]
    return [(ys[i], ys[i + 1], xs[j], xs[j + 1]) for i in range(TILES_Y) for j in range(TILES_X)]


def _median_ncc(ref: np.ndarray, cur: np.ndarray, dx: int, dy: int) -> float:
    h, w = ref.shape
    values = []
    for y0, y1, x0, x1 in _tiles(h, w):
        a0, a1 = max(y0, -dy), min(y1, h - dy)
        b0, b1 = max(x0, -dx), min(x1, w - dx)
        if (a1 - a0) * (b1 - b0) < 0.6 * (y1 - y0) * (x1 - x0):
            continue
        values.append(_ncc(ref[a0:a1, b0:b1], cur[a0 + dy : a1 + dy, b0 + dx : b1 + dx]))
    return float(np.median(values)) if values else 0.0


def compare(ref: ViewFeatures, cur: ViewFeatures) -> ViewMatch:
    """Сравнить кадр с эталоном: ref[y, x] против cur[y + dy, x + dx].

    dx > 0 — картинка уехала вправо, то есть камеру повернули влево.
    """
    match = -1.0
    best, bdx, bdy = -1.0, 0, 0
    for dy in range(-MAX_DY, MAX_DY + 1):
        for dx in range(-MAX_DX, MAX_DX + 1):
            s = _median_ncc(ref.mag, cur.mag, dx, dy)
            if abs(dx) <= JITTER and abs(dy) <= JITTER:
                match = max(match, s)
            if s > best:
                best, bdx, bdy = s, dx, dy
    return ViewMatch(match=match, best=best, dx=bdx, dy=bdy)


def decode_snapshot(raw: str) -> bytes:
    """Принять снимок от клиента: base64 → проверенное изображение → JPEG не больше 1280 px."""
    if raw.startswith("data:") and "," in raw[:100]:
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ViewError("Снимок не в формате base64") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise ViewError("Снимок больше 4 МБ")
    try:
        with Image.open(io.BytesIO(data)) as im:
            rgb = im.convert("RGB")
            rgb.thumbnail((1280, 1280))
            out = io.BytesIO()
            rgb.save(out, "JPEG", quality=85)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ViewError("Файл не является изображением") from exc
    return out.getvalue()


# --- Состояние камеры ---

def aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def move_active(camera: Camera, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return camera.view_move_status == "approved" and (aware(camera.view_move_until) or now) > now


def _user_name(db: Session, user_id: uuid.UUID | None) -> str | None:
    if not user_id:
        return None
    user = db.get(User, user_id)
    return (user.name or user.username) if user else None


def view_state(db: Session, camera: Camera, *, history: int = 12) -> dict:
    storage = get_storage()
    url = lambda key: storage.public_url(key) if key else None  # noqa: E731
    reference = (
        {
            "url": url(camera.view_reference_key),
            "at": camera.view_reference_at,
            "by": _user_name(db, camera.view_reference_by),
        }
        if camera.view_reference_key
        else None
    )
    proposal = (
        {
            "url": url(camera.view_proposal_key),
            "at": camera.view_proposal_at,
            "by": _user_name(db, camera.view_proposal_by),
            "by_id": camera.view_proposal_by,
            "note": camera.view_proposal_note,
        }
        if camera.view_proposal_key
        else None
    )
    move = (
        {
            "status": camera.view_move_status,
            "until": camera.view_move_until,
            "reason": camera.view_move_reason or "",
            "by": _user_name(db, camera.view_move_by),
            "by_id": camera.view_move_by,
            "at": camera.view_move_at,
            "approved_by": _user_name(db, camera.view_move_approved_by),
            "approved_at": camera.view_move_approved_at,
        }
        if camera.view_move_status
        else None
    )
    rows = db.scalars(
        select(CameraViewEvent)
        .where(CameraViewEvent.camera_id == camera.id)
        .order_by(CameraViewEvent.created_at.desc())
        .limit(history)
    ).all()
    return {
        "camera_id": camera.id,
        "camera_name": camera.name,
        "reference": reference,
        "proposal": proposal,
        "move": move,
        "history": [
            {
                "kind": r.kind,
                "at": r.created_at,
                "by": _user_name(db, r.user_id),
                "note": r.note,
                "url": url(r.snapshot_key),
                "until": r.until,
            }
            for r in rows
        ],
        "match_ok": MATCH_OK,
        "match_bad": MATCH_BAD,
    }


def _log(
    db: Session,
    camera: Camera,
    kind: str,
    user: User | None,
    *,
    note: str | None = None,
    key: str | None = None,
    until: datetime | None = None,
    now: datetime | None = None,
) -> None:
    db.add(
        CameraViewEvent(
            camera_id=camera.id,
            kind=kind,
            user_id=user.id if user else None,
            note=note,
            snapshot_key=key,
            until=until,
            created_at=now or datetime.now(UTC),
        )
    )


def _require_admin(user: User) -> None:
    if user.role != UserRole.ADMIN:
        raise ViewError("Согласует администратор", 403)


def _clear_move(camera: Camera) -> None:
    camera.view_move_status = None
    camera.view_move_until = None
    camera.view_move_reason = None
    camera.view_move_by = None
    camera.view_move_at = None
    camera.view_move_approved_by = None
    camera.view_move_approved_at = None


def _clear_proposal(camera: Camera) -> None:
    camera.view_proposal_key = None
    camera.view_proposal_at = None
    camera.view_proposal_by = None
    camera.view_proposal_note = None


# --- Эталон ---

def submit_reference(
    db: Session, camera: Camera, user: User, image: bytes, note: str | None, *, now: datetime | None = None
) -> None:
    """Администратор утверждает ракурс сразу; остальные предлагают его администратору."""
    now = now or datetime.now(UTC)
    key = f"cameras/{camera.id}/view/{now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}.jpg"
    get_storage().save(key, image)
    note = (note or "").strip() or None
    if user.role == UserRole.ADMIN:
        _approve_reference(db, camera, user, key, note, now)
        return
    camera.view_proposal_key = key
    camera.view_proposal_at = now
    camera.view_proposal_by = user.id
    camera.view_proposal_note = note
    _log(db, camera, "reference_proposed", user, note=note, key=key, now=now)


def approve_proposal(db: Session, camera: Camera, user: User, *, now: datetime | None = None) -> None:
    _require_admin(user)
    if not camera.view_proposal_key:
        raise ViewError("Нового ракурса на согласовании нет", 409)
    _approve_reference(db, camera, user, camera.view_proposal_key, camera.view_proposal_note, now or datetime.now(UTC))


def reject_proposal(db: Session, camera: Camera, user: User, note: str | None) -> None:
    _require_admin(user)
    if not camera.view_proposal_key:
        raise ViewError("Нового ракурса на согласовании нет", 409)
    _log(db, camera, "reference_rejected", user, note=(note or "").strip() or None, key=camera.view_proposal_key)
    _clear_proposal(camera)


def _approve_reference(
    db: Session, camera: Camera, user: User, key: str, note: str | None, now: datetime
) -> None:
    camera.view_reference_key = key
    camera.view_reference_at = now
    camera.view_reference_by = user.id
    _clear_proposal(camera)
    _log(db, camera, "reference_set", user, note=note, key=key, now=now)
    if camera.view_move_status:
        _log(db, camera, "move_completed", user, until=camera.view_move_until, now=now)
        _clear_move(camera)
    resolve_view_incidents(db, camera, user, now)


def resolve_view_incidents(db: Session, camera: Camera, user: User, now: datetime) -> int:
    """Утверждённый новый ракурс закрывает открытые события о ракурсе этой камеры."""
    incidents = db.scalars(
        select(Incident).where(
            Incident.camera_id == camera.id,
            Incident.discrepancy_type.in_(VIEW_TYPES),
            Incident.status.in_(OPEN_STATUSES),
        )
    ).all()
    name = user.name or user.username or "администратор"
    for incident in incidents:
        old = incident.status
        incident.status = IncidentStatus.RESOLVED
        incident.resolved_at = now
        incident.verification_requested_at = None
        incident.verification_details = {
            **(incident.verification_details or {}),
            "resolution": "accepted",
            "resolved_by": name,
            "checked_at": now.isoformat(),
        }
        db.add(IncidentEvent(
            incident_id=incident.id, event_type=IncidentEventType.COMMENTED, user_id=user.id,
            comment="Новый ракурс камеры утверждён: смещение согласовано",
        ))
        db.add(IncidentEvent(
            incident_id=incident.id, event_type=IncidentEventType.STATUS_CHANGED, user_id=user.id,
            old_status=old, new_status=IncidentStatus.RESOLVED,
            comment=f"Ракурс утверждён: {old.value} -> resolved",
        ))
        assignee = db.get(User, incident.assigned_user_id) if incident.assigned_user_id else None
        queue_notification(
            db, incident=incident, recipient=assignee, kind="view_accepted",
            title=f"{incident.code}: новый ракурс утверждён",
            body=f"{name} утвердил новый ракурс камеры «{camera.name}»; событие закрыто.",
        )
    return len(incidents)


# --- Перенос камеры ---

def plan_move(
    db: Session, camera: Camera, user: User, until: datetime, reason: str, *, now: datetime | None = None
) -> None:
    now = now or datetime.now(UTC)
    until = aware(until)
    reason = reason.strip()
    if until <= now:
        raise ViewError("Время окончания переноса уже прошло")
    if until - now > MAX_MOVE:
        raise ViewError("Перенос согласуется не дольше чем на 7 дней")
    if not reason:
        raise ViewError("Укажите причину переноса")
    if camera.view_move_status:
        raise ViewError("Перенос уже запрошен или согласован; сначала отмените его", 409)
    camera.view_move_status = "requested"
    camera.view_move_until = until
    camera.view_move_reason = reason
    camera.view_move_by = user.id
    camera.view_move_at = now
    _log(db, camera, "move_requested", user, note=reason, until=until, now=now)
    if user.role == UserRole.ADMIN:
        _approve_move(db, camera, user, now)


def approve_move(db: Session, camera: Camera, user: User, *, now: datetime | None = None) -> None:
    _require_admin(user)
    now = now or datetime.now(UTC)
    if camera.view_move_status != "requested":
        raise ViewError("Запроса на перенос нет", 409)
    if (aware(camera.view_move_until) or now) <= now:
        raise ViewError("Срок запрошенного переноса уже прошёл", 409)
    _approve_move(db, camera, user, now)


def _approve_move(db: Session, camera: Camera, user: User, now: datetime) -> None:
    camera.view_move_status = "approved"
    camera.view_move_approved_by = user.id
    camera.view_move_approved_at = now
    _log(db, camera, "move_approved", user, until=camera.view_move_until, now=now)


def reject_move(db: Session, camera: Camera, user: User, note: str | None) -> None:
    _require_admin(user)
    if camera.view_move_status != "requested":
        raise ViewError("Запроса на перенос нет", 409)
    _log(db, camera, "move_rejected", user, note=(note or "").strip() or None, until=camera.view_move_until)
    _clear_move(camera)


def cancel_move(db: Session, camera: Camera, user: User) -> None:
    if not camera.view_move_status:
        raise ViewError("Переноса нет", 409)
    if user.role != UserRole.ADMIN and camera.view_move_by != user.id:
        raise ViewError("Отменить перенос может тот, кто его запросил, или администратор", 403)
    _log(db, camera, "move_cancelled", user, until=camera.view_move_until)
    _clear_move(camera)


def expire_moves(db: Session, *, now: datetime | None = None, project_id: uuid.UUID | None = None) -> int:
    """Согласованный перенос истёк, а новый ракурс не утверждён: событие ответственному."""
    now = now or datetime.now(UTC)
    query = select(Camera).where(Camera.view_move_status == "approved", Camera.view_move_until <= now)
    if project_id:
        query = query.where(Camera.project_id == project_id)
    cameras = db.scalars(query).all()
    for camera in cameras:
        project = db.get(Project, camera.project_id)
        if project:
            _overdue_incident(db, camera, project, now)
        _log(db, camera, "move_expired", None, until=camera.view_move_until, now=now)
        _clear_move(camera)
    return len(cameras)


def _overdue_incident(db: Session, camera: Camera, project: Project, now: datetime) -> None:
    dedup = f"{project.id}:{camera.id}:{VIEW_MOVE_OVERDUE}"
    if db.scalar(select(Incident.id).where(Incident.dedup_key == dedup, Incident.status.in_(OPEN_STATUSES))):
        return
    tz = ZoneInfo(project.timezone or settings.default_timezone)
    until = aware(camera.view_move_until) or now
    local = until.astimezone(tz).strftime("%d.%m %H:%M")
    zone_name = camera.zone.name if camera.zone else None
    storage = get_storage()
    album = (
        [{
            "url": storage.public_url(camera.view_reference_key),
            "camera_name": f"{camera.name} · прежний утверждённый ракурс",
            "is_primary": True,
            "captured_at": (aware(camera.view_reference_at) or now).isoformat(),
        }]
        if camera.view_reference_key
        else []
    )
    incident = Incident(
        code=f"INC-{uuid.uuid4().hex[:8].upper()}",
        project_id=project.id,
        zone_id=camera.zone_id,
        camera_id=camera.id,
        category=IncidentCategory.CAMERA,
        type=IncidentType.CAMERA_VISIBILITY,
        title=f"Перенос камеры не завершён: {camera.name}",
        description="\n".join([
            f"Правило: перенос камеры «{camera.name}» был согласован до {local}; после переноса администратор утверждает новый ракурс.",
            f"Наблюдение: срок переноса истёк в {local}, новый ракурс не утверждён. Причина переноса: {camera.view_move_reason or 'не указана'}.",
            "Качество данных: пока ракурс не утверждён, кадры этой камеры не сверяются с эталоном.",
        ]),
        discrepancy_type=VIEW_MOVE_OVERDUE,
        priority=IncidentPriority.MEDIUM,
        status=IncidentStatus.PENDING,
        dedup_key=dedup,
        first_seen_at=until,
        last_seen_at=now,
        explanation={
            "camera_name": camera.name,
            "zone_name": zone_name,
            "severity": "warning",
            "album_photos": album,
            "snapshot_url": album[0]["url"] if album else None,
        },
    )
    db.add(incident)
    db.flush()
    assign_initial_alert(db, incident, project)


# --- Повторная проверка ---

def capture_http_frame(url: str, *, timeout: float = 5.0) -> bytes | None:
    """Один кадр HTTP-камеры без OpenCV: снимок (image/*) или первый JPEG из MJPEG-потока."""
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client, client.stream("GET", url) as r:
            if r.status_code >= 400:
                return None
            kind = r.headers.get("content-type", "")
            buf = b""
            for chunk in r.iter_bytes():
                buf += chunk
                if kind.startswith("image/"):
                    if len(buf) > MAX_IMAGE_BYTES:
                        return None
                    continue
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if end >= 0:
                    return buf[start : end + 2]
                if len(buf) > MAX_IMAGE_BYTES:
                    return None
            return buf if kind.startswith("image/") and buf else None
    except httpx.HTTPError:
        return None


def capture_frame(camera: Camera) -> bytes | None:
    url = camera.stream_url or ""
    if url.startswith(("http://", "https://")):
        frame = capture_http_frame(url)
        if frame:
            return frame
    from app.services.alert_service import _capture_frame  # noqa: PLC0415 - OpenCV for RTSP

    try:
        return _capture_frame(camera)
    except ImportError:
        return None


def verify_view_incident(
    db: Session,
    incident: Incident,
    *,
    capture: Callable[[Camera], bytes | None] | None = None,
    samples: int = 3,
    pause: float = 2.0,
) -> VerificationResult:
    """Сервер сам сверяет свежие кадры камеры с утверждённым ракурсом."""
    now = datetime.now(UTC)
    camera = db.get(Camera, incident.camera_id) if incident.camera_id else None
    if camera is None:
        return VerificationResult("unavailable", {"reason": "no_camera", "checked_at": now.isoformat()})
    if incident.discrepancy_type == VIEW_MOVE_OVERDUE:
        approved_after = (aware(camera.view_reference_at) or datetime.min.replace(tzinfo=UTC)) >= aware(incident.created_at or now)
        outcome = "passed" if approved_after and not camera.view_move_status else "failed"
        return VerificationResult(outcome, {"reason": None if outcome == "passed" else "view_not_approved", "checked_at": now.isoformat()})
    if not camera.view_reference_key:
        return VerificationResult("unavailable", {"reason": "no_view_reference", "checked_at": now.isoformat()})
    try:
        ref = features_from_image(get_storage().load(camera.view_reference_key))
    except (OSError, UnidentifiedImageError):
        logger.exception("Reference view unreadable: %s", camera.id)
        return VerificationResult("unavailable", {"reason": "no_view_reference", "checked_at": now.isoformat()})
    capture = capture or capture_frame
    scores: list[float] = []
    for i in range(samples):
        try:
            frame = capture(camera)
            if frame:
                scores.append(compare(ref, features_from_image(frame)).match)
        except Exception:  # noqa: BLE001 - одна неудачная попытка не валит проверку
            logger.exception("View recheck failed: %s", camera.id)
        if i < samples - 1 and pause:
            time.sleep(pause)
    details = {
        "working_cameras": 1 if scores else 0,
        "configured_cameras": 1,
        "view_match": [round(s, 2) for s in scores],
        "checked_at": now.isoformat(),
    }
    if not scores:
        return VerificationResult("unavailable", {**details, "reason": "no_frames"})
    good = sum(s >= MATCH_OK for s in scores)
    if good * 2 > len(scores):
        return VerificationResult("passed", {**details, "resolution": "restored"})
    return VerificationResult("failed", details)
