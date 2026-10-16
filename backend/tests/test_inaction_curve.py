from decimal import Decimal

from app.services.management.demo import DEMO_PROJECT_ID, make_demo_snapshot
from app.services.management.inaction_curve import calculate_inaction_curve


def test_curve_uses_no_action_calculator_at_each_delay_without_mutating_inputs():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    before = snapshot.model_dump_json()
    curve = calculate_inaction_curve(snapshot)
    points = {Decimal(p["work_hours"]): p for p in curve["points"]}
    assert curve["status"] == "complete"
    assert [Decimal(points[Decimal(h)]["cost"]) for h in (0, 2, 4, 8)] == [
        0, 24000, 48000, 112000,
    ]
    assert points[Decimal(8)]["idle_cost"] == "96000.00"
    assert points[Decimal(8)]["extension_cost"] == "16000.00"
    assert points[Decimal(8)]["delay_work_hours"] == "4"
    assert curve["is_actual_damage"] is False
    assert snapshot.model_dump_json() == before


def test_curve_does_not_fill_unknown_costs_or_invent_a_horizon():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = None
    curve = calculate_inaction_curve(snapshot)
    assert curve["status"] == "partial"
    assert curve["points"][-1]["cost"] is None
    assert curve["missing_inputs"]
    snapshot.scenarios[-1].recovery_work_hours = Decimal(0)
    curve = calculate_inaction_curve(snapshot)
    assert curve["horizon_work_hours"] == "0"
    assert [p["work_hours"] for p in curve["points"]] == ["0"]


def test_curve_exposes_only_used_rates_sources_and_reference_time():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    curve = calculate_inaction_curve(snapshot)
    assert curve["as_of"] == snapshot.as_of.isoformat()
    assert curve["timezone"] == snapshot.calendar.timezone
    assert curve["schedule_version"] == snapshot.schedule_version
    assert curve["horizon_source"] == snapshot.scenarios[-1].title
    assert curve["needs"] == []
    basis = curve["points"][-1]["basis"]
    assert {Decimal(row["rate"]) for row in basis} == {Decimal(8000), Decimal(4000)}
    assert {row["source"] for row in basis} == {snapshot.resources[0].rates[0].source}
    assert {row["confirmation"] for row in basis} == {"demo"}
    assert all(row["period_start"] and row["period_end"] for row in basis)
    assert sum(Decimal(row["amount"]) for row in basis) == Decimal(112000)
    assert curve["points"][0]["basis"] == []


def test_curve_names_the_missing_resource_rate_and_extension_rate():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = None
    snapshot.extension_rates = []
    curve = calculate_inaction_curve(snapshot)
    assert curve["status"] == "partial"
    assert set(curve["needs"]) == {
        f"Ставка простоя: {snapshot.resources[0].name}",
        "Ставка продления графика",
    }
    assert curve["points"][-1]["cost"] is None
    snapshot.resources = []
    assert "Оплачиваемые ресурсы и их ставки простоя" in (
        calculate_inaction_curve(snapshot)["needs"]
    )


def test_curve_names_invalid_graph_without_inventing_a_cost():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.dependencies.append(snapshot.dependencies[0].model_copy())
    curve = calculate_inaction_curve(snapshot)
    assert curve["status"] == "partial"
    assert curve["needs"] == ["Корректный график и связи этапов"]
    assert all(point["cost"] is None for point in curve["points"])


def test_basis_decimal_inputs_are_displayable_without_scientific_notation():
    snapshot = make_demo_snapshot(DEMO_PROJECT_ID)
    snapshot.resources[0].rates[0].amount = Decimal("1E+4")
    snapshot.resources[0].quantity = Decimal("1E+1")
    curve = calculate_inaction_curve(snapshot)
    basis = curve["points"][-1]["basis"][0]
    assert basis["rate"] == "10000"
    assert basis["multiplier"] == "10"
    assert basis["amount"] == "800000.00"
