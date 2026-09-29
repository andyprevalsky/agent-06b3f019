"""Backward-compatible re-exports for wait-for domain.

All business logic lives in domains/wait_for/.
This shim preserves the ``from tools.wait_for import ...`` contract
used by worker.py, workflows, and tests.
"""

from domains.wait_for.handler import WaitForManager, get_manager, wait_for
from domains.wait_for.service import (
    evaluate_condition_activity,
    format_duration,
    is_sibling_agent_completion_condition,
    sibling_agent_completion_already_met,
)

__all__ = [
    "WaitForManager",
    "evaluate_condition_activity",
    "format_duration",
    "get_manager",
    "is_sibling_agent_completion_condition",
    "sibling_agent_completion_already_met",
    "wait_for",
]
