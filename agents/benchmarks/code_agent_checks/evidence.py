"""Evidence the code-agent checks read, collected once per benchmark run.

    worker log (spawn_claude_code_agent, one clock)       backend log (one create at a time:
      "[ClaudeCode] Creating E2B session"  agent_id        creates hold one global slot)
      "[ClaudeCode] Session created"       task_id           [ClaudeCode] Creating session for agent A
      "[ClaudeCode] Code-agent event"      task_id           [E2B] Creating Claude Code session for agent A
           event_type session/agent_message, status          [E2B] Using sandbox: S (new)
                                                             [ProjectWorkspace] Restored project workspace
                                                             [E2B] WebSocket server ready in …
                                                             [CodePreviewSandbox] … Rose-in-Rose preview …
                                                             [E2B] Session ready: T
                         └──────────── spawns[] keyed by task_id T ────────────┘
    agent tree messages (spawn_claude_code_agent toolCallId) + ClaudeCodeSession rows
                         └──────────── sessions_by_agent / spawn_calls_by_agent ─┘

Only existing product log lines are read; the create path itself is not
instrumented here. Each spawn's startup phases are appended to the span history
(history/span_durations.jsonl, span_key ``code-agent-startup/<phase>``), the
durable per-benchmark latency baseline.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

from benchmarks.code_agent_checks import startup_time
from benchmarks.logs import fetch_local_backend_log_lines, fetch_local_worker_logs

WORKER_CREATE = "[ClaudeCode] Creating E2B session"
WORKER_CREATED = "[ClaudeCode] Session created"
WORKER_EVENT = "[ClaudeCode] Code-agent event"
SPAWN_TOOL = "spawn_claude_code_agent"
SPAN_KEY_PREFIX = "code-agent-startup/"

# Backend create lines, in the order one create emits them (back-end/src/providers/e2b.ts,
# projects/workspace.ts, codePreview/sandbox.ts, domains/claude-code/service.ts).
_BACKEND_MARKS = (
    ("request", "ClaudeCode", re.compile(r"^Creating session for agent (?P<agent>[0-9a-f-]{36})")),
    ("create_start", "E2B", re.compile(r"^Creating Claude Code session for agent (?P<agent>[0-9a-f-]{36})")),
    ("sandbox", "E2B", re.compile(r"^Using sandbox: (?P<sandbox>\S+) \((?P<from>[^)]+)\)")),
    ("workspace", "ProjectWorkspace", re.compile(r"^Restored project workspace\b")),
    ("ws_ready", "E2B", re.compile(r"^WebSocket server ready in\b")),
    ("preview", "CodePreviewSandbox", re.compile(r"Rose-in-Rose preview")),
    ("ready", "E2B", re.compile(r"^Session (?:ready|attached to the live CLI): (?P<task>[0-9a-f-]{36})")),
)
# Message substrings of the lines above: they match prod JSON and dev pretty lines alike.
BACKEND_NEEDLES = (
    "Creating session for agent",
    "Creating Claude Code session for agent",
    "Using sandbox: ",
    "Restored project workspace",
    "WebSocket server ready in",
    "Rose-in-Rose preview",
    "Session ready: ",
    "Session attached to the live CLI: ",
)
_DEV_LINE = re.compile(r"^\[(?P<ts>[^\]]+)\] (?P<level>[A-Z]+) \[(?P<component>[^\]]+)\] (?P<rest>.*)$")
_FIELD = re.compile(r"(\w+)=(\S+)")
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _worker_entries(lines: Iterable[str]) -> list[dict]:
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(entry, dict) and entry.get("event") in {WORKER_CREATE, WORKER_CREATED, WORKER_EVENT}:
            at = _iso(entry.get("timestamp"))
            if at is not None:
                entries.append({**entry, "_at": at})
    return entries


def parse_backend_line(line: str) -> Optional[tuple[datetime, str, str, dict]]:
    """(time, component, message, fields) of one backend line, prod JSON or dev pretty."""
    text = _ANSI.sub("", line).strip()
    try:
        entry = json.loads(text)
    except json.JSONDecodeError:
        entry = None
    if isinstance(entry, dict):
        at = _iso(entry.get("timestamp"))
        if at is None or not isinstance(entry.get("message"), str):
            return None
        fields = {k: v for k, v in entry.items() if k not in {"timestamp", "level", "component", "message"}}
        return at, str(entry.get("component") or ""), entry["message"], fields
    match = _DEV_LINE.match(text)
    at = _iso(match.group("ts")) if match else None
    if match is None or at is None:
        return None
    rest = match.group("rest")
    return at, match.group("component"), rest, dict(_FIELD.findall(rest))


def backend_creates(lines: Iterable[str], agent_ids: Iterable[str]) -> list[dict]:
    """Per-phase backend split of each create by one of ``agent_ids``, keyed by task id."""
    wanted = set(agent_ids)
    parsed = sorted((p for line in lines if (p := parse_backend_line(line)) is not None), key=lambda p: p[0])
    creates: list[dict] = []
    current: Optional[dict] = None
    requests: dict[str, datetime] = {}
    for at, component, message, fields in parsed:
        for mark, mark_component, pattern in _BACKEND_MARKS:
            found = pattern.search(message) if component == mark_component else None
            if found is None:
                continue
            groups = found.groupdict()
            if mark == "request":
                if groups["agent"] in wanted:
                    requests.setdefault(groups["agent"], at)
            elif mark == "create_start":
                current = None
                if groups["agent"] in wanted:
                    current = {"agentId": groups["agent"], "_marks": {"create_start": at}}
                    if groups["agent"] in requests:
                        current["_marks"]["request"] = requests.pop(groups["agent"])
            elif current is not None:
                current["_marks"].setdefault(mark, at)
                if mark == "sandbox":
                    current.update(sandboxId=groups["sandbox"], resumedFrom=groups["from"])
                elif mark == "workspace":
                    current.update(projectId=fields.get("projectId"), checkoutSource=fields.get("source"))
                elif mark == "preview":
                    current["previewStarted"] = "failed" not in message
                elif mark == "ready":
                    current["taskId"] = groups["task"]
                    creates.append(_finish_create(current))
                    current = None
            break
    return creates


def _finish_create(create: dict) -> dict:
    marks = create.pop("_marks")
    order = [name for name, _, _ in _BACKEND_MARKS if name in marks]
    phases: dict[str, float] = {}
    for previous, name in zip(order, order[1:]):
        phase = {"create_start": "slot_wait", "ready": "record"}.get(name, name)
        phases[phase] = round((marks[name] - marks[previous]).total_seconds() * 1000, 1)
    create["phases_ms"] = phases
    create["total_ms"] = round((marks[order[-1]] - marks[order[0]]).total_seconds() * 1000, 1)
    create["requestedAt"] = marks[order[0]].isoformat()
    return create


def _creates_for_spawn(spawn: dict, backend: list[dict]) -> list[dict]:
    """Backend creates this spawn caused: its agent's creates requested between its first
    worker create attempt and the worker's "Session created" (retries included)."""
    start, end = _iso(spawn.get("create_requested_at")), _iso(spawn.get("session_created_at"))
    if start is None or end is None:
        return [c for c in backend if c.get("taskId") == spawn["task_id"]]
    # Same host, but two writers: allow a second of skew at the window's start.
    return [
        c
        for c in backend
        if c.get("agentId") == spawn["agent_id"]
        and (at := _iso(c.get("requestedAt"))) is not None
        and start.timestamp() - 1 <= at.timestamp() <= end.timestamp()
    ]


def build_spawns(worker_entries: list[dict], backend: list[dict]) -> list[dict]:
    """One timeline per code-agent spawn, in order (worker clock).

    ``backend`` is the spawn's FIRST backend create (the one that built the
    sandbox and checkout); a create retried after a client timeout adds more
    creates to ``backend_creates`` and returns another create's task id.
    """
    spawns: dict[str, dict] = {}
    pending: dict[str, list[datetime]] = {}
    for entry in sorted(worker_entries, key=lambda e: e["_at"]):
        agent_id = str(entry.get("agent_id") or "")
        task_id = str(entry.get("task_id") or "")
        if entry["event"] == WORKER_CREATE:
            pending.setdefault(agent_id, []).append(entry["_at"])
            continue
        if entry["event"] == WORKER_CREATED and task_id:
            attempts = pending.pop(agent_id, [])
            spawns.setdefault(
                task_id,
                {
                    "task_id": task_id,
                    "agent_id": agent_id,
                    "create_requested_at": attempts[0] if attempts else None,
                    "create_attempts": len(attempts),
                    "session_created_at": entry["_at"],
                },
            )
            continue
        spawn = spawns.get(task_id)
        if spawn is None:
            continue
        event_type = entry.get("event_type")
        if event_type == "session" and entry.get("status") == "starting":
            spawn.setdefault("cli_launch_at", entry["_at"])
        elif event_type == "session" and entry.get("status") is None:
            spawn.setdefault("cli_ready_at", entry["_at"])
        elif event_type == "agent_message":
            spawn.setdefault("first_output_at", entry["_at"])
    ordered = sorted(spawns.values(), key=lambda s: s["session_created_at"])
    for spawn in ordered:
        for key, value in list(spawn.items()):
            if isinstance(value, datetime):
                # Run records are JSON: keep ISO strings, as the logs carry them.
                spawn[key] = value.isoformat()
        creates = _creates_for_spawn(spawn, backend)
        spawn["backend_creates"] = len(creates)
        if creates:
            spawn["backend"] = creates[0]
    return ordered


def _metadata(message: dict) -> dict:
    metadata = message.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            return {}
    return metadata if isinstance(metadata, dict) else {}


def spawn_calls_by_agent(data: dict, agent_ids: list[str]) -> dict[str, list[str]]:
    """Distinct spawn_claude_code_agent tool calls (toolCallId) each tree agent made."""
    tree = (data.get("_benchmark") or {}).get("tree") or {}
    sources = {aid: (tree.get(aid) or {}).get("messages") for aid in agent_ids}
    if agent_ids and not isinstance(sources.get(agent_ids[0]), list):
        sources[agent_ids[0]] = data.get("messages") or []
    calls: dict[str, list[str]] = {}
    for aid, messages in sources.items():
        seen: list[str] = []
        for message in messages or []:
            metadata = _metadata(message) if isinstance(message, dict) else {}
            call_id = metadata.get("toolCallId")
            if metadata.get("toolName") == SPAWN_TOOL and isinstance(call_id, str) and call_id not in seen:
                seen.append(call_id)
        calls[aid] = seen
    return calls


def sessions_by_agent(sessions: Iterable[Any]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for session in sessions:
        if isinstance(session, dict) and session.get("agentId"):
            row = {k: session.get(k) for k in ("id", "sandboxId", "status", "createdAt")}
            grouped.setdefault(str(session["agentId"]), []).append(row)
    return grouped


def _environment(base_url: Optional[str]) -> str:
    host = (urlparse(base_url or "").hostname or "").lower()
    return "local" if host in {"localhost", "127.0.0.1", "::1", ""} else "prod"


def record_startup_spans(benchmark: str, spawns: list[dict], *, environment: str) -> int:
    from benchmarks.span_history import make_observation, record_span_observations

    observations = []
    for spawn in spawns:
        for phase, ms in startup_time.spawn_phases(spawn).items():
            observations.append(
                make_observation(
                    agent_id=spawn["agent_id"],
                    benchmark=benchmark,
                    environment=environment,
                    span_key=f"{SPAN_KEY_PREFIX}{phase}",
                    span_name=phase,
                    duration_ms=ms,
                    source="code_agent_startup",
                    task_id=spawn["task_id"],
                )
            )
    return record_span_observations(observations) if observations else 0


def _agent_ids(data: dict) -> list[str]:
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root = str(agent.get("agent_id") or agent.get("agentId") or agent.get("id") or "").strip()
    ids = [root] if root else []
    for node in (data.get("_benchmark") or {}).get("all_agents") or []:
        if isinstance(node, dict):
            aid = str(node.get("agent_id") or node.get("id") or "").strip()
            if aid and aid not in ids:
                ids.append(aid)
    return ids


async def collect(data: dict, *, benchmark: str, base_url: Optional[str]) -> dict:
    from benchmarks.run_benchmark import _hydrate_claude_code_sessions

    agent_ids = _agent_ids(data)
    worker_lines: list[str] = []
    for agent_id in agent_ids:
        worker_lines.extend(fetch_local_worker_logs(agent_id))
    backend_lines = fetch_local_backend_log_lines(BACKEND_NEEDLES)
    creates = backend_creates(backend_lines, agent_ids)
    spawns = build_spawns(_worker_entries(worker_lines), creates)
    recorded = record_startup_spans(benchmark, spawns, environment=_environment(base_url))
    await _hydrate_claude_code_sessions(data)
    state = data.get("_benchmark") or {}
    return {
        "agent_ids": agent_ids,
        "spawns": spawns,
        "backend_creates": creates,
        "spawn_calls_by_agent": spawn_calls_by_agent(data, agent_ids),
        "sessions_by_agent": sessions_by_agent(state.get("claude_code_sessions") or []),
        "sources": {
            "worker_lines": len(worker_lines),
            "backend_lines": len(backend_lines),
            "backend_creates": len(creates),
            "span_observations_recorded": recorded,
            "session_evidence_error": state.get("claude_code_session_evidence_error"),
        },
    }
