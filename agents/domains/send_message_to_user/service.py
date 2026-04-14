"""Business logic for the send-message-to-user domain.

Pure orchestration functions: validate input, determine behaviour.
No framework imports (Temporal, ToolManager) here.
"""

from __future__ import annotations

from typing import Any

from domains.send_message_to_user.types import ValidationResult


def validate_tool_call(tool_call: dict[str, Any]) -> ValidationResult:
    """Validate the incoming tool_call and return a normalised result.

    Returns:
        ValidationResult with ``ok=True`` on success, or ``ok=False``
        with an error ``message`` explaining the problem.
    """
    message = tool_call.get("message")
    if not isinstance(message, str) or not message.strip():
        return ValidationResult(
            ok=False,
            message=(
                "send_message_to_user requires a non-empty `message` string describing what the user needs to know."
            ),
            is_question=False,
        )

    # Execute-phase variant always forces is_question=False
    tool_name = tool_call.get("tool", "send_message_to_user")
    is_question = False if tool_name == "send_message_to_user_execute_phase" else tool_call.get("is_question", True)

    if not isinstance(is_question, bool):
        return ValidationResult(
            ok=False,
            message="`is_question` must be a boolean. Use true to block for a response, false to send an FYI.",
            is_question=False,
        )

    return ValidationResult(ok=True, message=message.strip(), is_question=is_question)


def is_sub_agent(workflow_instance: object) -> bool:
    """Return True when the workflow is running as a sub-agent (depth >= 1)."""
    return getattr(workflow_instance, "depth", 0) >= 1
