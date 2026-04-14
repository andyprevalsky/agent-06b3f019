"""Parameter Populator Activity — backward-compatible re-export facade.

Production code lives in ``domains/param_populator/``.
This module re-exports public symbols so existing import paths keep working.
"""

from domains.param_populator.handler import populate_tool_params_activity
from domains.param_populator.service import build_agent_system_prompt

# Legacy alias — tests and other callers import the underscore-prefixed name.
_build_agent_system_prompt = build_agent_system_prompt

__all__ = [
    "populate_tool_params_activity",
    "_build_agent_system_prompt",
    "build_agent_system_prompt",
]
