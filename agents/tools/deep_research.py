"""Backward-compatible re-exports for deep-research domain.

All business logic lives in domains/deep_research/.
This shim preserves the ``from tools.deep_research import ...`` contract
used by worker.py, workflows, and tests.

Note: ``handle_tool_event`` is re-exported here so that blackbox tests can
patch ``tools.deep_research.handle_tool_event`` on this module's namespace.
"""

from domains.deep_research.handler import (  # noqa: F401
    DeepResearchManager,
    deep_research,
    deep_research_activity,
    get_manager,
)
from helpers.handle_tool_event import handle_tool_event  # noqa: F401

__all__ = [
    "DeepResearchManager",
    "deep_research",
    "deep_research_activity",
    "get_manager",
    "handle_tool_event",
]
