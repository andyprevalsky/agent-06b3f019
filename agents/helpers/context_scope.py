"""Helpers for keeping agent LLM contexts scoped to the owning agent.

Cross-language twin of back-end/src/providers/chat/contextScope.ts. Shared
classification fixtures: shared/context-scope/fixtures.json.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List


def is_internal_subagent_message(message: Dict[str, Any]) -> bool:
    """Return True for intermediate work messages emitted by a spawned agent.

    ``subAgentId`` rows belong to one child agent's own work stream.
    For_each child tree rows use plural ``subAgentIds`` plus suffixed
    ``toolCallId`` values like ``<base>:<idx>``; those UI rows are also hidden
    because the parent receives one aggregate result under the original
    toolCallId. Direct ``spawn_general_purpose_agent`` results also use plural
    ``subAgentIds`` but keep the original, unsuffixed toolCallId, so they remain
    visible to the parent context. Parent spawn FINISHED / task_complete
    terminals omit ``subAgentId`` so the result body stays in parent/chat context.
    """
    if not isinstance(message, dict):
        return False

    metadata = message.get("metadata") or {}
    if not isinstance(metadata, dict):
        return False

    if metadata.get("subAgentId"):
        return True

    sub_agent_ids = metadata.get("subAgentIds")
    if not isinstance(sub_agent_ids, list) or len(sub_agent_ids) == 0:
        return False

    tool_call_id = str(metadata.get("toolCallId") or "")
    # for_each child UI rows use `<base>:<idx>` (idx digits); unsuffixed
    # aggregates and provider IDs that merely contain ":" stay visible.
    return bool(re.search(r":\d+$", tool_call_id))


def filter_internal_subagent_messages(messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop spawned-agent work messages while preserving parent-visible rows."""
    return [message for message in messages if not is_internal_subagent_message(message)]


_COMPLETION_EVIDENCE_TOOLS = frozenset({"web_search", "web_fetch", "grep", "people_search"})
_COMPLETION_EVIDENCE_BODY_MAX = 4000


def _message_text(message: Dict[str, Any]) -> str:
    if not isinstance(message, dict):
        return ""
    return str(message.get("text") or message.get("message") or "").strip()


def select_completion_evidence_messages(
    messages: Iterable[Dict[str, Any]],
    *,
    min_chars: int = 200,
    max_body_chars: int = _COMPLETION_EVIDENCE_BODY_MAX,
) -> List[Dict[str, Any]]:
    """Keep parent-visible rows plus bounded FINISHED research internals.

    Full explore dumps blow Temporal's 2 MB activity payload; Task Complete only
    needs one long research body, not every thinking chip.
    """
    kept: List[Dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if not is_internal_subagent_message(message):
            kept.append(message)
            continue
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        tool_name = str(metadata.get("toolName") or "")
        status = str(metadata.get("toolStatus") or "").upper()
        body = _message_text(message)
        if tool_name not in _COMPLETION_EVIDENCE_TOOLS or status != "FINISHED" or len(body) < min_chars:
            continue
        if len(body) > max_body_chars:
            slim = dict(message)
            if "message" in slim:
                slim["message"] = body[:max_body_chars]
            if "text" in slim:
                slim["text"] = body[:max_body_chars]
            kept.append(slim)
            continue
        kept.append(message)
    return kept
