"""Versioned management contracts. Money and working hours serialize as strings.

The snapshot is immutable once submitted. Identifiers A..M are local graph keys;
schedule_task_id links to an existing task and is checked by the API.
"""

from __future__ import annotations

from datetime import date, time
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

NonNegative = Annotated[Decimal, Field(ge=0, le=1000000000000, allow_inf_nan=False)]
Hours = Annotated[Decimal, Field(ge=0, le=87600, allow_inf_nan=False)]
Fraction = Annotated[Decimal, Field(ge=0, le=1, allow_inf_nan=False)]
Key = Annotated[str, Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)


class WorkCalendar(Contract):
    timezone: str = "Europe/Moscow"
    shift_start: time = time(8)
    shift_end: time = time(16)
    working_weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    holidays: list[date] = Field(default_factory=list)
    extra_working_dates: list[date] = Field(default_factory=list)

    @model_validator(mode="after")
    def supported(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Unknown calendar timezone") from exc
        if self.shift_end <= self.shift_start:
            raise ValueError(
                "Night shifts are not supported; shift_end must exceed shift_start"
            )
        if not self.working_weekdays or not set(self.working_weekdays) <= set(range(7)):
            raise ValueError("At least one weekday in 0..6 is required")
        if set(self.holidays) & set(self.extra_working_dates):
            raise ValueError("Calendar exceptions conflict")
        return self


class TaskInput(Contract):
    id: Key
    project_id: UUID
    schedule_task_id: UUID | None = None
    name: str = Field(max_length=512)
    remaining_work_hours: Hours
    earliest_start_work_hours: Hours = Decimal(0)
    planned_start: AwareDatetime | None = None
    planned_end: AwareDatetime | None = None
    completed: bool = False
    actual_finish_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def valid_dates(self):
        if (
            self.planned_start
            and self.planned_end
            and self.planned_end < self.planned_start
        ):
            raise ValueError("Task planned_end must not precede planned_start")
        return self


class DependencyInput(Contract):
    predecessor_id: Key
    successor_id: Key
    kind: Literal["FS"] = "FS"
    lag_work_hours: Hours = Decimal(0)


class RateInput(Contract):
    id: Key
    amount: NonNegative | None
    currency: str = Field(default="RUB", pattern=r"^[A-Z]{3}$")
    unit: Literal["work_hour", "work_day", "calendar_day"] = "work_hour"
    valid_from: AwareDatetime | None = None
    valid_to: AwareDatetime | None = None
    source: str = Field(min_length=1, max_length=2000)
    confirmation: Literal["demo", "user_assumption", "confirmed"]

    @model_validator(mode="after")
    def interval(self):
        if self.valid_from and self.valid_to and self.valid_to <= self.valid_from:
            raise ValueError("Rate validity interval must be positive")
        return self


class ResourceInput(Contract):
    resource_id: Key
    name: str
    quantity: NonNegative = Decimal(1)
    idle_fraction: Fraction = Decimal(1)
    paid_and_affected: bool
    rates: list[RateInput] = Field(min_length=1, max_length=100)
    cost_group: Key
    source: str = Field(min_length=1)


class ExplicitCost(Contract):
    id: Key
    title: str
    amount: NonNegative | None
    currency: str = Field(default="RUB", pattern=r"^[A-Z]{3}$")
    cost_group: Key
    source: str = Field(min_length=1)


class ScenarioInput(Contract):
    id: Key
    title: str
    recovery_work_hours: Hours
    intervention_costs: list[ExplicitCost] = Field(default_factory=list)
    other_costs: list[ExplicitCost] = Field(default_factory=list)
    action_allowed: bool = True
    assumptions: list[str] = Field(default_factory=list)


class EvidenceInput(Contract):
    source_ref: Key
    project_id: UUID
    zone_id: str
    camera_id: str
    captured_at: AwareDatetime
    model_status: Literal["valid", "unavailable", "failed"]
    camera_status: Literal["online", "offline", "unknown"]
    detected_classes: list[str] = Field(default_factory=list)
    image_url: str | None = None
    origin: Literal["persisted_frame", "demo_replay", "user_observation"]


class RuleSnapshot(Contract):
    version: str = Field(min_length=1)
    source_ref: Key
    required_class: str
    applicable_task_ids: list[Key]
    max_frame_age_minutes: int = Field(default=30, ge=1, le=1440)
    max_camera_skew_seconds: int = Field(default=120, ge=0, le=3600)


class ManagementSnapshot(Contract):
    schema_version: Literal["1.0"] = "1.0"
    project_id: UUID
    incident_id: UUID | None = None
    as_of: AwareDatetime
    data_mode: Literal["demo", "user"]
    zone_id: str
    schedule_version: str
    profile_version: str
    calendar: WorkCalendar
    tasks: list[TaskInput] = Field(min_length=1, max_length=200)
    dependencies: list[DependencyInput] = Field(default_factory=list, max_length=1000)
    blocked_task_id: Key
    milestone_task_id: Key
    agreed_deadline_at: AwareDatetime | None = None
    blockage_confirmation: Literal["hypothesis", "human_confirmed"]
    confirmation_source: str | None = None
    rule: RuleSnapshot
    evidence: list[EvidenceInput] = Field(default_factory=list, max_length=100)
    resources: list[ResourceInput] = Field(default_factory=list, max_length=100)
    extension_rates: list[RateInput] = Field(default_factory=list, max_length=100)
    extension_cost_group: Key = "site_overhead"
    extension_excludes_resource_costs: bool = False
    scenarios: list[ScenarioInput] = Field(min_length=3, max_length=3)
    no_action_scenario_id: Key
    assumptions: list[str] = Field(default_factory=list)
    source_refs: list[Key] = Field(default_factory=list)

    @model_validator(mode="after")
    def consistent(self):
        keys = [t.id for t in self.tasks]
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate task ids")
        if self.blocked_task_id not in keys or self.milestone_task_id not in keys:
            raise ValueError("Unknown blocked task or milestone")
        if any(t.project_id != self.project_id for t in self.tasks):
            raise ValueError("Cross-project tasks are forbidden")
        if any(e.project_id != self.project_id for e in self.evidence):
            raise ValueError("Cross-project evidence is forbidden")
        scenarios = [s.id for s in self.scenarios]
        if (
            len(set(scenarios)) != len(scenarios)
            or self.no_action_scenario_id not in scenarios
        ):
            raise ValueError("Unique scenarios including no-action required")
        if (
            self.blockage_confirmation == "human_confirmed"
            and not self.confirmation_source
        ):
            raise ValueError("Human confirmation requires a source")
        if self.data_mode == "user" and any(
            e.origin == "demo_replay" for e in self.evidence
        ):
            raise ValueError("Demo evidence cannot be used in a user snapshot")
        if any(
            t.completed and (not t.actual_finish_at or t.actual_finish_at > self.as_of)
            for t in self.tasks
        ):
            raise ValueError(
                "Completed tasks require an actual finish no later than as_of"
            )
        if next(t for t in self.tasks if t.id == self.blocked_task_id).completed:
            raise ValueError("A completed task cannot be blocked")
        return self


class CostComponent(Contract):
    id: str
    category: Literal["idle", "extension", "intervention", "other"]
    title: str
    amount: Decimal | None
    currency: str
    cost_group: str
    source: str
    formula: str
    inputs: dict = Field(default_factory=dict)


class TaskForecast(Contract):
    task_id: str
    reference_start_work_hours: Decimal
    reference_finish_work_hours: Decimal
    start_work_hours: Decimal
    finish_work_hours: Decimal
    start_at: AwareDatetime
    finish_at: AwareDatetime


class ScenarioResult(Contract):
    scenario_id: str
    input_hash: str
    calculator_version: str
    status: Literal["complete", "partial", "insufficient_data", "invalid_input"]
    reference_milestone_at: AwareDatetime | None = None
    scenario_milestone_at: AwareDatetime | None = None
    incremental_delay_work_hours: Decimal | None = None
    deadline_variance_work_hours: Decimal | None = None
    idle_cost: Decimal | None = None
    extension_cost: Decimal | None = None
    intervention_cost: Decimal | None = None
    other_cost: Decimal | None = None
    total_cost: Decimal | None = None
    currency: str = "RUB"
    cost_components: list[CostComponent] = Field(default_factory=list)
    affected_tasks: list[TaskForecast] = Field(default_factory=list)
    missing_inputs: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    calculation_trace: list[str] = Field(default_factory=list)


class ObservationClaim(Contract):
    claim: str
    source_refs: list[str]


class HypothesisClaim(Contract):
    claim: str
    supporting_refs: list[str]
    missing_checks: list[str]


class EvidenceAssessment(Contract):
    verdict: Literal["supported_risk", "needs_review", "insufficient_evidence"]
    observations: list[ObservationClaim]
    hypotheses: list[HypothesisClaim]
    unsupported_claims: list[str]
    missing_inputs: list[str]


class Alternative(Contract):
    scenario_id: str
    rationale: str
    metric_refs: list[str]
    assumptions: list[str]


class ProposedAction(Contract):
    type: Literal["intervene", "observe", "request_data"]
    title: str
    suggested_due_at: AwareDatetime | None
    verification_condition: str


class DecisionProposal(Contract):
    recommended_scenario_id: str | None
    alternatives: list[Alternative]
    proposed_action: ProposedAction
    required_human_inputs: list[str]
    source_refs: list[str]


class ReviewIssue(Contract):
    code: str
    affected_claim: str
    source_refs: list[str]
    suggested_fix: str


class ReviewResult(Contract):
    status: Literal["passed", "needs_revision", "insufficient_data"]
    issues: list[ReviewIssue]
    validated_scenario_ids: list[str]
    unresolved_assumptions: list[str]


class RunCreate(Contract):
    snapshot: ManagementSnapshot
    mode: Literal["deterministic", "llm"] = "deterministic"
    idempotency_key: str = Field(min_length=8, max_length=120)
    parent_run_id: UUID | None = None


class ProfileWrite(Contract):
    snapshot: ManagementSnapshot


class DependenciesWrite(Contract):
    schedule_version: str
    dependencies: list[DependencyInput]
