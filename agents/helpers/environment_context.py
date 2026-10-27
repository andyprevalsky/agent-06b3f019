"""Environment context: what the model knows about "now" and the agents it started.

Two parts (user decision 2026-10-19, Codex world-state pattern)::

    persisted block (history)                    unsaved tail (every LLM call)
    ─────────────────────────                    ─────────────────────────────
    USER row {environmentContext, hidden}        <environment-status> after the cached
    <environment> date + timezone, own path,     prefix (UncachedContextText): time to
    parent, running agents (paths, max 8)        the minute, per running agent: type,
    appended ONLY when it differs from the       status, elapsed, current activity,
    last such row in the model context, so a     sub-agent counts (max 8). Never stored.
    compaction that drops it re-emits it.

Neither part is user-authored: response-schema feedback, verifier "user said"
logic, DAG plan supersession, planner memory and the FE skip the row by its
``environmentContext`` / ``hidden`` metadata, never by text.

CRITICAL: pure module (no I/O, no clock, no randomness) — imported inside the
Temporal workflow sandbox. Callers pass ``now``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence
from zoneinfo import ZoneInfo

ENVIRONMENT_CONTEXT_KEY = "environmentContext"
MAX_ENVIRONMENT_AGENTS = 8
ENVIRONMENT_ACTIVITY_MAX_CHARS = 60
_UTC = "UTC"


def _metadata(message: Any) -> Dict[str, Any]:
    metadata = message.get("metadata") if isinstance(message, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def is_environment_context_metadata(metadata: Any) -> bool:
    return isinstance(metadata, dict) and metadata.get(ENVIRONMENT_CONTEXT_KEY) is True


def is_environment_context_row(message: Any) -> bool:
    return is_environment_context_metadata(_metadata(message))


def environment_context_metadata(idempotency_key: str) -> Dict[str, Any]:
    """Metadata of a persisted environment row (model-visible, not a user turn, hidden in the FE)."""
    return {ENVIRONMENT_CONTEXT_KEY: True, "hidden": True, "idempotencyKey": idempotency_key}


def latest_environment_block_text(context: Sequence[Dict[str, Any]]) -> Optional[str]:
    """Text of the newest environment row still in the model context (None after compaction dropped it)."""
    for message in reversed(list(context or [])):
        if is_environment_context_row(message):
            return str(message.get("text") or "")
    return None


def _local(now: datetime, tz_name: Optional[str]) -> tuple:
    """(local datetime, zone label). Unknown / invalid zones fall back to UTC."""
    aware = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    if tz_name and tz_name != _UTC:
        try:
            local = aware.astimezone(ZoneInfo(tz_name))
            return local, local.strftime("%Z") or tz_name
        except Exception:
            pass
    return aware.astimezone(timezone.utc), _UTC


def _zone_name(tz_name: Optional[str], label: str) -> str:
    return tz_name if tz_name and label != _UTC else _UTC


def parent_task_path(own_path: Optional[str]) -> Optional[str]:
    """ "/root/a/b" -> "/root/a"; the root (or no path) has no parent path."""
    if not own_path or own_path.count("/") <= 1:
        return None
    return own_path.rsplit("/", 1)[0]


def _agent_label(agent: Dict[str, Any]) -> str:
    return str(agent.get("path") or agent.get("address") or agent.get("agent_id") or "unknown")


def _more_line(hidden: int) -> List[str]:
    return [f"+{hidden} more (an explore agent can list_agents)"] if hidden > 0 else []


def render_environment_block(
    *,
    now: datetime,
    tz_name: Optional[str],
    own_path: Optional[str],
    is_root: bool,
    agents: Sequence[Dict[str, Any]],
) -> str:
    """The persisted ``<environment>`` block (stable between real changes: date, not time)."""
    local, label = _local(now, tz_name)
    lines = [f"Current date: {local.strftime('%Y-%m-%d')} ({_zone_name(tz_name, label)})"]
    if is_root:
        lines.append(f"You are {own_path or '/root'}, the root agent.")
    else:
        parent = parent_task_path(own_path)
        you = f"You are {own_path}" if own_path else "You are a sub-agent"
        lines.append(f"{you}; your parent is {parent}." if parent else f'{you}; your parent is "parent".')
    shown = list(agents)[:MAX_ENVIRONMENT_AGENTS]
    if shown:
        lines.append("Running agents you started:")
        lines.extend(f"- {_agent_label(agent)} ({agent.get('type') or 'agent'})" for agent in shown)
        lines.extend(_more_line(len(agents) - len(shown)))
    else:
        lines.append("Running agents you started: none")
    return "<environment>\n" + "\n".join(lines) + "\n</environment>"


def format_elapsed(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    return f"{minutes // 60}h {minutes % 60:02d}m"


def _parse_time(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _clip(text: Any, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _status_line(agent: Dict[str, Any], now: datetime) -> str:
    status = str(agent.get("status") or "running").lower()
    started = _parse_time(agent.get("started_at"))
    head = f"{agent.get('type') or 'agent'}, {status}"
    if started is not None:
        head += f" {format_elapsed((now - started).total_seconds())}"
    details = []
    activity = agent.get("activity")
    if activity:
        details.append(_clip(activity, ENVIRONMENT_ACTIVITY_MAX_CHARS))
    children = agent.get("child_count")
    if isinstance(children, int) and children > 0:
        active = agent.get("active_child_count")
        noun = "sub-agent" if children == 1 else "sub-agents"
        details.append(f"{children} {noun}, {active if isinstance(active, int) else 0} active")
    line = f"- {_agent_label(agent)} ({head})"
    return f"{line}: {'; '.join(details)}" if details else line


def render_environment_tail(*, now: datetime, tz_name: Optional[str], agents: Sequence[Dict[str, Any]]) -> str:
    """The unsaved ``<environment-status>`` tail rebuilt on every model call."""
    aware = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    local, label = _local(aware, tz_name)
    lines = [f"Current time: {local.strftime('%Y-%m-%d %H:%M')} {label}"]
    shown = list(agents)[:MAX_ENVIRONMENT_AGENTS]
    if shown:
        lines.append("Running agents you started:")
        lines.extend(_status_line(agent, aware) for agent in shown)
        lines.extend(_more_line(len(agents) - len(shown)))
    return "<environment-status>\n" + "\n".join(lines) + "\n</environment-status>"


def merge_tree_status(agents: Sequence[Dict[str, Any]], nodes: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Overlay one bounded tree read (direct children) onto workflow-state entries.

    Matches by child agent id. Only status / activity / child counts come from
    the read; the entry list itself (which agents, their order) is workflow state.
    """
    by_id = {node.get("agent_id"): node for node in nodes or [] if isinstance(node, dict) and node.get("agent_id")}
    merged = []
    for agent in agents:
        entry = dict(agent)
        node = by_id.get(agent.get("agent_id"))
        if node is not None:
            status = str(node.get("status") or "").lower()
            if status and status != "active":
                entry["status"] = status
            tools = [tool for tool in node.get("tools_in_use") or [] if isinstance(tool, str) and tool]
            if tools and not entry.get("activity"):
                entry["activity"] = ", ".join(tools[:2])
            for key in ("child_count", "active_child_count"):
                if isinstance(node.get(key), int):
                    entry[key] = node[key]
        merged.append(entry)
    return merged


__all__ = [
    "ENVIRONMENT_CONTEXT_KEY",
    "MAX_ENVIRONMENT_AGENTS",
    "environment_context_metadata",
    "format_elapsed",
    "is_environment_context_metadata",
    "is_environment_context_row",
    "latest_environment_block_text",
    "merge_tree_status",
    "parent_task_path",
    "render_environment_block",
    "render_environment_tail",
]
