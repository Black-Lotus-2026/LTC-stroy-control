"""Durable orchestration. Duplicate deliveries cannot claim an active/finished run."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta

from sqlalchemy import select, update

from app.core.config import settings
from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models.management import ManagementRun, ManagementRunStep
from app.schemas.management import ManagementSnapshot
from app.services.management.agent_pipeline import AgentPipeline
from app.services.management.agents.provider import OpenRouterProvider
from app.services.management.economic_adapter import compare_scenarios, get_calculator


class LostLease(Exception):
    pass


def execute_run(run_id: str, *, session_factory=None, provider=None):
    factory = session_factory or SessionLocal
    with factory() as db:
        now = utcnow()
        claimed = db.execute(
            update(ManagementRun)
            .execution_options(synchronize_session=False)
            .where(
                ManagementRun.id == uuid.UUID(run_id),
                ManagementRun.status == "queued",
                ManagementRun.lease_expires_at > now,
            )
            .values(
                status="running",
                started_at=now,
                lease_expires_at=now
                + timedelta(seconds=settings.management_run_timeout_seconds),
            )
        )
        db.commit()
        if claimed.rowcount != 1:
            return {"id": run_id, "claimed": False}
        run = db.get(ManagementRun, uuid.UUID(run_id))
        try:
            return asyncio.run(_execute(db, run, provider))
        except Exception as exc:
            db.rollback()
            db.refresh(run, with_for_update=True)
            if run.status == "running":
                run.status = "partial" if run.results else "failed"
                run.error = (
                    "worker_lease_expired"
                    if isinstance(exc, LostLease)
                    else "analysis_failed"
                )
                run.finished_at = utcnow()
                run.active_key = None
                for step in db.scalars(
                    select(ManagementRunStep).where(ManagementRunStep.run_id == run.id)
                ):
                    if step.status in ("pending", "running"):
                        step.status = "failed"
                        step.error = run.error
                        step.finished_at = utcnow()
                db.commit()
            # Do not expose provider exception payloads or credentials to Celery.
            return {"id": run_id, "status": run.status, "error": run.error}


async def _execute(db, run, provider):
    from app.services.management.context import aware

    snapshot = ManagementSnapshot.model_validate(run.snapshot)
    steps = {
        step.role: step
        for step in db.scalars(
            select(ManagementRunStep).where(ManagementRunStep.run_id == run.id)
        )
    }

    def live():
        db.refresh(run, with_for_update=True)
        if run.status != "running" or aware(run.lease_expires_at) <= utcnow():
            raise LostLease()

    async def reserve_call(role, attempt):
        live()
        changed = db.execute(
            update(ManagementRun)
            .execution_options(synchronize_session=False)
            .where(
                ManagementRun.id == run.id,
                ManagementRun.status == "running",
                ManagementRun.lease_expires_at > utcnow(),
                ManagementRun.llm_calls < 6,
            )
            .values(llm_calls=ManagementRun.llm_calls + 1)
        )
        if changed.rowcount != 1:
            db.rollback()
            return False
        step = steps[role]
        step.llm_calls += 1
        step.attempts = attempt
        db.commit()
        return True

    def start(role):
        live()
        steps[role].status = "running"
        steps[role].started_at = utcnow()
        db.commit()

    def save_stage(stage, field):
        live()
        step = steps[stage.role]
        for key in (
            "status",
            "generation",
            "error",
            "provider",
            "model",
            "prompt_version",
            "started_at",
            "finished_at",
            "attempts",
            "usage",
            "tool_refs",
        ):
            setattr(step, key, getattr(stage, key))
        payload = stage.result.model_dump(mode="json")
        step.result = {**payload, "_validation_errors": stage.validation_errors}
        setattr(run, field, payload)
        db.commit()

    pipeline = AgentPipeline(
        snapshot,
        mode=run.mode,
        reserve_call=reserve_call,
        deadline_at=aware(run.lease_expires_at),
        provider=provider
        or OpenRouterProvider(
            api_key=settings.openrouter_api_key.get_secret_value(),
            model=settings.openrouter_model,
        ),
    )
    start("evidence")
    evidence = await pipeline.evidence()
    save_stage(evidence, "assessment")

    start("calculation")
    calculator = get_calculator()
    results = [
        calculator.calculate(snapshot, scenario) for scenario in snapshot.scenarios
    ]
    live()
    run.results = [r.model_dump(mode="json") for r in results]
    calculation = steps["calculation"]
    calculation.status = (
        "completed" if all(r.status != "invalid_input" for r in results) else "failed"
    )
    calculation.result = {
        "scenario_ids": [r.scenario_id for r in results],
        "calculator_version": results[0].calculator_version,
    }
    calculation.tool_refs = [f"simulate_scenario:{r.scenario_id}" for r in results]
    calculation.finished_at = utcnow()
    db.commit()
    pipeline.set_scenarios(results)

    start("actions")
    actions = await pipeline.actions(evidence.result)
    save_stage(actions, "proposal")
    start("reviewer")
    reviewer = await pipeline.reviewer(evidence.result, actions.result)
    save_stage(reviewer, "review")

    live()
    selected = next(
        (r for r in results if r.scenario_id == actions.result.recommended_scenario_id),
        None,
    )
    baseline = next(r for r in results if r.scenario_id == snapshot.no_action_scenario_id)
    difference = compare_scenarios(baseline, selected) if selected else None
    run.comparison = {
        "recommended_scenario_id": selected.scenario_id if selected else None,
        "net_avoidable_cost": str(difference) if difference is not None else None,
        "currency": baseline.currency,
        "criterion": (
            "Сравнение дополнительных затрат допустимых вариантов "
            "при заданных допущениях"
        ),
        "is_actual_saving": False,
    }
    agent_steps = [evidence, actions, reviewer]
    llm_count = sum(s.generation == "llm" for s in agent_steps)
    run.effective_mode = (
        "llm" if llm_count == 3 else ("partial" if llm_count else "deterministic")
    )
    if evidence.result.verdict == "insufficient_evidence":
        run.status = "needs_input"
    elif (
        any(r.status != "complete" for r in results)
        or reviewer.result.status != "passed"
        or run.mode == "llm"
        and llm_count != 3
    ):
        run.status = "partial"
    else:
        run.status = "completed"
    run.active_key = None
    run.finished_at = utcnow()
    db.commit()
    return {"id": str(run.id), "status": run.status, "llm_calls": run.llm_calls}
