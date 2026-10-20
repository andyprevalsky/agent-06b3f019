"""Business logic for the send-message-to-user domain.

Pure orchestration functions: validate input, determine behaviour.
No framework imports (Temporal, ToolManager) here.
"""

from __future__ import annotations

import json
import re
from typing import Any

from domains.send_message_to_user.config import INLINE_VIEW_MAX_PROPS_BYTES
from domains.send_message_to_user.types import ValidationResult

_VIEW_NAME_RE = re.compile(r"^[a-z0-9-]{1,64}$")


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


def validate_inline_view(raw: Any) -> tuple[dict[str, Any] | None, str | None]:
    """Normalise the optional `inline_view` argument.

    Returns ``(None, None)`` when absent, ``({"view", "props"}, None)`` when
    valid, or ``(None, error_text)`` for a tool-error result.
    """
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, "`inline_view` must be an object like {\"view\": \"<name>\", \"props\": {...}}."
    view = raw.get("view")
    if not isinstance(view, str) or not _VIEW_NAME_RE.match(view):
        return None, "`inline_view.view` must be a published inline view name matching [a-z0-9-]+."
    props = raw.get("props")
    if props is None:
        props = {}
    if not isinstance(props, dict):
        return None, "`inline_view.props` must be a JSON object."
    try:
        encoded = json.dumps(props)
    except (TypeError, ValueError):
        return None, "`inline_view.props` must be JSON-serialisable."
    if len(encoded.encode("utf-8")) > INLINE_VIEW_MAX_PROPS_BYTES:
        return None, f"`inline_view.props` must be at most {INLINE_VIEW_MAX_PROPS_BYTES} bytes of JSON."
    return {"view": view, "props": props}, None
