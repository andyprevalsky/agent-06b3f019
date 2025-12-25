"""
Tool for enabling write permissions before performing hard writes to internet databases.

This tool MUST be called before:
1. Transferring value (like clicking a pay button)
2. Publishing content (like submitting a social media post)
3. Transmitting messages (like sending an email)

The permission granted is SINGLE-USE: only the immediate next action is permissioned.
The agent must prepare the state so that no other action is required before the write.
"""

from typing import Dict, Any, Optional, AsyncGenerator
from temporalio import workflow
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus
from tools.request_user_approval import request_user_approval_direct

logger = structlog.get_logger()


class EnableWritePermissionsManager(ToolManager):
    """Manager for enabling write permissions (gates hard writes to internet databases)."""

    tool_name = "enable_write_permissions"
    read_only = True  # Available in plan phase

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """
        Request write permissions from the user before a hard write action.

        This creates an attention request that blocks until the user approves.
        Permission is granted only for the IMMEDIATE NEXT action.
        """
        reason = tool_call.get("reason")
        action_description = tool_call.get("action_description")
        
        if not isinstance(reason, str) or not reason.strip():
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing reason",
                message="enable_write_permissions requires a `reason` explaining why write permission is needed.",
                status=MessageStatus.ERROR,
            )
            return
            
        if not isinstance(action_description, str) or not action_description.strip():
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Missing action_description",
                message="enable_write_permissions requires an `action_description` of what action will be performed.",
                status=MessageStatus.ERROR,
            )
            return

        reason = reason.strip()
        action_description = action_description.strip()
        
        # Construct approval question with context
        approval_question = f"""🔐 **Write Permission Request**

**Reason:** {reason}

**Action to be performed:** {action_description}

⚠️ This permission is **single-use** - only the immediate next action will be authorized.

Do you approve this write action?"""

        # Use request_user_approval_direct under the hood
        try:
            result = await request_user_approval_direct(
                workflow_instance,
                question=approval_question,
                metadata={
                    "writePermission": True,
                    "reason": reason,
                    "actionDescription": action_description,
                }
            )
            
            logger.info(
                "Write permission granted",
                reason=reason,
                action_description=action_description,
                response=result.get("response", "")[:100]
            )
            
            # Emit success event
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✅ Write permission granted",
                message=f"Permission granted for: {action_description}",
                status=MessageStatus.FINISHED,
                metadata={
                    "writePermission": True,
                    "permissionGranted": True,
                    "reason": reason,
                    "actionDescription": action_description,
                }
            )
            
        except Exception as e:
            logger.error(f"Error requesting write permission: {e}")
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Permission request failed",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            return


# ========================================
# SINGLETON
# ========================================

_manager: Optional[EnableWritePermissionsManager] = None


def get_manager() -> EnableWritePermissionsManager:
    """Get or create enable_write_permissions manager singleton."""
    global _manager
    if _manager is None:
        _manager = EnableWritePermissionsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def enable_write_permissions(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str) -> None:
    """
    Workflow helper for enable_write_permissions.

    This requests user approval before a hard write action.
    Permission is granted only for the immediate next action.
    """
    manager = get_manager()
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "enable_write_permissions")

