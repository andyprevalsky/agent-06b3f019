"""Pause-style stop check shared by activity-backed tool handlers.

    explore / browser / code wait ── wait_condition(handle.done() or tool_stop_requested(wi, id))
        paused by the user            → cancel the activity (existing pause path)
        this agent was killed         → cancel the activity the same way; the
          (kill_agent; workflows/agent_control.py marks the in-flight
           LLM-turn tool call ids in ``_interrupted_tool_calls``)

A background spawn's start is exempt (agent_control ``_execute_interruptible_tool``),
so its id is never marked; a killed owner ends its background agents through
the kill cascade instead.

Pure function; safe inside the Temporal workflow sandbox.
"""

from typing import Any, Optional


def tool_stop_requested(workflow_instance: Any, tool_call_id: Optional[str]) -> bool:
    """True when the user paused the agent or this tool call was cancelled by a kill."""
    if getattr(workflow_instance, "is_paused", False):
        return True
    interrupted = getattr(workflow_instance, "_interrupted_tool_calls", None)
    return bool(tool_call_id) and isinstance(interrupted, set) and tool_call_id in interrupted
