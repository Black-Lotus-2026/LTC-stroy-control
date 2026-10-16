from datetime import time, timedelta
from decimal import Decimal

import pytest

from app.schemas.management import RateInput, WorkCalendar
from app.services.management.calendar import add_work_hours
from app.services.management.demo import (
    AS_OF,
    DEMO_PROJECT_ID,
    EPISODES,
    make_demo_snapshot,
)
from app.services.management.economic_adapter import compare_scenarios, get_calculator


def calculate(snapshot, index=0):
    return get_calculator().calculate(snapshot, snapshot.scenarios[index])


def test_exact_control_costs_and_conditional_difference():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    results = [calculate(snapshot, i) for i in range(3)]
    assert [r.total_cost for r in results] == [
        Decimal(44000),
        Decimal(68000),
        Decimal(112000),
    ]
    assert [r.idle_cost for r in results] == [24000, 48000, 96000]
    assert [r.extension_cost for r in results] == [0, 0, 16000]
    assert [r.intervention_cost for r in results] == [20000, 20000, 0]
    assert [r.incremental_delay_work_hours for r in results] == [0, 0, 4]
    assert all(r.status == "complete" for r in results)
    assert compare_scenarios(results[-1], results[0]) == 68000
    assert compare_scenarios(results[1], results[0]) == 24000
    assert '"total_cost":"44000.00"' in results[0].model_dump_json()


@pytest.mark.parametrize("episode", EPISODES)
def test_all_demo_episodes_reproducible_and_explicit(episode):
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID, episode)
    result = calculate(snapshot)
    assert calculate(snapshot).model_dump_json() == result.model_dump_json()
    assert len(snapshot.evidence) == 2
    assert all(e.origin == "demo_replay" for e in snapshot.evidence)
    assert snapshot.data_mode == "demo"
    if episode == "camera_unavailable":
        assert snapshot.evidence[-1].model_status == "unavailable"
        assert snapshot.blockage_confirmation == "hypothesis"
        assert (
            result.total_cost == 44000
        )  # arithmetic is conditional, not a factual inference


def test_expensive_action_has_negative_effect():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID, "expensive_action")
    assert compare_scenarios(calculate(snapshot, 2), calculate(snapshot)) == -62000


def test_unknown_rate_remains_null_and_no_comparison():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = None
    result = calculate(snapshot)
    assert result.status == "partial"
    assert result.idle_cost is None
    assert result.total_cost is None
    assert result.intervention_cost == 20000
    assert any(c.amount is None for c in result.cost_components)
    assert compare_scenarios(calculate(snapshot, 2), result) is None


def test_missing_extension_rate_only_matters_when_extension_exists():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.extension_rates = []
    assert calculate(snapshot).status == "complete"
    result = calculate(snapshot, 2)
    assert result.status == "partial"
    assert result.extension_cost is None
    assert result.total_cost is None


def test_missing_resource_profile_is_not_fabricated_zero():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources = []
    assert calculate(snapshot).idle_cost is None
    assert calculate(snapshot).total_cost is None


def test_known_zero_tariff_and_unaffected_resources():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = Decimal(0)
    snapshot.resources[1].paid_and_affected = False
    result = calculate(snapshot)
    assert result.status == "complete"
    assert result.idle_cost == 0
    assert result.total_cost == 20000


def test_fractional_decimal_money_without_float_error():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = Decimal("0.10")
    snapshot.resources[0].quantity = Decimal(3)
    snapshot.resources[1].paid_and_affected = False
    snapshot.scenarios[0].recovery_work_hours = Decimal("0.1")
    assert calculate(snapshot).idle_cost == Decimal("0.03")


def test_large_valid_monetary_inputs_do_not_overflow_decimal_context():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = Decimal("1000000000000")
    snapshot.resources[0].quantity = Decimal("1000000000000")
    snapshot.scenarios[0].recovery_work_hours = Decimal(10000)
    snapshot.resources[1].paid_and_affected = False
    result = calculate(snapshot)
    assert result.status == "complete"
    assert result.idle_cost == Decimal("10000000000000000000000000000.00")


def test_signed_comparison_preserves_cents_above_default_decimal_precision():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = Decimal("1000000000000")
    snapshot.resources[0].quantity = Decimal("1000000000000")
    snapshot.resources[1].paid_and_affected = False
    snapshot.scenarios[2].recovery_work_hours = Decimal(10000)
    snapshot.scenarios[0].recovery_work_hours = Decimal(0)
    snapshot.scenarios[0].intervention_costs[0].amount = Decimal("0.01")
    no_action, action = calculate(snapshot, 2), calculate(snapshot)
    assert no_action.status == action.status == "complete"
    expected = Decimal("10000000000000000000039983999.99")
    assert compare_scenarios(no_action, action) == expected
    assert compare_scenarios(action, no_action) == expected.copy_negate()


def test_comparison_rejects_incompatible_currency_or_calculator_definition():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    no_action, action = calculate(snapshot, 2), calculate(snapshot)
    assert (
        compare_scenarios(no_action, action.model_copy(update={"currency": "USD"}))
        is None
    )
    assert (
        compare_scenarios(
            no_action, action.model_copy(update={"calculator_version": "other"})
        )
        is None
    )


def test_conflicting_duplicate_resource_rate_definitions_are_invalid():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    other = snapshot.resources[0].rates[0].model_copy(deep=True)
    other.amount = Decimal(9000)
    snapshot.resources[0].rates.append(other)
    assert calculate(snapshot).status == "invalid_input"


def test_rate_changes_split_interval():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    first = snapshot.resources[0].rates[0]
    first.valid_to = AS_OF + timedelta(hours=1)
    second = first.model_copy(deep=True)
    second.id = "new-excavator"
    second.valid_from = first.valid_to
    second.valid_to = None
    second.amount = Decimal(10000)
    snapshot.resources[0].rates.append(second)
    result = calculate(snapshot)
    assert result.idle_cost == 26000
    rows = [c for c in result.cost_components if c.cost_group == "excavator_idle"]
    assert len(rows) == 2
    assert [c.amount for c in rows] == [8000, 10000]


def test_rate_gap_and_overlap_rejected_without_fake_total():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].valid_to = AS_OF + timedelta(hours=1)
    assert calculate(snapshot).status == "partial"
    assert calculate(snapshot).total_cost is None
    overlap = snapshot.resources[0].rates[0].model_copy(deep=True)
    overlap.id = "overlap"
    snapshot.resources[0].rates.append(overlap)
    assert calculate(snapshot).status == "invalid_input"


def test_non_eight_hour_work_day_rate():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.calendar = WorkCalendar(shift_start=time(8), shift_end=time(14))
    snapshot.resources[0].rates[0].unit = "work_day"
    snapshot.resources[0].rates[0].amount = Decimal(6000)
    snapshot.resources[1].paid_and_affected = False
    assert calculate(snapshot).idle_cost == 2000


def test_calendar_day_extension_includes_weekend_and_work_rate_excludes_it():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    # A -> B -> C reference becomes Friday 16:00; no_action ends Monday 16:00.
    snapshot.tasks[0].remaining_work_hours = Decimal(8)
    snapshot.tasks[1].earliest_start_work_hours = Decimal(0)
    snapshot.tasks[1].remaining_work_hours = Decimal(0)
    snapshot.tasks[2].remaining_work_hours = Decimal(0)
    snapshot.tasks[3].remaining_work_hours = Decimal(0)
    snapshot.extension_rates[0].unit = "calendar_day"
    snapshot.extension_rates[0].amount = Decimal(2400)
    assert calculate(snapshot, 2).extension_cost == 7200
    snapshot.extension_rates[0].unit = "work_day"
    assert calculate(snapshot, 2).extension_cost == 2400


def test_one_time_cost_and_exact_duplicate_resource_not_double_counted():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.scenarios[0].intervention_costs *= 2
    snapshot.resources.append(snapshot.resources[0].model_copy(deep=True))
    assert calculate(snapshot).total_cost == 44000


def test_ambiguous_groups_and_unknown_extension_composition_prevent_total():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[1].cost_group = snapshot.resources[0].cost_group
    result = calculate(snapshot)
    assert result.total_cost is None
    assert result.status == "partial"
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.extension_excludes_resource_costs = False
    assert calculate(snapshot, 2).total_cost is None
    assert calculate(snapshot, 2).idle_cost == 96000


def test_mixed_currency_refuses_sum():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].currency = "USD"
    result = calculate(snapshot)
    assert result.status == "invalid_input"
    assert result.total_cost is None
    assert "currencies" in result.missing_inputs[0]


def test_past_rate_does_not_become_future_avoidable_cost():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    historical = RateInput(
        id="past",
        amount=Decimal(999999999),
        valid_from=AS_OF - timedelta(days=30),
        valid_to=AS_OF,
        source="historical confirmed tariff",
        confirmation="confirmed",
    )
    snapshot.resources[0].rates[0].valid_from = AS_OF
    snapshot.resources[0].rates.append(historical)
    assert calculate(snapshot).total_cost == 44000
    assert compare_scenarios(calculate(snapshot, 2), calculate(snapshot)) == 68000


def test_saved_result_and_hash_unaffected_by_later_rate_changes():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    old = calculate(snapshot)
    old_serialized = old.model_dump_json()
    snapshot.resources[0].rates[0].amount = Decimal(9000)
    changed = calculate(snapshot)
    assert old.model_dump_json() == old_serialized
    assert old.input_hash != changed.input_hash
    assert compare_scenarios(old, changed) is None


def test_snapshot_and_selected_scenario_cannot_disagree():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    detached = snapshot.scenarios[0].model_copy(deep=True)
    detached.recovery_work_hours = Decimal(3)
    assert get_calculator().calculate(snapshot, detached).status == "invalid_input"


def test_calendar_idle_does_not_start_before_next_scheduled_shift():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.tasks[0].earliest_start_work_hours = Decimal(8)
    snapshot.scenarios[0].recovery_work_hours = Decimal(9)
    snapshot.resources[0].rates[0].unit = "calendar_day"
    snapshot.resources[0].rates[0].amount = Decimal(2400)
    snapshot.resources[1].paid_and_affected = False
    result = calculate(snapshot)
    assert result.idle_cost == 100
    assert (
        result.cost_components[0].inputs["start"]
        == add_work_hours(AS_OF, Decimal(8), snapshot.calendar)
        .replace(day=19, hour=5)
        .isoformat()
    )
