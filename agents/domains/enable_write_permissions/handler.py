"""Runtime handler for the enable-write-permissions domain.

Thin layer: parse input -> call service -> emit events.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Optional

import structlog

from domains.enable_write_permissions.service import (
    ValidationError,
    request_write_permission,
    validate_tool_call,
)
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

logger = structlog.get_logger()


class EnableWritePermissionsManager(ToolManager):
    """Manager for enabling write permissions (gates hard writes to internet databases)."""

    tool_name = "enable_write_permissions"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Request write permissions from the user before a hard write action.

        Creates an attention request that blocks until the user approves.
        Permission is granted only for the IMMEDIATE NEXT action.
        """
        result = validate_tool_call(tool_call)
        if isinstance(result, ValidationError):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"\u274c Missing {result.field}",
                message=result.message,
                status=MessageStatus.ERROR,
            )
            return

        validated = result

        try:
            await request_write_permission(workflow_instance, validated)

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u2705 Write permission granted",
                message=f"Permission granted for: {validated['action_description']}",
                status=MessageStatus.FINISHED,
                metadata={
                    "writePermission": True,
                    "permissionGranted": True,
                    "reason": validated["reason"],
                    "actionDescription": validated["action_description"],
                },
            )
        except Exception as e:
            logger.error(f"Error requesting write permission: {e}")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Permission request failed",
                message=str(e),
                status=MessageStatus.ERROR,
            )


# ========================================
# SINGLETON
# ========================================

_manager: Optional[EnableWritePermissionsManager] = None


def get_manager() -> EnableWritePermissionsManager:
    """Get or create enable_write_permissions manager singleton."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = EnableWritePermissionsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================


async def enable_write_permissions(
    workflow_instance: Any,
    tool_call: dict[str, Any],
    tool_call_id: str,
) -> Optional[MessageStatus]:
    """Workflow helper for enable_write_permissions.

    Requests user approval before a hard write action.
    Permission is granted only for the immediate next action.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "enable_write_permissions")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
