"""Sample saved recordings and persist reviewable, time-windowed candidates.

This is an explicit background pass, independent of an open browser. A successful
empty YOLO result is evidence of no detection; read/inference errors break the
window. Recorded time, not processing time, selects the calendar stage.
"""

from __future__ import annotations

import hashlib
import math
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.models.incident import Incident
from app.models.project import Camera, Project
from app.models.schedule import ScheduleTask
from app.models.video import VideoAsset
from app.services.alert_service import OPEN_STATUSES, assign_initial_alert
from app.services.detector_provider import get_detector
from app.services.observation_basis import (
    append_observation,
    approved_coverage,
    camera_frame_quality,
    observation_area,
    snapshot_basis,
    stored_evidence,
    writable_project,
)
from app.services.ppr_rules import citation_revision, ppr_evaluations, resolve_ppr_rules
from app.storage import get_storage


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


@dataclass
class Window:
    first: datetime
    first_offset: float
    first_views: list[tuple[str, bytes, datetime]]
    group_key: str
    first_bucket: int
    last_bucket: int
    source_ids: tuple[str, ...]
    buckets: set[int] = field(default_factory=set)
    samples: int = 1


def _jpeg(frame) -> bytes:
    image = Image.fromarray(frame[:, :, ::-1]).convert("RGB")
    image.thumbnail((1600, 1600))
    output = BytesIO()
    image.save(output, format="JPEG", quality=88)
    return output.getvalue()


def _in_shift(project: Project, at: datetime) -> bool:
    local = at.astimezone(ZoneInfo(project.timezone)).time().replace(tzinfo=None)
    begin, end = project.shift_start, project.shift_end
    return begin <= local <= end if begin <= end else local >= begin or local <= end


def _same_episode(incident, window, at):
    exp = incident.explanation or {}
    episodes = exp.get("recording_episodes", {}).get(window.group_key, [])
    if any(
        window.first_bucket <= entry["last_bucket"]
        and window.last_bucket >= entry["first_bucket"]
        for entry in episodes
    ):
        return True
    # Compatibility for already analyzed recordings predating episode metadata.
    positions = exp.get("recording_positions", {})
    return bool(set(positions) & set(window.source_ids)) and (
        aware(incident.first_seen_at) <= at
        and window.first <= aware(incident.last_seen_at)
    )


def _record_window(exp, window):
    observations = {
        key: list(value)
        for key, value in exp.get("recording_observation_buckets", {}).items()
    }
    observations[window.group_key] = sorted(
        set(observations.get(window.group_key, [])) | window.buckets
    )
    exp["recording_observation_buckets"] = observations
    episodes = {
        key: [dict(entry) for entry in value]
        for key, value in exp.get("recording_episodes", {}).items()
    }
    intervals = episodes.setdefault(window.group_key, [])
    overlapping = next(
        (
            entry
            for entry in intervals
            if window.first_bucket <= entry["last_bucket"]
            and window.last_bucket >= entry["first_bucket"]
        ),
        None,
    )
    if overlapping:
        overlapping["first_bucket"] = min(
            overlapping["first_bucket"], window.first_bucket
        )
        overlapping["last_bucket"] = max(overlapping["last_bucket"], window.last_bucket)
    else:
        intervals.append(
            dict(first_bucket=window.first_bucket, last_bucket=window.last_bucket)
        )
    exp["recording_episodes"] = episodes
    exp["observation_count_basis"] = "unique synchronized filmed sample buckets"
    return exp.get("recording_count_baseline", 0) + sum(
        len(value) for value in observations.values()
    )


def _healthy_photo(photo, storage):
    try:
        url = photo.get("url", "")
        base = urlsplit(storage.public_url("")).path.rstrip("/") + "/"
        path = unquote(urlsplit(url).path)
        if not path.startswith(base):
            return False
        key = path[len(base) :]
        if not storage.exists(key):
            return False
        contents = storage.load(key)
        if (
            photo.get("sha256")
            and hashlib.sha256(contents).hexdigest() != photo["sha256"]
        ):
            return False
        with Image.open(BytesIO(contents)) as image:
            image.verify()
        return True
    except Exception:
        return False


def _window_photos(code, window, views, storage, *, repair=False):
    photos = []
    for index, (name, contents, timestamp) in enumerate(window.first_views + views):
        digest = hashlib.sha256(contents).hexdigest()
        filename = f"repair_{digest[:24]}" if repair else f"recording_{index}"
        key = f"snapshots/albums/{code.lower()}/{filename}.jpg"
        storage.save(key, contents)
        photos.append(
            dict(
                url=storage.public_url(key),
                camera_name=name,
                is_primary=index == len(window.first_views),
                captured_at=timestamp.isoformat(),
                sha256=digest,
                origin="recording_analysis",
            )
        )
    return photos


def _repair_evidence(incident, exp, window, views):
    storage = get_storage()
    photos = exp.get("album_photos", [])
    healthy = [
        photo
        for photo in photos
        if isinstance(photo, dict) and _healthy_photo(photo, storage)
    ]
    primary = exp.get("snapshot_url")
    required_views = {name for name, _, _ in window.first_views + views}
    healthy_views = {photo.get("camera_name") for photo in healthy}
    if (
        photos
        and len(healthy) == len(photos)
        and any(photo["url"] == primary for photo in healthy)
        and required_views <= healthy_views
    ):
        return
    fresh = _window_photos(incident.code, window, views, storage, repair=True)
    identities = {
        (photo.get("sha256"), photo.get("camera_name"), photo.get("captured_at"))
        for photo in healthy
    }
    for photo in fresh:
        identity = (photo["sha256"], photo["camera_name"], photo["captured_at"])
        if identity not in identities:
            healthy.append(photo)
            identities.add(identity)
    if not any(photo["url"] == primary for photo in healthy):
        primary = next(photo["url"] for photo in fresh if photo["is_primary"])
    for photo in healthy:
        photo["is_primary"] = photo["url"] == primary
    exp["album_photos"] = healthy
    exp["snapshot_url"] = primary
    exp["evidence_repaired_at"] = datetime.now(UTC).isoformat()


def _sample(capture, offset, fps, sample_seconds):
    import cv2

    if capture is None or not capture.isOpened() or not math.isfinite(fps) or fps <= 0:
        return None
    capture.set(cv2.CAP_PROP_POS_MSEC, offset * 1000)
    ok, frame = capture.read()
    actual = (capture.get(cv2.CAP_PROP_POS_FRAMES) - 1) / fps
    if (
        not ok
        or frame is None
        or not math.isfinite(actual)
        or abs(actual - offset) > max(1, sample_seconds / 2)
    ):
        return None
    return frame, actual


def _persist(
    db,
    asset,
    project,
    camera,
    stage,
    evaluation,
    window,
    at,
    offset,
    views,
    detector,
    sample_seconds,
    window_seconds,
    blocked_observation=None,
):
    """Same open-event key and project row lock as browser incident creation."""
    if not writable_project(db, project.id, lock=True):
        return None, False
    zone_id = (
        camera.zone_id
        if camera and camera.zone_id
        else (stage.zone_id if stage else None)
    )
    area = observation_area(
        db,
        project.id,
        area_id=asset.area_id,
        zone_id=zone_id,
        stage_id=stage.id if stage else None,
    )
    if area is None:
        if blocked_observation:
            model_hash = getattr(detector, "sha256", None)
            if model_hash and (
                len(model_hash) != 64
                or any(char not in "0123456789abcdef" for char in model_hash)
            ):
                model_hash = None
            blocked_observation(
                {
                    "reason": "missing_responsibility_area",
                    "video_id": str(asset.id),
                    "observed_from": window.first.isoformat(),
                    "observed_until": at.isoformat(),
                    "first_offset_seconds": window.first_offset,
                    "last_offset_seconds": offset,
                    "source_sha256": _recording_sha256(asset),
                    "model_sha256": model_hash,
                    "machinery_name": evaluation.machinery_name,
                    "discrepancy_type": evaluation.discrepancy_type,
                    "limitation": (
                        "Область ответственности не определена однозначно; "
                        "дело не создано"
                    ),
                }
            )
        return None, False
    key = (
        f"{project.id}:{zone_id}:{stage.id if stage else None}:"
        f"{evaluation.machinery_name}:{evaluation.discrepancy_type}"
    )
    ppr_citations = getattr(evaluation, "ppr_requirements", [])
    base_key = key
    if ppr_citations:
        signature = citation_revision(ppr_citations)
        key += ":ppr:" + signature
    previous = list(
        db.scalars(
            select(Incident)
            .where(
                Incident.project_id == project.id,
                (Incident.dedup_key == key)
                | Incident.dedup_key.like(base_key + ":ppr:%"),
            )
            .order_by(Incident.created_at, Incident.id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    )
    previous = [
        item
        for item in previous
        if item.dedup_key == key
        or (
            ppr_citations
            and citation_revision((item.explanation or {}).get("ppr_requirements", []))
            == signature
        )
    ]
    # A replay must respect an earlier human decision even if another, newer
    # episode is open now. Match the historical episode before the open key.
    historical = next(
        (
            item
            for item in previous
            if item.status not in OPEN_STATUSES and _same_episode(item, window, at)
        ),
        None,
    )
    existing = historical or next(
        (item for item in previous if item.status in OPEN_STATUSES), None
    )
    marker = str(asset.id)
    if existing:
        explanation = dict(existing.explanation or {})
        _repair_evidence(existing, explanation, window, views)
        if historical:
            # Preserve status, counts and reviewed time range. Only recover
            # missing evidence from authentic decoded frames of this episode.
            existing.explanation = explanation
            db.commit()
            return existing.id, False
        positions = dict(explanation.get("recording_positions", {}))
        positions[marker] = max(positions.get(marker, -1), offset)
        explanation["recording_positions"] = positions
        if "recording_count_baseline" not in explanation:
            explanation["legacy_observation_count"] = existing.observation_count
            explanation["recording_count_baseline"] = (
                0
                if explanation.get("origin") == "recording_analysis"
                else existing.observation_count
            )
        existing.observation_count = _record_window(explanation, window)
        existing.first_seen_at = min(aware(existing.first_seen_at), window.first)
        existing.last_seen_at = max(aware(existing.last_seen_at), at)
        if evaluation.severity == "ERROR":
            existing.priority = IncidentPriority.CRITICAL
            explanation["severity"] = "error"
        try:
            last_confirmed = datetime.fromisoformat(
                explanation.get("last_confirmed_at")
                or explanation.get("captured_at")
                or at.isoformat()
            )
        except (ValueError, TypeError):
            last_confirmed = aware(existing.last_seen_at)
        explanation["last_confirmed_at"] = max(
            aware(last_confirmed), aware(existing.last_seen_at), at
        ).isoformat()
        existing.explanation = explanation
        stored_evidence(
            db,
            existing,
            explanation.get("album_photos", []),
            owner_participation_id=asset.owner_participation_id,
        )
        _append_window_observation(db, existing, window, at, detector, ppr_citations)
        db.commit()
        return existing.id, False

    from app.services.control_releases import release_at

    release = release_at(db, project.id, at)
    if not release or not ppr_citations:
        return None, False
    # A negative window may not straddle a release or coverage boundary.
    first_release = release_at(db, project.id, window.first)
    if first_release is None or first_release.id != release.id:
        return None, False
    source_assets = [
        db.get(VideoAsset, uuid.UUID(source_id)) for source_id in window.source_ids
    ]
    source_cameras = [source.camera_id for source in source_assets if source]
    coverage = approved_coverage(db, project.id, area, at, source_cameras)
    first_coverage = approved_coverage(db, project.id, area, window.first, source_cameras)
    if evaluation.discrepancy_type.startswith("MISSING_") and (
        not coverage or not first_coverage or coverage.id != first_coverage.id
    ):
        return None, False
    code = f"INC-{uuid.uuid4().hex[:8].upper()}"
    storage = get_storage()
    photos = _window_photos(code, window, views, storage)
    description = (
        f"{evaluation.description}\n"
        f"Запись «{asset.filename}», {window.first.isoformat()} — {at.isoformat()}. "
        f"Окно {window_seconds:g} с, шаг {sample_seconds:g} с, "
        f"успешных наблюдений {window.samples}.\n"
        f"Ракурсов в подтверждающей выборке: {len(views)}. "
        "Для отсутствия объединены успешные распознавания всех совпадающих по "
        "времени записей этой зоны; ошибка любого ракурса прерывает окно отсутствия.\n"
        "Кандидат для проверки человеком. Вывод относится к доступным ракурсам "
        "и выборочным кадрам; отсутствие распознавания не доказывает отсутствие "
        "техники на всей площадке. Качество модели не подтверждено, confidence "
        "не откалиброван; количество физических машин не определялось."
    )
    incident = Incident(
        code=code,
        project_id=project.id,
        area_id=area.id,
        origin_participation_id=asset.owner_participation_id,
        zone_id=zone_id,
        camera_id=camera.id if camera else None,
        schedule_task_id=stage.id if stage else None,
        category=IncidentCategory.EQUIPMENT,
        type=(
            IncidentType.EQUIPMENT_UNEXPECTED
            if evaluation.discrepancy_type == "UNCHARACTERISTIC_PRESENT"
            else IncidentType.EQUIPMENT_MISSING
        ),
        priority=(
            IncidentPriority.CRITICAL
            if evaluation.severity == "ERROR"
            else IncidentPriority.MEDIUM
        ),
        status=IncidentStatus.PENDING,
        title=f"Проверить по записи: {evaluation.machinery_name}",
        description=description,
        discrepancy_type=evaluation.discrepancy_type,
        machinery_type=evaluation.machinery_name,
        stage_probability=evaluation.stage_probability,
        dedup_key=key,
        first_seen_at=window.first,
        last_seen_at=at,
        observation_count=window.samples,
        explanation=dict(
            origin="recording_analysis",
            algorithm_version="recording-window-v1",
            video_id=str(asset.id),
            camera_name=asset.filename,
            observed_count=evaluation.observed_count,
            stage_name=stage.name if stage else "ППР объекта",
            ppr_requirements=ppr_citations,
            ppr_evaluated_at=datetime.now(UTC).isoformat() if ppr_citations else None,
            description=description,
            severity=evaluation.severity.lower(),
            captured_at=at.isoformat(),
            snapshot_url=photos[len(window.first_views)]["url"],
            album_photos=photos,
            model_sha256=getattr(detector, "sha256", None),
            quality_verified=False,
            confidence_calibrated=False,
            review_required=True,
            rule_version="recording-window-v1",
            sample_seconds=sample_seconds,
            sources_evaluated=[name for name, _, _ in views],
            window_seconds=window_seconds,
            first_offset_seconds=window.first_offset,
            confirmed_offset_seconds=offset,
            recording_positions={marker: offset},
            recording_count_baseline=0,
            last_confirmed_at=at.isoformat(),
        ),
    )
    explanation = dict(incident.explanation)
    incident.observation_count = _record_window(explanation, window)
    incident.explanation = explanation
    db.add(incident)
    db.flush()
    stored_evidence(
        db, incident, photos, owner_participation_id=asset.owner_participation_id
    )
    snapshot_basis(
        db,
        incident,
        kind="recording",
        observed_from=window.first,
        observed_until=at,
        policy={
            "provenance": "control_release",
            "release_id": str(release.id),
            "manifest_sha256": release.manifest_sha256,
            "coverage_status": "sufficient" if coverage else "insufficient",
            "coverage_configuration_id": str(coverage.id) if coverage else None,
            "required_camera_ids": coverage.camera_ids if coverage else [],
        },
        sources=[
            {
                "video_id": str(source.id),
                "camera_id": str(source.camera_id) if source.camera_id else None,
                "start_timestamp": aware(source.start_timestamp).isoformat(),
                "first_offset_seconds": (
                    window.first - aware(source.start_timestamp)
                ).total_seconds(),
                "last_offset_seconds": (
                    at - aware(source.start_timestamp)
                ).total_seconds(),
                "sha256": _recording_sha256(source),
                "model_sha256": getattr(detector, "sha256", None),
            }
            for source in source_assets
            if source
        ],
    )

    _append_window_observation(db, incident, window, at, detector, ppr_citations)
    assign_initial_alert(db, incident, project)
    db.commit()
    return incident.id, True


def analyze_recording(
    db: Session,
    video_id: uuid.UUID,
    *,
    sample_seconds: float = 10,
    window_seconds: float = 30,
    max_duration_seconds: float | None = None,
    detector=None,
    progress=None,
) -> dict:
    """Analyze the whole asset, or an explicitly bounded prefix for validation.

    At least three successful samples spanning >=30 filmed seconds are required.
    A window cannot cross an unreadable/failed sample, stage or shift boundary.
    Open incidents merge across browser/background passes; reruns are idempotent.
    """
    import cv2

    if (
        not math.isfinite(window_seconds)
        or window_seconds < 30
        or not math.isfinite(sample_seconds)
        or not 0 < sample_seconds <= window_seconds / 2
    ):
        raise ValueError("Require window >=30 seconds and 0 < sample <= window/2")
    if max_duration_seconds is not None and (
        not math.isfinite(max_duration_seconds) or max_duration_seconds <= 0
    ):
        raise ValueError("max_duration_seconds must be positive")
    asset = db.get(VideoAsset, video_id)
    if not asset or asset.status != "READY":
        raise ValueError("A READY saved recording is required")
    project = db.get(Project, asset.project_id)
    if not project:
        raise ValueError("Recording project does not exist")
    camera = db.get(Camera, asset.camera_id) if asset.camera_id else None
    if asset.camera_id and (not camera or camera.project_id != project.id):
        raise ValueError("Recording camera must belong to its project")
    result = dict(
        video_id=str(asset.id),
        status="complete",
        samples=0,
        failed_samples=0,
        insufficient_samples=0,
        created=0,
        incident_ids=[],
        analyzed_until_seconds=0,
        prefix_only=max_duration_seconds is not None,
        technical_observations=[],
    )
    if not writable_project(db, project.id):
        return {**result, "status": "disabled", "reason": "project_read_only"}
    detector = detector or get_detector()
    if not detector.is_ready or not detector.compliance_enabled:
        return {**result, "status": "disabled"}
    if project.settings and not project.settings.observation_enabled:
        return {**result, "status": "disabled"}
    demo = project.code == "MANAGEMENT-DEMO"
    warning_after = window_seconds if demo else max(window_seconds, 300)
    error_after = 2 * window_seconds if demo else max(window_seconds, 1800)
    unexpected_after = window_seconds if demo else max(window_seconds, 60)
    stages = list(
        db.scalars(
            select(ScheduleTask)
            .where(
                ScheduleTask.project_id == project.id,
                ScheduleTask.status != "cancelled",
            )
            .order_by(ScheduleTask.order_index, ScheduleTask.id)
        )
    )
    path = Path(asset.storage_key)
    if not path.is_file():
        raise ValueError("Saved recording is missing")
    capture = cv2.VideoCapture(str(path))
    companions = []
    if camera and camera.zone_id:
        others = list(
            db.scalars(
                select(VideoAsset)
                .join(Camera, VideoAsset.camera_id == Camera.id)
                .where(
                    VideoAsset.project_id == project.id,
                    VideoAsset.status == "READY",
                    VideoAsset.id != asset.id,
                    Camera.project_id == project.id,
                    Camera.zone_id == camera.zone_id,
                )
            )
        )
        for other in others:
            end = aware(other.start_timestamp) + timedelta(
                seconds=max(0, other.duration_seconds)
            )
            own_end = aware(asset.start_timestamp) + timedelta(
                seconds=max(0, asset.duration_seconds)
            )
            if (
                end < aware(asset.start_timestamp)
                or aware(other.start_timestamp) > own_end
            ):
                continue
            # Missing or corrupt companion files remain expected sources. They
            # cannot silently disappear and authorize an absence candidate.
            cap = (
                cv2.VideoCapture(other.storage_key)
                if Path(other.storage_key).is_file()
                else None
            )
            other_fps = float(cap.get(cv2.CAP_PROP_FPS)) if cap is not None else 0
            companions.append((other, cap, other_fps))
    from app.services.recording_integrity import SequenceReplay

    replay_detector = SequenceReplay()
    replay_detected = False
    windows: dict[tuple, Window] = {}
    last_stage = None
    last_sources = None
    touched = set()
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if (
            not capture.isOpened()
            or not math.isfinite(fps)
            or fps <= 0
            or not math.isfinite(count)
            or count <= 0
        ):
            raise ValueError("Recording cannot be decoded")
        duration = count / fps
        limit = min(duration, max_duration_seconds) if max_duration_seconds else duration
        result["duration_seconds"] = duration
        offset = 0.0
        attempts = 0
        while offset < duration and offset <= limit:
            attempts += 1
            if progress and attempts % 10 == 0:
                progress({**result, "incident_ids": sorted(touched)})
            if not detector.is_ready or not detector.compliance_enabled:
                result["status"] = "disabled"
                break
            # The decoder must actually reach the requested sample. Some corrupt
            # streams report a successful old frame after a failed random seek.
            sample = _sample(capture, offset, fps, sample_seconds)
            if sample is None:
                windows.clear()
                result["failed_samples"] += 1
                offset += sample_seconds
                continue
            frame, actual = sample
            at = aware(asset.start_timestamp) + timedelta(seconds=actual)
            candidates = [
                s
                for s in stages
                if aware(s.planned_start) <= at <= aware(s.planned_end)
                and (
                    s.zone_id is None
                    or camera is None
                    or camera.zone_id is None
                    or s.zone_id == camera.zone_id
                )
            ]
            # Ambiguous overlapping stages cannot establish an equipment rule.
            stage = candidates[0] if len(candidates) == 1 else None
            ppr_rules, ppr_revision = resolve_ppr_rules(
                db, project.id, stage, observed_at=at
            )
            if (not stage and not ppr_rules) or not _in_shift(project, at):
                windows.clear()
                last_stage = None
                offset += sample_seconds
                continue
            stage_revision = (stage.id if stage else None, ppr_revision)
            if last_stage != stage_revision:
                windows.clear()
                last_stage = stage_revision
            source_ids = tuple(
                sorted(
                    [str(asset.id)]
                    + [
                        str(other.id)
                        for other, _, _ in companions
                        if 0
                        <= (at - aware(other.start_timestamp)).total_seconds()
                        < other.duration_seconds
                    ]
                )
            )
            if source_ids != last_sources:
                # Joining/leaving views cannot borrow observation time from a
                # different camera group, especially at staggered recording starts.
                windows.clear()
                last_sources = source_ids
            anchor = max(
                [aware(asset.start_timestamp)]
                + [
                    aware(other.start_timestamp)
                    for other, _, _ in companions
                    if str(other.id) in source_ids
                ]
            )
            group_key = hashlib.sha256(
                (
                    "|".join(source_ids) + f"|{anchor.isoformat()}|{sample_seconds:g}"
                ).encode()
            ).hexdigest()[:24]
            bucket = round((at - anchor).total_seconds() / sample_seconds)
            jpeg = _jpeg(frame)
            duplicate_frame, repeated_offset = replay_detector.observe(jpeg, actual)
            if repeated_offset is not None:
                replay_detected = True
                from app.services.recording_integrity import record_replay_signal

                signal_id = record_replay_signal(
                    db, asset, camera, at, repeated_offset, actual, jpeg
                )
                if signal_id:
                    touched.add(str(signal_id))
                windows.clear()
            views = [(asset.filename, jpeg, at)]
            try:
                detections = detector.detect_frame(jpeg)
            except Exception:
                windows.clear()
                result["failed_samples"] += 1
                offset += sample_seconds
                continue
            area = observation_area(
                db,
                project.id,
                area_id=asset.area_id,
                zone_id=camera.zone_id if camera else (stage.zone_id if stage else None),
                stage_id=stage.id if stage else None,
            )
            source_assets = [asset] + [
                other for other, _, _ in companions if str(other.id) in source_ids
            ]
            coverage = approved_coverage(
                db, project.id, area, at, [source.camera_id for source in source_assets]
            )
            absence_allowed = (
                not duplicate_frame
                and not replay_detected
                and bool(coverage)
                and camera_frame_quality(db, asset.camera_id, at, jpeg)
            )
            for other, cap, other_fps in companions:
                other_offset = (at - aware(other.start_timestamp)).total_seconds()
                if not 0 <= other_offset < other.duration_seconds:
                    continue
                companion = _sample(cap, other_offset, other_fps, sample_seconds)
                try:
                    if companion is None:
                        raise ValueError("Companion frame unavailable")
                    companion_frame, companion_offset = companion
                    companion_jpeg = _jpeg(companion_frame)
                    companion_detections = detector.detect_frame(companion_jpeg)
                    if not camera_frame_quality(db, other.camera_id, at, companion_jpeg):
                        absence_allowed = False
                    detections.extend(companion_detections)
                    views.append(
                        (
                            other.filename,
                            companion_jpeg,
                            aware(other.start_timestamp)
                            + timedelta(seconds=companion_offset),
                        )
                    )
                except Exception:
                    absence_allowed = False
                    result["failed_samples"] += 1
            if not absence_allowed:
                result["insufficient_samples"] += 1
            try:
                evaluations = detector.evaluate_rules(
                    (stage.machinery_probabilities or {}) if stage else {}, detections
                )
            except Exception:
                windows.clear()
                result["failed_samples"] += 1
                offset += sample_seconds
                continue
            evaluations = (
                ppr_evaluations(evaluations, ppr_rules, detections, detector)
                if ppr_rules
                else evaluations
            )
            result["samples"] += 1
            result["analyzed_until_seconds"] = actual
            active = set()
            for evaluation in evaluations:
                if not getattr(evaluation, "ppr_requirements", []):
                    # Catalog probabilities are advisory until explicitly released.
                    continue
                if not evaluation.is_violation or not detector.can_evaluate(
                    evaluation.machinery_name
                ):
                    continue
                if (
                    evaluation.discrepancy_type.startswith("MISSING_")
                    and not absence_allowed
                ):
                    continue
                key = (
                    evaluation.discrepancy_type,
                    evaluation.machinery_name,
                    str(coverage.id)
                    if coverage and evaluation.discrepancy_type.startswith("MISSING_")
                    else None,
                )
                active.add(key)
                window = windows.get(key)
                if window is None:
                    windows[key] = Window(
                        at,
                        actual,
                        list(views),
                        group_key,
                        bucket,
                        bucket,
                        source_ids,
                        {bucket},
                    )
                    continue
                window.samples += 1
                window.last_bucket = bucket
                window.buckets.add(bucket)
                elapsed = (at - window.first).total_seconds()
                required = (
                    unexpected_after
                    if evaluation.discrepancy_type == "UNCHARACTERISTIC_PRESENT"
                    else warning_after
                )
                if window.samples < 3 or elapsed < required:
                    continue
                if evaluation.discrepancy_type == "MISSING_MANDATORY":
                    evaluation.severity = "ERROR" if elapsed >= error_after else "WARNING"
                identifier, created = _persist(
                    db,
                    asset,
                    project,
                    camera,
                    stage,
                    evaluation,
                    window,
                    at,
                    actual,
                    views,
                    detector,
                    sample_seconds,
                    window_seconds,
                    blocked_observation=result["technical_observations"].append,
                )
                if identifier is not None:
                    touched.add(str(identifier))
                result["created"] += int(created)
            windows = {key: window for key, window in windows.items() if key in active}
            offset += sample_seconds
        result["incident_ids"] = sorted(touched)
        if (result["failed_samples"] or result["technical_observations"]) and result[
            "status"
        ] == "complete":
            result["status"] = "partial"
        return result
    finally:
        capture.release()
        for _, companion, _ in companions:
            if companion is not None:
                companion.release()


def _recording_sha256(asset):
    try:
        with Path(asset.storage_key).open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest()
    except OSError:
        # A known missing companion remains unknown; positive detections from
        # an available source are still retainable with incomplete coverage.
        return None


def _append_window_observation(db, incident, window, at, detector, citations):
    from app.models.customer_control import IncidentBasis, ResponsibilityArea
    from app.schemas.customer_control import CitationDTO, CoverageDTO, IncidentBasisDTO
    from app.services.control_releases import release_at
    from app.services.observation_basis import digest

    stored = db.scalar(
        select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
    )
    release = release_at(db, incident.project_id, at)
    if stored is None or release is None:
        return None
    receipt = digest(
        {
            "recording_group": window.group_key,
            "last_bucket": window.last_bucket,
            "event_key": incident.dedup_key,
        }
    )
    sources = []
    camera_ids = []
    for identifier in window.source_ids:
        source = db.get(VideoAsset, uuid.UUID(identifier))
        if source:
            if source.camera_id:
                camera_ids.append(source.camera_id)
            sources.append(
                {
                    "video_id": str(source.id),
                    "camera_id": str(source.camera_id) if source.camera_id else None,
                    "start_timestamp": aware(source.start_timestamp).isoformat(),
                    "first_offset_seconds": (
                        window.first - aware(source.start_timestamp)
                    ).total_seconds(),
                    "last_offset_seconds": (
                        at - aware(source.start_timestamp)
                    ).total_seconds(),
                    "sha256": _recording_sha256(source),
                    "model_sha256": getattr(detector, "sha256", None),
                }
            )
    area = db.get(ResponsibilityArea, incident.area_id) if incident.area_id else None
    coverage = approved_coverage(db, incident.project_id, area, at, camera_ids)
    policy = dict(stored.snapshot)
    policy.update(
        release_id=release.id,
        manifest_sha256=release.manifest_sha256,
        provenance="release",
        citations=[
            CitationDTO.model_validate(
                {
                    key: value
                    for key, value in citation.items()
                    if key in CitationDTO.model_fields
                }
            )
            for citation in citations
        ],
        coverage=CoverageDTO(
            status="sufficient" if coverage else "insufficient",
            configuration_id=coverage.id if coverage else None,
            camera_ids=coverage.camera_ids if coverage else [],
            reasons=[] if coverage else ["missing_view"],
        ),
    )
    return append_observation(
        db,
        incident,
        source_receipt=receipt,
        observed_from=window.first,
        observed_until=at,
        sources=sources,
        policy_snapshot=IncidentBasisDTO.model_validate(policy),
    )
