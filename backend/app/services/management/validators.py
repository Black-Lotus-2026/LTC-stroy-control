"""Deterministic guards; models cannot upgrade evidence or author metric values.

Authorization belongs to the snapshot builder. This module accepts only that
immutable, project-scoped snapshot, never identifiers to fetch from elsewhere.
"""

from __future__ import annotations

import re
from decimal import Decimal, localcontext

from pydantic import BaseModel, Field

from app.schemas.management import (
    DecisionProposal,
    EvidenceAssessment,
    ManagementSnapshot,
    ObservationClaim,
    ReviewResult,
    ScenarioResult,
)

METRICS = (
    "total_cost",
    "idle_cost",
    "extension_cost",
    "intervention_cost",
    "other_cost",
    "incremental_delay_work_hours",
    "deadline_variance_work_hours",
    "reference_milestone_at",
    "scenario_milestone_at",
)
ABSENT = "Требуемый класс техники не обнаружен в кадре; это не подтверждает простой."
PRESENT = "Требуемый класс техники обнаружен в кадре; производительность не измерена."
NUMBERS = re.compile(
    r"\d|(?<!\w)(?:ноль|нуль|одна|один|одно|два|две|три|четыре|пять|шесть|семь|"
    r"восемь|девять|десять|\w*надцать|двадцать|тридцать|сорок|\w*десят|сто|двести|"
    r"триста|четыреста|\w*сот|полтора|тысяч\w*|"
    r"миллион\w*|zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|"
    r"thousand|million)(?!\w)",
    re.IGNORECASE,
)


class EvidenceInspection(BaseModel):
    verdict: str
    eligible_source_refs: list[str] = Field(default_factory=list)
    missing_inputs: list[str] = Field(default_factory=list)
    observation_catalog: list[ObservationClaim] = Field(default_factory=list)
    unsupported_claims: list[str] = Field(default_factory=list)


def source_refs(snapshot: ManagementSnapshot) -> set[str]:
    return (
        set(snapshot.source_refs)
        | {snapshot.rule.source_ref}
        | {e.source_ref for e in snapshot.evidence}
    )


def inspect_evidence(snapshot: ManagementSnapshot) -> EvidenceInspection:
    """Presence only; neither absent detections nor camera counts prove downtime."""
    missing: list[str] = []
    valid = []
    if not snapshot.zone_id.strip():
        missing.append("unknown_zone")
    if snapshot.blocked_task_id not in snapshot.rule.applicable_task_ids:
        missing.append("rule_not_applicable")
    if not snapshot.rule.required_class.strip():
        missing.append("required_class_missing")
    refs = [e.source_ref for e in snapshot.evidence]
    if len(set(refs)) != len(refs):
        missing.append("duplicate_evidence_refs")
    if not snapshot.evidence:
        missing.append("no_evidence")
    for evidence in snapshot.evidence:
        problems = []
        age = (snapshot.as_of - evidence.captured_at).total_seconds()
        if evidence.project_id != snapshot.project_id:
            problems.append("cross_project_evidence")
        if not evidence.camera_id.strip() or evidence.zone_id != snapshot.zone_id:
            problems.append("camera_zone_mismatch")
        if evidence.model_status != "valid":
            problems.append("model_" + evidence.model_status)
        if evidence.camera_status != "online":
            problems.append("camera_" + evidence.camera_status)
        if age < 0:
            problems.append("future_capture")
        elif age > snapshot.rule.max_frame_age_minutes * 60:
            problems.append("stale_capture")
        missing.extend(problems)
        if not problems:
            valid.append(evidence)
    if (
        valid
        and (
            max(e.captured_at for e in valid) - min(e.captured_at for e in valid)
        ).total_seconds()
        > snapshot.rule.max_camera_skew_seconds
    ):
        missing.append("camera_time_skew")
    catalog = [
        ObservationClaim(
            claim=PRESENT
            if snapshot.rule.required_class in e.detected_classes
            else ABSENT,
            source_refs=[e.source_ref],
        )
        for e in valid
    ]
    if not valid or any(
        code in missing
        for code in (
            "unknown_zone",
            "rule_not_applicable",
            "required_class_missing",
            "duplicate_evidence_refs",
            "cross_project_evidence",
        )
    ):
        verdict = "insufficient_evidence"
    elif (
        missing
        or any(snapshot.rule.required_class in e.detected_classes for e in valid)
        or snapshot.blockage_confirmation != "human_confirmed"
    ):
        verdict = "needs_review"
    else:
        verdict = "supported_risk"
    if snapshot.blockage_confirmation != "human_confirmed":
        missing.append("human_blockage_confirmation")
    return EvidenceInspection(
        verdict=verdict,
        eligible_source_refs=[e.source_ref for e in valid],
        missing_inputs=list(dict.fromkeys(missing)),
        observation_catalog=catalog,
        unsupported_claims=[
            "Отсутствие детекции не доказывает простой или причину отсутствия техники.",
            "Появление техники не подтверждает восстановление производительности.",
        ],
    )


def validate_calculations(
    snapshot: ManagementSnapshot, scenarios: list[ScenarioResult]
) -> list[str]:
    """Check exact calculator totals, completeness and the approved scenario set."""
    # Match the calculator's precision: allowed rate × quantity × working-hour
    # products can exceed the process-default twenty-eight significant digits.
    with localcontext() as context:
        context.prec = 64
        return _validate_calculations(snapshot, scenarios)


def _validate_calculations(
    snapshot: ManagementSnapshot, scenarios: list[ScenarioResult]
) -> list[str]:
    errors = []
    ids = [s.scenario_id for s in scenarios]
    if len(ids) != len(set(ids)) or set(ids) != {s.id for s in snapshot.scenarios}:
        errors.append("scenario_set_mismatch")
    if len({s.currency for s in scenarios}) > 1:
        errors.append("mixed_result_currencies")
    if len({s.input_hash for s in scenarios}) > 1:
        errors.append("mixed_snapshot_results")
    if len({s.calculator_version for s in scenarios}) > 1:
        errors.append("mixed_calculator_versions")
    for scenario in scenarios:
        if scenario.status != "complete":
            continue
        values = [
            scenario.idle_cost,
            scenario.extension_cost,
            scenario.intervention_cost,
            scenario.other_cost,
        ]
        if any(v is None or not v.is_finite() or v < 0 for v in values):
            errors.append("incomplete_cost_components")
            continue
        if scenario.total_cost is None or scenario.total_cost != sum(values, Decimal(0)):
            errors.append("total_cost_mismatch")
        components = scenario.cost_components
        if len({c.id for c in components}) != len(components):
            errors.append("duplicate_cost_components")
        if any(
            c.amount is None
            or not c.amount.is_finite()
            or c.amount < 0
            or c.currency != scenario.currency
            for c in components
        ):
            errors.append("invalid_cost_component")
            continue
        for category, value in zip(
            ("idle", "extension", "intervention", "other"), values, strict=True
        ):
            if (
                sum((c.amount for c in components if c.category == category), Decimal(0))
                != value
            ):
                errors.append("category_total_mismatch")
        delay = scenario.incremental_delay_work_hours
        if delay is None or not delay.is_finite() or delay < 0:
            errors.append("invalid_delay")
    return sorted(set(errors))


def metric_refs(scenarios: list[ScenarioResult]) -> set[str]:
    return {
        f"scenario.{s.scenario_id}.{metric}"
        for s in scenarios
        for metric in METRICS
        if getattr(s, metric) is not None
    }


def cost_minimum_scenarios(
    snapshot: ManagementSnapshot, scenarios: list[ScenarioResult]
) -> set[str] | None:
    """Conditional choice under the declared criterion, from calculator values only."""
    if validate_calculations(snapshot, scenarios) or any(
        s.status != "complete" or s.total_cost is None for s in scenarios
    ):
        return None
    allowed = {s.id for s in snapshot.scenarios if s.action_allowed}
    candidates = [s for s in scenarios if s.scenario_id in allowed]
    if not candidates:
        return set()
    minimum = min(s.total_cost for s in candidates)
    return {s.scenario_id for s in candidates if s.total_cost == minimum}


def _prose_errors(value: BaseModel, allowed_metrics: set[str]) -> list[str]:
    errors = []
    exempt = {
        "source_refs",
        "supporting_refs",
        "metric_refs",
        "scenario_id",
        "recommended_scenario_id",
        "validated_scenario_ids",
        "suggested_due_at",
        "verdict",
        "status",
        "type",
        "code",
    }

    def visit(node, key=""):
        if key in exempt:
            return
        if isinstance(node, dict):
            for child_key, child in node.items():
                visit(child, child_key)
        elif isinstance(node, list):
            for child in node:
                visit(child, key)
        elif isinstance(node, str):
            text = node
            for ref in sorted(allowed_metrics, key=len, reverse=True):
                text = re.sub(
                    re.escape(ref) + r"(?![A-Za-z0-9_:-]|\.[A-Za-z0-9_:-])", "", text
                )
            if "scenario." in text:
                errors.append("unknown_metric_in_prose")
            if NUMBERS.search(text):
                errors.append("numbers_in_prose")

    visit(value.model_dump(mode="json"))
    return errors


def validate_evidence(
    value: EvidenceAssessment,
    snapshot: ManagementSnapshot,
    inspection: EvidenceInspection,
) -> list[str]:
    errors = _prose_errors(value, set())
    rank = {"insufficient_evidence": 0, "needs_review": 1, "supported_risk": 2}
    if rank[value.verdict] > rank[inspection.verdict]:
        errors.append("evidence_verdict_upgrade")
    if not set(inspection.missing_inputs) <= set(value.missing_inputs):
        errors.append("missing_evidence_gaps")
    catalog = {(o.claim, tuple(o.source_refs)) for o in inspection.observation_catalog}
    for observation in value.observations:
        if (observation.claim, tuple(observation.source_refs)) not in catalog:
            errors.append("ungrounded_observation")
    allowed = source_refs(snapshot)
    for hypothesis in value.hypotheses:
        if not hypothesis.missing_checks:
            errors.append("unqualified_hypothesis")
        if (
            not hypothesis.supporting_refs
            or not set(hypothesis.supporting_refs) <= allowed
        ):
            errors.append("unknown_source_ref")
    if inspection.observation_catalog and not value.observations:
        errors.append("missing_observations")
    return sorted(set(errors))


def validate_proposal(
    value: DecisionProposal,
    snapshot: ManagementSnapshot,
    scenarios: list[ScenarioResult],
    evidence: EvidenceAssessment,
) -> list[str]:
    allowed_metrics = metric_refs(scenarios)
    errors = _prose_errors(value, allowed_metrics)
    errors += validate_calculations(snapshot, scenarios)
    allowed_sources = source_refs(snapshot)
    if not value.source_refs or not set(value.source_refs) <= allowed_sources:
        errors.append("unknown_source_ref")
    ids = {s.id for s in snapshot.scenarios}
    minimum_ids = cost_minimum_scenarios(snapshot, scenarios)
    if minimum_ids and value.recommended_scenario_id not in minimum_ids:
        errors.append("cost_criterion_mismatch")
    alternative_ids = [a.scenario_id for a in value.alternatives]
    if len(alternative_ids) != len(set(alternative_ids)) or set(alternative_ids) != ids:
        errors.append("missing_or_duplicate_alternatives")
    for alternative in value.alternatives:
        if not alternative.assumptions:
            errors.append("missing_scenario_assumptions")
        if (
            not alternative.metric_refs
            or not set(alternative.metric_refs) <= allowed_metrics
        ):
            errors.append("unknown_metric_ref")
        if any(
            not r.startswith(f"scenario.{alternative.scenario_id}.")
            for r in alternative.metric_refs
        ):
            errors.append("cross_scenario_metric_ref")
    if value.recommended_scenario_id is not None:
        chosen = next(
            (s for s in snapshot.scenarios if s.id == value.recommended_scenario_id), None
        )
        if chosen is None or not chosen.action_allowed:
            errors.append("scenario_not_allowed")
        if len(scenarios) != len(ids) or any(s.status != "complete" for s in scenarios):
            errors.append("incomplete_comparison")
    if evidence.verdict != "supported_risk" and not value.required_human_inputs:
        errors.append("missing_human_checks")
    if not set(evidence.missing_inputs) <= set(value.required_human_inputs):
        errors.append("missing_evidence_gaps")
    if evidence.verdict != "supported_risk" and value.proposed_action.type == "intervene":
        errors.append("unsupported_intervention")
    if value.proposed_action.type == "intervene" and (
        value.recommended_scenario_id is None
        or value.recommended_scenario_id == snapshot.no_action_scenario_id
        or any(s.status != "complete" for s in scenarios)
    ):
        errors.append("action_scenario_mismatch")
    if value.proposed_action.suggested_due_at is not None:
        # No intervention deadline is supplied by the profile: models must not invent one.
        errors.append("unsupported_due_at")
    if not value.proposed_action.verification_condition.strip():
        errors.append("missing_verification_condition")
    return sorted(set(errors))


def validate_review(
    value: ReviewResult,
    snapshot: ManagementSnapshot,
    scenarios: list[ScenarioResult],
    evidence: EvidenceAssessment,
    proposal_errors: list[str],
) -> list[str]:
    errors = _prose_errors(value, metric_refs(scenarios))
    if not set(value.validated_scenario_ids) <= {s.scenario_id for s in scenarios}:
        errors.append("unknown_scenario_ref")
    for issue in value.issues:
        if not set(issue.source_refs) <= source_refs(snapshot):
            errors.append("unknown_source_ref")
    if value.status == "passed":
        if (
            proposal_errors
            or value.issues
            or evidence.verdict != "supported_risk"
            or cost_minimum_scenarios(snapshot, scenarios) is None
        ):
            errors.append("unsupported_pass")
        if set(value.validated_scenario_ids) != {s.id for s in snapshot.scenarios}:
            errors.append("unreviewed_scenarios")
    if evidence.verdict != "supported_risk" and not value.unresolved_assumptions:
        errors.append("missing_unresolved_evidence")
    if not set(evidence.missing_inputs) <= set(value.unresolved_assumptions):
        errors.append("missing_evidence_gaps")
    return sorted(set(errors))
