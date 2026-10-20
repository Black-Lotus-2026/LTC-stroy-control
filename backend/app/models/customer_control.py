"""R1: project assignments, immutable decisions and evidence. No global grants."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin, utcnow
from app.db.types import enum_column


class ProjectRole(StrEnum):
    CUSTOMER_MANAGER = "customer_manager"
    CONTRACTOR_FOREMAN = "contractor_foreman"
    PTO_ENGINEER = "pto_engineer"
    PROJECT_VIEWER = "project_viewer"


class ReleaseStatus(StrEnum):
    DRAFT = "draft"
    IN_REVIEW = "in_review"
    CHANGES_REQUESTED = "changes_requested"
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    RETIRED = "retired"
    CANCELLED = "cancelled"


def fk(table: str, **kw):
    return mapped_column(
        PgUUID(as_uuid=True), ForeignKey(f"{table}.id", ondelete="RESTRICT"), **kw
    )


class Organization(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "organizations"
    name: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16), default="active")
    needs_confirmation: Mapped[bool] = mapped_column(Boolean, default=False)


class OrganizationMembership(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "organization_memberships"
    __table_args__ = (UniqueConstraint("organization_id", "user_id"),)
    organization_id: Mapped[uuid.UUID] = fk("organizations", index=True)
    user_id: Mapped[uuid.UUID] = fk("users", index=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    can_manage_members: Mapped[bool] = mapped_column(Boolean, default=False)
    can_create_projects: Mapped[bool] = mapped_column(Boolean, default=False)


class ProjectOrganization(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_organizations"
    __table_args__ = (
        UniqueConstraint("project_id", "organization_id"),
        CheckConstraint("side in ('customer','contractor')", name="side"),
    )
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    organization_id: Mapped[uuid.UUID] = fk("organizations", index=True)
    side: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active")


class ParticipationPeriod(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "participation_periods"
    participation_id: Mapped[uuid.UUID] = fk("project_organizations", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProjectAssignment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_assignments"
    __table_args__ = (UniqueConstraint("participation_id", "membership_id", "role"),)
    participation_id: Mapped[uuid.UUID] = fk("project_organizations", index=True)
    membership_id: Mapped[uuid.UUID] = fk("organization_memberships", index=True)
    role: Mapped[ProjectRole] = mapped_column(enum_column(ProjectRole))
    scope_kind: Mapped[str] = mapped_column(String(16), default="areas")
    status: Mapped[str] = mapped_column(String(16), default="active")
    row_version: Mapped[int] = mapped_column(Integer, default=1)


class ResponsibilityArea(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "responsibility_areas"
    __table_args__ = (
        CheckConstraint(
            "zone_id IS NOT NULL OR schedule_task_id IS NOT NULL", name="scope_required"
        ),
    )
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    name: Mapped[str] = mapped_column(String(256))
    zone_id: Mapped[uuid.UUID | None] = fk("zones")
    schedule_task_id: Mapped[uuid.UUID | None] = fk("schedule_tasks")


class AssignmentArea(Base):
    __tablename__ = "assignment_areas"
    assignment_id: Mapped[uuid.UUID] = fk("project_assignments", primary_key=True)
    area_id: Mapped[uuid.UUID] = fk("responsibility_areas", primary_key=True)


class Invitation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "invitations"
    organization_id: Mapped[uuid.UUID] = fk("organizations")
    project_id: Mapped[uuid.UUID | None] = fk("projects")
    recipient_user_id: Mapped[uuid.UUID] = fk("users")
    issued_by: Mapped[uuid.UUID] = fk("users")
    token_sha256: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="pending")
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentSeries(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "document_series"
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    owner_participation_id: Mapped[uuid.UUID] = fk("project_organizations")
    title: Mapped[str] = mapped_column(String(256))


class RequirementRevision(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "requirement_revisions"
    __table_args__ = (UniqueConstraint("requirement_id", "revision_no"),)
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    requirement_id: Mapped[uuid.UUID] = fk("ppr_requirements", index=True)
    revision_no: Mapped[int] = mapped_column(Integer)
    owner_participation_id: Mapped[uuid.UUID] = fk("project_organizations")
    author_user_id: Mapped[uuid.UUID] = fk("users")
    author_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    area_id: Mapped[uuid.UUID | None] = fk("responsibility_areas")
    kind: Mapped[str] = mapped_column(String(32))
    equipment_class: Mapped[str | None] = mapped_column(String(80))
    quote: Mapped[str] = mapped_column(Text)
    review_status: Mapped[str] = mapped_column(String(20), default="needs_review")
    check_mode: Mapped[str] = mapped_column(String(16), default="manual")
    citation: Mapped[dict] = mapped_column(JSONB)
    submitted: Mapped[bool] = mapped_column(Boolean, default=False)
    row_version: Mapped[int] = mapped_column(Integer, default=1)


class ControlRelease(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "control_releases"
    __table_args__ = (UniqueConstraint("project_id", "sequence"),)
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    row_version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[ReleaseStatus] = mapped_column(
        enum_column(ReleaseStatus), default=ReleaseStatus.DRAFT
    )
    base_release_id: Mapped[uuid.UUID | None] = fk("control_releases")
    submitted_by: Mapped[uuid.UUID] = fk("users")
    submitted_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    manifest_sha256: Mapped[str] = mapped_column(String(64))
    limitations: Mapped[list[str]] = mapped_column(JSONB, default=list)
    approved_by: Mapped[uuid.UUID | None] = fk("users")
    approved_assignment_id: Mapped[uuid.UUID | None] = fk("project_assignments")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    effective_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    effective_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)


class ControlReleaseItem(Base):
    __tablename__ = "control_release_items"
    release_id: Mapped[uuid.UUID] = fk("control_releases", primary_key=True)
    revision_id: Mapped[uuid.UUID] = fk("requirement_revisions", primary_key=True)


class IncidentBasis(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "incident_basis"
    incident_id: Mapped[uuid.UUID] = fk("incidents", unique=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    snapshot: Mapped[dict] = mapped_column(JSONB)
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EvidenceAsset(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "evidence_assets"
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    owner_participation_id: Mapped[uuid.UUID | None] = fk("project_organizations")
    storage_key: Mapped[str] = mapped_column(String(512))
    media_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    uploaded_by: Mapped[uuid.UUID | None] = fk("users")
    source: Mapped[str] = mapped_column(String(16), default="upload")
    integrity: Mapped[str] = mapped_column(String(20), default="verified")
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IncidentEvidenceLink(Base):
    __tablename__ = "incident_evidence_links"
    incident_id: Mapped[uuid.UUID] = fk("incidents", primary_key=True)
    asset_id: Mapped[uuid.UUID] = fk("evidence_assets", primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="context")


class RemediationSubmission(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "remediation_submissions"
    __table_args__ = (UniqueConstraint("incident_id", "sequence"),)
    incident_id: Mapped[uuid.UUID] = fk("incidents", index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    author_user_id: Mapped[uuid.UUID] = fk("users")
    author_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    note: Mapped[str] = mapped_column(Text)
    evidence_ids: Mapped[list[str]] = mapped_column(JSONB)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )


class RemediationReview(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "remediation_reviews"
    submission_id: Mapped[uuid.UUID] = fk("remediation_submissions", unique=True)
    reviewer_user_id: Mapped[uuid.UUID] = fk("users")
    reviewer_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    outcome: Mapped[str] = mapped_column(String(16))
    note: Mapped[str] = mapped_column(Text)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Dispute(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "disputes"
    incident_id: Mapped[uuid.UUID] = fk("incidents", index=True)
    author_user_id: Mapped[uuid.UUID] = fk("users")
    author_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    reason: Mapped[str] = mapped_column(String(32))
    note: Mapped[str] = mapped_column(Text)
    evidence_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(16), default="open")
    row_version: Mapped[int] = mapped_column(Integer, default=1)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DisputeDecision(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "dispute_decisions"
    dispute_id: Mapped[uuid.UUID] = fk("disputes", unique=True)
    reviewer_user_id: Mapped[uuid.UUID] = fk("users")
    outcome: Mapped[str] = mapped_column(String(16))
    correction: Mapped[str] = mapped_column(String(24))
    note: Mapped[str] = mapped_column(Text)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ShareColumns:
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    participation_id: Mapped[uuid.UUID] = fk("project_organizations", index=True)
    area_id: Mapped[uuid.UUID | None] = fk("responsibility_areas")
    read_kind: Mapped[str] = mapped_column(String(16), default="full")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class DocumentShare(UUIDPrimaryKeyMixin, ShareColumns, Base):
    __tablename__ = "document_shares"
    document_id: Mapped[uuid.UUID] = fk("ppr_documents")


class CameraShare(UUIDPrimaryKeyMixin, ShareColumns, Base):
    __tablename__ = "camera_shares"
    camera_id: Mapped[uuid.UUID] = fk("cameras")


class VideoShare(UUIDPrimaryKeyMixin, ShareColumns, Base):
    __tablename__ = "video_shares"
    video_id: Mapped[uuid.UUID] = fk("video_assets")


class EvidenceDisclosure(UUIDPrimaryKeyMixin, ShareColumns, Base):
    __tablename__ = "evidence_disclosures"
    incident_id: Mapped[uuid.UUID] = fk("incidents")
    asset_id: Mapped[uuid.UUID | None] = fk("evidence_assets")
    revision_id: Mapped[uuid.UUID | None] = fk("requirement_revisions")


class CommandReceipt(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "command_receipts"
    __table_args__ = (UniqueConstraint("user_id", "context_id", "route", "key"),)
    user_id: Mapped[uuid.UUID] = fk("users")
    context_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True))
    route: Mapped[str] = mapped_column(String(256))
    key: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True))
    payload_sha256: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True))
    event_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "audit_events"
    project_id: Mapped[uuid.UUID | None] = fk("projects", index=True)
    organization_id: Mapped[uuid.UUID] = fk("organizations")
    actor_user_id: Mapped[uuid.UUID | None] = fk("users")
    actor_membership_id: Mapped[uuid.UUID | None] = fk("organization_memberships")
    actor_assignment_id: Mapped[uuid.UUID | None] = fk("project_assignments")
    event_type: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True))
    old_version: Mapped[int | None] = mapped_column(Integer)
    new_version: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NotificationOutbox(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "notification_outbox"
    audit_id: Mapped[uuid.UUID] = fk("audit_events")
    assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    status: Mapped[str] = mapped_column(String(16), default="pending")
    __table_args__ = (UniqueConstraint("audit_id", "assignment_id"),)


class MigrationLedger(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "migration_ledger"
    legacy_kind: Mapped[str] = mapped_column(String(32))
    legacy_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True))
    new_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    basis: Mapped[str] = mapped_column(String(256))
    confidence: Mapped[str] = mapped_column(String(24))
    __table_args__ = (UniqueConstraint("legacy_kind", "legacy_id"),)


class CoverageConfiguration(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "coverage_configurations"
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    area_id: Mapped[uuid.UUID] = fk("responsibility_areas")
    camera_ids: Mapped[list[str]] = mapped_column(JSONB)
    approved_by: Mapped[uuid.UUID] = fk("users")
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    effective_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    policy_sha256: Mapped[str] = mapped_column(String(64))


class CameraMoveRequest(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "camera_move_requests"
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    camera_id: Mapped[uuid.UUID] = fk("cameras")
    author_user_id: Mapped[uuid.UUID] = fk("users")
    status: Mapped[str] = mapped_column(String(24), default="requested")
    requested_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    requested_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str] = mapped_column(Text)
    coverage_plan: Mapped[str] = mapped_column(Text)
    reference_revision_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    row_version: Mapped[int] = mapped_column(Integer, default=1)


class IncidentComment(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "incident_comments"
    incident_id: Mapped[uuid.UUID] = fk("incidents", index=True)
    author_user_id: Mapped[uuid.UUID] = fk("users")
    author_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    participation_id: Mapped[uuid.UUID] = fk("project_organizations")
    document_context: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DeadlinePause(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "deadline_pauses"
    incident_id: Mapped[uuid.UUID] = fk("incidents", index=True)
    actor_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    reason: Mapped[str] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    until: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectDeadlinePolicy(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "project_deadline_policies"
    __table_args__ = (UniqueConstraint("project_id", "version"),)
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    version: Mapped[int] = mapped_column(Integer)
    approved_by: Mapped[uuid.UUID] = fk("users")
    approved_assignment_id: Mapped[uuid.UUID] = fk("project_assignments")
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    reaction_minutes: Mapped[int] = mapped_column(Integer)
    remediation_minutes: Mapped[int] = mapped_column(Integer)
    review_minutes: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text)


class IncidentObservation(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "incident_observations"
    __table_args__ = (UniqueConstraint("project_id", "source_receipt"),)
    project_id: Mapped[uuid.UUID] = fk("projects", index=True)
    incident_id: Mapped[uuid.UUID] = fk("incidents", index=True)
    source_receipt: Mapped[str] = mapped_column(String(64))
    observed_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    observed_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IncidentRequirementLink(Base):
    __tablename__ = "incident_requirement_links"
    incident_id: Mapped[uuid.UUID] = fk("incidents", primary_key=True)
    revision_id: Mapped[uuid.UUID] = fk("requirement_revisions", primary_key=True)
