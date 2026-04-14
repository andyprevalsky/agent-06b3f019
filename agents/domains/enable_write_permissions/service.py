"""Business logic for the enable-write-permissions domain.

Validates inputs, builds the approval question, and delegates to the
user-approval provider.  All functions accept typed args and return typed
results -- no framework objects leak in or out.
"""

from __future__ import annotations

from typing import Any

import structlog

from domains.enable_write_permissions.types import (
    ApprovalResult,
    WritePermissionInput,
    WritePermissionMetadata,
)
from tools.request_user_approval import request_user_approval_direct

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class ValidationError:
    """Carrier for a validation failure (field name + human-readable message)."""

    __slots__ = ("field", "message")

    def __init__(self, field: str, message: str) -> None:
        self.field = field
        self.message = message


def validate_tool_call(tool_call: dict[str, Any]) -> WritePermissionInput | ValidationError:
    """Return a ``WritePermissionInput`` on success, or a ``ValidationError`` on failure."""
    reason = tool_call.get("reason")
    action_description = tool_call.get("action_description")

    if not isinstance(reason, str) or not reason.strip():
        return ValidationError(
            "reason",
            "enable_write_permissions requires a `reason` explaining why write permission is needed.",
        )

    if not isinstance(action_description, str) or not action_description.strip():
        return ValidationError(
            "action_description",
            "enable_write_permissions requires an `action_description` of what action will be performed.",
        )

    return WritePermissionInput(reason=reason.strip(), action_description=action_description.strip())


# ---------------------------------------------------------------------------
# Approval question construction
# ---------------------------------------------------------------------------

_APPROVAL_TEMPLATE = """🔐 **Write Permission Request**

**Reason:** {reason}

**Action to be performed:** {action_description}

\u26a0\ufe0f This permission is **single-use** - only the immediate next action will be authorized.

Do you approve this write action?"""


def build_approval_question(validated: WritePermissionInput) -> str:
    """Format the human-readable approval prompt."""
    return _APPROVAL_TEMPLATE.format(
        reason=validated["reason"],
        action_description=validated["action_description"],
    )


def build_approval_metadata(validated: WritePermissionInput) -> WritePermissionMetadata:
    """Build metadata dict for the approval request activity."""
    return WritePermissionMetadata(
        writePermission=True,
        reason=validated["reason"],
        actionDescription=validated["action_description"],
    )


# ---------------------------------------------------------------------------
# Approval execution
# ---------------------------------------------------------------------------


async def request_write_permission(
    workflow_instance: Any,
    validated: WritePermissionInput,
) -> ApprovalResult:
    """Request user approval for a write action.

    Delegates to ``request_user_approval_direct`` and logs the outcome.
    Raises on failure (caller is responsible for catching).
    """
    question = build_approval_question(validated)
    metadata = build_approval_metadata(validated)

    result: ApprovalResult = await request_user_approval_direct(
        workflow_instance,
        question=question,
        metadata=dict(metadata),
    )

    logger.info(
        "Write permission granted",
        reason=validated["reason"],
        action_description=validated["action_description"],
        response=result.get("response", "")[:100],
    )

    return result
