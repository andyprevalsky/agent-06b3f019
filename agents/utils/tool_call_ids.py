"""Pure helpers for tool-call-id derived identifiers.

Workflow-safe: no uuid/clock/random, so these can be called from inside the
Temporal workflow sandbox on both first-run and replay.
"""

from __future__ import annotations

from typing import Optional


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
