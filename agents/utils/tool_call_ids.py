"""Pure helpers for tool-call-id derived identifiers.

Workflow-safe: no uuid/clock/random, so these can be called from inside the
Temporal workflow sandbox on both first-run and replay.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Optional


def request_tool_call_ids(messages: Iterable[Any]) -> set[str]:
    """Every tool-call id an outgoing provider request already uses.

    Covers assistant ``tool_calls[].id`` declarations and ``role: tool``
    results, so a new call can be checked against the whole conversation.
    """
    taken: set[str] = set()
    for message in messages:
        if not isinstance(message, Mapping):
            continue
        for call in message.get("tool_calls") or ():
            if isinstance(call, Mapping) and call.get("id"):
                taken.add(str(call["id"]))
        if message.get("tool_call_id"):
            taken.add(str(message["tool_call_id"]))
    return taken


def context_tool_call_ids(rows: Iterable[Any]) -> set[str]:
    """Every tool-call id stored in an agent's context rows.

    ASSISTANT ``metadata.tool_calls[].tool_call_id`` declarations and TOOL
    ``metadata.toolCallId`` rows (any status). This is a superset of the ids an
    outgoing request carries: the request builder strips a declaration whose
    result was never written, yet the declaration registry still checks it.
    """
    taken: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        metadata = row.get("metadata")
        if not isinstance(metadata, Mapping):
            continue
        tool_calls = metadata.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                if isinstance(call, Mapping) and call.get("tool_call_id"):
                    taken.add(str(call["tool_call_id"]))
        if metadata.get("toolCallId"):
            taken.add(str(metadata["toolCallId"]))
    return taken


def claim_tool_call_id(provider_id: str, taken: set[str]) -> str:
    """Return a conversation-unique id for one new provider tool call, and reserve it.

    Provider ids are only unique per response for some models: kimi-k3 numbers
    them per turn (``spawn_agent:3`` again on a later turn). A repeat would make
    two declarations share one id, so the incoming call takes the first free
    ``<id>__<n>``. Ids already in the conversation are never rewritten, which
    keeps the cached prefix byte-identical, and a unique provider id passes
    through unchanged. Deterministic, so replays of a stream assign the same id.
    """
    claimed = provider_id
    suffix = 2
    while claimed in taken:
        claimed = f"{provider_id}__{suffix}"
        suffix += 1
    taken.add(claimed)
    return claimed


def base_tool_call_id(tool_call_id: Optional[str]) -> Optional[str]:
    """Return ``toolCallId`` without any per-child suffix."""
    if not isinstance(tool_call_id, str) or not tool_call_id:
        return None
    colon = tool_call_id.find(":")
    return tool_call_id if colon == -1 else tool_call_id[:colon]


def spawn_group_id(tool_call_id: Optional[str], explicit_group_id: Optional[str] = None) -> Optional[str]:
    """Return the cluster identity for a spawn row's ``toolCallId``.

    Direct LLM turns may intentionally spawn several general-purpose agents in
    one response; callers pass ``explicit_group_id`` so those siblings collapse
    into one tree. For-each children still fan out under suffixed tool-call ids
    (``<parent>:<idx>``), so stripping the suffix gives a stable fallback shared
    by the aggregate and all children.

    Broadcast/display metadata only — never enters the LLM context or the
    demo-cache key (which strips routing ids via
    ``_VOLATILE_OBJECT_FIELDS``), so it cannot affect trajectory cache hits.
    """
    if isinstance(explicit_group_id, str) and explicit_group_id:
        return explicit_group_id
    return base_tool_call_id(tool_call_id)
