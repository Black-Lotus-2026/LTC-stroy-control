"""Bounded product-agent stages. Persistence and durable budget live in the worker.

The caller must atomically reserve every call before network IO and persist each
stage's result. Re-delivery must not create a fresh pipeline for an active lease.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.management import (
    DecisionProposal,
    EvidenceAssessment,
    ManagementSnapshot,
    ReviewResult,
    ScenarioResult,
)
from app.services.management.agents import actions, evidence, reviewer
from app.services.management.agents.provider import (
    OpenRouterProvider,
    Provider,
    ProviderError,
)
from app.services.management.validators import (
    inspect_evidence,
    validate_evidence,
    validate_proposal,
    validate_review,
)

ReserveCall = Callable[[str, int], Awaitable[bool]]
StageCallback = Callable[["AgentStageResult"], Awaitable[None]]


class AgentStageResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["evidence", "actions", "reviewer"]
    status: Literal["completed", "skipped", "failed"]
    generation: Literal["llm", "deterministic"]
    result: EvidenceAssessment | DecisionProposal | ReviewResult
    error: str | None = None
    validation_errors: list[str] = Field(default_factory=list)
    provider: str | None = None
    model: str | None = None
    prompt_version: str
    started_at: datetime
    finished_at: datetime
    attempts: int = 0
    usage: dict[str, int] = Field(default_factory=dict)
    tool_refs: list[str] = Field(default_factory=list)


class PipelineResult(BaseModel):
    steps: list[AgentStageResult]
    evidence: EvidenceAssessment
    proposal: DecisionProposal
    review: ReviewResult
    llm_calls: int
    degraded: bool


class AgentPipeline:
    MAX_CALLS = 6
    CONTEXT_BYTES = 48000
    MAX_OUTPUT_BYTES = 24000

    def __init__(
        self,
        snapshot: ManagementSnapshot,
        scenarios=(),
        *,
        mode: Literal["deterministic", "llm"] = "deterministic",
        reserve_call: ReserveCall | None = None,
        provider: Provider | None = None,
        deadline_at: datetime | None = None,
    ):
        if mode not in {"deterministic", "llm"}:
            raise ValueError("Unsupported agent mode")
        self.snapshot = snapshot.model_copy(deep=True)
        self.scenarios = [s.model_copy(deep=True) for s in scenarios]
        self.mode = mode
        self.provider = provider if provider is not None else OpenRouterProvider()
        self.reserve_call = reserve_call
        self.deadline_at = deadline_at or datetime.now(UTC) + timedelta(seconds=90)
        if self.deadline_at.tzinfo is None:
            raise ValueError("deadline_at requires timezone")
        self._monotonic_deadline = time.monotonic() + min(
            90.0,
            max(0.0, (self.deadline_at - datetime.now(UTC)).total_seconds()),
        )
        self.llm_calls = 0
        self.repair_used = False
        self.inspection = inspect_evidence(self.snapshot)
        self.steps: list[AgentStageResult] = []

    def set_scenarios(self, scenarios: list[ScenarioResult]) -> None:
        self.scenarios = [s.model_copy(deep=True) for s in scenarios]

    def _remaining(self) -> float:
        return min(
            self._monotonic_deadline - time.monotonic(),
            (self.deadline_at - datetime.now(UTC)).total_seconds(),
        )

    async def _stage(
        self, *, role, module, schema, context, fallback, validator, tool_refs
    ) -> AgentStageResult:
        started = datetime.now(UTC)
        attempts = 0
        usage: dict[str, int] = {}
        error = None
        validation_errors = []

        def finish(status, result, generation="deterministic"):
            stage = AgentStageResult(
                role=role,
                status=status,
                generation=generation,
                result=result,
                error=error,
                validation_errors=validation_errors,
                provider=self.provider.name if self.mode == "llm" else None,
                model=self.provider.model if self.mode == "llm" else None,
                prompt_version=module.PROMPT_VERSION,
                started_at=started,
                finished_at=datetime.now(UTC),
                attempts=attempts,
                usage=usage,
                tool_refs=tool_refs,
            )
            self.steps.append(stage)
            return stage

        if self.mode == "deterministic":
            error = "disabled"
            return finish("skipped", fallback)
        if not self.provider.available:
            error = "provider_unavailable"
            return finish("skipped", fallback)
        if self.reserve_call is None:
            error = "durable_budget_unavailable"
            return finish("skipped", fallback)
        if len(json.dumps(context, ensure_ascii=False).encode()) > self.CONTEXT_BYTES:
            error = "context_budget_exceeded"
            return finish("skipped", fallback)
        while True:
            if self._remaining() <= 0:
                error = "analysis_deadline_exceeded"
                return finish("failed", fallback)
            if self.llm_calls >= self.MAX_CALLS:
                error = "llm_call_budget_exhausted"
                return finish("skipped", fallback)
            # Callback failures propagate: without durable accounting, do not proceed.
            reserved = await self.reserve_call(role, attempts + 1)
            if not reserved:
                error = "llm_call_budget_exhausted"
                return finish("skipped", fallback)
            self.llm_calls += 1
            attempts += 1
            try:
                timeout = min(20.0, self._remaining())
                if timeout <= 0:
                    error = "analysis_deadline_exceeded"
                    return finish("failed", fallback)
                async with asyncio.timeout(timeout):
                    reply = await self.provider.complete(
                        system=module.SYSTEM,
                        context=context,
                        schema=schema.model_json_schema(),
                        timeout=timeout,
                    )
                for key, count in reply.usage.items():
                    if key in {"prompt_tokens", "completion_tokens", "total_tokens"}:
                        usage[key] = usage.get(key, 0) + count
                if len(reply.content.encode()) > self.MAX_OUTPUT_BYTES:
                    raise ProviderError("provider_response_too_large")
                try:
                    result = schema.model_validate_json(reply.content)
                    validation_errors = validator(result)
                except (ValidationError, ValueError):
                    validation_errors = ["invalid_json_or_schema"]
                if not validation_errors:
                    error = None
                    return finish("completed", result, "llm")
                if self.repair_used:
                    error = "output_validation_failed"
                    return finish("failed", fallback)
                self.repair_used = True
                # One addressed correction per run. Never echo invalid model output.
                context = {
                    **context,
                    "repair": {
                        "validation_errors": validation_errors,
                        "instruction": "Correct violations using only the original data.",
                    },
                }
            except TimeoutError:
                error = "provider_timeout"
                return finish("failed", fallback)
            except ProviderError as exc:
                error = exc.code
                return finish("failed", fallback)
            except Exception:
                # A custom provider may throw arbitrary exceptions with secret bodies.
                error = "provider_error"
                return finish("failed", fallback)

    async def evidence(self) -> AgentStageResult:
        fallback = evidence.deterministic_assessment(self.snapshot, self.inspection)
        return await self._stage(
            role="evidence",
            module=evidence,
            schema=EvidenceAssessment,
            context=evidence.context(self.snapshot, self.inspection),
            fallback=fallback,
            validator=lambda result: validate_evidence(
                result, self.snapshot, self.inspection
            ),
            tool_refs=["snapshot:evidence", "snapshot:camera_health", "snapshot:rule"],
        )

    async def actions(self, assessment: EvidenceAssessment) -> AgentStageResult:
        # Do not accept caller-provided assessments that bypass the evidence guard.
        if validate_evidence(assessment, self.snapshot, self.inspection):
            assessment = evidence.deterministic_assessment(self.snapshot, self.inspection)
        fallback = actions.deterministic_proposal(
            self.snapshot, self.scenarios, assessment
        )
        return await self._stage(
            role="actions",
            module=actions,
            schema=DecisionProposal,
            context=actions.context(self.snapshot, self.scenarios, assessment),
            fallback=fallback,
            validator=lambda result: validate_proposal(
                result,
                self.snapshot,
                self.scenarios,
                assessment,
            ),
            tool_refs=["snapshot:approved_scenarios", "calculator:scenario_results"],
        )

    async def reviewer(
        self, assessment: EvidenceAssessment, proposal: DecisionProposal
    ) -> AgentStageResult:
        if validate_evidence(assessment, self.snapshot, self.inspection):
            assessment = evidence.deterministic_assessment(self.snapshot, self.inspection)
        errors = validate_proposal(proposal, self.snapshot, self.scenarios, assessment)
        fallback = reviewer.deterministic_review(
            self.snapshot, self.scenarios, assessment, errors
        )
        return await self._stage(
            role="reviewer",
            module=reviewer,
            schema=ReviewResult,
            context=reviewer.context(
                self.snapshot, self.scenarios, assessment, proposal, errors
            ),
            fallback=fallback,
            validator=lambda result: validate_review(
                result,
                self.snapshot,
                self.scenarios,
                assessment,
                errors,
            ),
            tool_refs=[
                "snapshot:evidence",
                "calculator:scenario_results",
                "validator:proposal",
            ],
        )

    async def run(self, on_stage: StageCallback | None = None) -> PipelineResult:
        evidence_stage = await self.evidence()
        if on_stage:
            await on_stage(evidence_stage)
        actions_stage = await self.actions(evidence_stage.result)
        if on_stage:
            await on_stage(actions_stage)
        reviewer_stage = await self.reviewer(evidence_stage.result, actions_stage.result)
        if on_stage:
            await on_stage(reviewer_stage)
        return PipelineResult(
            steps=self.steps,
            evidence=evidence_stage.result,
            proposal=actions_stage.result,
            review=reviewer_stage.result,
            llm_calls=self.llm_calls,
            degraded=any(s.status != "completed" for s in self.steps),
        )
