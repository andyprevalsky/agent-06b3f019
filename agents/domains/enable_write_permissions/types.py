"""Type definitions for the enable-write-permissions domain."""

from typing import TypedDict


class WritePermissionInput(TypedDict):
    """Validated input for a write-permission request."""

    reason: str
    action_description: str


class WritePermissionMetadata(TypedDict):
    """Metadata attached to an approval request."""

    writePermission: bool
    reason: str
    actionDescription: str


class ApprovalResult(TypedDict):
    """Return value from ``request_user_approval_direct``."""

    response: str
    question: str
