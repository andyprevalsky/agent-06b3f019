"""Types for the send-message-to-user domain.

Schemas, TypedDicts, and type aliases used across all layers.
"""

from typing import Any, TypedDict


class ValidationResult(TypedDict):
    """Result of validating the tool_call input."""

    ok: bool
    message: str
    is_question: bool


def build_attention_metadata(
    message: str,
    is_question: bool,
    is_waiting: bool,
    inline_view: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the attention metadata dict for a send_message_to_user event.

    ``inline_view`` is the resolved ``{"view", "versionId", "props"}`` pin and
    is persisted as ``metadata.inlineView`` when present.
    """
    metadata: dict[str, Any] = {
        "isUserAttentionMessage": True,
        "attentionMessage": message,
        "sendMessageToUser": {
            "isQuestion": is_question,
            "attentionKind": "question" if is_question else "info",
            "isWaitingForUser": is_waiting,
        },
    }
    if inline_view is not None:
        metadata["inlineView"] = inline_view
    return metadata
