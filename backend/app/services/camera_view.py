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
import hashlib
import io
import ipaddress
import logging
import socket
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit
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
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.models.incident import Incident
from app.models.project import Camera, Project
from app.models.user import User
from app.services.alert_service import (
    OPEN_STATUSES,
    VerificationResult,
    assign_initial_alert,
)

logger = logging.getLogger(__name__)

VIEW_W, VIEW_H = 64, 36
MAX_DX, MAX_DY = 8, 5
TILES_X, TILES_Y = 4, 3
JITTER = 1
# MATCH_OK and MATCH_BAD bound an inconclusive comparison interval.
MATCH_OK = 0.6
MATCH_BAD = 0.45
VIEW_CHANGED = "VIEW_CHANGED"
VIEW_MOVE_OVERDUE = "VIEW_MOVE_OVERDUE"
VIEW_TYPES = (VIEW_CHANGED, VIEW_MOVE_OVERDUE)
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_MOVE = timedelta(days=7)


def _view_path(key: str) -> Path:
    root = Path(
        getattr(
            settings,
            "camera_view_storage_root",
            settings.storage_local_root.parent / "camera-views-private",
        )
    ).resolve()
    path = (root / key).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Invalid camera view asset")
    return path


def save_view_image(key: str, image: bytes) -> None:
    path = _view_path(key)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(image)
    path.chmod(0o600)


def load_view_image(key: str) -> bytes:
    return _view_path(key).read_bytes()


def view_asset_url(camera: Camera, key: str) -> str:
    asset = hashlib.sha256(key.encode()).hexdigest()
    return f"/api/v1/projects/{camera.project_id}/cameras/{camera.id}/view/assets/{asset}"


def view_asset_key(db: Session, camera: Camera, asset: str) -> str | None:
    keys = [camera.view_reference_key, camera.view_proposal_key]
    keys.extend(
        db.scalars(
            select(CameraViewEvent.snapshot_key).where(
                CameraViewEvent.camera_id == camera.id
            )
        )
    )
    return next(
        (
            key
            for key in keys
            if key and hashlib.sha256(key.encode()).hexdigest() == asset
        ),
        None,
    )


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
    return [
        (ys[i], ys[i + 1], xs[j], xs[j + 1])
        for i in range(TILES_Y)
        for j in range(TILES_X)
    ]


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
    """Decode and bound a client snapshot to a verified 1280px JPEG."""
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
    return (
        camera.view_move_status == "approved"
        and (aware(camera.view_move_at) or now) <= now
        and (aware(camera.view_move_until) or now) > now
    )


def _user_name(db: Session, user_id: uuid.UUID | None) -> str | None:
    if not user_id:
        return None
    user = db.get(User, user_id)
    return (user.name or user.username) if user else None


def view_state(db: Session, camera: Camera, *, history: int = 12) -> dict:
    url = lambda key: view_asset_url(camera, key) if key else None  # noqa: E731
    reference = (
        {
            "url": url(camera.view_reference_key),
            "sha256": _view_sha256(camera.view_reference_key),
            "at": camera.view_reference_at,
            "by": _user_name(db, camera.view_reference_by),
        }
        if camera.view_reference_key
        else None
    )
    proposal = (
        {
            "url": url(camera.view_proposal_key),
            "sha256": _view_sha256(camera.view_proposal_key),
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


def _require_admin(db: Session, camera: Camera, user: User) -> None:
    from app.services.access_policy import resolve_context

    resolve_context(
        db,
        camera.project_id,
        user,
        permission="camera.reference.approve",
        write=True,
        lock=True,
    )


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
    db: Session,
    camera: Camera,
    user: User,
    image: bytes,
    note: str | None,
    *,
    now: datetime | None = None,
) -> None:
    """Сохранить предложение; конкретный снимок отдельно утверждает заказчик."""
    now = now or datetime.now(UTC)
    stamp = now.strftime("%Y%m%dT%H%M%S")
    key = f"cameras/{camera.id}/view/{stamp}-{uuid.uuid4().hex[:6]}.jpg"
    save_view_image(key, image)
    note = (note or "").strip() or None
    camera.view_proposal_key = key
    camera.view_proposal_at = now
    camera.view_proposal_by = user.id
    camera.view_proposal_note = note
    _log(db, camera, "reference_proposed", user, note=note, key=key, now=now)


def approve_proposal(
    db: Session, camera: Camera, user: User, *, now: datetime | None = None
) -> None:
    _require_admin(db, camera, user)
    if not camera.view_proposal_key:
        raise ViewError("Нового ракурса на согласовании нет", 409)
    _approve_reference(
        db,
        camera,
        user,
        camera.view_proposal_key,
        camera.view_proposal_note,
        now or datetime.now(UTC),
    )


def reject_proposal(db: Session, camera: Camera, user: User, note: str | None) -> None:
    _require_admin(db, camera, user)
    if not camera.view_proposal_key:
        raise ViewError("Нового ракурса на согласовании нет", 409)
    _log(
        db,
        camera,
        "reference_rejected",
        user,
        note=(note or "").strip() or None,
        key=camera.view_proposal_key,
    )
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
        from app.models.customer_control import CameraMoveRequest

        active_request = db.scalar(
            select(CameraMoveRequest.id).where(
                CameraMoveRequest.camera_id == camera.id,
                CameraMoveRequest.status.in_(
                    {"approved", "in_progress", "awaiting_reference"}
                ),
            )
        )
        if not active_request:
            _log(
                db, camera, "move_completed", user, until=camera.view_move_until, now=now
            )
            _clear_move(camera)
    # Reference changes are technical verification, not human acceptance of a
    # remediation submission. Historical incidents keep their evidence/state.


def resolve_view_incidents(db: Session, camera: Camera, user: User, now: datetime) -> int:
    """Compatibility entry point: reference approval never accepts remediation."""
    return 0


# --- Перенос камеры ---


def plan_move(
    db: Session,
    camera: Camera,
    user: User,
    until: datetime,
    reason: str,
    *,
    now: datetime | None = None,
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


def approve_move(
    db: Session, camera: Camera, user: User, *, now: datetime | None = None
) -> None:
    from app.services.access_policy import resolve_context

    resolve_context(
        db,
        camera.project_id,
        user,
        permission="camera.move.decide",
        write=True,
        lock=True,
    )
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
    from app.services.access_policy import resolve_context

    resolve_context(
        db,
        camera.project_id,
        user,
        permission="camera.move.decide",
        write=True,
        lock=True,
    )
    if camera.view_move_status != "requested":
        raise ViewError("Запроса на перенос нет", 409)
    _log(
        db,
        camera,
        "move_rejected",
        user,
        note=(note or "").strip() or None,
        until=camera.view_move_until,
    )
    _clear_move(camera)


def cancel_move(db: Session, camera: Camera, user: User) -> None:
    if not camera.view_move_status:
        raise ViewError("Переноса нет", 409)
    from app.services.access_policy import resolve_context

    if camera.view_move_status == "approved" or camera.view_move_by != user.id:
        resolve_context(
            db,
            camera.project_id,
            user,
            permission="camera.move.decide",
            write=True,
            lock=True,
        )
    _log(db, camera, "move_cancelled", user, until=camera.view_move_until)
    _clear_move(camera)


def expire_moves(
    db: Session, *, now: datetime | None = None, project_id: uuid.UUID | None = None
) -> int:
    """Record an overdue camera move without changing incident acceptance."""
    now = now or datetime.now(UTC)
    from app.api.v1.camera_workflow import expire_move_requests

    expired_requests = expire_move_requests(db, now)
    query = (
        select(Camera)
        .join(Project, Project.id == Camera.project_id)
        .where(
            Project.kind != "shared_demo",
            Project.lifecycle == "active",
            Camera.view_move_status == "approved",
            Camera.view_move_until <= now,
        )
        .with_for_update(skip_locked=True)
    )
    if project_id:
        query = query.where(Camera.project_id == project_id)
    cameras = db.scalars(query).all()
    for camera in cameras:
        project = db.get(Project, camera.project_id)
        if project:
            _overdue_incident(db, camera, project, now)
        _log(db, camera, "move_expired", None, until=camera.view_move_until, now=now)
        _clear_move(camera)
    return len(cameras) + expired_requests


def _overdue_incident(
    db: Session, camera: Camera, project: Project, now: datetime
) -> None:
    from app.models.customer_control import AuditEvent
    from app.services.observation_basis import snapshot_basis

    approval = db.scalar(
        select(AuditEvent)
        .where(
            AuditEvent.project_id == project.id,
            AuditEvent.resource_id == camera.id,
            AuditEvent.event_type == "camera.move.approved",
            AuditEvent.occurred_at >= camera.view_move_at,
        )
        .order_by(AuditEvent.occurred_at.desc())
    )
    if approval is None:
        return
    dedup = f"{project.id}:{camera.id}:{VIEW_MOVE_OVERDUE}"
    if db.scalar(
        select(Incident.id).where(
            Incident.dedup_key == dedup, Incident.status.in_(OPEN_STATUSES)
        )
    ):
        return
    tz = ZoneInfo(project.timezone or settings.default_timezone)
    until = aware(camera.view_move_until) or now
    local = until.astimezone(tz).strftime("%d.%m %H:%M")
    zone_name = camera.zone.name if camera.zone else None
    album = (
        [
            {
                "url": view_asset_url(camera, camera.view_reference_key),
                "camera_name": f"{camera.name} · прежний утверждённый ракурс",
                "is_primary": True,
                "captured_at": (aware(camera.view_reference_at) or now).isoformat(),
            }
        ]
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
        description="\n".join(
            [
                (
                    f"Правило: перенос камеры «{camera.name}» согласован до {local}; "
                    "после переноса заказчик утверждает новый ракурс."
                ),
                (
                    f"Наблюдение: перенос истёк в {local}, ракурс не утверждён. "
                    f"Причина: {camera.view_move_reason or 'не указана'}."
                ),
                (
                    "Качество данных: пока ракурс не утверждён, кадры "
                    "этой камеры не сверяются с эталоном."
                ),
            ]
        ),
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
    snapshot_basis(
        db,
        incident,
        kind="camera",
        observed_from=until,
        observed_until=now,
        policy={
            "provenance": "camera_policy",
            "approval_event_id": str(approval.id),
            "sha256": approval.reason,
            "move_until": until.isoformat(),
        },
        sources=[
            {"camera_id": str(camera.id), "reference_key": camera.view_reference_key}
        ],
    )
    assign_initial_alert(db, incident, project)


# --- Повторная проверка ---


def validated_capture_url(url: str) -> tuple[str, str, str]:
    """Pin resolved addresses; private networks require explicit configuration."""
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"http", "https", "rtsp"}
        or not parsed.hostname
        or parsed.fragment
    ):
        raise ValueError("Unsupported camera target")
    port = parsed.port or (
        443 if parsed.scheme == "https" else 554 if parsed.scheme == "rtsp" else 80
    )
    networks = [
        ipaddress.ip_network(str(value))
        for value in getattr(settings, "camera_allowed_networks", [])
    ]
    addresses = {
        ipaddress.ip_address(row[4][0].split("%", 1)[0])
        for row in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    }
    if not addresses:
        raise ValueError("Camera target unavailable")
    for address in addresses:
        address = getattr(address, "ipv4_mapped", None) or address
        if (
            address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_unspecified
            or address.is_reserved
        ):
            raise ValueError("Camera target prohibited")
        if not address.is_global and not any(
            address.version == network.version and address in network
            for network in networks
        ):
            raise ValueError("Private camera target not configured")
        if parsed.scheme == "rtsp" and not any(
            address.version == network.version and address in network
            for network in networks
        ):
            raise ValueError("RTSP target requires a trusted network")
    selected = str(sorted(addresses, key=str)[0])
    pinned = str(httpx.URL(url).copy_with(host=selected))
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    if parsed.port:
        host += f":{parsed.port}"
    return pinned, host, parsed.hostname


def capture_http_frame(url: str, *, timeout: float = 5.0) -> bytes | None:
    """Fetch one bounded image or MJPEG frame through the protected network policy."""
    try:
        deadline = time.monotonic() + timeout
        pinned, host, hostname = validated_capture_url(url)
        if time.monotonic() >= deadline:
            return None
        limits = httpx.Timeout(timeout, read=min(timeout, 1.0))
        with (
            httpx.Client(
                timeout=limits, follow_redirects=False, trust_env=False
            ) as client,
            client.stream(
                "GET",
                pinned,
                headers={"Host": host},
                extensions={"sni_hostname": hostname},
            ) as r,
        ):
            if not 200 <= r.status_code < 300:
                return None
            kind = r.headers.get("content-type", "")
            buf = b""
            for chunk in r.iter_bytes():
                if time.monotonic() >= deadline:
                    return None
                buf += chunk
                if len(buf) > MAX_IMAGE_BYTES:
                    return None
                if kind.startswith("image/"):
                    continue
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if end >= 0:
                    return buf[start : end + 2]
                if len(buf) > MAX_IMAGE_BYTES:
                    return None
            return buf if kind.startswith("image/") and buf else None
    except (httpx.HTTPError, ValueError, OSError):
        return None


def capture_frame(camera: Camera) -> bytes | None:
    url = (camera.stream_url or "").strip()
    if not url:
        return None
    is_hls = ".m3u8" in url.lower()
    if url.startswith(("http://", "https://")) and not is_hls:
        frame = capture_http_frame(url)
        if frame:
            return frame
    if url.startswith("rtsp://") and not getattr(
        settings, "camera_allow_rtsp_capture", False
    ):
        return None
    try:
        pinned, _, _ = validated_capture_url(url)
    except (ValueError, OSError):
        return None
    try:
        import cv2

        target = url if (is_hls or url.startswith("https://")) else pinned
        capture = cv2.VideoCapture(target)
        try:
            if not capture.isOpened():
                return None
            ok, image = capture.read()
            if not ok or image is None:
                return None
            encoded, data = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
            return data.tobytes() if encoded else None
        finally:
            capture.release()
    except (ImportError, Exception):
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
        return VerificationResult(
            "unavailable", {"reason": "no_camera", "checked_at": now.isoformat()}
        )
    if incident.discrepancy_type == VIEW_MOVE_OVERDUE:
        approved_after = (
            aware(camera.view_reference_at) or datetime.min.replace(tzinfo=UTC)
        ) >= aware(incident.created_at or now)
        outcome = "passed" if approved_after and not camera.view_move_status else "failed"
        return VerificationResult(
            outcome,
            {
                "reason": None if outcome == "passed" else "view_not_approved",
                "checked_at": now.isoformat(),
            },
        )
    if not camera.view_reference_key:
        return VerificationResult(
            "unavailable", {"reason": "no_view_reference", "checked_at": now.isoformat()}
        )
    try:
        ref = features_from_image(load_view_image(camera.view_reference_key))
    except (OSError, UnidentifiedImageError):
        logger.exception("Reference view unreadable: %s", camera.id)
        return VerificationResult(
            "unavailable", {"reason": "no_view_reference", "checked_at": now.isoformat()}
        )
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
        "requested_samples": samples,
        "successful_samples": len(scores),
        "checked_at": now.isoformat(),
    }
    if not scores:
        return VerificationResult("unavailable", {**details, "reason": "no_frames"})
    good = sum(s >= MATCH_OK for s in scores)
    if len(scores) * 2 <= samples:
        return VerificationResult(
            "unavailable", {**details, "reason": "insufficient_frames"}
        )
    if good * 2 > samples:
        return VerificationResult("passed", {**details, "resolution": "restored"})
    return VerificationResult("failed", details)


def _view_sha256(key):
    try:
        return hashlib.sha256(load_view_image(key)).hexdigest() if key else None
    except (OSError, ValueError):
        return None
