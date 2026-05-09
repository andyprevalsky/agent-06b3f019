"""Helpers for keeping agent LLM contexts scoped to the owning agent."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List


def is_internal_subagent_message(message: Dict[str, Any]) -> bool:
    """Return True for intermediate work messages emitted by a spawned agent.

    Parent-visible spawn lifecycle/result messages use ``subAgentIds``. The
    singular ``subAgentId`` tag is reserved for messages that belong to the
    spawned agent's own work stream and should not be replayed to the parent
    LLM, planner, verifier, or context compactor.
    """
    if not isinstance(message, dict):
        return False

    metadata = message.get("metadata") or {}
    if not isinstance(metadata, dict):
        return False

    return bool(metadata.get("subAgentId"))


def filter_internal_subagent_messages(messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop spawned-agent work messages while preserving parent-visible rows."""
    return [message for message in messages if not is_internal_subagent_message(message)]
