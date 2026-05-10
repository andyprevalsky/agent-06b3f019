"""Helpers for keeping agent LLM contexts scoped to the owning agent."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List


def is_internal_subagent_message(message: Dict[str, Any]) -> bool:
    """Return True for intermediate work messages emitted by a spawned agent.

    ``subAgentId`` rows belong to one child agent's own work stream.
    For_each child tree rows use plural ``subAgentIds`` plus suffixed
    ``toolCallId`` values like ``<base>:<idx>``; those UI rows are also hidden
    because the parent receives one aggregate result under the original
    toolCallId. Direct ``spawn_general_purpose_agent`` results also use plural
    ``subAgentIds`` but keep the original, unsuffixed toolCallId, so they remain
    visible to the parent context.
    """
    if not isinstance(message, dict):
        return False

    metadata = message.get("metadata") or {}
    if not isinstance(metadata, dict):
        return False

    if metadata.get("subAgentId"):
        return True

    tool_call_id = str(metadata.get("toolCallId") or "")
    return bool(metadata.get("subAgentIds") and ":" in tool_call_id)


def filter_internal_subagent_messages(messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop spawned-agent work messages while preserving parent-visible rows."""
    return [message for message in messages if not is_internal_subagent_message(message)]
