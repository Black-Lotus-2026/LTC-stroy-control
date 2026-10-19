"""Authenticated, project-scoped safety candidates. No client-supplied detections."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from io import BytesIO
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import delete, select
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, DbSession
from app.api.v1.videos import _detect_uploaded_image
from app.core.config import settings
from app.models.enums import UserRole
from app.models.project import Camera, Project
from app.models.safety import (
    SafetyDocument,
    SafetyEvent,
    SafetyFrameReceipt,
    SafetyRequirement,
    SafetySanction,
    SafetyTrack,
    SafetyZone,
)
from app.models.user import User
from app.schemas.safety import ReviewInput, ZoneInput
from app.services.safety_catalog import catalog
from app.services.trained_detector import decode_image
from app.services.trained_taxonomy import SEMANTIC_NAMES

router = APIRouter(prefix="/safety", tags=["Безопасность и нормы"])
VEHICLES = set(SEMANTIC_NAMES) - {"worker", "hanging_head", "grader"}
TITLES = {
    "worker_danger_zone": "Человек в опасной зоне",
    "vehicle_blocks_passage": "Техника в зоне прохода",
    "vehicle_restricted_zone": "Техника в запрещённой зоне",
}


def project_access(db, project_id, user, *, manage=False):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Объект не найден")
    owner = bool(project.owner_username and project.owner_username == user.username)
    admin = user.role == UserRole.ADMIN
    # No implicit cross-project access for managers; unowned projects are private.
    assigned = db.scalar(
        select(SafetyZone.id)
        .where(
            SafetyZone.project_id == project_id,
            SafetyZone.responsible_user_id == user.id,
            SafetyZone.enabled.is_(True),
        )
        .limit(1)
    )
    if not (admin or owner or (assigned and not manage)):
        raise HTTPException(403, "Нет доступа к безопасности этого объекта")
    return project


def event_access(db, event, user):
    """An old assignment grants access to that event only, never project ingestion."""
    try:
        return project_access(db, event.project_id, user)
    except HTTPException as exc:
        if exc.status_code != 403 or event.snapshot["zone"]["responsible_user_id"] != str(
            user.id
        ):
            raise
        return db.get(Project, event.project_id)


def zone_dict(zone):
    return {
        key: getattr(zone, key)
        for key in [
            "id",
            "project_id",
            "camera_id",
            "name",
            "scenario",
            "polygon",
            "site_basis",
            "responsible_user_id",
            "min_duration_seconds",
            "confidence_threshold",
            "allowed_classes",
            "enabled",
            "revision",
        ]
    }


def can_review(event, user, project):
    responsible = event.snapshot["zone"]["responsible_user_id"]
    return event.status == "candidate" and (
        user.role == UserRole.ADMIN
        or project.owner_username == user.username
        or (
            str(user.id) == responsible
            and user.role in {UserRole.MANAGER, UserRole.INSPECTOR}
        )
    )


def event_dict(event, user, project):
    return dict(
        id=event.id,
        project_id=event.project_id,
        camera_id=event.camera_id,
        zone_id=event.zone_id,
        status=event.status,
        scenario=event.scenario,
        title=TITLES[event.scenario],
        source_id=event.source_id,
        first_position_ms=event.first_position_ms,
        last_position_ms=event.last_position_ms,
        model_sha256=event.model_sha256,
        evidence_sha256=event.evidence_sha256,
        evidence_url=f"/api/v1/safety/events/{event.id}/evidence",
        created_at=event.created_at,
        snapshot=event.snapshot,
        reviewed_by=event.reviewed_by,
        reviewed_at=event.reviewed_at,
        review_comment=event.review_comment,
        can_review=can_review(event, user, project),
    )


@router.get("/catalog")
def get_catalog(db: DbSession, user: CurrentUser):
    return catalog(db)


@router.get("/projects/{project_id}/configuration")
def configuration(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    project = project_access(db, project_id, user)
    can_manage = user.role == UserRole.ADMIN or project.owner_username == user.username
    users = (
        db.scalars(
            select(User).where(
                User.is_active.is_(True),
                User.role.in_([UserRole.ADMIN, UserRole.MANAGER, UserRole.INSPECTOR]),
            )
        ).all()
        if can_manage
        else [user]
    )
    # Project owner can always be the responsible, regardless of their default role.
    if can_manage and user not in users:
        users.append(user)
    return dict(
        can_manage=can_manage,
        cameras=[
            dict(id=c.id, name=c.name)
            for c in db.scalars(select(Camera).where(Camera.project_id == project_id))
        ],
        responsibles=[dict(id=u.id, name=u.name, role=u.role) for u in users],
    )


@router.get("/projects/{project_id}/zones")
def zones(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    project_access(db, project_id, user)
    return [
        zone_dict(v)
        for v in db.scalars(
            select(SafetyZone)
            .where(SafetyZone.project_id == project_id)
            .order_by(SafetyZone.created_at)
        )
    ]


def validate_assignment(db, project, data, user):
    camera = db.get(Camera, data.camera_id)
    if not camera or camera.project_id != project.id:
        raise HTTPException(422, "Камера должна принадлежать объекту")
    responsible = db.get(User, data.responsible_user_id)
    if (
        not responsible
        or not responsible.is_active
        or not (
            responsible.role in {UserRole.ADMIN, UserRole.MANAGER, UserRole.INSPECTOR}
            or responsible.username == project.owner_username
        )
    ):
        raise HTTPException(422, "Выберите действующего ответственного")


@router.post("/projects/{project_id}/zones", status_code=201)
def create_zone(project_id: uuid.UUID, data: ZoneInput, db: DbSession, user: CurrentUser):
    project = project_access(db, project_id, user, manage=True)
    validate_assignment(db, project, data, user)
    zone = SafetyZone(
        project_id=project_id, created_by=user.id, **data.model_dump(mode="python")
    )
    db.add(zone)
    db.commit()
    db.refresh(zone)
    return zone_dict(zone)


@router.patch("/zones/{zone_id}")
def edit_zone(zone_id: uuid.UUID, data: ZoneInput, db: DbSession, user: CurrentUser):
    zone = db.scalar(select(SafetyZone).where(SafetyZone.id == zone_id).with_for_update())
    if not zone:
        raise HTTPException(404, "Зона не найдена")
    project = project_access(db, zone.project_id, user, manage=True)
    validate_assignment(db, project, data, user)
    for key, value in data.model_dump(mode="python").items():
        setattr(zone, key, value)
    zone.revision += 1
    db.execute(delete(SafetyTrack).where(SafetyTrack.zone_id == zone.id))
    db.execute(delete(SafetyFrameReceipt).where(SafetyFrameReceipt.zone_id == zone.id))
    db.commit()
    return zone_dict(zone)


@router.delete("/zones/{zone_id}", status_code=204)
def remove_zone(zone_id: uuid.UUID, db: DbSession, user: CurrentUser):
    zone = db.scalar(select(SafetyZone).where(SafetyZone.id == zone_id).with_for_update())
    if not zone:
        raise HTTPException(404, "Зона не найдена")
    project_access(db, zone.project_id, user, manage=True)
    # Soft deletion preserves evidence and attribution.
    zone.enabled = False
    zone.revision += 1
    db.execute(delete(SafetyTrack).where(SafetyTrack.zone_id == zone.id))
    db.commit()
    return Response(status_code=204)


@router.get("/projects/{project_id}/events")
def events(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    project = project_access(db, project_id, user)
    return [
        event_dict(v, user, project)
        for v in db.scalars(
            select(SafetyEvent)
            .where(SafetyEvent.project_id == project_id)
            .order_by(SafetyEvent.created_at.desc())
            .limit(200)
        )
    ]


@router.get("/events/{event_id}")
def get_event(event_id: uuid.UUID, db: DbSession, user: CurrentUser):
    event = db.get(SafetyEvent, event_id)
    if not event:
        raise HTTPException(404, "Событие не найдено")
    project = event_access(db, event, user)
    return event_dict(event, user, project)


@router.get("/events/{event_id}/evidence")
def evidence(event_id: uuid.UUID, db: DbSession, user: CurrentUser, kind: str = "last"):
    event = db.get(SafetyEvent, event_id)
    if not event:
        raise HTTPException(404, "Событие не найдено")
    event_access(db, event, user)
    if kind not in {"first", "last"}:
        raise HTTPException(422, "Неизвестный вид кадра")
    return Response(
        event.first_evidence_jpeg if kind == "first" else event.evidence_jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/events/{event_id}/review")
def review(event_id: uuid.UUID, data: ReviewInput, db: DbSession, user: CurrentUser):
    event = db.scalar(
        select(SafetyEvent).where(SafetyEvent.id == event_id).with_for_update()
    )
    if not event:
        raise HTTPException(404, "Событие не найдено")
    project = event_access(db, event, user)
    responsible = event.snapshot["zone"]["responsible_user_id"]
    if not (
        user.role == UserRole.ADMIN
        or project.owner_username == user.username
        or (
            str(user.id) == responsible
            and user.role in {UserRole.MANAGER, UserRole.INSPECTOR}
        )
    ):
        raise HTTPException(
            403, "Подтверждение доступно ответственному или владельцу объекта"
        )
    if event.status != "candidate":
        raise HTTPException(409, "Решение уже принято; запись аудита неизменяема")
    event.status = data.decision
    event.reviewed_by = user.id
    event.reviewed_at = datetime.now(UTC)
    event.review_comment = data.comment
    db.commit()
    db.refresh(event)
    return event_dict(event, user, project)


def inside(point, polygon):
    x, y = point
    hit = False
    for i, a in enumerate(polygon):
        b = polygon[(i + 1) % len(polygon)]
        cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        if (
            abs(cross) < 1e-9
            and min(a[0], b[0]) - 1e-9 <= x <= max(a[0], b[0]) + 1e-9
            and min(a[1], b[1]) - 1e-9 <= y <= max(a[1], b[1]) + 1e-9
        ):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (
            b[1] - a[1]
        ) + a[0]:
            hit = not hit
    return hit


def candidate_boxes(zone, detections):
    wanted = (
        {"worker"}
        if zone.scenario == "worker_danger_zone"
        else VEHICLES - set(zone.allowed_classes)
    )
    return [
        d
        for d in detections
        if d["raw_label"] in wanted
        and d["confidence"] >= zone.confidence_threshold
        and inside(((d["x1"] + d["x2"]) / 2, d["y2"]), zone.polygon)
    ]


def match_box(a, b):
    if a["raw_label"] != b["raw_label"]:
        return False
    overlap = max(0, min(a["x2"], b["x2"]) - max(a["x1"], b["x1"])) * max(
        0, min(a["y2"], b["y2"]) - max(a["y1"], b["y1"])
    )
    area = (
        (a["x2"] - a["x1"]) * (a["y2"] - a["y1"])
        + (b["x2"] - b["x1"]) * (b["y2"] - b["y1"])
        - overlap
    )
    return area > 0 and overlap / area >= 0.2


def prune_state(db, zone, source):
    """Bound observation cache: 200 frame hashes/session, 20 sessions/zone.

    This cache suppresses immediate replay; it is not a forensic authenticity guarantee.
    Candidate evidence and reviews are never deleted by cache cleanup.
    """
    db.flush()
    old_receipts = list(
        db.scalars(
            select(SafetyFrameReceipt.id)
            .where(
                SafetyFrameReceipt.zone_id == zone.id,
                SafetyFrameReceipt.source_id == source,
            )
            .order_by(SafetyFrameReceipt.position_ms.desc())
            .offset(200)
        )
    )
    if old_receipts:
        db.execute(
            delete(SafetyFrameReceipt).where(SafetyFrameReceipt.id.in_(old_receipts))
        )
    old_tracks = list(
        db.scalars(
            select(SafetyTrack)
            .where(
                SafetyTrack.zone_id == zone.id,
            )
            .order_by(SafetyTrack.touched_at.desc(), SafetyTrack.id)
            .offset(20)
        )
    )
    for old in old_tracks:
        db.execute(
            delete(SafetyFrameReceipt).where(
                SafetyFrameReceipt.zone_id == zone.id,
                SafetyFrameReceipt.source_id == old.source_id,
            )
        )
        db.delete(old)


def evaluate(
    db,
    zone,
    source,
    position,
    image_hash,
    jpeg,
    detections,
    model_sha,
    uploaded_by=None,
    recording_mode=False,
):
    receipt = db.scalar(
        select(SafetyFrameReceipt.id).where(
            SafetyFrameReceipt.zone_id == zone.id,
            SafetyFrameReceipt.source_id == source,
            SafetyFrameReceipt.image_sha256 == image_hash,
        )
    )
    if receipt:
        return None, "duplicate_frame"
    track = db.scalar(
        select(SafetyTrack)
        .where(SafetyTrack.zone_id == zone.id, SafetyTrack.source_id == source)
        .with_for_update()
    )
    if not track:
        track = SafetyTrack(zone_id=zone.id, source_id=source, state={})
        db.add(track)
    state = dict(track.state)
    if state and position <= state["last"]:
        return None, "out_of_order"
    db.add(
        SafetyFrameReceipt(
            zone_id=zone.id,
            source_id=source,
            image_sha256=image_hash,
            position_ms=position,
        )
    )
    track.touched_at = datetime.now(UTC)
    prune_state(db, zone, source)
    boxes = candidate_boxes(zone, detections)
    matching = [b for b in boxes if state.get("box") and match_box(state["box"], b)]
    if not boxes:
        track.state = {"last": position}
        return None, "clear"
    gap = position - state.get("last", position)
    # Continuity is heuristic, not identity tracking or a metre-distance measurement.
    if not matching or gap > 15000 or "first" not in state:
        state = {
            "first": position,
            "count": 0,
            "box": boxes[0],
            "first_box": boxes[0],
            "first_detections": detections,
        }
        track.first_jpeg = jpeg
    else:
        state["box"] = matching[0]
    state["last"] = position
    state["count"] += 1
    event = None
    if (
        state["count"] >= 2
        and position - state["first"] >= zone.min_duration_seconds * 1000
        and not state.get("event_id")
    ):
        z = zone_dict(zone)
        z = {k: str(v) if isinstance(v, uuid.UUID) else v for k, v in z.items()}
        z["camera_name"] = db.get(Camera, zone.camera_id).name
        z["responsible_name"] = db.get(User, zone.responsible_user_id).name
        requirements = []
        for r in db.scalars(
            select(SafetyRequirement).where(SafetyRequirement.scenario == zone.scenario)
        ):
            document = db.get(SafetyDocument, r.document_id)
            requirements.append({**r.data, "document": document.data})
        event = SafetyEvent(
            project_id=zone.project_id,
            camera_id=zone.camera_id,
            zone_id=zone.id,
            scenario=zone.scenario,
            source_id=source,
            first_position_ms=state["first"],
            last_position_ms=position,
            model_sha256=model_sha,
            evidence_sha256=hashlib.sha256(jpeg).hexdigest(),
            evidence_jpeg=jpeg,
            first_evidence_jpeg=track.first_jpeg or jpeg,
            snapshot=dict(
                zone=z,
                detections=detections,
                matched_detection=state["box"],
                first_matched_detection=state["first_box"],
                first_detections=state["first_detections"],
                requirements=requirements,
                sanctions=[s.data for s in db.scalars(select(SafetySanction))],
                first_evidence_sha256=hashlib.sha256(
                    track.first_jpeg or jpeg
                ).hexdigest(),
                observations=state["count"],
                algorithm_version="camera-zone-v1",
                uploaded_by=str(uploaded_by) if uploaded_by else None,
                recording_mode=recording_mode,
                limitations=(
                    "Кандидат по изображению фиксированной камеры. "
                    "Перспектива, перекрытия и "
                    "движение камеры влияют на результат. "
                    "Нет доказательства допуска, вины, "
                    "фактической блокировки или состава правонарушения. Временная шкала "
                    "предоставлена источником загрузки; идентичность объекта не доказана."
                ),
            ),
        )
        db.add(event)
        db.flush()
        state["event_id"] = str(event.id)
    track.state = state
    return event, "candidate" if event else "observing"


@router.post("/projects/{project_id}/analyze-frame")
async def analyze_frame(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    file: Annotated[UploadFile, File()],
    camera_id: Annotated[uuid.UUID, Form()],
    source_id: str = Form(..., min_length=1, max_length=120),
    position_ms: int = Form(..., ge=0, le=4102444800000),
    recording_mode: bool = Form(False),
):
    project = project_access(db, project_id, user)
    source_id = source_id.strip()
    if not source_id:
        raise HTTPException(422, "Нужен идентификатор источника")
    camera = db.get(Camera, camera_id)
    if not camera or camera.project_id != project_id:
        raise HTTPException(422, "Камера не принадлежит объекту")
    raw = await file.read(settings.max_image_upload_bytes + 1)
    if len(raw) > settings.max_image_upload_bytes:
        raise HTTPException(413, "Изображение превышает допустимый размер")
    # Reuse sole YOLO endpoint logic. Never VLM; no user JSON boxes accepted.
    result = await _detect_uploaded_image(
        UploadFile(BytesIO(raw), filename="frame.jpg"), None, photo=False
    )
    image = await run_in_threadpool(decode_image, raw)
    output = BytesIO()
    image.thumbnail((1600, 1600))
    image.save(output, format="JPEG", quality=88)
    jpeg = output.getvalue()
    image_hash = hashlib.sha256(raw).hexdigest()
    # Serialize on zone row: concurrent uploads cannot create two open candidates.
    configured = db.scalars(
        select(SafetyZone)
        .where(
            SafetyZone.project_id == project_id,
            SafetyZone.camera_id == camera_id,
            SafetyZone.enabled.is_(True),
        )
        .order_by(SafetyZone.id)
        .with_for_update()
    ).all()
    detections = [d.model_dump() for d in result.detections]
    made = []
    states = []
    for zone in configured:
        event, state = evaluate(
            db,
            zone,
            source_id,
            position_ms,
            image_hash,
            jpeg,
            detections,
            result.model_sha256 or "unavailable",
            user.id,
            recording_mode,
        )
        if event:
            made.append(event)
        states.append(dict(zone_id=str(zone.id), state=state))
    db.commit()
    return {
        **result.model_dump(),
        "safety": dict(
            events=[event_dict(e, user, project) for e in made],
            zones_evaluated=len(configured),
            states=states,
            recording_mode=recording_mode,
        ),
    }
