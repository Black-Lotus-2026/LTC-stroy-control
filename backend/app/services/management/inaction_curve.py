"""Cost of continued delay, sampled by the existing calculator; no LLM or new rates."""

from decimal import Decimal, localcontext

from app.schemas.management import ManagementSnapshot, ScenarioResult
from app.services.management.context import canonical_hash
from app.services.management.economic_adapter import get_calculator


def missing_requirements(result: ScenarioResult) -> list[str]:
    """Human-readable gaps from the calculator, never guessed missing rates."""
    needs = []
    for component in result.cost_components:
        if component.amount is not None:
            continue
        if component.source == "missing resource profile":
            needs.append("Оплачиваемые ресурсы и их ставки простоя")
        elif component.category == "idle":
            needs.append(f"Ставка простоя: {component.title}")
        elif component.category == "extension":
            needs.append("Ставка продления графика")
        else:
            needs.append(f"Сумма затрат: {component.title}")
    for gap in result.missing_inputs:
        if "overlapping rates" in gap.lower():
            needs.append("Непересекающиеся периоды ставок")
        elif "overlap" in gap.lower() or "composition" in gap.lower():
            needs.append("Состав затрат без двойного учёта")
        elif "currenc" in gap.lower():
            needs.append("Единая валюта расчёта или согласованный курс")
        elif "rate" in gap.lower() and not needs:
            needs.append("Ставки с согласованными периодами действия")
    if result.missing_inputs and not needs:
        needs.append("Корректный график и связи этапов")
    return list(dict.fromkeys(needs))


def component_basis(result: ScenarioResult) -> list[dict]:
    """Expose only the inputs actually used by the calculator at this point."""
    return [
        {
            "title": c.title,
            "category": c.category,
            "amount": str(c.amount) if c.amount is not None else None,
            "currency": c.currency,
            "source": c.source,
            **{
                key: (
                    format(Decimal(c.inputs[key]), "f")
                    if key in ("rate", "multiplier", "units")
                    and c.inputs.get(key) is not None
                    else c.inputs.get(key)
                )
                for key in ("rate", "unit", "multiplier", "units", "confirmation")
            },
            "period_start": c.inputs.get("start"),
            "period_end": c.inputs.get("end"),
        }
        for c in result.cost_components
    ]


def calculate_inaction_curve(snapshot: ManagementSnapshot) -> dict:
    no_action = next(
        s for s in snapshot.scenarios if s.id == snapshot.no_action_scenario_id
    )
    horizon = no_action.recovery_work_hours
    with localcontext() as ctx:
        ctx.prec = 64
        times = {horizon * Decimal(i) / Decimal(16) for i in range(17)}
    times.update(
        s.recovery_work_hours
        for s in snapshot.scenarios
        if s.recovery_work_hours <= horizon
    )
    calculator = get_calculator()
    points = []
    missing = []
    needs = []
    for hours in sorted(times):
        sample = snapshot.model_copy(deep=True)
        scenario = next(s for s in sample.scenarios if s.id == no_action.id)
        # Keep the selected scenario and its immutable sample snapshot consistent.
        scenario.recovery_work_hours = hours
        result = calculator.calculate(sample, scenario)
        points.append(
            {
                "work_hours": format(hours, "f"),
                "basis": component_basis(result),
                "cost": str(result.total_cost) if result.total_cost is not None else None,
                "delay_work_hours": (
                    str(result.incremental_delay_work_hours)
                    if result.incremental_delay_work_hours is not None
                    else None
                ),
                **{
                    key: str(getattr(result, key))
                    if getattr(result, key) is not None
                    else None
                    for key in (
                        "idle_cost",
                        "extension_cost",
                        "intervention_cost",
                        "other_cost",
                    )
                },
            }
        )
        missing.extend(result.missing_inputs)
        needs.extend(missing_requirements(result))
    return {
        "status": "complete" if all(p["cost"] is not None for p in points) else "partial",
        "as_of": snapshot.as_of.isoformat(),
        "data_mode": snapshot.data_mode,
        "currency": result.currency,
        "horizon_work_hours": format(horizon, "f"),
        "input_hash": canonical_hash(snapshot.model_dump(mode="json")),
        "calculator_version": result.calculator_version,
        "points": points,
        "missing_inputs": sorted(set(missing)),
        "needs": list(dict.fromkeys(needs)),
        "horizon_source": no_action.title,
        "schedule_version": snapshot.schedule_version,
        "timezone": snapshot.calendar.timezone,
        "is_actual_damage": False,
    }
