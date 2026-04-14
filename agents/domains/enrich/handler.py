"""Enrich domain handler - thin entry point for the workflow.

Parses input, delegates to service, handles events.
"""

from typing import Any, Dict, Optional

from tools.base import ToolEvent, ToolManager

from .service import execute_enrichment


class EnrichManager(ToolManager):
    """Manager for Enrich operations using Parallel AI's Task API."""

    tool_name = "enrich"

    async def execute_tool(self, workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
        """Delegate to service layer and yield events."""
        async for event in execute_enrichment(tool_call):
            yield event


# Singleton
_manager: Optional[EnrichManager] = None


def get_manager() -> EnrichManager:
    """Get or create Enrich manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = EnrichManager()
    return _manager


async def enrich(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
    """Workflow helper for Enrich (event-driven system).

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'input', 'output_schema', 'processor'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "enrich")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        if event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="enrich")

    return last_status
