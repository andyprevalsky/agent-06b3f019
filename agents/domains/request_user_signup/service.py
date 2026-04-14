"""Business logic for request-user-signup domain.

Imports: own types, own config.
"""

from __future__ import annotations

from typing import Any, Dict

from domains.request_user_signup.config import DEFAULT_REASON
from domains.request_user_signup.types import SignupOutcome


def extract_reason(tool_call: Dict[str, Any]) -> str:
    """Extract the signup reason from the tool call, falling back to default."""
    return tool_call.get("reason", DEFAULT_REASON)


def build_signup_metadata(reason: str, *, is_waiting: bool) -> Dict[str, Any]:
    """Build metadata dict for frontend rendering of the signup prompt."""
    return {
        "isUserAttentionMessage": True,
        "attentionMessage": reason,
        "requestUserSignup": {
            "isWaitingForUser": is_waiting,
            "attentionKind": "signup",
        },
    }


def resolve_signup_outcome(
    *,
    signup_completed: bool,
    signup_dismissed: bool,
) -> SignupOutcome:
    """Determine the signup outcome from workflow state flags."""
    if signup_completed:
        return SignupOutcome.COMPLETED
    if signup_dismissed:
        return SignupOutcome.DISMISSED
    return SignupOutcome.MESSAGE


# Outcome -> (title, message) for the resolution event
_OUTCOME_DISPLAY: Dict[SignupOutcome, tuple[str, str]] = {
    SignupOutcome.COMPLETED: ("Signup Complete", "User has signed up. Continuing..."),
    SignupOutcome.DISMISSED: ("Signup Skipped", "Continuing as anonymous user."),
    SignupOutcome.MESSAGE: ("Continuing", "Continuing with current session."),
}


def outcome_display(outcome: SignupOutcome) -> tuple[str, str]:
    """Return (title, message) for a given signup outcome."""
    return _OUTCOME_DISPLAY[outcome]
