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

USAGE

  python benchmarks/agent_latency.py <agent_id>           # summary + hot paths
  python benchmarks/agent_latency.py <agent_id> -v        # fully expanded tree
  python benchmarks/agent_latency.py <agent_id> --speedscope out.json

Flags:
  -v, --verbose          Expand every span (sub-agents, DB, broadcasts, HTTP internals).
  --speedscope OUT       Emit speedscope.app evented profile (browser flame graph).
  --stall-threshold N    Seconds of idle time to annotate (default 5).
  --slow-threshold N     Milliseconds above which a span is counted as "bad" (default 300).
  --no-color             Disable ANSI colors.
"""

from __future__ import annotations

import argparse
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


def _read_worker_raw() -> List[_RawEvent]:
    if not os.path.exists(WORKER_LOG):
        return []
    out: List[_RawEvent] = []
    with open(WORKER_LOG, errors="replace") as f:
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
    return out


def _read_backend_raw() -> List[_RawEvent]:
    if not os.path.exists(BACKEND_LOG):
        return []
    out: List[_RawEvent] = []
    # [2026-04-17T21:07:35.352Z] INFO [HTTP] message key=value key=value
    head = re.compile(
        r"\[(?P<ts>[^\]]+)\]\s+(?P<level>\w+)\s+\[(?P<comp>[^\]]+)\]\s+(?P<rest>.*)"
    )
    with open(BACKEND_LOG, errors="replace") as f:
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
    # Backend log lines that have `agent_id=<uuid>` embedded
    for k in ("workflowId", "agent_id"):
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
    parts: List[str] = []
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
        if md.get("ttft_ms"):
            parts.append(f"ttft={md['ttft_ms']}ms")
        if md.get("chunks"):
            parts.append(f"{md['chunks']} chunks")
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

    code_ptr = sp.metadata.get("code_ptr") or _find_code_pointer(sp.name, code_cache)
    ptr_s = _c(f"  @ {code_ptr}", DIM, color) if code_ptr else ""

    out.append(
        f"{_fmt_offset(offset)}  {dur}  "
        f"{indent}{branch}{src_c} {name_c}  {summary}{status_suffix}{ptr_s}"
    )

    prev_end_by_depth[depth] = sp.end or sp.start
    inner = {k: v for k, v in prev_end_by_depth.items() if k <= depth}
    for child in sp.children:
        _render_span(child, depth + 1, t0, out, color, stall_threshold,
                     code_cache, verbose, inner)


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


def _render_executive_summary(
    agent_id: str,
    roots: List[Span],
    t0: datetime,
    t1: datetime,
    stats: Dict[str, Any],
    code_cache: Dict[str, str],
    slow_threshold_ms: int,
    color: bool,
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
            "Sub-agents         "
            + ", ".join(sorted(stats["sub_agent_ids"]))
        )
    lines.append("")
    lines.append(_c("Re-run with full tree:", BOLD, color))
    lines.append(f"  python agents/benchmarks/agent_latency.py {agent_id} --verbose")
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
            if sp.metadata.get("actual_model"):
                frag += f"[{str(sp.metadata['actual_model']).split('/')[-1]}]"
            elif sp.metadata.get("call_site") and "[" not in frag:
                frag += f"[{sp.metadata['call_site']}]"
            if sp.duration_ms >= slow_threshold_ms:
                frag = _c(frag, YELLOW, color)
            path_labels.append(frag)
        leaf = path[-1]
        ptr = leaf.metadata.get("code_ptr") or _find_code_pointer(leaf.name, code_cache)
        ptr_s = f"  @ {ptr}" if ptr else ""
        lines.append(
            f"  {rank:2d}. {_c(_fmt_dur(worst), BOLD, color)}  "
            + " → ".join(path_labels)
            + _c(ptr_s, DIM, color)
        )
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
    color: bool,
    stall_threshold: float,
    verbose: bool,
) -> str:
    lines: List[str] = []
    header = f"{'offset':>12}  {'dur':>7}  trace"
    lines.append(_c(header, BOLD, color))
    lines.append("-" * 100)
    prev_end_by_depth: Dict[int, datetime] = {}
    for r in roots:
        _render_span(r, 0, t0, lines, color, stall_threshold, code_cache,
                     verbose, prev_end_by_depth)
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


def build_trace(agent_id: str) -> Tuple[List[Span], datetime, datetime, Dict[str, Any]]:
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

    combined = worker_raw + backend_raw + research_raw
    combined.sort(key=lambda e: e.ts)

    spans, leftover = _build_spans_from_events(combined)

    # Legacy fallbacks — apply per source: only reconstruct spans for layers
    # that didn't emit native span.start events. A partially-traced run (e.g.
    # a backend mid-rollout) shouldn't disable legacy reconstruction for the
    # other sources.
    worker_has_spans = any(e.event == "span.start" for e in worker_raw)
    backend_has_spans = any(e.event == "span.start" for e in backend_raw)
    worker_leftover = [e for e in leftover if e.source == "worker"]
    backend_leftover = [e for e in leftover if e.source == "backend"]
    if not worker_has_spans:
        spans.extend(_legacy_worker_llm_spans(worker_leftover))
        spans.extend(_legacy_worker_spawn_spans(worker_leftover))
    if not backend_has_spans:
        spans.extend(_legacy_backend_http_spans(backend_leftover))

    # Research events always hang off LLM spans; add them as point-width.
    spans.extend(_research_event_spans(leftover))

    roots = _assemble_tree(spans)

    t0 = min(s.start for s in spans)
    t1 = max((s.end or s.start) for s in spans)

    stats = {
        "worker_events": len(worker_raw),
        "backend_events": len(backend_raw),
        "research_events": len(research_raw),
        "sub_agent_ids": sub_ids,
        "has_span_events": worker_has_spans or backend_has_spans,
    }
    return roots, t0, t1, stats


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
    args = ap.parse_args()

    roots, t0, t1, stats = build_trace(args.agent_id)

    if args.speedscope:
        payload = export_speedscope(roots, args.agent_id, t0, t1)
        with open(args.speedscope, "w") as f:
            json.dump(payload, f)
        print(f"Wrote speedscope profile → {args.speedscope}")
        print("  Open at https://www.speedscope.app (drag-drop the file)")
        return 0

    color = _use_color(args.no_color)
    code_cache: Dict[str, str] = {}

    summary = _render_executive_summary(
        args.agent_id, roots, t0, t1, stats, code_cache,
        args.slow_threshold, color,
    )
    print(summary)

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
        print(_render_tree(roots, t0, code_cache, color,
                           args.stall_threshold, verbose=True))
    else:
        print(_c("HOT PATH TREE (re-run with -v for fully expanded tree)", BOLD, color))
        print(_c("═" * 100, BOLD, color))
        print(_render_tree(roots, t0, code_cache, color,
                           args.stall_threshold, verbose=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
