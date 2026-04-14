"""Backward-compatible re-exports for attempt-completion domain.

All business logic lives in domains/attempt_completion/.
This shim preserves the ``from tools.attempt_completion import ...`` contract
used by worker.py, workflows, and tests.

Note: ``handle_tool_event`` is re-exported here so that blackbox tests can
patch ``tools.attempt_completion.handle_tool_event`` on this module's namespace.
"""

from domains.attempt_completion.handler import (  # noqa: F401
    AttemptCompletionManager,
    attempt_completion,
    get_manager,
)
from helpers.handle_tool_event import handle_tool_event  # noqa: F401

__all__ = [
    "AttemptCompletionManager",
    "attempt_completion",
    "get_manager",
    "handle_tool_event",
]
