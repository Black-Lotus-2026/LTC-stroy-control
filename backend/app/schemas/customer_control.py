"""Public R1 contracts; OpenAPI is the source for the TypeScript contract."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.models.customer_control import ProjectRole, ReleaseStatus
from app.models.enums import IncidentStatus


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class DemoManifestDTO(DTO):
    zone_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    camera_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    video_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    document_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    incident_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    evidence_ids: list[UUID] = Field(default_factory=list, max_length=1000)


PositiveInt = Annotated[int, Field(ge=1)]
Note = Annotated[str, Field(min_length=1, max_length=4000)]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Permission = Literal[
    "project.read",
    "project.create",
    "project.manage",
    "membership.manage",
    "participation.manage",
    "assignment.manage",
    "camera.read",
    "camera.configure",
    "camera.reference.propose",
    "camera.reference.approve",
    "camera.move.request",
    "camera.move.decide",
    "camera.move.restore",
    "video.read",
    "video.upload",
    "video.analyze",
    "document.read",
    "document.upload",
    "document.analyze",
    "requirement.edit",
    "control.submit",
    "control.approve",
    "control.publish",
    "control.retire",
    "incident.read",
    "incident.confirm",
    "incident.dismiss",
    "incident.assign",
    "incident.deadline",
    "incident.start",
    "incident.comment",
    "remediation.submit",
    "remediation.accept",
    "remediation.return",
    "dispute.open",
    "dispute.decide",
    "evidence.read",
    "evidence.append",
    "evidence.publish",
    "report.read",
    "report.create",
    "audit.read",
]


class ProjectScope(DTO):
    kind: Literal["project"] = "project"


class AreaScope(DTO):
    kind: Literal["areas"] = "areas"
    area_ids: list[UUID] = Field(min_length=1)


AccessScope = Annotated[ProjectScope | AreaScope, Field(discriminator="kind")]


class ContextDTO(DTO):
    organization_id: UUID | None
    membership_id: UUID | None
    project_id: UUID
    participation_id: UUID | None
    assignment_id: UUID | None
    organization_name: str
    project_name: str
    role: ProjectRole
    side: Literal["customer", "contractor"]
    scope: AccessScope
    authorization_version: PositiveInt
    effective_permissions: list[Permission]
    is_demo: bool
    lifecycle: Literal["active", "archived"]


class VersionedCommand(DTO):
    expected_version: PositiveInt


class ConfirmCommand(VersionedCommand):
    action: Literal["confirm"]
    responsible_participation_id: UUID
    assignee_assignment_id: UUID | None = None
    area_id: UUID | None
    remediation_due_at: AwareDatetime
    note: Note


class StartCommand(VersionedCommand):
    action: Literal["start"]


class SubmitRemediationCommand(VersionedCommand):
    action: Literal["submit_remediation"]
    note: Note
    evidence_ids: list[UUID] = Field(min_length=1, max_length=20)


class AcceptRemediationCommand(VersionedCommand):
    action: Literal["accept_remediation"]
    submission_id: UUID
    note: Note


class ReturnRemediationCommand(VersionedCommand):
    action: Literal["return_remediation"]
    submission_id: UUID
    note: Note
    new_remediation_due_at: AwareDatetime | None = None


class DismissCommand(VersionedCommand):
    action: Literal["dismiss"]
    reason: Literal[
        "wrong_detection",
        "wrong_requirement",
        "wrong_scope",
        "insufficient_evidence",
        "not_an_incident",
    ]
    note: Note


IncidentCommandDTO = Annotated[
    ConfirmCommand
    | StartCommand
    | SubmitRemediationCommand
    | AcceptRemediationCommand
    | ReturnRemediationCommand
    | DismissCommand,
    Field(discriminator="action"),
]


class CitationDTO(DTO):
    requirement_revision_id: UUID
    document_id: UUID
    analysis_id: UUID
    document_sha256: Sha256
    page_number: PositiveInt
    page_artifact_sha256: Sha256
    quote: str = Field(min_length=1, max_length=20000)
    source_kind: Literal["native_pdf", "converted_pdf", "image", "vision_ocr"]


class CoverageDTO(DTO):
    status: Literal["sufficient", "insufficient", "unknown"]
    configuration_id: UUID | None = None
    camera_ids: list[UUID] = []
    reasons: list[
        Literal[
            "missing_view",
            "stale_frame",
            "camera_move",
            "loop_detected",
            "inference_failed",
            "unsupported_class",
            "unknown_geometry",
        ]
    ] = []


class SourceObservationDTO(DTO):
    camera_id: UUID | None = None
    video_id: UUID | None = None
    safety_event_id: UUID | None = None
    reference_revision_id: UUID | None = None
    source_id: str | None = None
    start_timestamp: AwareDatetime | None = None
    first_position_ms: float | None = None
    last_position_ms: float | None = None
    first_offset_seconds: float | None = None
    last_offset_seconds: float | None = None
    model_sha256: Sha256 | None = None
    evidence_sha256: Sha256 | None = None
    sha256: Sha256 | None = None


class IncidentBasisDTO(DTO):
    schema_version: Literal[1] = 1
    project_id: UUID
    observed_from: AwareDatetime
    observed_until: AwareDatetime
    source_evidence_ids: list[UUID] = []
    detector_sha256: Sha256 | None = None
    release_id: UUID | None = None
    manifest_sha256: Sha256 | None = None
    provenance: Literal["release", "legacy", "safety_policy", "camera_policy", "catalog"]
    policy_revision_id: UUID | None = None
    policy_sha256: Sha256 | None = None
    source_safety_event_id: UUID | None = None
    sources: list[SourceObservationDTO] = []
    citations: list[CitationDTO] = []
    coverage: CoverageDTO
    limitations: list[str] = []


class VisibleCitationDTO(DTO):
    requirement_revision_id: UUID
    document_title: str
    document_sha256: Sha256
    page_number: PositiveInt
    quote: str


class EvidenceBasisProjectionDTO(DTO):
    source_access: Literal["full", "partial", "restricted"]
    observed_from: AwareDatetime
    observed_until: AwareDatetime
    visible_evidence_ids: list[UUID]
    visible_citations: list[VisibleCitationDTO]
    coverage_status: Literal["sufficient", "insufficient", "unknown"]
    limitations: list[str]


class IncidentSummary(DTO):
    id: UUID
    project_id: UUID
    code: str
    title: str
    case_kind: Literal["construction", "control_integrity"]
    status: IncidentStatus
    row_version: PositiveInt
    area_id: UUID | None
    responsible_participation_id: UUID | None
    assignee_assignment_id: UUID | None
    detected_at: AwareDatetime | None
    first_seen_at: AwareDatetime
    reaction_due_at: AwareDatetime | None
    remediation_due_at: AwareDatetime | None
    review_due_at: AwareDatetime | None
    resolution_origin: (
        Literal["customer_accepted", "legacy_auto", "legacy_unverified"] | None
    )
    verification_status: Literal[
        "pending", "not_requested", "queued", "passed", "failed", "unavailable"
    ]
    allowed_actions: list[Permission]
    open_dispute_count: int = 0
    deadline_paused_until: AwareDatetime | None = None


class CustomerIncidentDTO(IncidentSummary):
    view: Literal["customer"] = "customer"
    origin_participation_id: UUID | None
    basis: IncidentBasisDTO | None


class ContractorIncidentDTO(IncidentSummary):
    view: Literal["contractor"] = "contractor"
    basis: EvidenceBasisProjectionDTO


IncidentDTO = Annotated[
    CustomerIncidentDTO | ContractorIncidentDTO, Field(discriminator="view")
]


class EvidenceDTO(DTO):
    id: UUID
    project_id: UUID
    sha256: Sha256
    media_type: str
    size_bytes: int
    captured_at: AwareDatetime | None
    received_at: AwareDatetime
    source: Literal["upload", "camera", "recording", "page", "legacy"]
    integrity: Literal["pending", "verified", "rejected", "legacy_unknown"]
    can_submit: bool = False


class ReviewDTO(DTO):
    id: UUID
    submission_id: UUID
    outcome: Literal["accepted", "returned"]
    note: str
    decided_at: AwareDatetime


class SubmissionDTO(DTO):
    id: UUID
    sequence: PositiveInt
    note: str
    evidence_ids: list[UUID]
    submitted_at: AwareDatetime
    review: ReviewDTO | None


class DisputeDTO(DTO):
    id: UUID
    incident_id: UUID
    author_assignment_id: UUID
    reason: Literal[
        "wrong_detection",
        "wrong_requirement",
        "wrong_scope",
        "insufficient_evidence",
        "other",
    ]
    note: str
    evidence_ids: list[UUID]
    status: Literal["open", "upheld", "rejected", "withdrawn"]
    row_version: PositiveInt
    opened_at: AwareDatetime


class IncidentDetailDTO(DTO):
    incident: IncidentDTO
    evidence: list[EvidenceDTO]
    submissions: list[SubmissionDTO]
    disputes: list[DisputeDTO]
    history: list[str]


class CommandResultDTO(DTO):
    command_id: UUID
    event_id: UUID
    replayed: bool
    incident: IncidentDTO


class AssignIncidentCommand(VersionedCommand):
    responsible_participation_id: UUID
    assignee_assignment_id: UUID | None = None
    area_id: UUID | None
    note: Note


class DeadlineCommand(VersionedCommand):
    remediation_due_at: AwareDatetime
    reason: Note


class OpenDisputeCommand(VersionedCommand):
    reason: Literal[
        "wrong_detection",
        "wrong_requirement",
        "wrong_scope",
        "insufficient_evidence",
        "other",
    ]
    note: Note
    evidence_ids: list[UUID] = Field(default_factory=list, max_length=20)


class DecideDisputeCommand(VersionedCommand):
    incident_expected_version: PositiveInt
    outcome: Literal["upheld", "rejected"]
    correction: Literal["none", "dismiss_incident"]
    note: Note


class CreateRevisionCommand(DTO):
    area_id: UUID | None
    review_status: Literal["verified", "excluded"]
    note: Note
    kind: Literal["equipment_required", "equipment_forbidden", "manual"] | None = None
    equipment_class: str | None = None
    quote: str | None = Field(default=None, min_length=10, max_length=20000)


class RequirementRevisionDTO(DTO):
    id: UUID
    requirement_id: UUID
    revision_no: PositiveInt
    area_id: UUID | None
    kind: Literal["equipment_required", "equipment_forbidden", "manual"]
    equipment_class: str | None
    quote: str
    review_status: Literal["needs_review", "verified", "excluded"]
    check_mode: Literal["automated", "manual"]
    row_version: PositiveInt
    citation: CitationDTO


class CreateReleaseCommand(DTO):
    base_release_id: UUID | None = None
    requirement_revision_ids: list[UUID] = Field(min_length=1, max_length=500)
    limitations: list[str] = Field(default_factory=list, max_length=100)


class ControlReleaseDTO(DTO):
    id: UUID
    project_id: UUID
    sequence: PositiveInt
    row_version: PositiveInt
    status: ReleaseStatus
    base_release_id: UUID | None
    requirement_revision_ids: list[UUID]
    manifest_sha256: Sha256 | None
    effective_from: AwareDatetime | None
    effective_until: AwareDatetime | None
    approved_by: UUID | None
    approved_at: AwareDatetime | None
    limitations: list[str]
    note: str | None


class ApproveControlCommand(VersionedCommand):
    manifest_sha256: Sha256
    effective_from: AwareDatetime
    note: Note


class ReturnControlCommand(VersionedCommand):
    note: Note


class CreateOrganizationCommand(DTO):
    name: str = Field(min_length=1, max_length=256)


class CreateProjectCommand(DTO):
    name: str = Field(min_length=1, max_length=256)
    kind: Literal["production", "jury"] = "production"
    reaction_minutes: int = Field(ge=1, le=43200)
    remediation_minutes: int = Field(ge=1, le=43200)
    review_minutes: int = Field(ge=1, le=43200)


class CreateAreaCommand(DTO):
    name: str = Field(min_length=1, max_length=256)
    zone_id: UUID | None = None
    schedule_task_id: UUID | None = None


class CreateAssignmentCommand(DTO):
    participation_id: UUID
    membership_id: UUID
    role: ProjectRole
    scope: AccessScope


class RevokeCommand(VersionedCommand):
    reason: Note


class InvitationCommand(DTO):
    recipient_user_id: UUID
    expires_at: AwareDatetime


class PublishEvidenceCommand(VersionedCommand):
    participation_id: UUID
    evidence_ids: list[UUID] = []
    revision_ids: list[UUID] = []


class ShareCommand(DTO):
    participation_id: UUID
    area_id: UUID | None = None
    active: bool = True
    read_kind: Literal["full", "requirements"] = "full"


class CameraMoveCommand(DTO):
    requested_from: AwareDatetime
    requested_until: AwareDatetime
    reason: Note
    coverage_plan: Note


class CameraMoveDecisionCommand(VersionedCommand):
    action: Literal[
        "approve", "reject", "cancel", "start", "propose_reference", "complete"
    ]
    note: Note


class CoverageCommand(DTO):
    area_id: UUID
    camera_ids: list[UUID] = Field(min_length=1)
    effective_from: AwareDatetime
    reason: Note


class NamedOptionDTO(DTO):
    id: UUID
    name: str


class AssignmentOptionDTO(NamedOptionDTO):
    participation_id: UUID
    role: ProjectRole
    area_ids: list[UUID]


class ParticipantOptionsDTO(DTO):
    participations: list[NamedOptionDTO]
    assignments: list[AssignmentOptionDTO]
    areas: list[NamedOptionDTO]


class MetricsDTO(DTO):
    as_of: AwareDatetime
    project_id: UUID
    kind: Literal["production", "jury", "shared_demo"]
    counts: dict[IncidentStatus, int]
    customer_accepted: int
    sample_size: int


class OrganizationDTO(DTO):
    id: UUID
    name: str
    status: Literal["active", "archived"]
    needs_confirmation: bool


class MembershipDTO(DTO):
    id: UUID
    organization_id: UUID
    user_id: UUID
    status: Literal["active", "revoked"]
    can_manage_members: bool
    can_create_projects: bool


class NamedMembershipDTO(MembershipDTO):
    name: str


class ProjectDTO(DTO):
    id: UUID
    name: str
    code: str
    kind: Literal["production", "jury", "shared_demo"]
    lifecycle: Literal["active", "archived"]
    row_version: PositiveInt


class ParticipationDTO(DTO):
    id: UUID
    project_id: UUID
    organization_id: UUID
    side: Literal["customer", "contractor"]
    status: Literal["invited", "active", "ended"]


class AssignmentDTO(DTO):
    id: UUID
    participation_id: UUID
    membership_id: UUID
    role: ProjectRole
    scope_kind: Literal["project", "areas"]
    status: Literal["active", "revoked"]
    row_version: PositiveInt


class InvitationDTO(DTO):
    id: UUID
    organization_id: UUID
    status: Literal["pending", "accepted", "expired", "revoked"]
    expires_at: AwareDatetime
    token: str | None = None
    organization_name: str
    project_name: str | None


class InviteParticipationCommand(InvitationCommand):
    organization_id: UUID


class CameraMoveRequestDTO(DTO):
    id: UUID
    camera_id: UUID
    status: Literal[
        "requested",
        "approved",
        "in_progress",
        "awaiting_reference",
        "completed",
        "rejected",
        "cancelled",
        "expired",
    ]
    requested_from: AwareDatetime
    requested_until: AwareDatetime
    reason: str
    coverage_plan: str
    reference_revision_id: UUID | None
    row_version: PositiveInt


class CoverageConfigurationDTO(DTO):
    id: UUID
    area_id: UUID
    camera_ids: list[UUID]
    effective_from: AwareDatetime
    effective_until: AwareDatetime | None
    policy_sha256: Sha256


class AuditEventDTO(DTO):
    id: UUID
    event_type: str
    resource_id: UUID
    old_version: int | None
    new_version: int | None
    reason: str
    occurred_at: AwareDatetime


class MemberOptionDTO(NamedOptionDTO):
    user_id: UUID
    organization_id: UUID


class ParticipationOptionDTO(NamedOptionDTO):
    organization_id: UUID
    side: Literal["customer", "contractor"]


class AssignmentSetupDTO(DTO):
    project: ProjectDTO
    participations: list[ParticipationOptionDTO]
    members: list[MemberOptionDTO]
    areas: list[NamedOptionDTO]
    assignments: list[AssignmentDTO]
    zones: list[NamedOptionDTO]
    stages: list[NamedOptionDTO]


class MembershipRevokeCommand(DTO):
    reason: Note


class EndParticipationCommand(DTO):
    reason: Note


class RestoreProjectCommand(VersionedCommand):
    reason: Note


class ArchiveProjectCommand(RevokeCommand):
    acknowledge_open_cases: bool = False


class ShareDTO(DTO):
    id: UUID
    active: bool


class CommentCommand(VersionedCommand):
    note: Note


class CommentDTO(DTO):
    id: UUID
    note: str
    created_at: AwareDatetime


class IncidentDocumentContextDTO(DTO):
    id: UUID
    code: str
    row_version: PositiveInt
    visible_citations: list[VisibleCitationDTO]
    comments: list[CommentDTO]
    can_dispute: bool


class DeadlinePauseCommand(VersionedCommand):
    until: AwareDatetime
    reason: Note


class DeadlinePolicyCommand(DTO):
    reaction_minutes: int = Field(ge=1, le=43200)
    remediation_minutes: int = Field(ge=1, le=43200)
    review_minutes: int = Field(ge=1, le=43200)
    reason: Note


class DeadlinePolicyDTO(DeadlinePolicyCommand):
    id: UUID
    version: PositiveInt
    effective_from: AwareDatetime


class ScopedReportCommand(DTO):
    from_at: AwareDatetime
    until_at: AwareDatetime
    kind: Literal["operations", "documents"]


class ScopedReportDTO(DTO):
    id: UUID
    project_id: UUID
    kind: Literal["operations", "documents"]
    from_at: AwareDatetime
    until_at: AwareDatetime
    as_of: AwareDatetime
    incidents: list[IncidentDTO]
    requirements: list[RequirementRevisionDTO]


class NotificationDTO(DTO):
    id: UUID
    event_type: str
    resource_id: UUID
    occurred_at: AwareDatetime
    source: Literal["workflow", "alert"] = "workflow"
    title: str = ""
    incident_id: UUID | None = None
