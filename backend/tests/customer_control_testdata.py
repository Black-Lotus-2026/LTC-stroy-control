"""Explicit isolated R1 grants and approved sources for regression fixtures.

These builders deliberately model pre-existing human decisions in synthetic
databases. Production authorization never calls them or infers grants from roles.
"""

from __future__ import annotations

import hashlib
import io
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

from pypdf import PdfWriter
from sqlalchemy import func, select

from app.core.config import settings
from app.models import PprAnalysis, PprDocument, PprPage, PprRequirement, User, UserRole
from app.models.customer_control import (
    ControlRelease,
    ControlReleaseItem,
    DocumentSeries,
    Organization,
    OrganizationMembership,
    ProjectAssignment,
    ProjectOrganization,
    ProjectRole,
    ReleaseStatus,
    RequirementRevision,
    ResponsibilityArea,
)
from app.services.incident_workflow import digest
from app.services.ppr_extraction import text_hash


def customer_grant(db, project, user=None, *, role=ProjectRole.CUSTOMER_MANAGER):
    if user is None:
        user = User(
            username="fixture-" + uuid4().hex,
            name="Synthetic customer",
            role=UserRole.VIEWER,
        )
        db.add(user)
    db.flush()
    organization = (
        db.get(Organization, project.customer_organization_id)
        if project.customer_organization_id
        else None
    )
    if organization is None:
        organization = Organization(name="Explicit synthetic customer")
        db.add(organization)
        db.flush()
        project.customer_organization_id = organization.id
    project.authorization_version = 2
    participation = db.scalar(
        select(ProjectOrganization).where(
            ProjectOrganization.project_id == project.id,
            ProjectOrganization.organization_id == organization.id,
        )
    )
    if participation is None:
        participation = ProjectOrganization(
            project_id=project.id, organization_id=organization.id, side="customer"
        )
        db.add(participation)
    membership = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == organization.id,
            OrganizationMembership.user_id == user.id,
        )
    )
    if membership is None:
        membership = OrganizationMembership(
            organization_id=organization.id, user_id=user.id
        )
        db.add(membership)
    db.flush()
    assignment = db.scalar(
        select(ProjectAssignment).where(
            ProjectAssignment.participation_id == participation.id,
            ProjectAssignment.membership_id == membership.id,
            ProjectAssignment.role == role,
        )
    )
    if assignment is None:
        assignment = ProjectAssignment(
            participation_id=participation.id,
            membership_id=membership.id,
            role=role,
            scope_kind="project",
        )
        db.add(assignment)
    db.flush()
    return SimpleNamespace(
        user=user,
        organization=organization,
        participation=participation,
        membership=membership,
        assignment=assignment,
    )


def approved_requirement(
    db,
    project,
    at,
    *,
    zone=None,
    stage=None,
    area=None,
    kind="equipment_required",
    grants=None,
    replace=True,
):
    grants = grants or customer_grant(db, project)
    if area is None:
        area = ResponsibilityArea(
            project_id=project.id,
            name="Synthetic approved area",
            zone_id=zone.id if zone else None,
            schedule_task_id=stage.id if stage else None,
        )
        db.add(area)
        db.flush()
    quote = (
        "На всей строительной площадке запрещено присутствие экскаватора."
        if kind == "equipment_forbidden"
        else "На всей строительной площадке обязательно наличие экскаватора."
    )
    buffer = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(buffer)
    content = buffer.getvalue()
    sha = hashlib.sha256(content).hexdigest()
    key = "regression/" + uuid4().hex + ".pdf"
    path = settings.ppr_storage_root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    series = DocumentSeries(
        project_id=project.id,
        owner_participation_id=grants.participation.id,
        title="Explicit synthetic PPR",
    )
    db.add(series)
    db.flush()
    document = PprDocument(
        project_id=project.id,
        filename="synthetic.pdf",
        media_type="application/pdf",
        size_bytes=len(content),
        sha256=sha,
        storage_key=key,
        uploaded_by="Synthetic customer",
        series_id=series.id,
        owner_participation_id=grants.participation.id,
        area_id=area.id,
        preview_kind="pdf",
    )
    db.add(document)
    db.flush()
    analysis = PprAnalysis(
        document_id=document.id,
        project_id=project.id,
        document_sha256=sha,
        status="COMPLETED",
        pages_total=1,
        pages_processed=1,
        provider="synthetic",
        model="explicit-regression-fixture",
    )
    db.add(analysis)
    db.flush()
    page = PprPage(
        analysis_id=analysis.id,
        page_number=1,
        status="COMPLETED",
        extraction_method="native_pdf",
        text=quote,
        text_sha256=text_hash(quote),
        preview_key=key,
        preview_media_type="application/pdf",
        artifact_sha256=sha,
    )
    requirement = PprRequirement(
        analysis_id=analysis.id,
        project_id=project.id,
        document_id=document.id,
        document_sha256=sha,
        page_number=1,
        fingerprint=uuid4().hex,
        title="Synthetic approved excavator rule",
        type=kind,
        equipment_class="excavator",
        scope_text="Вся площадка",
        quote=quote,
        quote_verified=True,
        detector_supported=True,
        active=False,
        applicability="project",
        extraction_method="native_pdf",
    )
    db.add_all([page, requirement])
    db.flush()
    revision_id = uuid4()
    citation = {
        "requirement_revision_id": str(revision_id),
        "document_id": str(document.id),
        "analysis_id": str(analysis.id),
        "document_sha256": sha,
        "page_number": 1,
        "page_artifact_sha256": sha,
        "quote": quote,
        "source_kind": "native_pdf",
    }
    revision = RequirementRevision(
        id=revision_id,
        project_id=project.id,
        requirement_id=requirement.id,
        revision_no=1,
        owner_participation_id=grants.participation.id,
        author_user_id=grants.user.id,
        author_assignment_id=grants.assignment.id,
        area_id=area.id,
        kind=kind,
        equipment_class="excavator",
        quote=quote,
        review_status="verified",
        check_mode="automated",
        citation=citation,
        submitted=True,
    )
    db.add(revision)
    sequence = (
        db.scalar(
            select(func.max(ControlRelease.sequence)).where(
                ControlRelease.project_id == project.id
            )
        )
        or 0
    ) + 1
    effective = at - timedelta(days=1) + timedelta(seconds=sequence)
    base = db.scalar(
        select(ControlRelease)
        .where(ControlRelease.project_id == project.id)
        .order_by(ControlRelease.sequence.desc())
    )
    if base and replace:
        base.effective_until = effective
        base.status = ReleaseStatus.RETIRED
    release = ControlRelease(
        project_id=project.id,
        sequence=sequence,
        status=ReleaseStatus.ACTIVE,
        base_release_id=base.id if base else None,
        submitted_by=grants.user.id,
        submitted_assignment_id=grants.assignment.id,
        manifest_sha256=digest(citation),
        approved_by=grants.user.id,
        approved_assignment_id=grants.assignment.id,
        approved_at=effective,
        effective_from=effective,
    )
    db.add(release)
    db.flush()
    if base and not replace:
        for item in db.scalars(
            select(ControlReleaseItem).where(ControlReleaseItem.release_id == base.id)
        ):
            db.add(
                ControlReleaseItem(release_id=release.id, revision_id=item.revision_id)
            )
        base.effective_until = effective
        base.status = ReleaseStatus.RETIRED
    db.add(ControlReleaseItem(release_id=release.id, revision_id=revision.id))
    db.flush()
    return SimpleNamespace(
        grants=grants,
        area=area,
        document=document,
        analysis=analysis,
        page=page,
        requirement=requirement,
        revision=revision,
        release=release,
    )
