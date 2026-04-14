"""Request user approval domain types.

Exception classes and type aliases for the approval domain.
Imports: external packages only.
"""

from __future__ import annotations

from typing import Any, Dict


class UserRejectedError(Exception):
    """Raised when user rejects an approval request.

    Attributes:
        rejection_message: The user's rejection feedback text (if any).
    """

    def __init__(self, message: str = "User rejected the approval request", rejection_message: str = ""):
        super().__init__(message)
        self.rejection_message = rejection_message


# Result type from request_user_approval_direct
ApprovalResult = Dict[str, Any]
