"""Authenticated, project-scoped safety candidates. No client-supplied detections."""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from io import BytesIO
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import delete, select
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, DbSession
from app.api.v1.videos import _detect_uploaded_image
from app.models.project import Camera
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
from app.services.access_policy import resolve_context
from app.services.legacy_access import require_full_project_read
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
    return (
        resolve_context(
            db, project_id, user, permission="camera.configure", write=True, lock=True
        ).project
        if manage
        else require_full_project_read(db, project_id, user).project
    )


def event_access(db, event, user):
    return project_access(db, event.project_id, user)


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
    # The canonical Incident owns review and acceptance; this adapter is read-only.
    return False


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
        snapshot={
            **event.snapshot,
            "ppr_requirements": [
                {
                    **citation,
                    "source_url": (
                        f"/api/v1/safety/events/{event.id}/ppr-sources/"
                        f"{citation['requirement_id']}"
                    ),
                }
                for citation in event.snapshot.get("ppr_requirements", [])
            ],
        },
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
    ctx = resolve_context(db, project_id, user, permission="camera.configure")
    from app.models.customer_control import (
        OrganizationMembership,
        ProjectAssignment,
        ProjectOrganization,
    )

    users = db.scalars(
        select(User)
        .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
        .join(
            ProjectAssignment,
            ProjectAssignment.membership_id == OrganizationMembership.id,
        )
        .join(
            ProjectOrganization,
            ProjectOrganization.id == ProjectAssignment.participation_id,
        )
        .where(
            ProjectOrganization.project_id == project_id,
            ProjectOrganization.status == "active",
            ProjectAssignment.status == "active",
            OrganizationMembership.status == "active",
            User.is_active.is_(True),
        )
        .distinct()
    )
    return dict(
        can_manage=not ctx.is_demo,
        cameras=[
            dict(id=c.id, name=c.name)
            for c in db.scalars(select(Camera).where(Camera.project_id == project_id))
        ],
        responsibles=[dict(id=u.id, name=u.name, role="assigned") for u in users],
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
    from app.models.customer_control import (
        OrganizationMembership,
        ProjectAssignment,
        ProjectOrganization,
    )

    assigned = db.scalar(
        select(ProjectAssignment.id)
        .join(
            OrganizationMembership,
            OrganizationMembership.id == ProjectAssignment.membership_id,
        )
        .join(
            ProjectOrganization,
            ProjectOrganization.id == ProjectAssignment.participation_id,
        )
        .join(User, User.id == OrganizationMembership.user_id)
        .where(
            ProjectOrganization.project_id == project.id,
            ProjectOrganization.status == "active",
            ProjectAssignment.status == "active",
            OrganizationMembership.status == "active",
            User.is_active.is_(True),
            User.id == data.responsible_user_id,
        )
    )
    if assigned is None:
        raise HTTPException(
            422, "Ответственный должен иметь действующее назначение на объект"
        )


@router.post("/projects/{project_id}/zones", status_code=201)
def create_zone(project_id: uuid.UUID, data: ZoneInput, db: DbSession, user: CurrentUser):
    project = project_access(db, project_id, user, manage=True)
    validate_assignment(db, project, data, user)
    zone = SafetyZone(
        project_id=project_id, created_by=user.id, **data.model_dump(mode="python")
    )
    db.add(zone)
    db.flush()
    _approve_zone_policy(db, zone, user)
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
    _approve_zone_policy(db, zone, user)
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
    _approve_zone_policy(db, zone, user)
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
    event = db.get(SafetyEvent, event_id)
    if event is None:
        raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
    resolve_context(
        db, event.project_id, user, permission="incident.confirm", write=True, lock=True
    )
    raise HTTPException(
        409,
        detail={
            "code": "WORKFLOW_UPGRADE_REQUIRED",
            "message": "Решение по безопасности принимается в связанном деле",
        },
    )


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
    observed_at=None,
):
    from app.services.observation_basis import approved_safety_policy, writable_project

    if not writable_project(db, zone.project_id):
        return None, "project_read_only"
    policy_event = approved_safety_policy(db, zone)
    if not policy_event:
        return None, "policy_not_approved"
    observed_at = observed_at or datetime.now(UTC)
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=UTC)
    if policy_event.occurred_at.replace(tzinfo=UTC) > observed_at:
        return None, "policy_not_effective_at_capture"
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
    from app.services.ppr_rules import resolve_ppr_rules

    ppr_rules, ppr_revision = resolve_ppr_rules(
        db, zone.project_id, observed_at=observed_at
    )
    state = dict(track.state)
    if state.get("ppr_revision", "") != ppr_revision:
        state = {}
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
            "ppr_revision": ppr_revision,
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
        matched_class = state["box"].get("raw_label")
        ppr_rule = ppr_rules.get(matched_class, {})
        ppr_citations = (
            ppr_rule.get("citations", [])
            if ppr_rule.get("probability") == 0 and not ppr_rule.get("conflict")
            else []
        )
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
                capture_schema_version=1,
                observed_from=(
                    observed_at - timedelta(milliseconds=position - state["first"])
                ).isoformat(),
                observed_until=observed_at.isoformat(),
                policy_event_id=str(policy_event.id),
                policy_sha256=policy_event.reason,
                zone=z,
                detections=detections,
                matched_detection=state["box"],
                first_matched_detection=state["first_box"],
                first_detections=state["first_detections"],
                requirements=requirements,
                ppr_requirements=ppr_citations,
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
        from app.services.observation_basis import link_safety_incident

        link_safety_incident(
            db,
            event,
            observed_from=observed_at - timedelta(milliseconds=position - state["first"]),
            observed_until=observed_at,
            policy_event=policy_event,
        )
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
    project = resolve_context(
        db, project_id, user, permission="video.analyze", write=False, lock=False
    ).project
    source_id = source_id.strip()
    if not source_id:
        raise HTTPException(422, "Нужен идентификатор источника")
    camera = db.get(Camera, camera_id)
    if not camera or camera.project_id != project_id:
        raise HTTPException(422, "Камера не принадлежит объекту")
    require_full_project_read(db, project_id, user)
    observed_at = datetime.now(UTC)
    if recording_mode:
        from app.models import VideoAsset
        from app.services.access_policy import resource_visible

        try:
            video_id = uuid.UUID(source_id.removeprefix("video:"))
        except ValueError:
            raise HTTPException(422, "Источник записи должен быть video:UUID") from None
        asset = db.get(VideoAsset, video_id)
        ctx = resolve_context(db, project_id, user, permission="video.read")
        if (
            not asset
            or asset.project_id != project_id
            or asset.camera_id != camera.id
            or not resource_visible(db, ctx, "video", asset.id)
        ):
            raise HTTPException(404, detail={"code": "RESOURCE_NOT_FOUND"})
        if not 0 <= position_ms < asset.duration_seconds * 1000:
            raise HTTPException(422, "Позиция за пределами записи")
        raw = await run_in_threadpool(_recording_source_frame, asset, position_ms)
        observed_at = asset.start_timestamp.replace(tzinfo=UTC) + timedelta(
            milliseconds=position_ms
        )
        source_id = f"video:{asset.id}"
    else:
        from app.services.camera_view import capture_frame

        db.rollback()
        raw = await run_in_threadpool(capture_frame, camera)
        source_id = f"camera:{camera.id}"
        position_ms = int(observed_at.timestamp() * 1000)
    if raw is None:
        raise HTTPException(
            409,
            detail={
                "code": "INSUFFICIENT_OBSERVATION",
                "message": "Серверный кадр источника недоступен",
            },
        )
    from app.services.observation_basis import camera_frame_quality

    if not camera_frame_quality(db, camera.id, observed_at, raw):
        raise HTTPException(
            409,
            detail={
                "code": "INSUFFICIENT_OBSERVATION",
                "message": "Ракурс, перенос или повтор записи не позволяют проверку зоны",
            },
        )
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
            observed_at=observed_at,
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


def _approve_zone_policy(db, zone, user):
    from app.services.incident_workflow import audit
    from app.services.observation_basis import digest, safety_policy_payload

    ctx = resolve_context(
        db, zone.project_id, user, permission="camera.configure", write=True, lock=True
    )
    db.flush()
    audit(db, ctx, "safety.policy.approved", zone.id, digest(safety_policy_payload(zone)))


def _recording_source_frame(asset, position_ms):
    import cv2

    from app.api.v1.videos import _video_path

    capture = cv2.VideoCapture(str(_video_path(asset)))
    try:
        capture.set(cv2.CAP_PROP_POS_MSEC, position_ms)
        success, frame = capture.read()
        if not success or frame is None:
            return None
        fps = capture.get(cv2.CAP_PROP_FPS)
        actual = (
            (capture.get(cv2.CAP_PROP_POS_FRAMES) - 1) / fps * 1000 if fps > 0 else -1
        )
        if abs(actual - position_ms) > 1000:
            return None
        success, encoded = cv2.imencode(".jpg", frame)
        return encoded.tobytes() if success else None
    finally:
        capture.release()
