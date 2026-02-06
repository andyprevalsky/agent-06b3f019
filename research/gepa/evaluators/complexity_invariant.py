"""Complexity Invariant evaluator: checks each child task < parent in complexity.

STUB: Returns mock result. Replace with LLM call in Phase B.
"""

from helpers.tool_schemas import PlannerResponse
from ..types import EvalResult


async def evaluate_complexity(goal: str, planner_response: PlannerResponse) -> EvalResult:
    # STUB: Replace with LLM call
    return EvalResult(passed=True, score=1.0, reasoning='STUB: Not implemented')
