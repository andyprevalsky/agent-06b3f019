"""Request user approval domain handler.

Thin entry points: parse input, call service, return output.
Imports: own service, own types.
"""

from __future__ import annotations

from typing import Any, Dict

from .service import get_manager


async def request_user_approval(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> None:
    """Workflow helper for request_user_approval (event-driven system).

    This is used by other tools to gate actions requiring user approval.
    Not called directly by the LLM.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "request_user_approval")
