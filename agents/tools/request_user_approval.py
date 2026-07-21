"""Request user approval tools - backward-compatible re-exports.

All logic has moved to domains/request_user_approval/. This shim exists so that
existing callers (tests, workflow sandbox imports) continue to work.
"""

from domains.request_user_approval.handler import request_user_approval
from domains.request_user_approval.repo import (
    create_approval_request_activity,
    resolve_attention_request_activity,
)
from domains.request_user_approval.service import (
    RequestUserApprovalManager,
    get_manager,
    request_user_approval_direct,
    request_user_attention_direct,
)
from domains.request_user_approval.types import UserRejectedError

__all__ = [
    "RequestUserApprovalManager",
    "UserRejectedError",
    "create_approval_request_activity",
    "get_manager",
    "resolve_attention_request_activity",
    "request_user_attention_direct",
    "request_user_approval",
    "request_user_approval_direct",
]
