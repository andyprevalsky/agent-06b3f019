#!/usr/bin/env python3
"""Agent latency tracer — span-based causal tree for a single agent_id.

Root of the tree is the /agents worker (originator of every code path).
Everything the worker does — deeper agent functions, HTTP requests into
the backend, sub-agent spawns, DB queries, broadcasts, research-side
completions — hangs off it.

Primary signal: `span.start` / `span.end` / `db.query` / `broadcast.span`
events emitted by the tracing instrumentation in:
  - agents/helpers/tracing.py (worker, contextvars-based)
  - back-end/src/providers/tracing.ts (backend, AsyncLocalStorage-based)
  - back-end/src/providers/database.ts (Prisma $extends hook)
  - back-end/src/providers/chat/supabaseBroadcast.ts (fetch wrapper)

Tree is built from span_id / parent_span_id. When those are absent
(legacy events or uninstrumented code paths), we fall back to
time-window containment + request_id correlation.

USAGE — LOCAL (full span depth: worker + backend + research)

  python benchmarks/agent_latency.py <agent_id>           # summary + hot paths
  python benchmarks/agent_latency.py <agent_id> -v        # fully expanded tree

  Reads: navi-worker-log.txt, backend-logs.log, research-logs.log

USAGE — PROD (full depth when retained ClickHouse worker logs are available)

  # Post-hoc (uses ClickHouse retained worker logs when CLICKHOUSE_* is set):
  python benchmarks/agent_latency.py <agent_id> --url https://navi-j9a9.onrender.com

  # Live fallback/additional stream during benchmark:
  python benchmarks/agent_latency.py <agent_id> --url https://navi-j9a9.onrender.com --fly-stream 300

  Fetches: Render API (backend), ClickHouse (retained worker), Fly.io flyctl (live stream)
  Requires: RENDER_API_KEY in back-end/.env, CLICKHOUSE_* and/or FLY_API_TOKEN in agents/.env

SPAN DEPTH COMPARISON

  Local:  worker(run_agent → execute_iteration → call_llm_activity) → backend(http.request → db.query)
  Prod:   worker + backend when ClickHouse retained logs or --fly-stream are available

Flags:
  -v, --verbose          Expand every span (sub-agents, DB, broadcasts, HTTP internals).
  --speedscope OUT       Emit speedscope.app evented profile (browser flame graph).
  --stall-threshold N    Seconds of idle time to annotate (default 5).
  --slow-threshold N     Milliseconds above which a span is counted as "bad" (default 300).
  --no-color             Disable ANSI colors.
  --url URL              Prod mode: fetch logs from Render, ClickHouse, and Fly.io.
  --fly-stream SECONDS   Stream Fly.io worker logs for N seconds (use during live benchmarks).
"""

from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKER_LOG = os.path.join(REPO_ROOT, "agents", "navi-worker-log.txt")
BACKEND_LOG = os.path.join(REPO_ROOT, "back-end", "backend-logs.log")
RESEARCH_LOG = os.path.join(REPO_ROOT, "research", "research-logs.log")

# Isolated benchmark stacks (scripts/run-bench --local, run-predeploy-local) do
# NOT write to the shared logs above: each run gets its own
# .context/benchmarks/<run-id>/logs/{backend,worker.N}.log. Every /deploy smoke
# failure therefore lives ONLY in a per-run directory, and reading just the
# shared paths made this tool report "No log lines found" for exactly the
# failures it exists to explain. Consider both, newest isolated runs first.
ISOLATED_STACK_ROOT = os.path.join(REPO_ROOT, ".context", "benchmarks")
MAX_ISOLATED_STACKS = int(os.getenv("AGENT_LATENCY_MAX_ISOLATED_STACKS", "3"))

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchmarks.logs import (
    FlyLogCollector,
    fetch_clickhouse_worker_logs,
    load_env_var,
)
from benchmarks.span_history import make_observation, record_span_observations
from benchmarks.span_history import summary as span_history_summary

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

AGENTS_SRC = os.path.join(REPO_ROOT, "agents")
BACKEND_SRC = os.path.join(REPO_ROOT, "back-end", "src")

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Span:
    """A single traced operation. Built from paired span.start/span.end events
    or synthesized from point events (HTTP lines, LLM markers, etc.)."""

    span_id: str
    parent_span_id: Optional[str]
    name: str                       # span_name (e.g. "call_llm_activity", "http.request", "db.query")
    source: str                     # "worker" | "backend" | "research"
    start: datetime
    end: Optional[datetime]
    agent_id: str = ""
    request_id: Optional[str] = None
    status: str = "ok"              # "ok" | "error"
    metadata: Dict[str, Any] = field(default_factory=dict)
    children: List["Span"] = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        if self.end is None:
            return 0
        return int((self.end - self.start).total_seconds() * 1000)

    @property
    def duration_s(self) -> float:
        return self.duration_ms / 1000.0


# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------


def parse_ts(s: str) -> datetime:
    s = s.replace("Z", "+00:00")
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# Worker log parsing (JSONL structlog)
# ---------------------------------------------------------------------------


@dataclass
class _RawEvent:
    ts: datetime
    source: str
    event: str
    data: Dict[str, Any]


def isolated_stack_log_dirs() -> List[str]:
    """Per-run log dirs for isolated benchmark stacks, newest first.

    BENCHMARK_CONTEXT_DIR pins one run when the caller already knows it;
    otherwise the most recent runs are scanned. Events are filtered by agent id
    downstream, so scanning extra runs costs parse time, never correctness.
    """
    dirs: List[str] = []
    explicit = os.getenv("BENCHMARK_CONTEXT_DIR", "").strip()
    if explicit:
        pinned = os.path.join(explicit, "logs")
        if os.path.isdir(pinned):
            dirs.append(pinned)
    if os.path.isdir(ISOLATED_STACK_ROOT):
        candidates = []
        for name in os.listdir(ISOLATED_STACK_ROOT):
            log_dir = os.path.join(ISOLATED_STACK_ROOT, name, "logs")
            if os.path.isdir(log_dir) and log_dir not in dirs:
                candidates.append(log_dir)
        candidates.sort(key=os.path.getmtime, reverse=True)
        dirs.extend(candidates[:MAX_ISOLATED_STACKS])
    return dirs


def _log_paths(shared: str, isolated_glob: str, env_var: str) -> List[str]:
    """Resolve an explicit runner-provided log set or discover recent stacks."""
    raw = os.environ.get(env_var, "").strip()
    if raw:
        patterns = [part.strip() for part in raw.replace(os.pathsep, ",").split(",") if part.strip()]
        explicit: List[str] = []
        for pattern in patterns:
            matches = sorted(glob.glob(pattern)) if glob.has_magic(pattern) else [pattern]
            explicit.extend(path for path in matches if path not in explicit)
        if explicit:
            return explicit

    paths = [shared] if os.path.exists(shared) else []
    for log_dir in isolated_stack_log_dirs():
        paths.extend(sorted(glob.glob(os.path.join(log_dir, isolated_glob))))
    return paths


def _read_worker_raw() -> List[_RawEvent]:
    out: List[_RawEvent] = []
    # An isolated stack runs several worker processes, each with its own file.
    for path in _log_paths(WORKER_LOG, "worker*.log", "NAVI_WORKER_LOGS"):
        if not os.path.exists(path):
            continue
        with open(path, errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts_str = d.get("timestamp")
                if not ts_str:
                    continue
                out.append(_RawEvent(parse_ts(ts_str), "worker", d.get("event", ""), d))
    out.sort(key=lambda event: event.ts)
    return out


def _read_backend_raw() -> List[_RawEvent]:
    out: List[_RawEvent] = []
    # [2026-04-17T21:07:35.352Z] INFO [HTTP] message key=value key=value
    head = re.compile(
        r"\[(?P<ts>[^\]]+)\]\s+(?P<level>\w+)\s+\[(?P<comp>[^\]]+)\]\s+(?P<rest>.*)"
    )
    for path in _log_paths(BACKEND_LOG, "backend*.log", "NAVI_BACKEND_LOGS"):
        if not os.path.exists(path):
            continue
        out.extend(_parse_backend_lines(path, head))
    out.sort(key=lambda event: event.ts)
    return out


def _parse_backend_lines(path: str, head: "re.Pattern[str]") -> List[_RawEvent]:
    out: List[_RawEvent] = []
    with open(path, errors="replace") as f:
        for raw in f:
            line = ANSI_RE.sub("", raw).rstrip("\n")
            m = head.match(line)
            if not m:
                continue
            ts = parse_ts(m.group("ts"))
            rest = m.group("rest")
            # First token (before a space followed by `key=`) is the message;
            # the remainder is k=v pairs.
            mm = re.match(r"(?P<msg>.*?)(?=\s+\w+=)(?P<kv>.*)$", rest)
            if mm:
                msg = mm.group("msg").strip()
                kv_str = mm.group("kv")
            else:
                msg = rest.strip()
                kv_str = ""
            data: Dict[str, Any] = {
                "level": m.group("level"),
                "component": m.group("comp"),
                "message": msg,
            }
            # Extract k=value pairs (greedy value until next `\s\w+=` or EOL)
            for km in re.finditer(r"(\w+)=((?:(?!\s+\w+=).)+)", kv_str):
                data[km.group(1)] = km.group(2).strip()
            out.append(_RawEvent(ts, "backend", msg, data))
    return out


def _read_research_raw() -> List[_RawEvent]:
    if not os.path.exists(RESEARCH_LOG):
        return []
    out: List[_RawEvent] = []
    tail = re.compile(r"(\{.*\})$")
    with open(RESEARCH_LOG, errors="replace") as f:
        for raw in f:
            line = ANSI_RE.sub("", raw).strip()
            m = tail.search(line)
            if not m:
                continue
            try:
                d = json.loads(m.group(1))
            except json.JSONDecodeError:
                continue
            ts_str = d.get("timestamp")
            if not ts_str:
                continue
            out.append(_RawEvent(parse_ts(ts_str), "research", d.get("message", ""), d))
    return out


# ---------------------------------------------------------------------------
# Sub-agent discovery (backend POST /api/agents with parent_agent_id)
# ---------------------------------------------------------------------------


def _discover_sub_agent_ids(backend_raw: List[_RawEvent], root_id: str) -> Set[str]:
    """Transitively discover sub-agent ids spawned under root by scanning
    `POST /api/agents` requests and any log lines that mention
    parent_agent_id=<ancestor>."""
    children: Dict[str, Set[str]] = defaultdict(set)

    for e in backend_raw:
        parent: Optional[str] = None

        # Prefer parsed structured key (e.g. from backend JSON log): reliably
        # present when a request's body has been decoded into e.data already.
        raw_parent = e.data.get("parent_agent_id")
        if isinstance(raw_parent, str) and UUID_RE.fullmatch(raw_parent):
            parent = raw_parent
        else:
            body = e.data.get("body", "") or e.data.get("message", "")
            if body and "parent_agent_id" in body:
                parent_m = re.search(r'"parent_agent_id"\s*:\s*"([0-9a-f-]{36})"', body)
                if parent_m:
                    parent = parent_m.group(1)

        if not parent:
            continue

        # Any co-occurring UUIDs (either in structured fields or free text) are
        # candidate child ids for that parent.
        candidates: Set[str] = set()
        body = e.data.get("body", "") or e.data.get("message", "")
        if body:
            candidates.update(UUID_RE.findall(body))
        for key in ("id", "agent_id"):
            v = e.data.get(key)
            if isinstance(v, str) and UUID_RE.fullmatch(v):
                candidates.add(v)
        for uid in candidates:
            if uid != parent:
                children[parent].add(uid)

    # BFS from root
    discovered: Set[str] = set()
    frontier = {root_id}
    while frontier:
        new_frontier: Set[str] = set()
        for pid in frontier:
            for cid in children.get(pid, set()):
                if cid not in discovered and cid != root_id:
                    discovered.add(cid)
                    new_frontier.add(cid)
        frontier = new_frontier
    return discovered


# ---------------------------------------------------------------------------
# Filter raw events to a set of agent_ids
# ---------------------------------------------------------------------------


def _event_agent_id(e: _RawEvent) -> str:
    aid = e.data.get("agent_id") or e.data.get("agentId")
    if aid:
        return str(aid)
    # Backend HTTP: look for /api/agents/<uuid> in path
    path = e.data.get("path")
    if path:
        m = UUID_RE.search(str(path))
        if m:
            return m.group(0)
    # Backend log lines that have `agent_id=<uuid>` embedded. Also pick up
    # parent_agent_id so legacy spawn POSTs (which only carry the parent id)
    # attach to the trace — mirrors _discover_sub_agent_ids.
    for k in ("workflowId", "agent_id", "parent_agent_id", "parentAgentId"):
        v = e.data.get(k)
        if v and UUID_RE.match(str(v)):
            return str(v)
    return ""


def _filter_by_agents(events: List[_RawEvent], ids: Set[str]) -> List[_RawEvent]:
    return [e for e in events if _event_agent_id(e) in ids]


# ---------------------------------------------------------------------------
# Span construction
# ---------------------------------------------------------------------------


def _as_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(str(v).replace("ms", "").strip())
    except (ValueError, TypeError):
        return None


def _as_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace("%", "").strip())
    except (ValueError, TypeError):
        return None


def _build_spans_from_events(events: List[_RawEvent]) -> Tuple[List[Span], List[_RawEvent]]:
    """Build Spans from span.start/span.end pairs + point events (db.query,
    broadcast.span). Returns (spans, leftover_events) where leftover_events
    are un-paired raw events (used later for legacy fallback extraction)."""
    spans: List[Span] = []
    leftover: List[_RawEvent] = []

    # Pair span.start with span.end by span_id
    open_starts: Dict[str, _RawEvent] = {}
    for e in events:
        ev_name = e.event
        if ev_name == "span.start":
            sid = str(e.data.get("span_id", ""))
            if sid:
                open_starts[sid] = e
            continue
        if ev_name == "span.end":
            sid = str(e.data.get("span_id", ""))
            start_ev = open_starts.pop(sid, None)
            if start_ev is None:
                # Dangling end — synthesize zero-width
                spans.append(
                    Span(
                        span_id=sid or f"orphan-{id(e)}",
                        parent_span_id=e.data.get("parent_span_id"),
                        name=str(e.data.get("span_name", "<unknown>")),
                        source=e.source,
                        start=e.ts,
                        end=e.ts,
                        agent_id=_event_agent_id(e),
                        request_id=e.data.get("request_id"),
                        status=str(e.data.get("status", "ok")),
                        metadata={k: v for k, v in e.data.items()
                                  if k not in {"span_name", "span_id", "parent_span_id",
                                               "timestamp", "event", "level", "component",
                                               "message"}},
                    )
                )
                continue
            spans.append(
                Span(
                    span_id=sid,
                    parent_span_id=start_ev.data.get("parent_span_id")
                    or e.data.get("parent_span_id"),
                    name=str(start_ev.data.get("span_name")
                             or e.data.get("span_name", "<unknown>")),
                    source=e.source,
                    start=start_ev.ts,
                    end=e.ts,
                    agent_id=_event_agent_id(start_ev) or _event_agent_id(e),
                    request_id=start_ev.data.get("request_id")
                    or e.data.get("request_id"),
                    status=str(e.data.get("status", "ok")),
                    metadata={k: v for k, v in {**start_ev.data, **e.data}.items()
                              if k not in {"span_name", "span_id", "parent_span_id",
                                           "timestamp", "event", "level", "component",
                                           "message"}},
                )
            )
            continue
        if ev_name == "db.query":
            dur = _as_int(e.data.get("duration_ms"))
            end = e.ts
            start = e.ts - timedelta(milliseconds=dur or 0)
            spans.append(
                Span(
                    span_id=f"db-{id(e)}",
                    parent_span_id=e.data.get("parent_span_id"),
                    name=f"db.{e.data.get('operation','?')}({e.data.get('model','?')})",
                    source=e.source,
                    start=start,
                    end=end,
                    agent_id=_event_agent_id(e),
                    request_id=e.data.get("request_id"),
                    status=str(e.data.get("status", "ok")),
                    metadata={"code_ptr": "back-end/src/providers/database.ts"},
                )
            )
            continue
        if ev_name == "broadcast.span":
            dur = _as_int(e.data.get("duration_ms"))
            end = e.ts
            start = e.ts - timedelta(milliseconds=dur or 0)
            spans.append(
                Span(
                    span_id=f"bc-{id(e)}",
                    parent_span_id=e.data.get("parent_span_id"),
                    name=f"broadcast:{e.data.get('event','?')}",
                    source=e.source,
                    start=start,
                    end=end,
                    agent_id=_event_agent_id(e),
                    request_id=e.data.get("request_id"),
                    status="error" if str(e.data.get("status")) == "error" else "ok",
                    metadata={"topic": e.data.get("topic"),
                              "code_ptr": "back-end/src/providers/chat/supabaseBroadcast.ts"},
                )
            )
            continue
        leftover.append(e)

    # Unclosed starts — emit with no end
    for sid, start_ev in open_starts.items():
        spans.append(
            Span(
                span_id=sid,
                parent_span_id=start_ev.data.get("parent_span_id"),
                name=str(start_ev.data.get("span_name", "<unknown>")) + " [NO-END]",
                source=start_ev.source,
                start=start_ev.ts,
                end=None,
                agent_id=_event_agent_id(start_ev),
                request_id=start_ev.data.get("request_id"),
                status="unclosed",
                metadata={k: v for k, v in start_ev.data.items()
                          if k not in {"span_name", "span_id", "parent_span_id",
                                       "timestamp", "event", "level", "component",
                                       "message"}},
            )
        )

    return spans, leftover


# ---------------------------------------------------------------------------
# Legacy fallback extractors (for events that haven't been instrumented yet)
# ---------------------------------------------------------------------------


def _legacy_worker_llm_spans(events: List[_RawEvent]) -> List[Span]:
    """Reconstruct LLM call spans from the old `Streaming Rose model …` /
    `Rose streaming complete …` markers when no span.* events are available."""
    pending: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    last_start_by_agent: Dict[str, Dict[str, Any]] = {}
    out: List[Span] = []

    for e in events:
        if e.source != "worker":
            continue
        ev = e.event
        aid = _event_agent_id(e)
        if "Streaming Rose model" in ev:
            model_m = re.search(r"Streaming Rose model[^:]*:\s*(\S+)", ev)
            cs_m = re.search(r"\[([a-z_]+)\]", ev)
            rid_m = re.search(r"\[([0-9a-f]{8})\]", ev)
            info = {
                "start": e.ts,
                "model": model_m.group(1) if model_m else "?",
                "actual_model": None,
                "ttft_ms": None,
                "chunks": None,
                "call_site": cs_m.group(1) if cs_m else "?",
                "rid": rid_m.group(1) if rid_m else None,
                "agent_id": aid,
            }
            pending[(aid, info["call_site"])].append(info)
            last_start_by_agent[aid] = info
        elif ev.startswith("⏱️ Rose structured TTFT"):
            info = last_start_by_agent.get(aid)
            m = re.search(r"(\d+)ms", ev)
            if info and m:
                info["ttft_ms"] = int(m.group(1))
        elif ev.startswith("🎯 Rose model selected"):
            info = last_start_by_agent.get(aid)
            m = re.search(r"selected:\s*(\S+)", ev)
            if info and m:
                info["actual_model"] = m.group(1)
        elif "Rose streaming complete" in ev:
            cs_m = re.search(r"\[([a-z_]+)\]", ev)
            cs = cs_m.group(1) if cs_m else "?"
            queue = pending.get((aid, cs))
            if not queue:
                continue
            info = queue.pop(0)
            chunks_m = re.search(r"received (\d+) chunks", ev)
            if chunks_m:
                info["chunks"] = int(chunks_m.group(1))
            out.append(
                Span(
                    span_id=f"llm-legacy-{id(e)}",
                    parent_span_id=None,
                    name=f"llm[{info['call_site']}]",
                    source="worker",
                    start=info["start"],
                    end=e.ts,
                    agent_id=aid,
                    request_id=info["rid"],
                    status="ok",
                    metadata={"model": info["model"], "actual_model": info["actual_model"],
                              "ttft_ms": info["ttft_ms"], "chunks": info["chunks"],
                              "call_site": info["call_site"],
                              "legacy": True},
                )
            )
    # Unclosed
    for queue in pending.values():
        for info in queue:
            out.append(
                Span(
                    span_id=f"llm-legacy-open-{id(info)}",
                    parent_span_id=None,
                    name=f"llm[{info['call_site']}] [NO-END]",
                    source="worker",
                    start=info["start"],
                    end=None,
                    agent_id=info["agent_id"],
                    request_id=info["rid"],
                    status="unclosed",
                    metadata={"model": info["model"], "call_site": info["call_site"],
                              "legacy": True, "actual_model": info["actual_model"],
                              "ttft_ms": info["ttft_ms"], "chunks": info["chunks"]},
                )
            )
    return out


def _legacy_backend_http_spans(events: List[_RawEvent]) -> List[Span]:
    """Synthesize HTTP spans from legacy `[HTTP] METHOD /path -> STATUS` lines
    when span.* events aren't available."""
    out: List[Span] = []
    for e in events:
        if e.source != "backend":
            continue
        if e.data.get("component") != "HTTP":
            continue
        msg = e.data.get("message", "")
        m = re.match(r"(\w+)\s+(\S+)\s+->\s+(\d+)", msg)
        if not m:
            continue
        dur = _as_int(e.data.get("duration_ms"))
        end = e.ts
        start = e.ts - timedelta(milliseconds=dur or 0)
        out.append(
            Span(
                span_id=f"http-legacy-{id(e)}",
                parent_span_id=None,
                name=f"http {m.group(1)} {m.group(2).split('?')[0]}",
                source="backend",
                start=start,
                end=end,
                agent_id=_event_agent_id(e),
                request_id=e.data.get("request_id"),
                status="error" if int(m.group(3)) >= 400 else "ok",
                metadata={"method": m.group(1), "path": m.group(2),
                          "status_code": int(m.group(3)), "legacy": True,
                          "code_ptr": "back-end/src/routes/*"},
            )
        )
    return out


def _legacy_worker_spawn_spans(events: List[_RawEvent]) -> List[Span]:
    """Reconstruct spawn windows from [spawn_agent] Starting / Finished
    when no span.* events exist (these also bound sub-agent trees)."""
    pending: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    out: List[Span] = []
    for e in events:
        if e.source != "worker":
            continue
        ev = e.event
        aid = _event_agent_id(e)
        if ev.startswith("[spawn_agent] Starting"):
            m = re.match(r"\[spawn_agent\] Starting type=(\w+), goal=(.+)", ev)
            pending[aid].append({
                "start": e.ts,
                "type": m.group(1) if m else "?",
                "goal": m.group(2)[:200] if m else "?",
            })
        elif ev.startswith("[spawn_agent] Finished"):
            q = pending.get(aid)
            if not q:
                continue
            info = q.pop(0)
            out.append(
                Span(
                    span_id=f"spawn-legacy-{id(info)}",
                    parent_span_id=None,
                    name=f"spawn({info['type']})",
                    source="worker",
                    start=info["start"],
                    end=e.ts,
                    agent_id=aid,
                    status="ok",
                    metadata={"goal": info["goal"], "legacy": True,
                              "code_ptr": "agents/tools/spawn_agent.py"},
                )
            )
    return out


def _research_event_spans(events: List[_RawEvent]) -> List[Span]:
    """Research-side events become point-width spans attached to their
    request_id so the LLM parent picks them up."""
    out: List[Span] = []
    for e in events:
        if e.source != "research":
            continue
        msg = e.event
        rid = e.data.get("request_id")
        if not rid:
            continue
        kind = "rsch.info"
        if msg == "REQUEST START":
            kind = "rsch.start"
        elif "Validating API key" in msg:
            kind = "rsch.auth"
        elif "API key validated" in msg:
            kind = "rsch.auth.ok"
        elif "Chat completion request" in msg:
            kind = "rsch.dispatch"
        elif "Claude token present" in msg:
            kind = "rsch.claude_direct"
        elif "Request to" in msg:
            kind = "rsch.race"
        elif "502" in msg or "timeout" in msg.lower() or "error" in msg.lower():
            kind = "rsch.error"
        out.append(
            Span(
                span_id=f"rsch-{id(e)}",
                parent_span_id=None,
                name=kind,
                source="research",
                start=e.ts,
                end=e.ts,
                agent_id=_event_agent_id(e),
                request_id=str(rid),
                status="error" if kind == "rsch.error" else "ok",
                metadata={"message": msg[:200]},
            )
        )
    return out


# ---------------------------------------------------------------------------
# Tree assembly: link spans via span_id, request_id, and time containment
# ---------------------------------------------------------------------------


def _assemble_tree(spans: List[Span]) -> List[Span]:
    """Link spans into a parent/child tree. Order of precedence:
      1. parent_span_id (authoritative)
      2. request_id match to an enclosing LLM span (for research events)
      3. Time-window containment (shortest enclosing span wins)
    """
    by_id: Dict[str, Span] = {s.span_id: s for s in spans}
    roots: List[Span] = []

    # Clear any stale children (in case called twice)
    for s in spans:
        s.children = []

    # Pass 1 — authoritative parent_span_id
    unplaced: List[Span] = []
    for s in spans:
        psid = s.parent_span_id
        if psid and psid in by_id:
            by_id[psid].children.append(s)
        else:
            unplaced.append(s)

    # Pass 2 — research events hang off matching LLM span by request_id
    rid_buckets: Dict[str, List[Span]] = defaultdict(list)
    for s in spans:
        if s.request_id and (s.name.startswith("llm") or s.name == "call_llm_activity"
                             or s.name == "call_llm" or s.name == "call_planner_llm_activity"):
            rid_buckets[s.request_id].append(s)

    still_unplaced: List[Span] = []
    for s in unplaced:
        if s.source == "research" and s.request_id and s.request_id in rid_buckets:
            llm_candidates = rid_buckets[s.request_id]
            # Pick the LLM span whose window contains s.start
            match = next(
                (llm for llm in llm_candidates
                 if llm.start <= s.start and (llm.end is None or s.start <= llm.end)),
                None,
            )
            if match is None and llm_candidates:
                match = min(llm_candidates, key=lambda x: abs((x.start - s.start).total_seconds()))
            if match is not None:
                match.children.append(s)
                continue
        still_unplaced.append(s)

    # Pass 3 — time containment (shortest enclosing span wins). This mostly
    # attaches legacy backend HTTP spans to the worker LLM/spawn that
    # triggered them, and sub-agent spans to their parent's spawn() window.
    sorted_by_start = sorted(
        [s for s in spans if s.end is not None],
        key=lambda s: (s.start, -(s.end - s.start).total_seconds() if s.end else 0),
    )

    def _enclose(sp: Span) -> Optional[Span]:
        best: Optional[Span] = None
        best_width = None
        for cand in sorted_by_start:
            if cand is sp:
                continue
            if cand.end is None:
                continue
            if cand.start > sp.start:
                break
            if cand.end < sp.start:
                continue
            # cand encloses sp.start; must also enclose end
            sp_end = sp.end or sp.start
            if cand.end < sp_end:
                continue
            w = (cand.end - cand.start).total_seconds()
            if best is None or (best_width is not None and w < best_width):
                best = cand
                best_width = w
        return best

    for s in still_unplaced:
        parent = _enclose(s)
        if parent is not None and parent is not s:
            parent.children.append(s)
        else:
            roots.append(s)

    # De-duplicate root list (child may have been added multiple times)
    seen: Set[int] = set()
    unique_roots: List[Span] = []
    for r in roots:
        if id(r) in seen:
            continue
        seen.add(id(r))
        unique_roots.append(r)

    # Sort children recursively
    def _sort(s: Span) -> None:
        s.children.sort(key=lambda c: c.start)
        for c in s.children:
            _sort(c)

    for r in unique_roots:
        _sort(r)

    unique_roots.sort(key=lambda s: s.start)
    return unique_roots


# ---------------------------------------------------------------------------
# Code pointer resolution
# ---------------------------------------------------------------------------


def _find_code_pointer(name: str, cache: Dict[str, str]) -> str:
    """Map span_name → 'repo/path:line'. Cached. Covers @traced("x"),
    span("x"), sync_span("x"), withSpan("x"), and top-level file matches."""
    if name in cache:
        return cache[name]
    bare = name.split("[")[0].split("(")[0].strip()
    pointer = ""

    # Known built-ins
    known = {
        "http.request": "back-end/src/providers/tracing.ts:81",
        "db.query": "back-end/src/providers/database.ts:58",
        "broadcast.span": "back-end/src/providers/chat/supabaseBroadcast.ts:205",
    }
    if bare in known:
        cache[name] = known[bare]
        return known[bare]
    if bare.startswith("db."):
        cache[name] = "back-end/src/providers/database.ts:58"
        return cache[name]
    if bare.startswith("broadcast"):
        cache[name] = "back-end/src/providers/chat/supabaseBroadcast.ts:205"
        return cache[name]
    if bare.startswith("http"):
        cache[name] = "back-end/src/providers/tracing.ts:81"
        return cache[name]

    # Grep the agents tree first, then backend
    patterns = [
        f'@traced("{bare}")',
        f"@traced('{bare}')",
        f'span("{bare}"',
        f"span('{bare}'",
        f'sync_span("{bare}"',
        f'withSpan("{bare}"',
        f"withSpan('{bare}'",
    ]
    for root in (AGENTS_SRC, BACKEND_SRC):
        for pat in patterns:
            hit = _grep_first(root, pat)
            if hit:
                pointer = hit
                break
        if pointer:
            break
    cache[name] = pointer
    return pointer


_GREP_EXTS = {".py", ".ts", ".tsx"}


def _grep_first(root: str, needle: str) -> str:
    """Return 'relpath:line' of first occurrence of `needle` under `root`."""
    for dirpath, _, filenames in os.walk(root):
        # Skip heavy dirs
        base = os.path.basename(dirpath)
        if base in {"node_modules", "venv", "dist", "build", "__pycache__",
                    ".next", ".git", "coverage"}:
            continue
        for fn in filenames:
            if os.path.splitext(fn)[1] not in _GREP_EXTS:
                continue
            full = os.path.join(dirpath, fn)
            try:
                with open(full, errors="replace") as f:
                    for lineno, line in enumerate(f, 1):
                        if needle in line:
                            rel = os.path.relpath(full, REPO_ROOT)
                            return f"{rel}:{lineno}"
            except OSError:
                continue
    return ""


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


SRC_COLOR = {
    "worker": "\x1b[38;5;33m",
    "backend": "\x1b[38;5;34m",
    "research": "\x1b[38;5;172m",
}
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RED = "\x1b[1;38;5;196m"
YELLOW = "\x1b[38;5;178m"
CYAN = "\x1b[38;5;45m"
RESET = "\x1b[0m"


def _use_color(no_color_flag: bool) -> bool:
    if no_color_flag or os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _c(s: str, code: str, enabled: bool) -> str:
    return f"{code}{s}{RESET}" if enabled and code else s


def _fmt_dur(ms: int) -> str:
    if ms >= 10_000:
        return f"{ms/1000:5.1f}s"
    if ms >= 1000:
        return f"{ms/1000:5.2f}s"
    return f"{ms:4d}ms "


def _fmt_offset(seconds: float) -> str:
    return f"t+{seconds:7.2f}s"


def _fmt_mb_from_bytes(value: int | float) -> str:
    return f"{value / (1024 * 1024):.1f}MB"


def _flatten(roots: List[Span]) -> List[Span]:
    out: List[Span] = []
    def walk(s: Span) -> None:
        out.append(s)
        for c in s.children:
            walk(c)
    for r in roots:
        walk(r)
    return out


def _summarize_span(sp: Span) -> str:
    md = sp.metadata or {}
    runtime = md.get("runtime_context") if isinstance(md.get("runtime_context"), dict) else {}
    parts: List[str] = []
    queue_ms = _as_int(md.get("temporal_schedule_to_start_ms"))
    if queue_ms and queue_ms >= 1000:
        parts.append(f"queue={_fmt_dur(queue_ms).strip()}")
        slots_used = _as_int(md.get("worker_activity_slots_used_at_activity_start"))
        slots_available = _as_int(md.get("worker_activity_slots_available_at_activity_start"))
        capacity = _as_int(md.get("worker_observed_task_capacity_at_activity_start"))
        backlog = _as_int(md.get("worker_task_queue_backlog_at_activity_start"))
        workflows = _as_int(md.get("worker_running_workflow_count_at_activity_start"))
        activity_pollers = _as_int(md.get("worker_activity_task_pollers_at_activity_start"))
        cpu_usage = _as_float(md.get("worker_resource_slots_cpu_usage_at_activity_start"))
        mem_usage = _as_float(md.get("worker_resource_slots_mem_usage_at_activity_start"))
        cpu_pid = _as_float(md.get("worker_resource_slots_cpu_pid_output_at_activity_start"))
        mem_pid = _as_float(md.get("worker_resource_slots_mem_pid_output_at_activity_start"))
        slot_bits = []
        if slots_used is not None:
            slot_bits.append(f"used={slots_used}")
        slot_bits.append(f"avail={slots_available if slots_available is not None else '?'}")
        slot_bits.append(f"capacity={capacity if capacity is not None else '?'}")
        if slot_bits:
            parts.append("slots(" + " ".join(slot_bits) + ")")
        if backlog is not None:
            parts.append(f"backlog={backlog}")
        if workflows is not None:
            parts.append(f"workflows={workflows}")
        if activity_pollers is not None:
            parts.append(f"activity_pollers={activity_pollers}")
        tuner_bits = []
        if cpu_usage is not None:
            tuner_bits.append(f"cpu={cpu_usage:.1f}%")
        if mem_usage is not None:
            tuner_bits.append(f"mem={mem_usage:.1f}%")
        if cpu_pid is not None:
            tuner_bits.append(f"cpu_pid={cpu_pid:.2f}")
        if mem_pid is not None:
            tuner_bits.append(f"mem_pid={mem_pid:.2f}")
        if tuner_bits:
            parts.append("tuner(" + " ".join(tuner_bits) + ")")
    if sp.name.startswith("llm") or "llm" in sp.name:
        if md.get("actual_model"):
            am = str(md["actual_model"])
            pool = md.get("model") or ""
            if pool and pool != am and "rose-" in str(pool):
                parts.append(f"pool={str(pool).replace('rose-labs/','')} → {am}")
            else:
                parts.append(am)
        elif md.get("model"):
            parts.append(str(md["model"]))
        elif runtime.get("model"):
            parts.append(str(runtime["model"]))
        if runtime.get("call_site") and not md.get("call_site"):
            parts.append(f"call_site={runtime['call_site']}")
        if md.get("ttft_ms"):
            parts.append(f"ttft={md['ttft_ms']}ms")
        if md.get("chunks"):
            parts.append(f"{md['chunks']} chunks")
    if runtime.get("phase"):
        parts.append(f"phase={runtime['phase']}")
    if runtime.get("agent_type"):
        parts.append(f"agent_type={runtime['agent_type']}")
    if runtime.get("tool_name") and not md.get("tool_name"):
        parts.append(f"tool={runtime['tool_name']}")
    mem_peak_delta = _as_int(md.get("memory_tree_rss_peak_delta_bytes"))
    if mem_peak_delta is not None and abs(mem_peak_delta) >= 1024 * 1024:
        parts.append(f"mem_peakΔ={_fmt_mb_from_bytes(mem_peak_delta)}")
    if sp.name.startswith("spawn"):
        if md.get("goal"):
            parts.append(f"goal={md['goal'][:100]}")
        if md.get("type"):
            parts.append(f"type={md['type']}")
    if sp.name.startswith("http"):
        if md.get("method") and md.get("path"):
            parts.append(f"{md['method']} {md['path']}")
        if md.get("status_code"):
            parts.append(f"→ {md['status_code']}")
    if sp.name.startswith("db."):
        if md.get("operation") and md.get("model"):
            parts.append(f"{md['model']}.{md['operation']}")
    if sp.name.startswith("broadcast"):
        if md.get("topic"):
            parts.append(str(md["topic"]))
    if sp.source == "research":
        if md.get("message"):
            parts.append(str(md["message"])[:120])
    if sp.request_id:
        parts.append(f"rid={sp.request_id}")
    if sp.status and sp.status != "ok":
        parts.append(f"status={sp.status}")
    return "  ".join(parts)


def _span_code_pointer(sp: Span, code_cache: Dict[str, str]) -> str:
    md = sp.metadata or {}
    return str(
        md.get("code_ptr")
        or md.get("span_source")
        or md.get("span_key")
        or _find_code_pointer(sp.name, code_cache)
    )


def _span_history_key(sp: Span) -> str:
    md = sp.metadata or {}
    return str(md.get("span_key") or md.get("span_source") or md.get("code_ptr") or sp.name)


def _span_runtime(sp: Span) -> Dict[str, Any]:
    runtime = sp.metadata.get("runtime_context") if isinstance(sp.metadata.get("runtime_context"), dict) else {}
    return runtime


def _span_observations(
    roots: List[Span],
    *,
    agent_id: str,
    benchmark: str,
    environment: str,
    timestamp: str,
    run_status: str,
) -> List[Dict[str, Any]]:
    observations: List[Dict[str, Any]] = []
    for sp in _flatten(roots):
        if sp.end is None or sp.duration_ms < 0:
            continue
        md = sp.metadata or {}
        runtime = _span_runtime(sp)
        observations.append(
            make_observation(
                agent_id=sp.agent_id or agent_id,
                benchmark=benchmark,
                environment=environment,
                span_key=_span_history_key(sp),
                span_name=sp.name,
                duration_ms=sp.duration_ms,
                timestamp=timestamp,
                run_status=run_status,
                span_source=md.get("span_source"),
                source=sp.source,
                status=sp.status,
                phase=runtime.get("phase"),
                agent_type=runtime.get("agent_type"),
                call_site=runtime.get("call_site") or md.get("call_site"),
                tool_name=runtime.get("tool_name") or md.get("tool_name"),
                model=runtime.get("model") or md.get("model") or md.get("actual_model"),
            )
        )
    return observations


def _span_baseline_map(
    observations: List[Dict[str, Any]],
    *,
    benchmark: str,
    environment: str,
    min_samples: int,
) -> Dict[str, Dict[str, Any]]:
    baselines: Dict[str, Dict[str, Any]] = {}
    for observation in observations:
        span_key = str(observation.get("span_key") or "")
        if not span_key or span_key in baselines:
            continue
        stats = span_history_summary(span_key, benchmark=benchmark, environment=environment)
        if stats and stats["count"] >= min_samples:
            baselines[span_key] = stats
    return baselines


# Spans must be at least this slow (absolute) AND past p95 to be flagged
# out-of-band — keeps the report focused on real anomalies, not sub-100ms noise.
_OUT_OF_BAND_FLOOR_MS = 100


def _out_of_band_ratio(sp: Span, stats: Dict[str, Any]) -> Optional[float]:
    """How far past the historical p95 this span ran, as a multiple.

    Returns None when there is no baseline, the span is within band, or the
    absolute duration is too small to be worth flagging (avoids noise on
    sub-100ms spans that trip p95 by a hair).
    """
    p95 = stats.get("p95_ms") or 0
    if not p95 or sp.duration_ms <= p95 or sp.duration_ms < _OUT_OF_BAND_FLOOR_MS:
        return None
    return sp.duration_ms / p95


def _format_span_baseline(sp: Span, baselines: Dict[str, Dict[str, Any]], color: bool) -> str:
    stats = baselines.get(_span_history_key(sp))
    if not stats:
        return ""
    ratio = _out_of_band_ratio(sp, stats)
    is_slow = ratio is not None
    marker = f"{_c(f'⚠ OUT-OF-BAND {ratio:.1f}× p95', RED, color)} " if is_slow else ""
    return _c(
        "  "
        + marker
        + "hist "
        + f"p50={_fmt_dur(int(stats['p50_ms'])).strip()} "
        + f"p90={_fmt_dur(int(stats['p90_ms'])).strip()} "
        + f"p95={_fmt_dur(int(stats['p95_ms'])).strip()} "
        + f"max={_fmt_dur(int(stats['max_ms'])).strip()} "
        + f"n={stats['count']}",
        DIM if not is_slow else "",
        color,
    )


# Lightweight spans that only appear in verbose mode
LIGHT_NAMES = {
    "db.query",            # legacy synth if any
    "broadcast.span",
}

def _is_light(sp: Span) -> bool:
    if sp.name.startswith("db."):
        return True
    if sp.name.startswith("broadcast"):
        return True
    return False


def _render_span(
    sp: Span,
    depth: int,
    t0: datetime,
    out: List[str],
    color: bool,
    stall_threshold: float,
    code_cache: Dict[str, str],
    span_baselines: Dict[str, Dict[str, Any]],
    verbose: bool,
    prev_end_by_depth: Dict[int, datetime],
) -> None:
    if not verbose and _is_light(sp):
        return

    offset = (sp.start - t0).total_seconds()
    indent = "  " * depth
    branch = "└─ " if depth > 0 else ""
    src = {"worker": "work", "backend": "back", "research": "rsch"}.get(sp.source, sp.source[:4])
    dur = _fmt_dur(sp.duration_ms)

    prev = prev_end_by_depth.get(depth)
    if prev is not None:
        gap = (sp.start - prev).total_seconds()
        if gap >= stall_threshold:
            gap_col = _c(f"{gap:.1f}s", RED if gap >= 10 else DIM, color)
            out.append(
                f"{_fmt_offset((prev - t0).total_seconds())}  "
                f"         {indent}{_c('⋯', DIM, color)} "
                f"{_c('IDLE', DIM, color)}  {gap_col}"
            )

    name_c = _c(sp.name, CYAN if sp.name.startswith("llm") or "llm" in sp.name else "", color)
    src_c = _c(src, SRC_COLOR.get(sp.source, ""), color)
    summary = _summarize_span(sp)
    status_suffix = ""
    if sp.status == "error":
        status_suffix = _c("  [ERR]", RED, color)
    elif sp.status == "unclosed":
        status_suffix = _c("  [NO-END]", RED, color)

    code_ptr = _span_code_pointer(sp, code_cache)
    ptr_s = _c(f"  @ {code_ptr}", DIM, color) if code_ptr else ""
    baseline_s = _format_span_baseline(sp, span_baselines, color)

    out.append(
        f"{_fmt_offset(offset)}  {dur}  "
        f"{indent}{branch}{src_c} {name_c}  {summary}{baseline_s}{status_suffix}{ptr_s}"
    )

    prev_end_by_depth[depth] = sp.end or sp.start
    inner = {k: v for k, v in prev_end_by_depth.items() if k <= depth}
    for child in sp.children:
        _render_span(child, depth + 1, t0, out, color, stall_threshold,
                     code_cache, span_baselines, verbose, inner)


# ---------------------------------------------------------------------------
# Critical-path extraction for executive summary
# ---------------------------------------------------------------------------


def _leaf_paths(roots: List[Span]) -> List[List[Span]]:
    paths: List[List[Span]] = []
    def walk(s: Span, cur: List[Span]) -> None:
        cur = cur + [s]
        if not s.children:
            paths.append(cur)
            return
        for c in s.children:
            walk(c, cur)
    for r in roots:
        walk(r, [])
    return paths


def _top_bad_paths(
    roots: List[Span],
    code_cache: Dict[str, str],
    n: int = 10,
) -> List[Tuple[int, List[Span]]]:
    """Return top-N slowest leaf paths (max duration along the path),
    deduplicated by path-signature so repeated identical HTTP calls
    inside the same parent don't swallow all 10 slots."""
    scored: List[Tuple[int, List[Span]]] = []
    seen: Set[str] = set()
    for path in _leaf_paths(roots):
        worst = max((s.duration_ms for s in path), default=0)
        sig = " → ".join(s.name for s in path)
        if sig in seen:
            continue
        seen.add(sig)
        scored.append((worst, path))
    scored.sort(key=lambda x: -x[0])
    return scored[:n]


def _activity_memory_rows(all_spans: List[Span]) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Tuple[int, int, int, int]]] = defaultdict(list)
    for sp in all_spans:
        md = sp.metadata or {}
        activity_type = md.get("temporal_activity_type")
        if not activity_type:
            continue
        peak_delta = _as_int(md.get("memory_tree_rss_peak_delta_bytes"))
        end_delta = _as_int(md.get("memory_tree_rss_delta_bytes"))
        peak = _as_int(md.get("memory_tree_rss_peak_bytes"))
        if peak_delta is None or end_delta is None or peak is None:
            continue
        grouped[str(activity_type)].append((peak_delta, end_delta, peak, sp.duration_ms))

    rows: List[Dict[str, Any]] = []
    for activity_type, values in grouped.items():
        peak_deltas = [v[0] for v in values]
        end_deltas = [v[1] for v in values]
        peaks = [v[2] for v in values]
        durations = [v[3] for v in values]
        rows.append(
            {
                "activity_type": activity_type,
                "count": len(values),
                "avg_peak_delta": sum(peak_deltas) / len(peak_deltas),
                "max_peak_delta": max(peak_deltas),
                "max_end_delta": max(end_deltas),
                "max_peak": max(peaks),
                "avg_duration_ms": sum(durations) / len(durations),
            }
        )
    rows.sort(key=lambda r: (r["max_peak_delta"], r["avg_peak_delta"]), reverse=True)
    return rows


def _render_executive_summary(
    agent_id: str,
    roots: List[Span],
    t0: datetime,
    t1: datetime,
    stats: Dict[str, Any],
    code_cache: Dict[str, str],
    slow_threshold_ms: int,
    color: bool,
    span_baselines: Optional[Dict[str, Dict[str, Any]]] = None,
) -> str:
    all_spans = _flatten(roots)
    total_ms = int((t1 - t0).total_seconds() * 1000)
    slow = [s for s in all_spans if s.duration_ms >= slow_threshold_ms]
    errors = [s for s in all_spans if s.status == "error" or s.status == "unclosed"]

    lines: List[str] = []
    lines.append(_c("═" * 100, BOLD, color))
    lines.append(_c(f"AGENT {agent_id}", BOLD, color))
    lines.append(_c("═" * 100, BOLD, color))
    lines.append(f"Duration           {total_ms/1000:.1f}s  ({t0.isoformat()[:19]} → {t1.isoformat()[:19]})")
    lines.append(
        f"Spans              {len(all_spans)} total, "
        f"{len(slow)} ≥ {slow_threshold_ms}ms, "
        f"{len(errors)} errors"
    )
    lines.append(
        f"Sources            {stats['worker_events']} worker events · "
        f"{stats['backend_events']} backend events · "
        f"{stats['research_events']} research events"
    )
    if stats.get("sub_agent_ids"):
        lines.append(
            f"Sub-agents         {len(stats['sub_agent_ids'])} discovered"
        )
    if stats.get("span_count") == 0:
        lines.append(_c(
            "Diagnostic         log events found, but no span or legacy timing windows were reconstructed",
            YELLOW, color,
        ))

    worker_span_names = {s.name for s in all_spans if s.source == "worker"}
    backend_span_names = {s.name for s in all_spans if s.source == "backend"}
    expected_worker = {
        "run_agent", "execute_iteration", "call_llm", "call_llm_activity",
        "check_progress", "call_planner_llm_activity",
        "spawn_sub_agent_activity", "spawn_explore_agent_activity",
        "web_search_activity", "web_fetch_activity",
        "generate_message_activity", "fetch_recent_messages_activity",
    }
    found_worker = worker_span_names & expected_worker
    missing_worker = expected_worker - worker_span_names
    lines.append("")
    lines.append(_c("SPAN COVERAGE", BOLD, color))
    lines.append("-" * 100)
    lines.append(f"  Backend spans:  {sum(1 for s in all_spans if s.source == 'backend')}"
                 f"  (http.request, db.*, broadcast.*)")
    lines.append(f"  Worker spans:   {sum(1 for s in all_spans if s.source == 'worker')}"
                 f"  (LLM calls, tool execution, iterations)")
    lines.append(f"  Research spans: {sum(1 for s in all_spans if s.source == 'research')}"
                 f"  (completions edge function)")
    if found_worker:
        lines.append(f"  Worker present: {', '.join(sorted(found_worker))}")
    if missing_worker and stats["worker_events"] == 0:
        lines.append(_c(
            f"  Worker MISSING:  {', '.join(sorted(missing_worker))}",
            YELLOW, color,
        ))
        lines.append(_c(
            "  → Without worker spans, LLM call latency and tool execution timing are invisible.",
            YELLOW, color,
        ))
        lines.append(_c(
            "  → For live runs: use --fly-stream <seconds> to capture worker logs in real-time.",
            YELLOW, color,
        ))
        lines.append(_c(
            "  → For local runs: omit --url to read from navi-worker-log.txt directly.",
            YELLOW, color,
        ))
    lines.append("")
    lines.append(_c("Re-run with full tree:", BOLD, color))
    lines.append(f"  python agents/benchmarks/agent_latency.py {agent_id} --verbose")
    lines.append("")

    # OUT-OF-BAND SPANS — every span running past its historical p95, ranked by
    # how far out of band. This is the "single parse → critical span is obvious"
    # view: whatever sub-stage actually misbehaved (provider read, broadcast,
    # backoff, cooldown…) surfaces here by name with its multiple over p95.
    if span_baselines:
        flagged = []
        for sp in all_spans:
            stats_b = span_baselines.get(_span_history_key(sp))
            if not stats_b:
                continue
            ratio = _out_of_band_ratio(sp, stats_b)
            if ratio is not None:
                excess_ms = sp.duration_ms - int(stats_b["p95_ms"])
                flagged.append((excess_ms, ratio, sp, stats_b))
        # Rank by EXCESS wall-time (dur − p95), not raw ratio: the critical span
        # is the one burning the most anomalous time, not a 50ms span at 10× p95.
        flagged.sort(key=lambda x: x[0], reverse=True)
        lines.append(_c("⚠ OUT-OF-BAND SPANS (dur > historical p95, ranked by excess wall-time)", BOLD, color))
        lines.append("-" * 100)
        if not flagged:
            lines.append(_c("  (none — all spans within historical band)", DIM, color))
        for excess_ms, ratio, sp, stats_b in flagged[:15]:
            ptr = _span_code_pointer(sp, code_cache)
            ptr_s = f"  @ {ptr}" if ptr else ""
            frag = sp.name
            if sp.metadata.get("actual_model"):
                frag += f"[{str(sp.metadata['actual_model']).split('/')[-1]}]"
            elif sp.metadata.get("call_site"):
                frag += f"[{sp.metadata['call_site']}]"
            lines.append(
                f"  +{_c(_fmt_dur(excess_ms).strip(), RED, color)} over p95  "
                f"{_c(_fmt_dur(sp.duration_ms), BOLD, color)} "
                f"({ratio:.1f}× p95={_fmt_dur(int(stats_b['p95_ms'])).strip()}, n={stats_b['count']})  "
                f"{frag}{_c(ptr_s, DIM, color)}"
            )
        lines.append("")

    bad = _top_bad_paths(roots, code_cache, 10)
    lines.append(_c("TOP 10 SLOW PATHS (root → leaf, worst duration)", BOLD, color))
    lines.append("-" * 100)
    if not bad:
        lines.append("  (no paths recorded)")
    for rank, (worst, path) in enumerate(bad, 1):
        path_labels = []
        for i, sp in enumerate(path):
            frag = sp.name
            runtime = sp.metadata.get("runtime_context") if isinstance(sp.metadata.get("runtime_context"), dict) else {}
            if sp.metadata.get("actual_model"):
                frag += f"[{str(sp.metadata['actual_model']).split('/')[-1]}]"
            elif sp.metadata.get("call_site") and "[" not in frag:
                frag += f"[{sp.metadata['call_site']}]"
            elif runtime.get("call_site") and "[" not in frag:
                frag += f"[{runtime['call_site']}]"
            if sp.duration_ms >= slow_threshold_ms:
                frag = _c(frag, YELLOW, color)
            path_labels.append(frag)
        leaf = path[-1]
        ptr = _span_code_pointer(leaf, code_cache)
        ptr_s = f"  @ {ptr}" if ptr else ""
        lines.append(
            f"  {rank:2d}. {_c(_fmt_dur(worst), BOLD, color)}  "
            + " → ".join(path_labels)
            + _c(ptr_s, DIM, color)
        )
    lines.append("")

    memory_rows = _activity_memory_rows(all_spans)
    if memory_rows:
        lines.append(_c("ACTIVITY MEMORY FOOTPRINT (worker process-tree RSS)", BOLD, color))
        lines.append("-" * 100)
        lines.append("  count  avg_peakΔ  max_peakΔ  max_endΔ   max_peakRSS  avg_dur   activity_type")
        for row in memory_rows[:20]:
            lines.append(
                f"  {row['count']:5d}  "
                f"{_fmt_mb_from_bytes(row['avg_peak_delta']):>9}  "
                f"{_fmt_mb_from_bytes(row['max_peak_delta']):>9}  "
                f"{_fmt_mb_from_bytes(row['max_end_delta']):>8}  "
                f"{_fmt_mb_from_bytes(row['max_peak']):>11}  "
                f"{_fmt_dur(int(row['avg_duration_ms'])).strip():>7}   "
                f"{row['activity_type']}"
            )
        lines.append(_c(
            "  Note: RSS deltas are process-wide; concurrent activities can overlap. "
            "Use serialized or low-concurrency runs for cleaner per-activity attribution.",
            DIM, color,
        ))
        lines.append("")

    if errors:
        lines.append(_c(f"ERRORS ({len(errors)})", BOLD, color))
        lines.append("-" * 100)
        for (name, status), n in Counter((e.name, e.status) for e in errors).most_common(10):
            lines.append(f"  {n:3d}×  {_c(name, RED, color)}  status={status}")
        lines.append("")

    return "\n".join(lines)


def _render_tree(
    roots: List[Span],
    t0: datetime,
    code_cache: Dict[str, str],
    span_baselines: Dict[str, Dict[str, Any]],
    color: bool,
    stall_threshold: float,
    verbose: bool,
) -> str:
    lines: List[str] = []
    header = f"{'offset':>12}  {'dur':>7}  trace"
    lines.append(_c(header, BOLD, color))
    lines.append("-" * 100)
    prev_end_by_depth: Dict[int, datetime] = {}
    if not roots:
        lines.append("  (no spans reconstructed from retained log events)")
    for r in roots:
        _render_span(r, 0, t0, lines, color, stall_threshold, code_cache,
                     span_baselines, verbose, prev_end_by_depth)
    lines.append("")
    lines.append(
        _c("LEGEND: ", BOLD, color)
        + _c("worker", SRC_COLOR["worker"], color) + " · "
        + _c("backend", SRC_COLOR["backend"], color) + " · "
        + _c("research", SRC_COLOR["research"], color)
        + "    " + _c("⋯ IDLE", DIM, color)
        + "    [NO-END] = span never closed (crash/cutoff)"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Speedscope export
# ---------------------------------------------------------------------------


def export_speedscope(
    roots: List[Span], agent_id: str, t0: datetime, t1: datetime
) -> Dict[str, Any]:
    frames: List[Dict[str, Any]] = []
    frame_idx: Dict[str, int] = {}

    def fid(label: str) -> int:
        if label not in frame_idx:
            frame_idx[label] = len(frames)
            frames.append({"name": label})
        return frame_idx[label]

    events: List[Dict[str, Any]] = []

    def to_us(t: datetime) -> float:
        return (t - t0).total_seconds() * 1e6

    def walk(sp: Span) -> None:
        label = f"{sp.source}: {sp.name}"
        start = to_us(sp.start)
        end = to_us(sp.end) if sp.end else start + 1
        events.append({"type": "O", "frame": fid(label), "at": start})
        for c in sorted(sp.children, key=lambda x: x.start):
            walk(c)
        events.append({"type": "C", "frame": fid(label), "at": end})

    for r in sorted(roots, key=lambda s: s.start):
        walk(r)

    total_us = (t1 - t0).total_seconds() * 1e6
    return {
        "$schema": "https://www.speedscope.app/file-format-schema.json",
        "name": f"Agent {agent_id}",
        "activeProfileIndex": 0,
        "exporter": "agent_latency.py",
        "shared": {"frames": frames},
        "profiles": [
            {
                "type": "evented",
                "name": f"Agent {agent_id}",
                "unit": "microseconds",
                "startValue": 0,
                "endValue": total_us,
                "events": events,
            }
        ],
    }


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


async def _fetch_prod_agent_tree(base_url: str, agent_id: str) -> Tuple[dict, Set[str]]:
    """Fetch agent details and discover all sub-agent IDs via the tree API."""
    import httpx
    headers = {"X-API-Key": API_KEY, "X-User-Id": USER_ID}
    async with httpx.AsyncClient(timeout=30) as client:
        agent_resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
        if agent_resp.status_code != 200:
            raise SystemExit(f"Failed to fetch agent: {agent_resp.status_code} {agent_resp.text[:200]}")
        agent_data = agent_resp.json()

        tree_resp = await client.get(
            f"{base_url}/api/agents/tree", headers=headers, params={"busId": agent_id}
        )
        sub_ids: Set[str] = set()
        if tree_resp.status_code == 200:
            for a in tree_resp.json().get("agents", []):
                aid = a.get("agent_id", "")
                if aid and aid != agent_id:
                    sub_ids.add(aid)
    return agent_data, sub_ids


def _parse_fly_line_to_raw_event(line: str) -> Optional[_RawEvent]:
    """Parse a Fly.io log line (raw or pre-extracted JSON) into a _RawEvent."""
    json_str = line
    json_start = line.find("{")
    if json_start > 0:
        json_str = line[json_start:]
    if not json_str.startswith("{"):
        return None
    try:
        d = json.loads(json_str)
    except json.JSONDecodeError:
        return None
    ts_str = d.get("timestamp")
    if not ts_str:
        return None
    # Fly/ClickHouse retained logs wrap app structlog JSON in an outer Fly
    # envelope. The useful span fields live in the JSON-encoded `message`
    # string, while ClickHouse top-level parsed columns may be empty.
    message = d.get("message")
    if isinstance(message, str) and message.startswith("{"):
        try:
            inner = json.loads(message)
        except json.JSONDecodeError:
            inner = None
        if isinstance(inner, dict) and inner.get("timestamp"):
            inner.setdefault("fly_timestamp", ts_str)
            inner.setdefault("fly_event", d.get("event"))
            inner.setdefault("fly_host", d.get("host"))
            return _RawEvent(parse_ts(str(inner["timestamp"])), "worker", inner.get("event", ""), inner)
    return _RawEvent(parse_ts(ts_str), "worker", d.get("event", ""), d)


def _parse_render_line_to_raw_event(line: str) -> Optional[_RawEvent]:
    """Parse a Render backend log line into a _RawEvent.
    Handles both JSON format (prod API) and text format (local file)."""
    line = ANSI_RE.sub("", line).rstrip("\n")

    if line.startswith("{"):
        try:
            d = json.loads(line)
            ts_str = d.get("timestamp")
            if not ts_str:
                return None
            msg = d.get("message", "")
            return _RawEvent(parse_ts(ts_str), "backend", msg, d)
        except json.JSONDecodeError:
            pass

    head = re.compile(
        r"\[(?P<ts>[^\]]+)\]\s+(?P<level>\w+)\s+\[(?P<comp>[^\]]+)\]\s+(?P<rest>.*)"
    )
    m = head.match(line)
    if not m:
        return None
    ts = parse_ts(m.group("ts"))
    rest = m.group("rest")
    mm = re.match(r"(?P<msg>.*?)(?=\s+\w+=)(?P<kv>.*)$", rest)
    if mm:
        msg = mm.group("msg").strip()
        kv_str = mm.group("kv")
    else:
        msg = rest.strip()
        kv_str = ""
    data: Dict[str, Any] = {
        "level": m.group("level"),
        "component": m.group("comp"),
        "message": msg,
    }
    for km in re.finditer(r"(\w+)=((?:(?!\s+\w+=).)+)", kv_str):
        data[km.group(1)] = km.group(2).strip()
    return _RawEvent(ts, "backend", msg, data)


def _parse_research_line_to_raw_event(line: str) -> Optional[_RawEvent]:
    line = ANSI_RE.sub("", line).strip()
    json_start = line.find("{")
    if json_start < 0:
        return None
    try:
        d = json.loads(line[json_start:])
    except json.JSONDecodeError:
        return None
    ts_str = d.get("timestamp")
    if not ts_str:
        return None
    return _RawEvent(parse_ts(ts_str), "research", d.get("message", ""), d)


def record_span_history_from_logs(
    *,
    agent_id: str,
    logs: Dict[str, Any],
    benchmark: str,
    environment: str,
    timestamp: str,
    run_status: str = "passed",
) -> int:
    """Record span-duration history from logs already embedded in a benchmark result."""
    try:
        worker_raw = [
            event
            for line in logs.get("worker_logs", []) or []
            for event in [_parse_fly_line_to_raw_event(str(line))]
            if event is not None
        ]
        backend_raw = [
            event
            for line in logs.get("backend_logs", []) or []
            for event in [_parse_render_line_to_raw_event(str(line))]
            if event is not None
        ]
        research_raw = [
            event
            for line in logs.get("research_logs", []) or []
            for event in [_parse_research_line_to_raw_event(str(line))]
            if event is not None
        ]
        if not (worker_raw or backend_raw or research_raw):
            return 0
        ids = {
            aid
            for event in [*worker_raw, *backend_raw, *research_raw]
            for aid in [_event_agent_id(event)]
            if aid
        }
        sub_ids = ids - {agent_id}
        roots, _t0, _t1, _stats = _build_trace_from_events(worker_raw, backend_raw, research_raw, sub_ids)
        observations = _span_observations(
            roots,
            agent_id=agent_id,
            benchmark=benchmark,
            environment=environment,
            timestamp=timestamp,
            run_status=run_status,
        )
        return record_span_observations(observations)
    except Exception:
        return 0


async def _fetch_render_logs_bulk(
    all_ids: Set[str], start_time: datetime, end_time: Optional[datetime] = None,
) -> List[_RawEvent]:
    """Fetch ALL backend logs from Render in the time window, filter locally by agent IDs."""
    import httpx

    from benchmarks.logs import RENDER_API_KEY, RENDER_OWNER_ID, RENDER_SERVICE_ID

    if not RENDER_API_KEY:
        print("  [render] RENDER_API_KEY not set in back-end/.env")
        return []

    if end_time is None:
        end_time = datetime.now(timezone.utc)

    headers = {"Authorization": f"Bearer {RENDER_API_KEY}"}
    all_events: List[_RawEvent] = []
    page = 0
    max_pages = 40
    current_end = end_time.strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient(timeout=30) as client:
        while page < max_pages:
            params: Dict[str, str] = {
                "ownerId": RENDER_OWNER_ID,
                "resource": RENDER_SERVICE_ID,
                "limit": "500",
                "direction": "backward",
                "startTime": start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endTime": current_end,
            }

            resp = await client.get("https://api.render.com/v1/logs", headers=headers, params=params)
            if resp.status_code == 429:
                print(f"  [render] Rate limited on page {page}, waiting 3s...")
                await asyncio.sleep(3)
                continue
            if resp.status_code != 200:
                print(f"  [render] API {resp.status_code}: {resp.text[:200]}")
                break

            data = resp.json()
            logs = data.get("logs", []) if isinstance(data, dict) else []
            if not logs:
                break

            for entry in logs:
                msg = entry.get("message", "") if isinstance(entry, dict) else str(entry)
                matches_agent = any(aid in msg or aid[:12] in msg for aid in all_ids)
                if matches_agent:
                    ev = _parse_render_line_to_raw_event(msg)
                    if ev:
                        all_events.append(ev)

            has_more = data.get("hasMore", False)
            next_end = data.get("nextEndTime")
            page += 1
            print(f"  [render] Page {page}: {len(logs)} entries, {len(all_events)} matched so far")

            if not has_more or not next_end:
                break
            current_end = next_end

    return all_events


async def _fetch_fly_logs_bulk(
    all_ids: Set[str],
    fly_stream_seconds: int = 0,
    start_time: Optional[datetime] = None,
) -> List[_RawEvent]:
    """Fetch worker logs from retained ClickHouse plus Fly.io live/snapshot logs.

    If fly_stream_seconds > 0, start a real-time streaming collector and collect
    for that many seconds. Otherwise, fall back to ClickHouse retained logs and
    the --no-tail snapshot (Fly only holds ~30s of recent buffer).
    """
    lines: List[str] = []
    from benchmarks.logs import FLY_API_TOKEN

    if fly_stream_seconds > 0:
        if not FLY_API_TOKEN:
            print("  [fly.io] FLY_API_TOKEN not set — skipping live worker stream")
        else:
            print(f"  [fly.io] Starting real-time stream for {fly_stream_seconds}s...")
            collector = FlyLogCollector()
            status = await collector.start()
            print(f"  [fly.io] {status}")
            if "error" not in status.lower() and "not found" not in status.lower():
                await asyncio.sleep(fly_stream_seconds)
                for aid in all_ids:
                    agent_lines = collector.get_logs_for_agent(aid)
                    for l in agent_lines:
                        if not l.startswith("[fly.io]"):
                            lines.append(l)
                await collector.stop()
                print(f"  [fly.io] Collected {len(lines)} lines from stream ({collector.total_lines} total streamed)")
    else:
        if FLY_API_TOKEN:
            from benchmarks.logs import _find_flyctl
            env = {**os.environ, "FLY_API_TOKEN": FLY_API_TOKEN}
            try:
                proc = await asyncio.create_subprocess_exec(
                    _find_flyctl(), "logs", "-a", "navi-whisper-lux", "--no-tail",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
                lines = stdout.decode().strip().splitlines()
            except Exception as e:
                print(f"  [fly.io] Error fetching snapshot: {e}")
        else:
            print("  [fly.io] FLY_API_TOKEN not set — skipping short buffer snapshot")

    clickhouse_count = 0
    if start_time:
        clickhouse_results = await asyncio.gather(
            *(fetch_clickhouse_worker_logs(aid, start_time) for aid in all_ids)
        )
        clickhouse_lines = [
            line
            for result in clickhouse_results
            for line in result
            if not line.startswith("[clickhouse]")
        ]
        clickhouse_count = len(clickhouse_lines)
        seen_lines = set(lines)
        lines.extend(line for line in clickhouse_lines if line not in seen_lines)
        print(f"  [clickhouse] Collected {clickhouse_count} retained worker log lines")

    events: List[_RawEvent] = []
    for line in lines:
        ev = _parse_fly_line_to_raw_event(line)
        if ev:
            aid = _event_agent_id(ev)
            if aid in all_ids:
                events.append(ev)

    if not events and lines:
        print(f"  [fly.io] 0 matching events from {len(lines)} lines"
              + (" (buffer only holds ~30s)" if fly_stream_seconds == 0 else ""))
    if not events and not lines and start_time:
        print("  [worker] 0 worker log lines from ClickHouse/Fly.io")
    return events


def build_trace(
    agent_id: str, url: Optional[str] = None,
    fly_stream_seconds: int = 0, worker_log_file: Optional[str] = None,
) -> Tuple[List[Span], datetime, datetime, Dict[str, Any]]:
    if url:
        return asyncio.run(_build_trace_prod(agent_id, url, fly_stream_seconds, worker_log_file))
    return _build_trace_local(agent_id)


def _read_worker_log_file(path: str, all_ids: Set[str]) -> List[_RawEvent]:
    """Read saved worker JSONL file and filter by agent IDs."""
    events: List[_RawEvent] = []
    total = 0
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            total += 1
            ev = _parse_fly_line_to_raw_event(line)
            if ev:
                aid = _event_agent_id(ev)
                if aid in all_ids:
                    events.append(ev)
    print(f"  [worker-log] Read {path}: {total} lines, {len(events)} matched")
    return events


async def _build_trace_prod(
    agent_id: str, base_url: str,
    fly_stream_seconds: int = 0, worker_log_file: Optional[str] = None,
) -> Tuple[List[Span], datetime, datetime, Dict[str, Any]]:
    try:
        agent_data, sub_ids = await _fetch_prod_agent_tree(base_url, agent_id)
    except SystemExit:
        if worker_log_file and os.path.exists(worker_log_file):
            print(f"  Agent {agent_id[:12]} not found via API (deleted?), discovering from log file...")
            agent_data = {}
            sub_ids = set()
        else:
            raise

    all_ids = {agent_id, *sub_ids}

    agent_obj = agent_data.get("agent", agent_data)
    created_at_str = agent_obj.get("created_at") or agent_obj.get("createdAt", "")
    start_time = parse_ts(created_at_str) if created_at_str else datetime.now(timezone.utc) - timedelta(hours=1)

    if worker_log_file and os.path.exists(worker_log_file):
        worker_raw_unfiltered = _read_worker_log_file(worker_log_file, {agent_id})
        if not sub_ids:
            for ev in worker_raw_unfiltered:
                aid = _event_agent_id(ev)
                if aid and aid != agent_id:
                    sub_ids.add(aid)
            if sub_ids:
                print(f"  Discovered {len(sub_ids)} sub-agents from worker log")
            all_ids = {agent_id, *sub_ids}
        worker_raw = _read_worker_log_file(worker_log_file, all_ids)
        if not created_at_str and worker_raw:
            start_time = worker_raw[0].ts - timedelta(seconds=10)
        backend_raw = await _fetch_render_logs_bulk(all_ids, start_time)
    else:
        print(f"Fetching prod logs for {len(all_ids)} agents ({len(sub_ids)} sub-agents)...")
        worker_raw, backend_raw = await asyncio.gather(
            _fetch_fly_logs_bulk(all_ids, fly_stream_seconds, start_time),
            _fetch_render_logs_bulk(all_ids, start_time),
        )
    research_raw: List[_RawEvent] = []

    print(f"  Worker events: {len(worker_raw)}, Backend events: {len(backend_raw)}")

    if not (worker_raw or backend_raw):
        raise SystemExit(f"No prod log lines found for agent {agent_id}.")

    return _build_trace_from_events(worker_raw, backend_raw, research_raw, sub_ids)


def _build_trace_local(agent_id: str) -> Tuple[List[Span], datetime, datetime, Dict[str, Any]]:
    worker_raw_all = _read_worker_raw()
    backend_raw_all = _read_backend_raw()
    research_raw_all = _read_research_raw()

    sub_ids = _discover_sub_agent_ids(backend_raw_all, agent_id)
    all_ids = {agent_id, *sub_ids}

    worker_raw = _filter_by_agents(worker_raw_all, all_ids)
    backend_raw = _filter_by_agents(backend_raw_all, all_ids)
    research_raw = _filter_by_agents(research_raw_all, all_ids)

    if not (worker_raw or backend_raw or research_raw):
        raise SystemExit(f"No log lines found for agent {agent_id}.")

    return _build_trace_from_events(worker_raw, backend_raw, research_raw, sub_ids)


def _build_trace_from_events(
    worker_raw: List[_RawEvent],
    backend_raw: List[_RawEvent],
    research_raw: List[_RawEvent],
    sub_ids: Set[str],
) -> Tuple[List[Span], datetime, datetime, Dict[str, Any]]:
    combined = worker_raw + backend_raw + research_raw
    combined.sort(key=lambda e: e.ts)

    spans, leftover = _build_spans_from_events(combined)

    worker_has_spans = any(e.event == "span.start" for e in worker_raw)
    backend_has_spans = any(e.event == "span.start" for e in backend_raw)
    worker_leftover = [e for e in leftover if e.source == "worker"]
    backend_leftover = [e for e in leftover if e.source == "backend"]
    if not worker_has_spans:
        spans.extend(_legacy_worker_llm_spans(worker_leftover))
        spans.extend(_legacy_worker_spawn_spans(worker_leftover))
    if not backend_has_spans:
        spans.extend(_legacy_backend_http_spans(backend_leftover))

    spans.extend(_research_event_spans(leftover))

    roots = _assemble_tree(spans)

    if spans:
        t0 = min(s.start for s in spans)
        t1 = max((s.end or s.start) for s in spans)
    elif combined:
        t0 = combined[0].ts
        t1 = combined[-1].ts
    else:
        now = datetime.now(timezone.utc)
        t0 = now
        t1 = now

    stats = {
        "worker_events": len(worker_raw),
        "backend_events": len(backend_raw),
        "research_events": len(research_raw),
        "sub_agent_ids": sub_ids,
        "has_span_events": worker_has_spans or backend_has_spans,
        "span_count": len(spans),
    }
    return roots, t0, t1, stats


# ── Agent wall-clock rollup ───────────────────────────────────────────────────

_TERMINAL_AGENT_STATUSES = {
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "CANCELED",
    "ERROR",
    "TIMEOUT",
    "COST_LIMIT_REACHED",
}


def _fetch_agent_tree_for_wall_clocks(base_url: str, seed_agent_id: str) -> List[dict]:
    """Fetch tree agents with timestamps. Falls back to per-agent detail if needed."""
    import urllib.parse
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor

    headers = {"X-API-Key": API_KEY, "X-User-Id": USER_ID}

    def fetch_detail(agent_id: str) -> Optional[dict]:
        req = urllib.request.Request(f"{base_url}/api/agents/{agent_id}", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
        except Exception:
            return None
        agent = data.get("agent") or data
        return {
            "agent_id": agent.get("agent_id") or agent.get("id") or agent_id,
            "parent_agent_id": agent.get("parent_agent_id") or agent.get("parentAgentId"),
            "goal": agent.get("goal") or "",
            "status": agent.get("status") or "",
            "created_at": agent.get("created_at") or agent.get("createdAt"),
            "updated_at": agent.get("updated_at") or agent.get("updatedAt"),
        }

    agents: List[dict] = []
    try:
        query = urllib.parse.urlencode({"busId": seed_agent_id})
        req = urllib.request.Request(f"{base_url}/api/agents/tree?{query}", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            agents = list(json.load(resp).get("agents", []))
    except Exception:
        detail = fetch_detail(seed_agent_id)
        return [detail] if detail else []

    ids = [str(a.get("agent_id")) for a in agents if a.get("agent_id")]
    if seed_agent_id not in ids:
        ids.insert(0, seed_agent_id)

    missing_timestamp_ids = [
        aid
        for aid in ids
        if not any(
            a.get("agent_id") == aid and a.get("created_at") and a.get("updated_at")
            for a in agents
        )
    ]
    if missing_timestamp_ids:
        details_by_id: Dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=12) as ex:
            for detail in ex.map(fetch_detail, missing_timestamp_ids):
                if detail and detail.get("agent_id"):
                    details_by_id[str(detail["agent_id"])] = detail
        merged: Dict[str, dict] = {str(a.get("agent_id")): dict(a) for a in agents if a.get("agent_id")}
        merged.update(details_by_id)
        agents = list(merged.values())

    return agents


def _agent_wall_clock_rows(base_url: str, seed_agent_id: str) -> List[dict]:
    now = datetime.now(timezone.utc)
    rows: List[dict] = []
    for agent in _fetch_agent_tree_for_wall_clocks(base_url, seed_agent_id):
        aid = agent.get("agent_id")
        created_raw = agent.get("created_at") or agent.get("createdAt")
        updated_raw = agent.get("updated_at") or agent.get("updatedAt")
        if not aid or not created_raw:
            continue
        try:
            start = parse_ts(str(created_raw))
        except Exception:
            continue
        status = str(agent.get("status") or "")
        if status.upper() in _TERMINAL_AGENT_STATUSES and updated_raw:
            try:
                end = parse_ts(str(updated_raw))
            except Exception:
                end = now
        else:
            end = now
        if end < start:
            end = start
        rows.append({
            "agent_id": str(aid),
            "parent_agent_id": agent.get("parent_agent_id"),
            "goal": agent.get("goal") or "",
            "status": status,
            "created_at": start.isoformat(),
            "updated_at": end.isoformat(),
            "wall_s": (end - start).total_seconds(),
            "is_main": str(aid) == seed_agent_id or not agent.get("parent_agent_id"),
        })
    return rows


def _render_agent_wall_clocks(
    base_url: str,
    seed_agent_id: str,
    color: bool,
    json_out: Optional[str] = None,
) -> str:
    rows = _agent_wall_clock_rows(base_url, seed_agent_id)
    if not rows:
        return _c(f"  [wall-clock] skipped ({base_url}): no agent timestamp data", YELLOW, color)

    rows.sort(key=lambda r: r["wall_s"], reverse=True)
    walls = sorted(r["wall_s"] for r in rows)

    def pct(p: float) -> float:
        if not walls:
            return 0.0
        idx = min(len(walls) - 1, int((len(walls) - 1) * p))
        return walls[idx]

    starts = [parse_ts(r["created_at"]) for r in rows]
    ends = [parse_ts(r["updated_at"]) for r in rows]
    tree_elapsed_s = (max(ends) - min(starts)).total_seconds()
    sum_wall_s = sum(walls)
    main = next((r for r in rows if r["agent_id"] == seed_agent_id), None)
    if main is None:
        main = next((r for r in rows if r["is_main"]), rows[0])
    status_counts = Counter(str(r["status"] or "UNKNOWN") for r in rows)

    payload = {
        "agent_id": seed_agent_id,
        "base_url": base_url,
        "agent_count": len(rows),
        "tree_elapsed_s": tree_elapsed_s,
        "sum_agent_wall_s": sum_wall_s,
        "main_agent_wall_s": main["wall_s"],
        "status_counts": dict(status_counts),
        "p50_s": pct(0.50),
        "p90_s": pct(0.90),
        "p95_s": pct(0.95),
        "p99_s": pct(0.99),
        "max_s": walls[-1],
        "agents": rows,
    }
    if json_out:
        out_dir = os.path.dirname(json_out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(json_out, "w") as f:
            json.dump(payload, f, indent=2)

    lines = [
        _c("AGENT WALL CLOCKS", BOLD, color),
        _c("═" * 100, BOLD, color),
        f"  Unified sum       {sum_wall_s:.1f}s  ({sum_wall_s/60:.1f} agent-min, {sum_wall_s/3600:.2f} agent-hr)",
        f"  Tree elapsed      {tree_elapsed_s:.1f}s",
        f"  Main agent        {main['wall_s']:.1f}s  {main['agent_id'][:12]}  {main['status']}",
        f"  Agents            {len(rows)} total · "
        + ", ".join(f"{status}={count}" for status, count in status_counts.most_common()),
        f"  Distribution      p50={pct(0.50):.1f}s p90={pct(0.90):.1f}s "
        f"p95={pct(0.95):.1f}s p99={pct(0.99):.1f}s max={walls[-1]:.1f}s",
    ]
    if json_out:
        lines.append(f"  JSON              {json_out}")
    lines.append("  Slowest agents")
    for r in rows[:10]:
        lines.append(
            f"    {r['wall_s']:7.1f}s  {r['agent_id'][:12]}  {r['status'] or 'UNKNOWN'}  "
            f"{str(r['goal'])[:90]}"
        )
    return "\n".join(lines)


# ── FE message cadence ────────────────────────────────────────────────────────
# Message.createdAt is stamped when the backend inserts a message, which is also
# when it auto-broadcasts the INSERT to Supabase Realtime — i.e. ≈ the moment the
# FE receives it. Per-agent gaps between consecutive createdAt values therefore
# approximate what a user sees on the FE: how long an agent "sits thinking" with
# no new messages. Comparing the root (usually low concurrency) against the leaf
# sub-agents (which run under fan-out concurrency) surfaces load-based streaming
# lag that the worker-side span waterfall alone doesn't show.


def _fetch_agent_message_cadence(base_url: str, agent_id: str) -> Optional[dict]:
    """Fetch one agent's message createdAt gaps. Returns {n, gaps[], parent} or None."""
    import urllib.request

    headers = {"X-API-Key": API_KEY, "X-User-Id": USER_ID}
    req = urllib.request.Request(f"{base_url}/api/agents/{agent_id}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except Exception:
        return None
    agent = data.get("agent") or data
    msgs = data.get("messages") or agent.get("messages") or []
    times: List[float] = []
    for m in msgs:
        # The API serializes Message.createdAt as `timestamp` (the broadcast time).
        ca = m.get("timestamp") or m.get("created_at") or m.get("createdAt")
        if not ca:
            continue
        try:
            times.append(parse_ts(ca).timestamp())
        except Exception:
            continue
    times.sort()
    gaps = sorted(times[i] - times[i - 1] for i in range(1, len(times)))
    return {"n": len(times), "gaps": gaps, "parent": agent.get("parent_agent_id")}


def _fetch_message_cadence(base_url: str, seed_agent_id: str) -> Tuple[str, Dict[str, dict]]:
    """Return (root_id, {agent_id: {n, gaps, parent, is_root}}) for the whole tree.

    Fetches the tree via /api/agents/tree?busId=, then each agent's messages in
    parallel. Silently returns ({}, {}) if the backend is unreachable.
    """
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor

    headers = {"X-API-Key": API_KEY, "X-User-Id": USER_ID}
    ids: List[str] = [seed_agent_id]
    try:
        treq = urllib.request.Request(
            f"{base_url}/api/agents/tree?busId={seed_agent_id}", headers=headers
        )
        with urllib.request.urlopen(treq, timeout=30) as resp:
            for a in json.load(resp).get("agents", []):
                aid = a.get("agent_id")
                if aid and aid not in ids:
                    ids.append(aid)
    except Exception:
        pass

    result: Dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        for aid, cad in zip(ids, ex.map(lambda a: _fetch_agent_message_cadence(base_url, a), ids)):
            if cad and cad["n"] >= 2:
                result[aid] = cad
    root_id = next((a for a, c in result.items() if not c.get("parent")), seed_agent_id)
    for aid, c in result.items():
        c["is_root"] = aid == root_id
    return root_id, result


def _render_message_cadence(root_id: str, cadence: Dict[str, dict], color: bool) -> str:
    if not cadence:
        return ""

    def stat(c: dict) -> Tuple[float, float, float]:
        g = c["gaps"]
        if not g:
            return (0.0, 0.0, 0.0)
        return (g[len(g) // 2], g[min(len(g) - 1, int(len(g) * 0.9))], g[-1])

    lines = [
        _c("FE MESSAGE CADENCE  (Message.createdAt = broadcast ≈ FE receive time)", BOLD, color),
        _c("═" * 100, BOLD, color),
    ]
    root = cadence.get(root_id)
    root_p50 = 0.0
    if root:
        p50, p90, mx = stat(root)
        root_p50 = p50
        lines.append(
            f"  ROOT   {root_id[:8]}: {root['n']:4d} msgs | inter-msg gap "
            f"p50={p50:.2f}s p90={p90:.2f}s max={mx:.2f}s"
        )
    leaves = [(a, c) for a, c in cadence.items() if a != root_id]
    if leaves:
        lp50 = sorted(stat(c)[0] for _, c in leaves)
        lmax = sorted(stat(c)[2] for _, c in leaves)
        med_p50 = lp50[len(lp50) // 2]
        med_max = lmax[len(lmax) // 2]
        lines.append(
            f"  LEAVES ({len(leaves):2d}): inter-msg gap median-p50={med_p50:.2f}s "
            f"worst-p50={lp50[-1]:.2f}s | dead-gap median-max={med_max:.1f}s worst-max={lmax[-1]:.1f}s"
        )
        if root and med_p50 > 3 * root_p50 + 0.3:
            ratio = med_p50 / max(root_p50, 0.01)
            lines.append(_c(
                f"  ⚠ LOAD LAG: leaves stream {ratio:.0f}× slower than root "
                f"({med_p50:.2f}s vs {root_p50:.2f}s per msg) — concurrency contention, not compute.",
                YELLOW, color,
            ))
        lines.append("  Slowest leaves (id: msgs, p50 gap, worst dead-gap):")
        for aid, c in sorted(leaves, key=lambda x: stat(x[1])[0], reverse=True)[:6]:
            p50, _p90, mx = stat(c)
            lines.append(f"    {aid[:8]}: {c['n']:4d} msgs  p50={p50:.2f}s  max={mx:.1f}s")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("agent_id")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="Expand every span including DB queries, broadcasts, HTTP internals.")
    ap.add_argument("--speedscope", metavar="OUT.json",
                    help="Write speedscope.app profile JSON and exit.")
    ap.add_argument("--stall-threshold", type=float, default=5.0,
                    help="Seconds of idle time to flag as a stall (default 5).")
    ap.add_argument("--slow-threshold", type=int, default=300,
                    help="Milliseconds above which a span is counted as 'bad' (default 300).")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--no-fe-cadence", action="store_true",
                    help="Skip the FE message-cadence analysis (per-agent Message.createdAt gaps).")
    ap.add_argument("--no-wall-clock", action="store_true",
                    help="Skip agent created_at→updated_at wall-clock rollup.")
    ap.add_argument("--wall-clock-json", default=None,
                    help="Write agent wall-clock rollup JSON to this path.")
    ap.add_argument("--fe-base-url", default=None,
                    help="Backend base URL for the FE-cadence fetch "
                         "(defaults to --url, else http://localhost:3001).")
    ap.add_argument("--url", default=None,
                    help="Base URL for prod mode (e.g. https://navi-j9a9.onrender.com). "
                         "Fetches logs from Render, ClickHouse, and Fly.io instead of local files.")
    ap.add_argument("--fly-stream", type=int, default=0, metavar="SECONDS",
                    help="Stream Fly.io worker logs for N seconds before analysis. "
                         "Use during a live benchmark as a supplement to retained ClickHouse logs. "
                         "Requires --url and FLY_API_TOKEN in agents/.env.")
    ap.add_argument("--worker-log", default=None, metavar="FILE",
                    help="Path to a saved worker log file (JSONL from Fly.io). "
                         "Generated by benchmark_monitor.py on exit. "
                         "Provides full worker span depth for prod analysis.")
    ap.add_argument("--benchmark", default="",
                    help="Benchmark/task name for span-baseline lookup and recording.")
    ap.add_argument("--environment", choices=["local", "prod"], default=None,
                    help="Span-baseline environment. Defaults to prod when --url is set, otherwise local.")
    ap.add_argument("--span-history-status", default="observed",
                    choices=["observed", "passed", "failed"],
                    help="Status stored when recording this trace to span history.")
    ap.add_argument("--span-baseline-min-samples", type=int, default=20,
                    help="Minimum historical samples required before comparing a span_key.")
    ap.add_argument("--no-record-span-history", action="store_true",
                    help="Do not append this analyzed trace to span history.")
    args = ap.parse_args()

    roots, t0, t1, stats = build_trace(args.agent_id, url=args.url,
                                        fly_stream_seconds=args.fly_stream,
                                        worker_log_file=args.worker_log)

    if args.speedscope:
        payload = export_speedscope(roots, args.agent_id, t0, t1)
        with open(args.speedscope, "w") as f:
            json.dump(payload, f)
        print(f"Wrote speedscope profile → {args.speedscope}")
        print("  Open at https://www.speedscope.app (drag-drop the file)")
        return 0

    color = _use_color(args.no_color)
    code_cache: Dict[str, str] = {}
    environment = args.environment or ("prod" if args.url else "local")
    timestamp = datetime.now(timezone.utc).isoformat()
    observations = _span_observations(
        roots,
        agent_id=args.agent_id,
        benchmark=args.benchmark,
        environment=environment,
        timestamp=timestamp,
        run_status=args.span_history_status,
    )
    span_baselines = _span_baseline_map(
        observations,
        benchmark=args.benchmark,
        environment=environment,
        min_samples=args.span_baseline_min_samples,
    )
    if not args.no_record_span_history:
        written = record_span_observations(observations)
        if written:
            print(f"Recorded {written} span observation(s) to historical span baselines.")

    summary = _render_executive_summary(
        args.agent_id, roots, t0, t1, stats, code_cache,
        args.slow_threshold, color, span_baselines,
    )
    print(summary)

    if not args.no_wall_clock:
        wall_base = args.fe_base_url or args.url or "http://localhost:3001"
        try:
            print(_render_agent_wall_clocks(
                wall_base,
                args.agent_id,
                color,
                json_out=args.wall_clock_json,
            ))
            print("")
        except Exception as exc:
            print(_c(f"  [wall-clock] skipped ({wall_base}): {exc}", YELLOW, color))

    if not args.no_fe_cadence:
        fe_base = args.fe_base_url or args.url or "http://localhost:3001"
        try:
            fe_root_id, fe_cadence = _fetch_message_cadence(fe_base, args.agent_id)
            fe_section = _render_message_cadence(fe_root_id, fe_cadence, color)
            if fe_section:
                print(fe_section)
                print("")
        except Exception as exc:
            print(_c(f"  [fe-cadence] skipped ({fe_base}): {exc}", YELLOW, color))

    if not stats.get("has_span_events"):
        print(_c(
            "NOTE: No span.* events found in logs. Falling back to legacy heuristics.",
            YELLOW, color,
        ))
        print(_c(
            "      Restart worker + backend to pick up the new tracing instrumentation.",
            YELLOW, color,
        ))
        print("")

    if args.verbose:
        print(_c("FULL TREE", BOLD, color))
        print(_c("═" * 100, BOLD, color))
        print(_render_tree(roots, t0, code_cache, span_baselines, color,
                           args.stall_threshold, verbose=True))
    else:
        print(_c("HOT PATH TREE (re-run with -v for fully expanded tree)", BOLD, color))
        print(_c("═" * 100, BOLD, color))
        print(_render_tree(roots, t0, code_cache, span_baselines, color,
                           args.stall_threshold, verbose=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
