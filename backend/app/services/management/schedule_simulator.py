"""Deterministic finish-to-start DAG simulation on remaining work only."""

from dataclasses import dataclass
from decimal import Decimal

from app.schemas.management import ManagementSnapshot, ScenarioInput, TaskForecast
from app.services.management.calendar import (
    add_work_hours,
    next_work_start,
    working_hours_between,
)

ZERO = Decimal(0)


@dataclass(frozen=True)
class ScheduleForecast:
    tasks: list[TaskForecast]
    reference_milestone_hours: Decimal
    scenario_milestone_hours: Decimal
    idle_start_hours: Decimal
    idle_end_hours: Decimal


def simulate(snapshot: ManagementSnapshot, scenario: ScenarioInput) -> ScheduleForecast:
    tasks = {task.id: task for task in snapshot.tasks}
    predecessors = {key: [] for key in tasks}
    successors = {key: [] for key in tasks}
    edges = set()
    for edge in snapshot.dependencies:
        a, b = edge.predecessor_id, edge.successor_id
        if a not in tasks or b not in tasks:
            raise ValueError(f"Unknown dependency task: {a} -> {b}")
        if (a, b) in edges:
            raise ValueError(f"Duplicate dependency: {a} -> {b}")
        edges.add((a, b))
        predecessors[b].append((a, edge.lag_work_hours))
        successors[a].append(b)
    indegree = {key: len(value) for key, value in predecessors.items()}
    ready = sorted(key for key, degree in indegree.items() if degree == 0)
    ordered = []
    while ready:
        key = ready.pop(0)
        ordered.append(key)
        for child in sorted(successors[key]):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(child)
    if len(ordered) != len(tasks):
        raise ValueError("Cyclic schedule dependencies")

    def forecast(recovery: Decimal):
        result = {}
        for key in ordered:
            task = tasks[key]
            if task.completed:
                if task.remaining_work_hours != 0:
                    raise ValueError(f"Completed task {key} has remaining work")
                finish = working_hours_between(
                    snapshot.as_of, task.actual_finish_at, snapshot.calendar
                )
                result[key] = (finish, finish)
                continue
            start = max(
                ZERO,
                task.earliest_start_work_hours,
                recovery if key == snapshot.blocked_task_id else ZERO,
                *(result[parent][1] + lag for parent, lag in predecessors[key]),
            )
            result[key] = (start, start + task.remaining_work_hours)
        return result

    reference, projected = forecast(ZERO), forecast(scenario.recovery_work_hours)
    result_tasks = []
    for key in ordered:
        task = tasks[key]
        start, finish = projected[key]
        if task.completed:
            start_at = finish_at = task.actual_finish_at
        else:
            start_at = add_work_hours(snapshot.as_of, start, snapshot.calendar)
            if task.remaining_work_hours:
                start_at = next_work_start(start_at, snapshot.calendar)
            finish_at = add_work_hours(snapshot.as_of, finish, snapshot.calendar)
            if finish == 0:
                finish_at = start_at
        result_tasks.append(
            TaskForecast(
                task_id=key,
                reference_start_work_hours=reference[key][0],
                reference_finish_work_hours=reference[key][1],
                start_work_hours=start,
                finish_work_hours=finish,
                start_at=start_at,
                finish_at=finish_at,
            )
        )
    baseline_start = reference[snapshot.blocked_task_id][0]
    return ScheduleForecast(
        tasks=result_tasks,
        reference_milestone_hours=reference[snapshot.milestone_task_id][1],
        scenario_milestone_hours=projected[snapshot.milestone_task_id][1],
        idle_start_hours=baseline_start,
        idle_end_hours=max(baseline_start, scenario.recovery_work_hours),
    )
