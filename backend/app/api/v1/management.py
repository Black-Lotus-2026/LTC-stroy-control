"""Authorized, versioned management API. GET never executes analysis or LLM."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.db.base import utcnow
from app.models import Incident, ProjectSettings
from app.models.management import ManagementRun, ManagementRunStep, TaskDependency
from app.schemas.management import (
    DependenciesWrite,
    ManagementSnapshot,
    ProfileWrite,
    RunCreate,
)
from app.services.management.context import (
    aware,
    canonical_hash,
    ensure_demo_incident,
    require_project,
    validate_snapshot,
)
from app.services.management.demo import make_demo_snapshot
from app.services.management.economic_adapter import get_calculator
from app.services.management.inaction_curve import calculate_inaction_curve
from app.services.management.validators import inspect_evidence

router = APIRouter(tags=["Управленческие решения"])
ROLES = ("evidence", "calculation", "actions", "reviewer")


def check_calculation_input(snapshot: ManagementSnapshot) -> None:
    """Reject structurally invalid graphs/cost profiles before saving or queuing."""
    calculator = get_calculator()
    for scenario in snapshot.scenarios:
        try:
            result = calculator.calculate(snapshot, scenario)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if result.status == "invalid_input":
            raise HTTPException(422, result.missing_inputs or result.calculation_trace)


def expire_run(db, run: ManagementRun) -> None:
    # A stale GET must not overwrite a worker that finished in the meantime.
    # Worker commits use the same row lock, including the final state transition.
    if run.status not in ("queued", "running"):
        return
    db.refresh(run, with_for_update=True)
    if (
        run.status in ("queued", "running")
        and run.lease_expires_at
        and aware(run.lease_expires_at) <= utcnow()
    ):
        run.status = "partial" if run.results else "failed"
        run.error = "worker_lease_expired"
        run.finished_at = utcnow()
        run.active_key = None
        for step in db.scalars(
            select(ManagementRunStep).where(ManagementRunStep.run_id == run.id)
        ):
            if step.status in ("pending", "running"):
                step.status = "failed"
                step.error = "worker_lease_expired"
                step.finished_at = utcnow()
        db.commit()


def run_payload(db, run: ManagementRun, *, summary=False) -> dict:
    expire_run(db, run)
    fields = (
        "id",
        "project_id",
        "incident_id",
        "parent_run_id",
        "as_of",
        "mode",
        "effective_mode",
        "status",
        "input_hash",
        "assessment",
        "proposal",
        "review",
        "comparison",
        "error",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
        "llm_calls",
    )
    result = {name: getattr(run, name) for name in fields}
    incident = db.get(Incident, run.incident_id) if run.incident_id else None
    result["incident"] = (
        {
            "id": incident.id,
            "code": incident.code,
            "status": incident.status.value,
            "title": incident.title,
        }
        if incident
        else None
    )
    if not summary:
        result["snapshot"] = run.snapshot
        result["results"] = run.results
        steps = {
            s.role: s
            for s in db.scalars(
                select(ManagementRunStep).where(ManagementRunStep.run_id == run.id)
            )
        }
        step_fields = (
            "role",
            "status",
            "generation",
            "started_at",
            "finished_at",
            "result",
            "error",
            "provider",
            "model",
            "prompt_version",
            "attempts",
            "llm_calls",
            "usage",
            "tool_refs",
        )
        result["steps"] = [
            {k: getattr(steps[role], k) for k in step_fields}
            for role in ROLES
            if role in steps
        ]
    return result


def get_owned_run(db, run_id: uuid.UUID, user) -> ManagementRun:
    run = db.get(ManagementRun, run_id)
    if run is None:
        raise HTTPException(404, "Запуск не найден")
    require_project(db, run.project_id, user)
    return run


@router.get("/incidents/{incident_id}/inaction-cost")
def incident_inaction_cost(incident_id: uuid.UUID, db: DbSession, user: CurrentUser):
    incident = db.get(Incident, incident_id)
    if incident is None:
        raise HTTPException(404, "Случай не найден")
    project = require_project(db, incident.project_id, user)
    run = db.scalars(
        select(ManagementRun)
        .where(
            ManagementRun.incident_id == incident.id,
            ManagementRun.project_id == incident.project_id,
            ManagementRun.status.in_(["completed", "partial", "needs_input"]),
        )
        .order_by(ManagementRun.created_at.desc(), ManagementRun.id.desc())
        .limit(1)
    ).first()
    case_context = {
        "incident_code": incident.code,
        "observed_since": aware(incident.first_seen_at).isoformat(),
        "responsible": (
            incident.assignee.name or incident.assignee.username
            if incident.assignee else None
        ),
        "project_owner": project.owner_username,
    }
    unavailable = {
        **case_context,
        "incident_id": str(incident.id),
        "title": incident.title,
        "status": "unavailable",
        "message": "Расчёт для этого случая не подготовлен.",
        "points": [],
        "needs": [
            "Привязанные к случаю ресурсы и ставки простоя",
            "График работ и срок восстановления",
        ],
        "is_actual_damage": False,
    }
    try:
        if run:
            snapshot = ManagementSnapshot.model_validate(run.snapshot)
        else:
            profile = get_profile(incident.project_id, db, user).get("snapshot")
            # A project-wide or another case's profile is not evidence for this case.
            if not profile or profile.get("incident_id") != str(incident.id):
                return unavailable
            snapshot = validate_snapshot(db, ManagementSnapshot.model_validate(profile))
        if (
            snapshot.project_id != incident.project_id
            or snapshot.incident_id != incident.id
        ):
            return unavailable
        curve = calculate_inaction_curve(snapshot)
    except HTTPException as exc:
        if exc.status_code != 422:
            raise
        return {
            **unavailable,
            "message": "Входы расчёта требуют проверки.",
            "needs": [str(exc.detail)],
        }
    except (ValidationError, ValueError):
        return {
            **unavailable,
            "message": "Входы расчёта требуют проверки.",
            "needs": ["Корректный профиль расчёта этого случая"],
        }
    return {
        **curve,
        **case_context,
        "incident_id": str(incident.id),
        "title": incident.title,
        "run_id": str(run.id) if run else None,
        "evidence_supported": inspect_evidence(snapshot).verdict == "supported_risk",
    }


@router.get("/projects/{project_id}/management/demo")
def demo_profile(
    project_id: uuid.UUID,
    db: DbSession,
    user: CurrentUser,
    episode: Literal[
        "baseline", "camera_unavailable", "slack", "expensive_action"
    ] = "baseline",
):
    require_project(db, project_id, user)
    return make_demo_snapshot(project_id, episode).model_dump(mode="json")


@router.get("/projects/{project_id}/management/profile")
def get_profile(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    row = db.get(ProjectSettings, project_id)
    return (
        (row.extra or {}).get(
            "management_profile",
            {"snapshot": None, "updated_at": None, "updated_by": None},
        )
        if row
        else {"snapshot": None, "updated_at": None, "updated_by": None}
    )


def replace_dependencies(db, project_id, snapshot):
    db.execute(delete(TaskDependency).where(TaskDependency.project_id == project_id))
    for edge in snapshot.dependencies:
        db.add(
            TaskDependency(
                project_id=project_id,
                schedule_version=snapshot.schedule_version,
                **edge.model_dump(),
            )
        )


@router.put("/projects/{project_id}/management/profile")
def put_profile(
    project_id: uuid.UUID, body: ProfileWrite, db: DbSession, user: CurrentUser
):
    require_project(db, project_id, user, write=True, lock=True)
    if body.snapshot.project_id != project_id:
        raise HTTPException(422, "Профиль принадлежит другому объекту")
    snapshot = validate_snapshot(db, body.snapshot)
    check_calculation_input(snapshot)
    row = db.get(ProjectSettings, project_id)
    if row is None:
        row = ProjectSettings(project_id=project_id)
        db.add(row)
    saved = {
        "snapshot": snapshot.model_dump(mode="json"),
        "updated_by": user.username,
        "updated_at": utcnow().isoformat(),
    }
    row.extra = {**(row.extra or {}), "management_profile": saved}
    replace_dependencies(db, project_id, snapshot)
    db.commit()
    return saved


@router.get("/projects/{project_id}/schedule/dependencies")
def get_dependencies(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    profile = get_profile(project_id, db, user)
    snapshot = profile.get("snapshot")
    return {
        "schedule_version": snapshot["schedule_version"] if snapshot else None,
        "dependencies": snapshot["dependencies"] if snapshot else [],
    }


@router.put("/projects/{project_id}/schedule/dependencies")
def put_dependencies(
    project_id: uuid.UUID, body: DependenciesWrite, db: DbSession, user: CurrentUser
):
    require_project(db, project_id, user, write=True, lock=True)
    profile = get_profile(project_id, db, user)
    if profile["snapshot"] is None:
        raise HTTPException(409, "Сначала сохраните профиль с задачами")
    data = {**profile["snapshot"], **body.model_dump(mode="json")}
    saved = put_profile(
        project_id,
        ProfileWrite(snapshot=ManagementSnapshot.model_validate(data)),
        db,
        user,
    )
    return {key: saved["snapshot"][key] for key in ("schedule_version", "dependencies")}


@router.post("/management/runs", status_code=202)
def create_run(body: RunCreate, db: DbSession, user: CurrentUser):
    project_id = body.snapshot.project_id
    require_project(db, project_id, user, write=True, lock=True)
    request_hash = canonical_hash(
        body.model_dump(mode="json", exclude={"idempotency_key"})
    )
    existing = db.scalars(
        select(ManagementRun).where(
            ManagementRun.project_id == project_id,
            ManagementRun.created_by == user.id,
            ManagementRun.idempotency_key == body.idempotency_key,
        )
    ).first()
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "Ключ уже использован с другими входными данными")
        return run_payload(db, existing)
    if body.parent_run_id:
        parent = get_owned_run(db, body.parent_run_id, user)
        if parent.project_id != project_id:
            raise HTTPException(422, "Предыдущий запуск принадлежит другому объекту")
    snapshot = validate_snapshot(db, body.snapshot)
    check_calculation_input(snapshot)
    if snapshot.data_mode == "demo":
        snapshot.incident_id = ensure_demo_incident(db, snapshot)
    input_data = snapshot.model_dump(mode="json")
    input_hash = canonical_hash(input_data)
    active = db.scalars(
        select(ManagementRun).where(ManagementRun.active_key == input_hash)
    ).first()
    if active:
        expire_run(db, active)
        if active.active_key:
            raise HTTPException(
                409,
                {"message": "Этот снимок уже анализируется", "run_id": str(active.id)},
            )
    run = ManagementRun(
        id=uuid.uuid4(),
        project_id=project_id,
        incident_id=snapshot.incident_id,
        created_by=user.id,
        parent_run_id=body.parent_run_id,
        as_of=snapshot.as_of,
        mode=body.mode,
        status="queued",
        idempotency_key=body.idempotency_key,
        request_hash=request_hash,
        input_hash=input_hash,
        active_key=input_hash,
        snapshot=input_data,
        lease_expires_at=utcnow()
        + timedelta(seconds=settings.management_queue_timeout_seconds),
    )
    db.add(run)
    for role in ROLES:
        db.add(ManagementRunStep(run_id=run.id, role=role, status="pending"))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Запуск уже создан параллельным запросом") from exc
    # Snapshot is committed BEFORE dispatch. Broker failure remains an explicit
    # saved terminal state; GET or repeat POST never silently retries or charges.
    from app.workers.management_tasks import analyze_management_run

    try:
        analyze_management_run.apply_async(args=[str(run.id)], retry=False)
    except Exception:
        db.refresh(run)
        if run.status == "queued":
            run.status = "failed"
            run.error = "queue_unavailable"
            run.active_key = None
            run.finished_at = utcnow()
            for step in db.scalars(
                select(ManagementRunStep).where(ManagementRunStep.run_id == run.id)
            ):
                step.status = "skipped"
                step.error = "queue_unavailable"
            db.commit()
    db.expire_all()
    return run_payload(db, db.get(ManagementRun, run.id))


@router.get("/management/runs/{run_id}")
def get_run(run_id: uuid.UUID, db: DbSession, user: CurrentUser):
    return run_payload(db, get_owned_run(db, run_id, user))


@router.get("/management/runs/{run_id}/trace")
def get_trace(run_id: uuid.UUID, db: DbSession, user: CurrentUser):
    result = get_run(run_id, db, user)
    return {
        key: result[key] for key in ("id", "input_hash", "steps", "error", "llm_calls")
    }


@router.get("/projects/{project_id}/management/risks")
def get_risks(project_id: uuid.UUID, db: DbSession, user: CurrentUser):
    require_project(db, project_id, user)
    runs = db.scalars(
        select(ManagementRun)
        .where(ManagementRun.project_id == project_id)
        .order_by(ManagementRun.created_at.desc())
        .limit(100)
    ).all()
    seen = set()
    result = []
    for run in runs:
        item = run_payload(db, run, summary=True)
        key = run.incident_id or run.input_hash
        item["is_latest_for_incident"] = key not in seen
        seen.add(key)
        result.append(item)
    return result
