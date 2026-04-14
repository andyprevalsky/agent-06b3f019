"""Backward-compatible re-export shim.

All logic lives in domains/request_user_signup/. This file exists so that
existing imports (tests, workflow TOOL_EXECUTORS) continue to resolve.
"""

from domains.request_user_signup.handler import (  # noqa: F401
    RequestUserSignupManager,
    get_manager,
    request_user_signup,
)
