"""Stable replacement boundary for the captain's economic implementation."""

from decimal import Decimal, localcontext
from typing import Protocol

from app.schemas.management import ManagementSnapshot, ScenarioInput, ScenarioResult
from app.services.management.cost_calculator import DefaultScenarioCalculator


class ScenarioCalculator(Protocol):
    def calculate(
        self, snapshot: ManagementSnapshot, scenario: ScenarioInput
    ) -> ScenarioResult: ...


def get_calculator() -> ScenarioCalculator:
    return DefaultScenarioCalculator()


def compare_scenarios(
    no_action: ScenarioResult, action: ScenarioResult
) -> Decimal | None:
    """Signed avoidable cost; incomplete or different snapshots cannot compare."""
    if (
        no_action.status != "complete"
        or action.status != "complete"
        or no_action.total_cost is None
        or action.total_cost is None
        or no_action.currency != action.currency
        or no_action.input_hash != action.input_hash
        or no_action.calculator_version != action.calculator_version
    ):
        return None
    with localcontext() as context:
        context.prec = 64
        return no_action.total_cost - action.total_cost
