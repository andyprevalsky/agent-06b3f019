"""Validates PlannerResponse decompositions.

Wraps agents/tools/set_plan.validate_dependencies (Kahn's algorithm)
and adds GEPA-specific task count constraint (2-8 tasks).
"""

from typing import List

from helpers.tool_schemas import PlannerResponse
from tools.set_plan import validate_dependencies

from .types import ValidationError

MIN_TASKS = 2
MAX_TASKS = 8


def validate_decomposition(planner_response: PlannerResponse) -> List[ValidationError]:
    errors: List[ValidationError] = []

    n = len(planner_response.tasks)
    if n < MIN_TASKS or n > MAX_TASKS:
        errors.append(ValidationError(
            'INVALID_TASK_COUNT',
            f'Got {n} tasks, need {MIN_TASKS}-{MAX_TASKS}',
        ))
        return errors

    deps_dict = {
        e.task_idx: e.depends_on
        for e in planner_response.dependencies_graph
    }
    task_indices = [str(i) for i in range(n)]
    result = validate_dependencies(task_indices, deps_dict)

    if result is not None:
        if 'cycle' in result.lower() or 'itself' in result.lower():
            errors.append(ValidationError('CYCLE_DETECTED', result))
        else:
            errors.append(ValidationError('INVALID_DEPENDENCY_INDEX', result))

    return errors
