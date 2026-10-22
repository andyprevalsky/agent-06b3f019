"""Agent-to-agent context in provider messages (Codex ``InterAgentMessage`` shape).

    stored USER row {agentMessage | agentNotification}
        ──▶ converter ──▶ {"role": "assistant", "content": InterAgentText(body)}
                           placed after the tool results of its turn (pairing pass)
        ──▶ RoseClient.complete: a TRAILING inter-agent message (nothing after it)
            is sent as user role, because every Rose transport strips trailing
            assistant messages (assistant prefill) and would drop it silently.

Codex (codex-rs/core/src/context/inter_agent_message.rs) records these as
assistant-role content; Rose follows it. A ``str`` subclass is the marker so
nothing extra reaches provider JSON: it serializes as a plain string and every
provider still sees the same text (same pattern as ``UncachedContextText``).
"""

from __future__ import annotations

from typing import Any, Dict, List


class InterAgentText(str):
    """Text of an agent-to-agent message or completion notification."""

    __slots__ = ()


def inter_agent_message(text: str) -> Dict[str, Any]:
    """One assistant-role provider message carrying agent-to-agent content."""
    return {"role": "assistant", "content": InterAgentText(text)}


def is_inter_agent_message(message: Any) -> bool:
    return (
        isinstance(message, dict)
        and message.get("role") == "assistant"
        and isinstance(message.get("content"), InterAgentText)
        and not message.get("tool_calls")
    )


def settle_trailing_inter_agent_messages(messages: Any) -> Any:
    """Trailing inter-agent messages become user role; everything else is untouched.

    Only the trailing run changes (the conversation's cached prefix keeps its
    bytes). Returns the input object itself when nothing trails.
    """
    if not isinstance(messages, list) or not messages or not is_inter_agent_message(messages[-1]):
        return messages
    settled: List[Any] = list(messages)
    index = len(settled) - 1
    while index >= 0 and is_inter_agent_message(settled[index]):
        settled[index] = {**settled[index], "role": "user"}
        index -= 1
    return settled


__all__ = [
    "InterAgentText",
    "inter_agent_message",
    "is_inter_agent_message",
    "settle_trailing_inter_agent_messages",
]
