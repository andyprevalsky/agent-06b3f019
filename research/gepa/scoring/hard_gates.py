"""Hard gates: invalid decomposition = -inf score."""

import math

from helpers.tool_schemas import PlannerResponse

from ..validators import validate_decomposition


def hard_gate(planner_response: PlannerResponse) -> float:
    errors = validate_decomposition(planner_response)
    return -math.inf if errors else 0.0
