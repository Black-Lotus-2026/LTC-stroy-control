"""Auditable future incremental costs. No LLM output enters this module."""

import hashlib
import json
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext

from app.schemas.management import (
    CostComponent,
    ManagementSnapshot,
    RateInput,
    ScenarioInput,
    ScenarioResult,
)
from app.services.management.calendar import (
    add_work_hours,
    elapsed_hours,
    next_work_start,
    shift_hours,
    working_hours_between,
)
from app.services.management.schedule_simulator import simulate

VERSION = "management-decimal-fs-v1.0"
ZERO = Decimal(0)
CENT = Decimal("0.01")


def snapshot_hash(snapshot: ManagementSnapshot) -> str:
    payload = json.dumps(
        snapshot.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _rate_components(
    *,
    start: datetime,
    end: datetime,
    rates: list[RateInput],
    snapshot: ManagementSnapshot,
    category: str,
    component_id: str,
    title: str,
    cost_group: str,
    multiplier: Decimal = Decimal(1),
) -> tuple[list[CostComponent], list[str]]:
    """Split at tariff boundaries; require exactly one tariff for chargeable time."""
    if end <= start or multiplier == 0:
        return [], []
    unique = {}
    for rate in rates:
        if rate.id in unique and unique[rate.id] != rate:
            raise ValueError(f"Conflicting duplicate rate id: {rate.id}")
        unique[rate.id] = rate
    rates = list(unique.values())
    points = {start, end}
    for rate in rates:
        if rate.valid_from and start < rate.valid_from < end:
            points.add(rate.valid_from)
        if rate.valid_to and start < rate.valid_to < end:
            points.add(rate.valid_to)
    points = sorted(points)
    components, missing = [], []
    calendar_billing = any(rate.unit == "calendar_day" for rate in rates)
    for index, (left, right) in enumerate(zip(points, points[1:], strict=False)):
        work_hours = working_hours_between(left, right, snapshot.calendar)
        active = [
            r
            for r in rates
            if (r.valid_from is None or r.valid_from <= left)
            and (r.valid_to is None or r.valid_to >= right)
        ]
        if len(active) > 1:
            raise ValueError(
                f"Overlapping rates for {component_id}: "
                f"{left.isoformat()}..{right.isoformat()}"
            )
        if not active:
            if work_hours == 0 and not calendar_billing:
                continue
            missing.append(
                f"{component_id}: no rate for {left.isoformat()}..{right.isoformat()}"
            )
            components.append(
                CostComponent(
                    id=f"{component_id}:missing:{index}",
                    category=category,
                    title=title,
                    amount=None,
                    currency="RUB",
                    cost_group=cost_group,
                    source="missing rate",
                    formula="quantity × idle_fraction × tariff × duration",
                    inputs={"start": left.isoformat(), "end": right.isoformat()},
                )
            )
            continue
        rate = active[0]
        if rate.unit == "calendar_day":
            units = elapsed_hours(left, right) / Decimal(24)
        elif rate.unit == "work_day":
            units = work_hours / shift_hours(snapshot.calendar)
        else:
            units = work_hours
        if units == 0:
            continue
        amount = None if rate.amount is None else money(multiplier * rate.amount * units)
        if rate.amount is None:
            missing.append(f"{component_id}: missing amount for rate {rate.id}")
        components.append(
            CostComponent(
                id=f"{component_id}:{rate.id}:{index}",
                category=category,
                title=title,
                amount=amount,
                currency=rate.currency,
                cost_group=cost_group,
                source=rate.source,
                formula="quantity × idle_fraction × tariff × duration_in_tariff_units",
                inputs={
                    "multiplier": str(multiplier),
                    "rate": str(rate.amount) if rate.amount is not None else None,
                    "units": str(units),
                    "unit": rate.unit,
                    "working_hours": str(work_hours),
                    "shift_hours": str(shift_hours(snapshot.calendar)),
                    "start": left.isoformat(),
                    "end": right.isoformat(),
                    "rate_id": rate.id,
                    "confirmation": rate.confirmation,
                },
            )
        )
    return components, missing


class DefaultScenarioCalculator:
    def calculate(
        self, snapshot: ManagementSnapshot, scenario: ScenarioInput
    ) -> ScenarioResult:
        """Invalid graphs/tariffs return a persisted, explicit invalid_input result."""
        base = dict(
            scenario_id=scenario.id,
            input_hash=snapshot_hash(snapshot),
            calculator_version=VERSION,
        )
        try:
            with localcontext() as context:
                context.prec = 64  # bounds permit rate × quantity well above 28 digits
                return self._calculate(snapshot, scenario, base)
        except (ValueError, OverflowError, InvalidOperation) as exc:
            return ScenarioResult(
                **base,
                status="invalid_input",
                missing_inputs=[str(exc)],
                calculation_trace=["Input rejected; no aggregate cost was produced."],
            )

    def _calculate(
        self, snapshot: ManagementSnapshot, scenario: ScenarioInput, base: dict
    ) -> ScenarioResult:
        selected = next((s for s in snapshot.scenarios if s.id == scenario.id), None)
        if selected != scenario:
            raise ValueError("Scenario must match the immutable input snapshot")
        if any(task.project_id != snapshot.project_id for task in snapshot.tasks):
            raise ValueError("Cross-project schedule is forbidden")
        forecast = simulate(snapshot, scenario)
        milestone = next(
            t for t in forecast.tasks if t.task_id == snapshot.milestone_task_id
        )
        milestone_input = next(
            t for t in snapshot.tasks if t.id == snapshot.milestone_task_id
        )
        reference_at = (
            milestone_input.actual_finish_at
            if milestone_input.completed
            else add_work_hours(
                snapshot.as_of, forecast.reference_milestone_hours, snapshot.calendar
            )
        )
        scenario_at = milestone.finish_at
        delay = forecast.scenario_milestone_hours - forecast.reference_milestone_hours
        components, missing, assumptions = (
            [],
            [],
            [*snapshot.assumptions, *scenario.assumptions],
        )
        groups: dict[str, str] = {}
        ambiguous_groups = []

        def claim_group(group: str, owner: str):
            if group in groups and groups[group] != owner:
                ambiguous_groups.append(
                    f"Cost group {group} overlaps: {groups[group]} / {owner}"
                )
            groups[group] = owner

        seen_resources = {}
        charged_resources = False
        for resource in snapshot.resources:
            if resource.resource_id in seen_resources:
                if seen_resources[resource.resource_id] != resource:
                    raise ValueError(
                        f"Conflicting resource definitions: {resource.resource_id}"
                    )
                continue  # Exact repeated evidence/input is not another resource.
            seen_resources[resource.resource_id] = resource
            if (
                not resource.paid_and_affected
                or resource.quantity == 0
                or resource.idle_fraction == 0
            ):
                continue
            if forecast.idle_end_hours > forecast.idle_start_hours:
                charged_resources = True
                claim_group(resource.cost_group, f"resource:{resource.resource_id}")
            rows, gaps = _rate_components(
                start=next_work_start(
                    add_work_hours(
                        snapshot.as_of, forecast.idle_start_hours, snapshot.calendar
                    ),
                    snapshot.calendar,
                ),
                end=add_work_hours(
                    snapshot.as_of, forecast.idle_end_hours, snapshot.calendar
                ),
                rates=resource.rates,
                snapshot=snapshot,
                category="idle",
                component_id=f"idle:{resource.resource_id}",
                title=resource.name,
                cost_group=resource.cost_group,
                multiplier=resource.quantity * resource.idle_fraction,
            )
            components.extend(rows)
            missing.extend(gaps)
        if not snapshot.resources and forecast.idle_end_hours > forecast.idle_start_hours:
            missing.append(
                "resources: affected paid resources are not specified; idle costs unknown"
            )
            components.append(
                CostComponent(
                    id="idle:unknown",
                    category="idle",
                    title="Простой: ресурсы не заданы",
                    amount=None,
                    currency="RUB",
                    cost_group="unknown_resources",
                    source="missing resource profile",
                    formula="unknown",
                )
            )
        if delay > 0:
            claim_group(snapshot.extension_cost_group, "extension")
            rows, gaps = _rate_components(
                start=max(snapshot.as_of, reference_at),
                end=scenario_at,
                rates=snapshot.extension_rates,
                snapshot=snapshot,
                category="extension",
                component_id="extension",
                title="Продление объекта",
                cost_group=snapshot.extension_cost_group,
            )
            components.extend(rows)
            missing.extend(gaps)
            if charged_resources and not snapshot.extension_excludes_resource_costs:
                ambiguous_groups.append(
                    "Extension tariff composition is not confirmed to exclude "
                    "separately charged resources"
                )
        seen_costs = {}
        for category, explicit_costs in (
            ("intervention", scenario.intervention_costs),
            ("other", scenario.other_costs),
        ):
            for cost in explicit_costs:
                if cost.id in seen_costs:
                    if seen_costs[cost.id] != (category, cost):
                        raise ValueError(f"Conflicting explicit cost id: {cost.id}")
                    continue
                seen_costs[cost.id] = (category, cost)
                claim_group(cost.cost_group, f"{category}:{cost.id}")
                if cost.amount is None:
                    missing.append(f"{category}:{cost.id}: missing amount")
                components.append(
                    CostComponent(
                        id=f"{category}:{cost.id}",
                        category=category,
                        title=cost.title,
                        amount=None if cost.amount is None else money(cost.amount),
                        currency=cost.currency,
                        cost_group=cost.cost_group,
                        source=cost.source,
                        formula="explicit one-time incremental amount",
                        inputs={
                            "amount": str(cost.amount)
                            if cost.amount is not None
                            else None
                        },
                    )
                )
        # Do not treat an unknown/ambiguous composition as a verified clean sum.
        missing.extend(ambiguous_groups)
        currencies = {
            c.currency
            for c in components
            if c.source != "missing rate" and c.source != "missing resource profile"
        }
        if len(currencies) > 1:
            raise ValueError(
                "Mixed currencies require an explicit conversion rate and date"
            )
        currency = next(iter(currencies), "RUB")
        subtotals = {}
        for category in ("idle", "extension", "intervention", "other"):
            rows = [row for row in components if row.category == category]
            subtotals[category] = (
                None
                if any(row.amount is None for row in rows)
                else sum((row.amount for row in rows), ZERO)
            )
        total = None if missing else sum(subtotals.values(), ZERO)
        if snapshot.blockage_confirmation == "hypothesis":
            assumptions.append(
                "Блокировка не подтверждена человеком: последствия и затраты "
                "являются условным сценарием."
            )
        if any(
            r.confirmation == "demo"
            for resource in snapshot.resources
            for r in resource.rates
        ) or any(r.confirmation == "demo" for r in snapshot.extension_rates):
            assumptions.append(
                "Использованы явно условные демонстрационные ставки; "
                "это не рыночные данные и не фактическая экономия."
            )
        if not scenario.action_allowed:
            assumptions.append(
                "Сценарий рассчитан для сравнения; действие не разрешено "
                "и не может быть рекомендовано к исполнению."
            )
        trace = [
            "FS DAG; reference and scenario use the same remaining durations "
            "and immutable planned dates.",
            f"Reference milestone = {forecast.reference_milestone_hours} work hours; "
            f"scenario = {forecast.scenario_milestone_hours}; "
            f"incremental delay = {delay}.",
            f"Future resource idle window = [{forecast.idle_start_hours}, "
            f"{forecast.idle_end_hours}) work hours from as_of; sunk costs excluded.",
            "Tariff intervals are half-open; work_day uses configured shift duration; "
            "calendar_day = elapsed seconds / 86400.",
            "Each tariff segment is rounded to currency cents "
            "with Decimal ROUND_HALF_UP, then summed.",
            f"Total = idle {subtotals['idle']} + extension {subtotals['extension']} "
            f"+ intervention {subtotals['intervention']} + other {subtotals['other']}; "
            f"total {total} {currency}.",
        ]
        return ScenarioResult(
            **base,
            status="partial" if missing else "complete",
            reference_milestone_at=reference_at,
            scenario_milestone_at=scenario_at,
            incremental_delay_work_hours=delay,
            deadline_variance_work_hours=None
            if snapshot.agreed_deadline_at is None
            else working_hours_between(
                snapshot.agreed_deadline_at, scenario_at, snapshot.calendar
            ),
            idle_cost=subtotals["idle"],
            extension_cost=subtotals["extension"],
            intervention_cost=subtotals["intervention"],
            other_cost=subtotals["other"],
            total_cost=total,
            currency=currency,
            cost_components=components,
            affected_tasks=forecast.tasks,
            missing_inputs=missing,
            assumptions=list(dict.fromkeys(assumptions)),
            calculation_trace=trace,
        )
