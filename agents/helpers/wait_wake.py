"""Wake events for in-tool waits (wait_for).

wait_seconds is not a model tool: TOOL_EXECUTORS has no entry for it and the
DAG alias routes old ``wait_seconds`` plan tasks to wait_for, so every wait the
model or a plan can start goes through wait_for and wakes here. The
wait_seconds handler remains an internal sleep helper with no wake handling.

    signal / workflow event ──▶ workflow._note_wait_wake(kind, **detail)
        user_message        receive_user_response (plain chat / SMS message)
        agent_message       receive_agent_message (another agent wrote to us)
        agent_notification  a background agent of ours finished (notification row)
        child_completed     a child workflow reported (agents-mode matching only)
        aborted             this run is ending: kill_agent killed it or its parent
                            finished (workflows/agent_control.py ``_abort_run``)
            │  _wait_wake_seq += 1, event appended to a bounded in-memory log
            ▼
    poll ── note_context_snapshot(wi, seq read before the poll), after it succeeds
            (the poll feeding the LLM turn that may issue a wait)
    wait ── mark = wait_baseline(wi) ── wait_condition(first_wake(wi, mark, kinds) is not None)

The baseline is the context snapshot, not the wait's start: an event that
arrived after the poll but before the wait began (e.g. a user message while
the LLM was deciding to wait) is something the model has not seen, so the
wait ends at once. An event during the poll itself may already be in context;
counting it costs one spurious wake, never a missed one.

Waits are deterministic ``wait_condition``s on workflow state (no polling
activities). The log is per agent and bounded, so cost does not grow with
the number of agents in the tree.

Pure helpers; safe inside the Temporal workflow sandbox. ``wi`` may be any
object (tests use bare stand-ins): a missing log reads as "never woken".
"""

from __future__ import annotations

from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional

# Kinds that end a timestamp / condition wait: each
# one carries something the model should read now (a new model-visible row,
# or an explicit interrupt / stop).
GENERAL_WAKE_KINDS: FrozenSet[str] = frozenset({"user_message", "agent_message", "agent_notification", "aborted"})
# Kinds that always end an agents-mode wait, whichever agents it lists.
ALWAYS_WAKE_KINDS: FrozenSet[str] = frozenset({"user_message", "aborted"})

MAX_WAKE_EVENTS = 50

_KIND_LABELS = {
    "user_message": "a new user message",
    "agent_message": "a message from another agent",
    "agent_notification": "a background agent notification",
    "child_completed": "a sub-agent finishing",
    "aborted": "this agent being stopped",
}


def wake_mark(wi: Any) -> int:
    """Current wake sequence; events after it are new to a wait started now."""
    seq = getattr(wi, "_wait_wake_seq", 0)
    return seq if isinstance(seq, int) else 0


def note_context_snapshot(wi: Any, mark: int) -> None:
    """Record ``mark`` (``wake_mark`` read right before a poll) once that poll succeeded."""
    wi._context_wake_mark = mark


def wait_baseline(wi: Any) -> int:
    """Mark a wait compares against: the last context snapshot (else now)."""
    current = wake_mark(wi)
    snapshot = getattr(wi, "_context_wake_mark", None)
    if isinstance(snapshot, int) and not isinstance(snapshot, bool) and 0 <= snapshot <= current:
        return snapshot
    return current


def has_user_message_since(wi: Any, mark: int) -> bool:
    """Unread user progress survives unrelated events evicting the bounded log."""
    seq = getattr(wi, "_last_user_message_wake_seq", 0)
    return isinstance(seq, int) and not isinstance(seq, bool) and seq > mark


def wake_events_since(wi: Any, mark: int) -> List[Dict[str, Any]]:
    events = getattr(wi, "_wait_wake_events", None)
    if not isinstance(events, list):
        return []
    return [event for event in events if isinstance(event, dict) and int(event.get("seq") or 0) > mark]


def first_wake(
    wi: Any,
    mark: int,
    kinds: Iterable[str] = GENERAL_WAKE_KINDS,
    matcher: Optional[Callable[[Dict[str, Any]], bool]] = None,
) -> Optional[Dict[str, Any]]:
    """First event after ``mark`` whose kind is in ``kinds`` (or that ``matcher`` accepts)."""
    allowed = frozenset(kinds)
    for event in wake_events_since(wi, mark):
        if event.get("kind") in allowed or (matcher is not None and matcher(event)):
            return event
    return None


def record_wake(wi: Any, kind: str, at: Optional[str] = None, **detail: Any) -> Dict[str, Any]:
    """Append one wake event to ``wi``'s bounded log and bump its sequence."""
    seq = wake_mark(wi) + 1
    wi._wait_wake_seq = seq
    if kind == "user_message":
        wi._last_user_message_wake_seq = seq
    event: Dict[str, Any] = {"seq": seq, "kind": kind}
    if at:
        event["at"] = at
    event.update({key: value for key, value in detail.items() if value is not None})
    events = getattr(wi, "_wait_wake_events", None)
    if not isinstance(events, list):
        events = []
        wi._wait_wake_events = events
    events.append(event)
    del events[:-MAX_WAKE_EVENTS]
    return event


def wake_source_path(event: Dict[str, Any]) -> Optional[str]:
    """Task path the event itself names for its source agent, if any."""
    for key in ("from_agent_path", "path"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def wake_source_id(event: Dict[str, Any]) -> Optional[str]:
    """Agent id of the event's source (sender, finished child, killer), if any."""
    for key in ("from_agent_id", "agent_id"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    children = event.get("child_agent_ids")
    if isinstance(children, list) and children and isinstance(children[0], str):
        return children[0]
    return None


def describe_wake(event: Dict[str, Any], source_path: Optional[str] = None) -> str:
    """Short factual phrase for a result row: what woke the wait.

    Names the source agent by task path (``source_path`` when the caller
    resolved one, else the event's own); the agent id only when no path is known.
    """
    kind = str(event.get("kind") or "")
    label = _KIND_LABELS.get(kind, kind or "an event")
    source = source_path or wake_source_path(event) or event.get("address") or wake_source_id(event)
    if kind in {"agent_message", "agent_notification", "child_completed", "aborted"} and source:
        label += f" ({source})"
    return label
