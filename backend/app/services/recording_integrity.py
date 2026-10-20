"""Exact server-decoded sequence replay signals; never a verdict of contractor fault."""

from __future__ import annotations

import hashlib
from collections import deque
from datetime import timedelta


class SequenceReplay:
    """Require three distinct frames repeated in the same order, at another position."""

    def __init__(self):
        self.recent = deque(maxlen=3)
        self.seen = {}
        self.frames = set()

    def observe(self, jpeg: bytes, offset: float):
        digest = hashlib.sha256(jpeg).hexdigest()
        duplicate = digest in self.frames
        self.frames.add(digest)
        self.recent.append(digest)
        if len(self.recent) != 3 or len(set(self.recent)) != 3:
            return duplicate, None
        signature = tuple(self.recent)
        original = self.seen.setdefault(signature, offset)
        # A sequence ending at the same time is its first observation.
        return duplicate, original if offset > original else None


def record_replay_signal(db, asset, camera, at, first_offset, offset, jpeg):
    import uuid

    from sqlalchemy import select

    from app.models import Incident
    from app.models.enums import (
        IncidentCategory,
        IncidentPriority,
        IncidentStatus,
        IncidentType,
    )
    from app.services.alert_service import assign_initial_alert
    from app.services.observation_basis import (
        digest,
        snapshot_basis,
        stored_evidence,
        writable_project,
    )

    project = writable_project(db, asset.project_id, lock=True)
    if project is None:
        return None
    key = f"recording-loop:{asset.id}"
    existing = db.scalar(
        select(Incident)
        .where(Incident.project_id == project.id, Incident.dedup_key == key)
        .with_for_update()
    )
    if existing:
        return existing.id
    from app.storage import get_storage

    storage = get_storage()
    identifier = uuid.uuid4()
    image_key = f"snapshots/recording-integrity/{identifier}.jpg"
    storage.save(image_key, jpeg)
    photo = {
        "url": storage.public_url(image_key),
        "camera_name": asset.filename,
        "is_primary": True,
        "captured_at": at.isoformat(),
        "sha256": hashlib.sha256(jpeg).hexdigest(),
    }
    began = at - timedelta(seconds=offset - first_offset)
    policy = {"algorithm": "recording-exact-sequence-v1", "distinct_frames": 3}
    incident = Incident(
        id=identifier,
        code="INC-" + uuid.uuid4().hex[:8].upper(),
        project_id=project.id,
        camera_id=camera.id if camera else None,
        zone_id=camera.zone_id if camera else None,
        area_id=asset.area_id,
        origin_participation_id=asset.owner_participation_id,
        case_kind="control_integrity",
        category=IncidentCategory.CAMERA,
        type=IncidentType.CAMERA_VISIBILITY,
        status=IncidentStatus.PENDING,
        priority=IncidentPriority.HIGH,
        title="Повторяющийся фрагмент сохранённой записи",
        description=(
            "Сервер повторно декодировал одинаковую последовательность "
            "трёх разных кадров. "
            "Это сигнал качества источника; он не доказывает вину подрядчика "
            "или подмену прямого эфира."
        ),
        discrepancy_type="STREAM_LOOP",
        dedup_key=key,
        first_seen_at=began,
        last_seen_at=at,
        explanation={
            "origin": "recording_integrity",
            "algorithm_version": policy["algorithm"],
            "video_id": str(asset.id),
            "first_offset_seconds": first_offset,
            "confirmed_offset_seconds": offset,
            "snapshot_url": photo["url"],
            "album_photos": [photo],
            "review_required": True,
        },
    )
    db.add(incident)
    db.flush()
    stored_evidence(
        db, incident, [photo], owner_participation_id=asset.owner_participation_id
    )
    snapshot_basis(
        db,
        incident,
        kind="camera",
        observed_from=began,
        observed_until=at,
        policy={"provenance": "camera_policy", "sha256": digest(policy)},
        sources=[
            {
                "video_id": str(asset.id),
                "camera_id": str(camera.id) if camera else None,
                "first_offset_seconds": first_offset,
                "last_offset_seconds": offset,
                "evidence_sha256": photo["sha256"],
            }
        ],
    )
    assign_initial_alert(db, incident, project)
    db.commit()
    return incident.id
