"""Backward-compatibility shim -- re-exports from domains.set_plan.

All business logic lives in domains/set_plan/.  This file exists solely
so that existing import paths (``from tools.set_plan import ...``) keep
working, including blackbox tests.
"""

from domains.set_plan.handler import SetPlanManager, get_manager, set_plan  # noqa: F401
from domains.set_plan.service import validate_dependencies  # noqa: F401
from domains.set_plan.service import validate_planner_result as _validate_planner_result  # noqa: F401
