"""Helpers for keeping agent LLM contexts scoped to the owning agent.

Cross-language twin of back-end/src/providers/chat/contextScope.ts. Shared
classification fixtures: shared/context-scope/fixtures.json.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List

_PROVIDER_NUMERIC_TOOL_CALL_ID = re.compile(r"^(toolu|tooluse):\d+$", re.IGNORECASE)
_HISTORICAL_FOR_EACH_SUFFIX = re.compile(r":[0-9]+$")


def _is_provider_numeric_tool_call_id(tool_call_id: str) -> bool:
    """Provider-native ids that look like ``base:digits`` but are not for_each children."""
    return _PROVIDER_NUMERIC_TOOL_CALL_ID.fullmatch(tool_call_id) is not None


def _has_historical_for_each_child_suffix(tool_call_id: str) -> bool:
    """Historical for_each child UI rows use ``<parent>:<idx>`` (ASCII digit idx)."""
    if _HISTORICAL_FOR_EACH_SUFFIX.search(tool_call_id) is None:
        return False
    return not _is_provider_numeric_tool_call_id(tool_call_id)


def is_internal_subagent_message(message: Dict[str, Any]) -> bool:
    """Return True for intermediate work messages emitted by a spawned agent.

    ``subAgentId`` rows belong to one child agent's own work stream.
    For_each child tree rows are producer-marked with ``forEachChild: true``
    plus plural ``subAgentIds``; those UI rows are hidden because the parent
    receives one aggregate result under the original toolCallId (and
    ``forEachAggregate: true``). Historical rows (pre-marker) still use a
    ``<parent>:<idx>`` toolCallId with nonempty ``subAgentIds`` and are also
    dropped. A bare provider id like ``toolu:123`` must stay parent-visible.
    Direct ``spawn_general_purpose_agent`` results also use plural
    ``subAgentIds`` but omit ``forEachChild`` and the child suffix, so they
    remain visible. Parent spawn FINISHED / task_complete terminals omit
    ``subAgentId`` so the result body stays in parent/chat context.
    """
    if not isinstance(message, dict):
        return False

    metadata = message.get("metadata") or {}
    if not isinstance(metadata, dict):
        return False

    if metadata.get("subAgentId"):
        return True

    if metadata.get("forEachAggregate") is True:
        return False

    sub_agent_ids = metadata.get("subAgentIds")
    if not isinstance(sub_agent_ids, list) or len(sub_agent_ids) == 0:
        return False

    if metadata.get("forEachChild") is True:
        return True

    tool_call_id = str(metadata.get("toolCallId") or "")
    return _has_historical_for_each_child_suffix(tool_call_id)


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
