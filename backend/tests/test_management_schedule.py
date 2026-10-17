from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.management import DependencyInput, ManagementSnapshot, WorkCalendar
from app.services.management.calendar import add_work_hours, working_hours_between
from app.services.management.demo import AS_OF, DEMO_PROJECT_ID, make_demo_snapshot
from app.services.management.economic_adapter import get_calculator
from app.services.management.schedule_simulator import simulate


def test_control_graph_parallel_slack_and_preserves_plan():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    before = snapshot.model_dump_json()
    results = [simulate(snapshot, s) for s in snapshot.scenarios]
    assert [r.reference_milestone_hours for r in results] == [28, 28, 28]
    assert [r.scenario_milestone_hours for r in results] == [28, 28, 32]
    assert [
        next(t for t in r.tasks if t.task_id == "D").finish_work_hours for r in results
    ] == [24, 24, 24]
    assert snapshot.model_dump_json() == before


def test_monotonic_recovery_and_true_slack_episode():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    completions = []
    for hours in range(12):
        snapshot.scenarios[0].recovery_work_hours = Decimal(hours)
        completions.append(
            simulate(snapshot, snapshot.scenarios[0]).scenario_milestone_hours
        )
    assert completions == sorted(completions)
    slack = make_demo_snapshot(DEMO_PROJECT_ID, "slack")
    assert [
        get_calculator().calculate(slack, s).incremental_delay_work_hours
        for s in slack.scenarios
    ] == [0, 0, 0]


@pytest.mark.parametrize(
    "edges",
    [
        [DependencyInput(predecessor_id="M", successor_id="A")],
        [DependencyInput(predecessor_id="missing", successor_id="A")],
        [DependencyInput(predecessor_id="A", successor_id="B")],
    ],
)
def test_invalid_edges_are_rejected(edges):
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.dependencies.extend(edges)
    result = get_calculator().calculate(snapshot, snapshot.scenarios[0])
    assert result.status == "invalid_input"
    assert result.total_cost is None


def test_cross_project_task_rejected_at_contract_boundary():
    data = make_demo_snapshot(DEMO_PROJECT_ID).model_dump(mode="json")
    data["tasks"][0]["project_id"] = str(uuid4())
    with pytest.raises(ValidationError, match="Cross-project"):
        ManagementSnapshot.model_validate(data)


def test_calendar_shift_end_weekend_and_exceptions():
    calendar = WorkCalendar()
    assert add_work_hours(AS_OF, Decimal(8), calendar) == datetime(
        2026, 10, 16, 13, tzinfo=UTC
    )
    assert add_work_hours(AS_OF, Decimal(9), calendar) == datetime(
        2026, 10, 19, 6, tzinfo=UTC
    )
    exceptional = WorkCalendar(
        holidays=[date(2026, 10, 19)], extra_working_dates=[date(2026, 10, 17)]
    )
    assert add_work_hours(AS_OF, Decimal(17), exceptional) == datetime(
        2026, 10, 20, 6, tzinfo=UTC
    )
    assert working_hours_between(
        AS_OF, add_work_hours(AS_OF, Decimal("17.25"), exceptional), exceptional
    ) == Decimal("17.25")


def test_after_hours_start_and_nonstandard_shift():
    calendar = WorkCalendar(shift_start=time(9), shift_end=time(15))
    saturday = datetime(2026, 10, 17, 17, tzinfo=UTC)
    assert add_work_hours(saturday, Decimal("6.5"), calendar) == datetime(
        2026, 10, 20, 6, 30, tzinfo=UTC
    )
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.as_of = saturday
    result = simulate(snapshot, snapshot.scenarios[0])
    independent = next(t for t in result.tasks if t.task_id == "D")
    assert independent.start_at == datetime(2026, 10, 19, 5, tzinfo=UTC)
    assert independent.finish_at == datetime(2026, 10, 21, 13, tzinfo=UTC)


def test_unsupported_night_shift_and_conflicting_exceptions_rejected():
    with pytest.raises(ValidationError, match="Night shifts"):
        WorkCalendar(shift_start=time(22), shift_end=time(6))
    with pytest.raises(ValidationError, match="conflict"):
        WorkCalendar(
            holidays=[date(2026, 10, 16)], extra_working_dates=[date(2026, 10, 16)]
        )


def test_completed_task_actual_finish_is_preserved_and_not_future_work():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    task = next(t for t in snapshot.tasks if t.id == "D")
    task.completed = True
    task.remaining_work_hours = Decimal(0)
    task.actual_finish_at = AS_OF - timedelta(days=1)
    result = simulate(snapshot, snapshot.scenarios[-1])
    completed = next(t for t in result.tasks if t.task_id == "D")
    assert completed.finish_at == task.actual_finish_at
    assert completed.finish_work_hours == -8


def test_deadline_variance_is_separate_from_incremental_delay():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.agreed_deadline_at = add_work_hours(AS_OF, Decimal(24), snapshot.calendar)
    result = get_calculator().calculate(snapshot, snapshot.scenarios[0])
    assert result.incremental_delay_work_hours == 0
    assert result.deadline_variance_work_hours == 4


def test_lag_propagates_but_does_not_serialize_parallel_tasks():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.dependencies[0].lag_work_hours = Decimal(5)
    result = simulate(snapshot, snapshot.scenarios[0])
    assert result.reference_milestone_hours == 29
    assert result.scenario_milestone_hours == 31
    assert next(t for t in result.tasks if t.task_id == "D").finish_work_hours == 24


def test_no_idle_charge_before_blocked_task_could_start():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.tasks[0].earliest_start_work_hours = Decimal(12)
    result = get_calculator().calculate(snapshot, snapshot.scenarios[0])
    assert result.idle_cost == 0
    assert result.incremental_delay_work_hours == 0
