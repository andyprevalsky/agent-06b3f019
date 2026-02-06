"""
Unified Agent Loop Module

This module provides the core agent loop that is used by both:
- Main agent workflow (PLAN → EXECUTE phases)
- Browser agent activity (single EXECUTE phase)

The same `run_agent` function is used, parameterized by:
- tools: List of tool schemas
- system_prompt: Async callback that builds prompt fresh each iteration (includes user context, phase-specific instructions, shared memory)
- is_inside_temporal_activity: Controls how activities are executed

Key behaviors (shared by all agents):
- Blueprint search after first iteration
- Blueprint save on completion
- Verification on attempt_completion
- Context compression when needed
- Tool status standards (IN_PROGRESS → FINISHED)

NOTE: To avoid circular imports, import directly:
  from loop.run_agent import run_agent
  from loop.activity_helper import call_temporal_activity_from_activity
"""

# Only export activity_helper (no circular dependency)
from loop.activity_helper import call_temporal_activity_from_activity

__all__ = [
    "call_temporal_activity_from_activity",
]

# run_agent must be imported directly to avoid circular import:
# loop/__init__ → run_agent → handle_tool_event → loop.activity_helper → circular

