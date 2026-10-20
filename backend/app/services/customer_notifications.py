"""Publication and reading use one current assignment, never a union of roles."""

from fastapi import HTTPException
from sqlalchemy import select

from app.models import Camera, Incident, User
from app.models.customer_control import (
    CameraMoveRequest,
    ControlRelease,
    ControlReleaseItem,
    CoverageConfiguration,
    Dispute,
    EvidenceAsset,
    IncidentComment,
    IncidentEvidenceLink,
    NotificationOutbox,
    ProjectOrganization,
    ProjectRole,
    RequirementRevision,
)
from app.services.access_policy import (
    assignment_query,
    can_read_incident,
    resolve_context,
    resource_visible,
)


def event_case(db, event):
    identifier = event.resource_id
    if event.event_type == "incident.commented":
        comment = db.get(IncidentComment, identifier)
        return db.get(Incident, comment.incident_id) if comment else None
    if (
        event.event_type.startswith("incident.")
        or event.event_type == "evidence.disclosed"
    ):
        return db.get(Incident, identifier)
    if event.event_type.startswith("dispute."):
        dispute = db.get(Dispute, identifier)
        return db.get(Incident, dispute.incident_id) if dispute else None
    return None


def _case_visible(db, ctx, row):
    if row is None or row.project_id != ctx.project.id:
        return False
    if ctx.role == ProjectRole.PTO_ENGINEER:
        from app.services.document_context import document_incident_query

        return (
            db.scalar(document_incident_query(db, ctx).where(Incident.id == row.id))
            is not None
        )
    return "incident.read" in ctx.permissions and can_read_incident(db, ctx, row)


def audit_visible(db, ctx, event):
    if ctx.is_demo or event.project_id != ctx.project.id:
        return False
    if ctx.side == "customer" and ctx.role == ProjectRole.CUSTOMER_MANAGER:
        return True
    case = event_case(db, event)
    if case:
        if event.event_type == "incident.commented" and ctx.side == "contractor":
            comment = db.get(IncidentComment, event.resource_id)
            if comment.participation_id != ctx.participation.id:
                return False
            if ctx.role != ProjectRole.PTO_ENGINEER and comment.document_context:
                return False
        if ctx.role == ProjectRole.PTO_ENGINEER:
            if event.event_type == "incident.commented":
                comment = db.get(IncidentComment, event.resource_id)
                if not comment.document_context:
                    return False
                if (
                    ctx.side == "contractor"
                    and comment.participation_id != ctx.participation.id
                ):
                    return False
            elif not event.event_type.startswith("dispute."):
                return False
        return _case_visible(db, ctx, case)
    if event.event_type.startswith("document."):
        return "document.read" in ctx.permissions and resource_visible(
            db, ctx, "document", event.resource_id
        )
    if event.event_type == "source.disclosed":
        return any(
            permission in ctx.permissions
            and resource_visible(db, ctx, kind, event.resource_id)
            for kind, permission in (
                ("document", "document.read"),
                ("video", "video.read"),
                ("camera", "camera.read"),
            )
        )
    if event.event_type.startswith("requirement."):
        from app.services.control_releases import revision_visible

        revision = db.get(RequirementRevision, event.resource_id)
        return bool(
            revision
            and revision.project_id == ctx.project.id
            and revision_visible(db, ctx, revision)
        )
    if event.event_type.startswith("control."):
        from app.services.control_releases import revision_query

        release = db.get(ControlRelease, event.resource_id)
        if (
            not release
            or release.project_id != ctx.project.id
            or "document.read" not in ctx.permissions
        ):
            return False
        if (
            not release.approved_at
            and release.submitted_assignment_id != ctx.assignment.id
        ):
            return False
        return (
            db.scalar(
                select(ControlReleaseItem.release_id).where(
                    ControlReleaseItem.release_id == release.id,
                    ControlReleaseItem.revision_id.in_(
                        revision_query(db, ctx).with_only_columns(RequirementRevision.id)
                    ),
                )
            )
            is not None
        )
    if event.event_type == "evidence.appended":
        asset = db.get(EvidenceAsset, event.resource_id)
        if not asset or asset.project_id != ctx.project.id:
            return False
        if ctx.role == ProjectRole.PTO_ENGINEER and not (
            asset.source == "page" or asset.uploaded_by == ctx.user.id
        ):
            return False
        from app.services.incident_workflow import visible_evidence_query

        return any(
            _case_visible(db, ctx, row)
            and db.scalar(
                visible_evidence_query(db, ctx, row).where(EvidenceAsset.id == asset.id)
            )
            is not None
            for row in db.scalars(
                select(Incident)
                .join(
                    IncidentEvidenceLink, IncidentEvidenceLink.incident_id == Incident.id
                )
                .where(IncidentEvidenceLink.asset_id == asset.id)
            )
        )
    if event.event_type.startswith("camera.") and "camera.read" in ctx.permissions:
        if event.event_type == "camera.coverage.approved":
            coverage = db.get(CoverageConfiguration, event.resource_id)
            return bool(
                coverage
                and coverage.project_id == ctx.project.id
                and coverage.area_id in ctx.area_ids
            )
        move = db.get(CameraMoveRequest, event.resource_id)
        identifier = move.camera_id if move else event.resource_id
        camera = db.get(Camera, identifier)
        return bool(
            camera
            and camera.project_id == ctx.project.id
            and resource_visible(db, ctx, "camera", camera.id)
        )
    return False


def publish_audit_notifications(db, event):
    """Store identifiers once; every consumer must still revalidate the resource."""
    saved = db.info.pop("assignment_id", None)
    saved_membership = db.info.pop("membership_id", None)
    try:
        users = db.scalars(select(User).where(User.is_active.is_(True)))
        for user in users:
            for assignment, _, _ in db.execute(
                assignment_query(user).where(
                    ProjectOrganization.project_id == event.project_id,
                )
            ).all():
                db.info["assignment_id"] = assignment.id
                try:
                    ctx = resolve_context(db, event.project_id, user)
                except HTTPException:
                    continue
                if not audit_visible(db, ctx, event):
                    continue
                if not db.scalar(
                    select(NotificationOutbox.id).where(
                        NotificationOutbox.audit_id == event.id,
                        NotificationOutbox.assignment_id == assignment.id,
                    )
                ):
                    db.add(
                        NotificationOutbox(audit_id=event.id, assignment_id=assignment.id)
                    )
    finally:
        db.info.pop("assignment_id", None)
        if saved is not None:
            db.info["assignment_id"] = saved
        if saved_membership is not None:
            db.info["membership_id"] = saved_membership


def alert_event_type(kind):
    for prefix, event in (
        ("reaction_overdue_", "incident.reaction_overdue"),
        ("remediation_overdue_", "incident.remediation_overdue"),
        ("review_overdue_", "incident.review_overdue"),
    ):
        if kind.startswith(prefix):
            return event
    return {
        "assigned": "incident.assigned",
        "candidate_review": "incident.candidate_review",
        "verified": "incident.verification_passed",
        "escalated": "incident.escalated",
    }.get(kind, "incident.alert")
