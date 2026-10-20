"""Only an explicit operator publication can expose a legacy shared-demo source."""

from typing import Literal
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select


def demo_ids(
    project,
    kind: Literal["zone", "camera", "video", "document", "incident", "evidence"],
) -> tuple[UUID, ...]:
    data = getattr(project, "demo_manifest", None)
    if not data:
        return ()
    from app.schemas.customer_control import DemoManifestDTO

    try:
        manifest = DemoManifestDTO.model_validate(data)
    except ValidationError:
        return ()
    return tuple(getattr(manifest, f"{kind}_ids"))


def validate_demo_manifest(db, project, payload):
    """Operator-only validation helper; no public mutation endpoint calls it."""
    from app.models import Camera, Incident, PprDocument, VideoAsset, Zone
    from app.models.customer_control import EvidenceAsset
    from app.schemas.customer_control import DemoManifestDTO

    manifest = DemoManifestDTO.model_validate(payload)
    if project.kind != "shared_demo":
        raise ValueError("Publication requires an explicit shared-demo project")
    total = 0
    for kind, model in (
        ("zone", Zone),
        ("camera", Camera),
        ("video", VideoAsset),
        ("document", PprDocument),
        ("incident", Incident),
        ("evidence", EvidenceAsset),
    ):
        requested = set(getattr(manifest, f"{kind}_ids"))
        total += len(requested)
        actual = set(
            db.scalars(
                select(model.id).where(
                    model.project_id == project.id,
                    model.id.in_(requested),
                )
            )
        )
        if actual != requested:
            raise ValueError(f"Unknown or foreign {kind} in demo publication")
    if total > 1000:
        raise ValueError(
            "Demo publication is limited to 1000 explicitly vetted resources"
        )
    return manifest


def published_incident_ids(db, project):
    """An incident cannot indirectly publish an unlisted document or source."""
    from app.models import Incident
    from app.models.customer_control import IncidentBasis
    from app.schemas.customer_control import IncidentBasisDTO

    selected = demo_ids(project, "incident")
    documents = set(demo_ids(project, "document"))
    evidence = set(demo_ids(project, "evidence"))
    cameras = set(demo_ids(project, "camera"))
    videos = set(demo_ids(project, "video"))
    zones = set(demo_ids(project, "zone"))
    visible = []
    for row, stored in db.execute(
        select(Incident, IncidentBasis)
        .join(
            IncidentBasis,
            IncidentBasis.incident_id == Incident.id,
        )
        .where(Incident.project_id == project.id, Incident.id.in_(selected))
    ):
        try:
            basis = IncidentBasisDTO.model_validate(stored.snapshot)
            explanation = row.explanation
            if not isinstance(explanation, dict):
                continue
            cited = {
                UUID(citation["document_id"])
                for citation in explanation.get("ppr_requirements", [])
            }
            explained_videos = {
                UUID(identifier)
                for identifier in explanation.get("recording_positions", {})
            }
            if explanation.get("video_id"):
                explained_videos.add(UUID(explanation["video_id"]))
        except (ValidationError, ValueError, TypeError, KeyError, AttributeError):
            continue
        if (
            basis.project_id != project.id
            or not set(basis.source_evidence_ids) <= evidence
            or not {citation.document_id for citation in basis.citations} <= documents
            or not cited <= documents
            or not explained_videos <= videos
            or not set(basis.coverage.camera_ids) <= cameras
            or (row.camera_id is not None and row.camera_id not in cameras)
            or (row.zone_id is not None and row.zone_id not in zones)
            or any(
                source.camera_id and source.camera_id not in cameras
                for source in basis.sources
            )
            or any(
                source.video_id and source.video_id not in videos
                for source in basis.sources
            )
        ):
            continue
        visible.append(row.id)
    return tuple(visible)
