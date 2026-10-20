"""Explicit synthetic construction contexts; never imported by application code."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select

from app.models import Camera, Incident, Zone
from app.models.customer_control import (
    AssignmentArea,
    CameraShare,
    Organization,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ResponsibilityArea,
)
from app.models.enums import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    IncidentType,
)
from app.services.alert_service import assign_initial_alert
from app.services.observation_basis import snapshot_basis
from tests.customer_control_testdata import customer_grant


def customer(db, project, user, *, role=ProjectRole.CUSTOMER_MANAGER):
    if user.id is None:
        db.add(user)
        db.flush()
    else:
        user = db.merge(user)
    return customer_grant(db, project, user, role=role)


def contractor(db, project, user, *, role=ProjectRole.CONTRACTOR_FOREMAN):
    if user.id is None:
        db.add(user)
    db.flush()
    organization = Organization(name="Explicit synthetic contractor " + user.username)
    db.add(organization)
    db.flush()
    membership = OrganizationMembership(organization_id=organization.id, user_id=user.id)
    participation = ProjectOrganization(
        project_id=project.id, organization_id=organization.id, side="contractor"
    )
    db.add_all([membership, participation])
    db.flush()
    assignment = ProjectAssignment(
        participation_id=participation.id,
        membership_id=membership.id,
        role=role,
        scope_kind="areas",
    )
    db.add(assignment)
    zone = db.scalar(select(Zone).where(Zone.project_id == project.id))
    if zone is None:
        zone = Zone(
            project_id=project.id, code="TEST-AREA", name="Synthetic assigned zone"
        )
        db.add(zone)
        db.flush()
    area = ResponsibilityArea(
        project_id=project.id, zone_id=zone.id, name="Synthetic responsibility area"
    )
    db.add(area)
    db.flush()
    db.add(AssignmentArea(assignment_id=assignment.id, area_id=area.id))
    for camera in db.scalars(select(Camera).where(Camera.project_id == project.id)):
        if camera.zone_id is None:
            camera.zone_id = zone.id
        db.add(
            CameraShare(
                project_id=project.id,
                participation_id=participation.id,
                camera_id=camera.id,
                area_id=area.id,
            )
        )
    db.flush()
    return SimpleNamespace(
        user=user,
        organization=organization,
        membership=membership,
        participation=participation,
        assignment=assignment,
        area=area,
        zone=zone,
    )


def system_camera_incident(
    db, project, camera, *, issue="VIEW_CHANGED", require_reference=True
):
    """Seed server-verified evidence directly; browser POST is deliberately retired."""
    if camera is None or (require_reference and not camera.view_reference_key):
        raise HTTPException(
            422, "Synthetic camera policy requires its approved reference"
        )
    from app.services.camera_view import move_active

    if require_reference and move_active(camera):
        raise HTTPException(409, "Camera is within its approved move window")
    key = f"synthetic-camera:{project.id}:{camera.id}:{issue}"
    existing = db.scalar(
        select(Incident).where(
            Incident.dedup_key == key,
            Incident.discrepancy_type == issue,
            Incident.status.in_(
                {
                    IncidentStatus.PENDING,
                    IncidentStatus.CONFIRMED,
                    IncidentStatus.IN_PROGRESS,
                }
            ),
        )
    )
    if existing:
        existing.observation_count += 1
        db.commit()
        return existing
    now = datetime.now(UTC)
    incident = Incident(
        project_id=project.id,
        camera_id=camera.id,
        zone_id=camera.zone_id,
        code="INC-" + uuid.uuid4().hex[:8],
        case_kind="control_integrity",
        category=IncidentCategory.CAMERA,
        type=IncidentType.CAMERA_VISIBILITY,
        priority=IncidentPriority.CRITICAL,
        status=IncidentStatus.PENDING,
        title="Synthetic verified camera issue",
        discrepancy_type=issue,
        first_seen_at=now,
        last_seen_at=now,
        dedup_key=key,
        explanation={
            "camera_name": camera.name,
            "album_photos": [
                {
                    "url": "synthetic-current",
                    "camera_name": camera.name + " · сейчас",
                    "is_primary": True,
                },
                {
                    "url": "synthetic-reference",
                    "camera_name": camera.name + " · утверждённый ракурс",
                },
            ],
            "synthetic": True,
        },
    )
    db.add(incident)
    db.flush()
    snapshot_basis(
        db,
        incident,
        kind="camera",
        observed_from=now,
        observed_until=now,
        policy={"provenance": "camera_policy", "sha256": "a" * 64},
        sources=[],
    )
    assign_initial_alert(db, incident, project)
    db.commit()
    return incident
