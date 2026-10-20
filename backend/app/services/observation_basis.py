"""Server-approved observation policy and immutable source snapshots."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from sqlalchemy import or_, select

from app.models import Incident, Project
from app.models.customer_control import (
    AuditEvent,
    CoverageConfiguration,
    EvidenceAsset,
    IncidentBasis,
    IncidentEvidenceLink,
    ResponsibilityArea,
)

if TYPE_CHECKING:
    from app.schemas.customer_control import IncidentBasisDTO


def aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
        ).encode()
    ).hexdigest()


def writable_project(db, project_id, *, lock=False):
    query = select(Project).where(Project.id == project_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    project = db.scalar(query)
    return (
        project
        if project and project.kind != "shared_demo" and project.lifecycle == "active"
        else None
    )


def observation_area(db, project_id, *, area_id=None, zone_id=None, stage_id=None):
    query = select(ResponsibilityArea).where(ResponsibilityArea.project_id == project_id)
    if area_id:
        query = query.where(ResponsibilityArea.id == area_id)
    else:
        if zone_id is not None:
            query = query.where(
                or_(
                    ResponsibilityArea.zone_id.is_(None),
                    ResponsibilityArea.zone_id == zone_id,
                )
            )
        else:
            query = query.where(ResponsibilityArea.zone_id.is_(None))
        if stage_id is not None:
            query = query.where(
                or_(
                    ResponsibilityArea.schedule_task_id.is_(None),
                    ResponsibilityArea.schedule_task_id == stage_id,
                )
            )
        else:
            query = query.where(ResponsibilityArea.schedule_task_id.is_(None))
    candidates = list(db.scalars(query))
    if len(candidates) != 1:
        return None
    area = candidates[0]
    if (area.zone_id and area.zone_id != zone_id) or (
        area.schedule_task_id and area.schedule_task_id != stage_id
    ):
        return None
    return area


def approved_coverage(db, project_id, area, at, camera_ids):
    if area is None:
        return None
    configurations = db.scalars(
        select(CoverageConfiguration)
        .where(
            CoverageConfiguration.project_id == project_id,
            CoverageConfiguration.area_id == area.id,
            CoverageConfiguration.effective_from <= aware(at),
            or_(
                CoverageConfiguration.effective_until.is_(None),
                CoverageConfiguration.effective_until > aware(at),
            ),
        )
        .order_by(CoverageConfiguration.effective_from.desc())
    )
    actual = {str(value) for value in camera_ids if value}
    for configuration in configurations:
        expected = set(configuration.camera_ids)
        if expected and expected <= actual:
            return configuration
    return None


def snapshot_basis(db, incident, *, kind, observed_from, observed_until, policy, sources):
    existing = db.scalar(
        select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
    )
    if existing:
        return existing
    from app.services.deadlines import apply_detection_deadline

    apply_detection_deadline(db, incident)
    from app.schemas.customer_control import (
        CitationDTO,
        CoverageDTO,
        IncidentBasisDTO,
        SourceObservationDTO,
    )

    db.flush()
    evidence_ids = list(
        db.scalars(
            select(IncidentEvidenceLink.asset_id).where(
                IncidentEvidenceLink.incident_id == incident.id
            )
        )
    )
    citations = []
    for citation in (incident.explanation or {}).get("ppr_requirements", []):
        fields = {
            key: value
            for key, value in citation.items()
            if key in CitationDTO.model_fields
        }
        citations.append(CitationDTO.model_validate(fields))
    from app.models.customer_control import IncidentRequirementLink

    for citation in citations:
        if (
            db.get(
                IncidentRequirementLink, (incident.id, citation.requirement_revision_id)
            )
            is None
        ):
            db.add(
                IncidentRequirementLink(
                    incident_id=incident.id, revision_id=citation.requirement_revision_id
                )
            )
    detector_hash = (incident.explanation or {}).get("model_sha256")
    if detector_hash and (
        len(detector_hash) != 64
        or any(char not in "0123456789abcdef" for char in detector_hash)
    ):
        detector_hash = None
    provenance = (
        "release"
        if policy.get("provenance") == "control_release"
        else policy["provenance"]
    )
    status = policy.get("coverage_status", "unknown")
    data = dict(
        schema_version=1,
        project_id=incident.project_id,
        observed_from=aware(observed_from),
        observed_until=aware(observed_until),
        source_evidence_ids=evidence_ids,
        detector_sha256=detector_hash,
        release_id=policy.get("release_id"),
        manifest_sha256=policy.get("manifest_sha256"),
        provenance=provenance,
        citations=citations,
        coverage=CoverageDTO(
            status=status,
            configuration_id=policy.get("coverage_configuration_id"),
            camera_ids=policy.get("required_camera_ids", []),
            reasons=["missing_view"] if status != "sufficient" else [],
        ),
        limitations=[
            "Требуется проверка человеком",
            "Автоматический результат не является приёмкой устранения",
        ],
    )
    for field, value in (
        ("policy_revision_id", policy.get("approval_event_id")),
        ("policy_sha256", policy.get("sha256")),
        ("source_safety_event_id", incident.source_safety_event_id),
    ):
        if field in IncidentBasisDTO.model_fields:
            data[field] = value
    source_rows = []
    for source in sources:
        source = {
            key: value
            for key, value in source.items()
            if key in SourceObservationDTO.model_fields
        }
        for key in ("model_sha256", "evidence_sha256", "sha256"):
            value = source.get(key)
            if value and (
                len(value) != 64 or any(char not in "0123456789abcdef" for char in value)
            ):
                source[key] = None
        source_rows.append(SourceObservationDTO.model_validate(source))
    data["sources"] = source_rows
    snapshot = IncidentBasisDTO(**data).model_dump(mode="json")
    basis = IncidentBasis(
        incident_id=incident.id, snapshot=snapshot, sha256=digest(snapshot)
    )
    db.add(basis)
    return basis


def stored_evidence(db, incident, photos, *, owner_participation_id=None):
    from app.storage import get_storage

    storage = get_storage()
    for photo in photos:
        path = unquote(urlsplit(photo["url"]).path)
        prefix = urlsplit(storage.public_url("")).path.rstrip("/") + "/"
        if not path.startswith(prefix):
            continue
        key = path[len(prefix) :]
        contents = storage.load(key)
        sha256 = hashlib.sha256(contents).hexdigest()
        asset = db.scalar(
            select(EvidenceAsset).where(
                EvidenceAsset.project_id == incident.project_id,
                EvidenceAsset.storage_key == key,
            )
        )
        if asset is None:
            asset = EvidenceAsset(
                id=uuid.uuid4(),
                project_id=incident.project_id,
                owner_participation_id=owner_participation_id,
                storage_key=key,
                media_type="image/jpeg",
                size_bytes=len(contents),
                sha256=sha256,
                source="recording",
                integrity="verified",
                captured_at=datetime.fromisoformat(photo["captured_at"]),
            )
            db.add(asset)
        if db.get(IncidentEvidenceLink, (incident.id, asset.id)) is None:
            db.add(
                IncidentEvidenceLink(
                    incident_id=incident.id, asset_id=asset.id, kind="context"
                )
            )


def safety_policy_payload(zone):
    return {
        name: getattr(zone, name)
        for name in (
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
        )
    }


def approved_safety_policy(db, zone):
    expected = digest(safety_policy_payload(zone))
    return db.scalar(
        select(AuditEvent)
        .where(
            AuditEvent.project_id == zone.project_id,
            AuditEvent.resource_id == zone.id,
            AuditEvent.event_type == "safety.policy.approved",
            AuditEvent.reason == expected,
        )
        .order_by(AuditEvent.occurred_at.desc())
    )


def camera_frame_quality(db, camera_id, at, jpeg):
    """Validate the historical reference, move state and loop state at capture time."""
    if not camera_id:
        return False
    from app.models.camera_view import CameraViewEvent
    from app.services.camera_view import (
        MATCH_OK,
        compare,
        features_from_image,
        load_view_image,
    )

    event = db.scalar(
        select(CameraViewEvent)
        .where(
            CameraViewEvent.camera_id == camera_id,
            CameraViewEvent.created_at <= aware(at),
            CameraViewEvent.kind == "reference_set",
        )
        .order_by(CameraViewEvent.created_at.desc())
    )
    if not event or not event.snapshot_key:
        return False
    from app.models.customer_control import CameraMoveRequest

    approved_reference = db.scalar(
        select(AuditEvent.id).where(
            AuditEvent.resource_id == camera_id,
            AuditEvent.event_type == "camera.reference.approved",
            AuditEvent.occurred_at >= event.created_at,
            AuditEvent.occurred_at <= aware(at),
        )
    )
    if not approved_reference:
        return False
    pending_restore = db.scalar(
        select(CameraMoveRequest.id).where(
            CameraMoveRequest.camera_id == camera_id,
            CameraMoveRequest.requested_from <= aware(at),
            or_(
                CameraMoveRequest.status.in_(
                    {"approved", "in_progress", "awaiting_reference", "expired"}
                ),
                (CameraMoveRequest.status == "completed")
                & (CameraMoveRequest.updated_at > aware(at)),
            ),
        )
    )
    if pending_restore:
        return False
    moved = db.scalar(
        select(CameraViewEvent.id).where(
            CameraViewEvent.camera_id == camera_id,
            CameraViewEvent.created_at > event.created_at,
            CameraViewEvent.created_at <= aware(at),
            CameraViewEvent.kind == "move_approved",
        )
    )
    if moved:
        return False
    loop = db.scalar(
        select(Incident.id).where(
            Incident.camera_id == camera_id,
            Incident.discrepancy_type == "STREAM_LOOP",
            Incident.first_seen_at <= aware(at),
            or_(Incident.resolved_at.is_(None), Incident.resolved_at > aware(at)),
        )
    )
    if loop:
        return False
    try:
        return (
            compare(
                features_from_image(load_view_image(event.snapshot_key)),
                features_from_image(jpeg),
            ).match
            >= MATCH_OK
        )
    except (OSError, ValueError):
        return False


def link_safety_incident(db, event, *, observed_from, observed_until, policy_event):
    from app.models import Camera
    from app.models.enums import (
        IncidentCategory,
        IncidentPriority,
        IncidentStatus,
        IncidentType,
    )
    from app.services.alert_service import assign_initial_alert

    existing = db.scalar(
        select(Incident).where(Incident.source_safety_event_id == event.id)
    )
    if existing:
        return existing
    project = writable_project(db, event.project_id, lock=True)
    if project is None:
        return None
    camera = db.get(Camera, event.camera_id)
    area = observation_area(
        db, event.project_id, zone_id=camera.zone_id if camera else None
    )
    if area is None:
        # The immutable source SafetyEvent remains available for configuration
        # review; attribution cannot be invented from an ambiguous geography.
        return None
    titles = {
        "worker_danger_zone": "Человек в опасной зоне",
        "vehicle_blocks_passage": "Техника в зоне прохода",
        "vehicle_restricted_zone": "Техника в запрещённой зоне",
    }
    incident = Incident(
        id=uuid.uuid4(),
        code=f"INC-{uuid.uuid4().hex[:8].upper()}",
        project_id=event.project_id,
        camera_id=event.camera_id,
        zone_id=camera.zone_id if camera else None,
        area_id=area.id,
        source_safety_event_id=event.id,
        case_kind="construction",
        category=IncidentCategory.SAFETY,
        type=IncidentType.OTHER,
        status=IncidentStatus.PENDING,
        priority=IncidentPriority.HIGH,
        title=titles.get(event.scenario, "Проверить событие безопасности"),
        description=event.snapshot.get("limitations"),
        discrepancy_type=event.scenario,
        dedup_key=f"safety:{event.id}",
        first_seen_at=observed_from,
        last_seen_at=observed_until,
        observation_count=event.snapshot.get("observations", 2),
        explanation={
            "origin": "safety",
            "source_safety_event_id": str(event.id),
            "ppr_requirements": event.snapshot.get("ppr_requirements", []),
            "model_sha256": event.model_sha256,
            "review_required": True,
            "snapshot_url": f"/media/safety/{event.id}/last.jpg",
            "album_photos": [
                {
                    "url": f"/media/safety/{event.id}/{kind}.jpg",
                    "is_primary": kind == "last",
                    "camera_name": camera.name if camera else "Камера",
                    "captured_at": time.isoformat(),
                }
                for kind, time in (("first", observed_from), ("last", observed_until))
            ],
        },
    )
    db.add(incident)
    db.flush()
    for kind, contents, captured_at in (
        ("first", event.first_evidence_jpeg, observed_from),
        ("last", event.evidence_jpeg, observed_until),
    ):
        asset = EvidenceAsset(
            id=uuid.uuid4(),
            project_id=event.project_id,
            storage_key=f"safety/{event.id}/{kind}.jpg",
            media_type="image/jpeg",
            size_bytes=len(contents),
            sha256=hashlib.sha256(contents).hexdigest(),
            source="camera",
            integrity="verified",
            captured_at=captured_at,
        )
        db.add(asset)
        db.add(
            IncidentEvidenceLink(
                incident_id=incident.id, asset_id=asset.id, kind="context"
            )
        )
    snapshot_basis(
        db,
        incident,
        kind="safety",
        observed_from=observed_from,
        observed_until=observed_until,
        policy={
            "provenance": "safety_policy",
            "approval_event_id": str(policy_event.id),
            "sha256": policy_event.reason,
            "snapshot": event.snapshot,
        },
        sources=[
            {
                "safety_event_id": str(event.id),
                "source_id": event.source_id,
                "first_position_ms": event.first_position_ms,
                "last_position_ms": event.last_position_ms,
                "model_sha256": event.model_sha256,
                "evidence_sha256": event.evidence_sha256,
            }
        ],
    )
    assign_initial_alert(db, incident, project)
    return incident


def append_observation(
    db,
    incident,
    *,
    source_receipt,
    observed_from,
    observed_until,
    sources,
    policy_snapshot: IncidentBasisDTO | None = None,
):
    from app.models.customer_control import (
        IncidentObservation,
        IncidentRequirementLink,
        RequirementRevision,
    )
    from app.schemas.customer_control import IncidentBasisDTO, SourceObservationDTO

    existing = db.scalar(
        select(IncidentObservation.id).where(
            IncidentObservation.project_id == incident.project_id,
            IncidentObservation.source_receipt == source_receipt,
        )
    )
    if existing:
        return existing
    basis = db.scalar(
        select(IncidentBasis).where(IncidentBasis.incident_id == incident.id)
    )
    if basis is None:
        return None
    policy = IncidentBasisDTO.model_validate(policy_snapshot or basis.snapshot)
    if policy.project_id != incident.project_id:
        raise ValueError("Observation policy must belong to the incident project")
    for citation in policy.citations:
        revision = db.get(RequirementRevision, citation.requirement_revision_id)
        if revision is None or revision.project_id != incident.project_id:
            raise ValueError("Observation citation must belong to the incident project")
        if db.get(IncidentRequirementLink, (incident.id, revision.id)) is None:
            db.add(
                IncidentRequirementLink(incident_id=incident.id, revision_id=revision.id)
            )
    snapshot = policy.model_dump(mode="json")
    normalized = []
    for source in sources:
        source = {
            key: value
            for key, value in source.items()
            if key in SourceObservationDTO.model_fields
        }
        for field in ("model_sha256", "sha256", "evidence_sha256"):
            value = source.get(field)
            if value and (
                len(value) != 64 or any(char not in "0123456789abcdef" for char in value)
            ):
                source[field] = None
        normalized.append(SourceObservationDTO.model_validate(source))
    snapshot.update(
        observed_from=aware(observed_from),
        observed_until=aware(observed_until),
        sources=normalized,
        source_evidence_ids=list(
            db.scalars(
                select(IncidentEvidenceLink.asset_id).where(
                    IncidentEvidenceLink.incident_id == incident.id
                )
            )
        ),
    )
    row = IncidentObservation(
        id=uuid.uuid4(),
        project_id=incident.project_id,
        incident_id=incident.id,
        source_receipt=source_receipt,
        observed_from=aware(observed_from),
        observed_until=aware(observed_until),
        snapshot=IncidentBasisDTO.model_validate(snapshot).model_dump(mode="json"),
    )
    db.add(row)
    return row.id


def link_pending_safety_events(db):
    """Retry attribution of retained source events using their original policy."""
    from app.models.safety import SafetyEvent

    events = db.scalars(
        select(SafetyEvent)
        .join(
            Project,
            Project.id == SafetyEvent.project_id,
        )
        .where(
            Project.kind != "shared_demo",
            Project.lifecycle == "active",
            SafetyEvent.snapshot["capture_schema_version"].as_integer() == 1,
            ~select(Incident.id)
            .where(Incident.source_safety_event_id == SafetyEvent.id)
            .exists(),
        )
        .order_by(SafetyEvent.project_id, SafetyEvent.created_at)
    )
    linked = 0
    for event in events:
        data = event.snapshot or {}
        # Legacy source timestamps and approvals are unknown, never reconstructed.
        if data.get("capture_schema_version") != 1:
            continue
        try:
            approval = db.get(AuditEvent, uuid.UUID(data["policy_event_id"]))
            first = aware(datetime.fromisoformat(data["observed_from"]))
            last = aware(datetime.fromisoformat(data["observed_until"]))
        except (KeyError, ValueError, TypeError):
            continue
        if (
            approval is None
            or approval.project_id != event.project_id
            or approval.resource_id != event.zone_id
            or approval.event_type != "safety.policy.approved"
            or approval.reason != data.get("policy_sha256")
            or first > last
            or aware(approval.occurred_at) > last
        ):
            continue
        if link_safety_incident(
            db,
            event,
            observed_from=first,
            observed_until=last,
            policy_event=approval,
        ):
            linked += 1
    return {"linked": linked}
