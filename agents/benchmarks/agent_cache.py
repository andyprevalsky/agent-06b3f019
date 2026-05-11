#!/usr/bin/env python3
"""Agent cache tracer — file-tree view of prompt caching across every LLM call.

Reads worker log (JSONL) and backend log (dev-format) for `llm.cache`
events and renders a tree showing cache read/write/hit% for every call
site, grouped by agent → sub-agent hierarchy.

Covers ALL LLM paths: agent pipeline (worker), chat router/generator
(backend), explore sub-agents, browser agents, and verifiers.

USAGE — LOCAL

  python benchmarks/agent_cache.py <agent_id>
  python benchmarks/agent_cache.py <agent_id> --log agents/navi-worker-log.txt

USAGE — ALL RECENT (no agent_id)

  python benchmarks/agent_cache.py --all --since 5m

Output format:

  Agent abc123 (rose-1-lite)
  ├── plan_loop i1       claude-sonnet-4-6-claude  Cache: read=11,607 write=0 → 89% hit
  ├── planner            claude-sonnet-4-6-claude  Cache: read=11,760 write=3,200 → 78% hit
  ├── routerLlm [chat]   claude-sonnet-4-6-claude  Cache: read=5,200 write=1,000 → 72% hit
  ├── generatorLlm [chat] claude-sonnet-4-6-claude  Cache: read=6,100 write=500 → 80% hit
  └── verifier i1        claude-sonnet-4-6-claude  Cache: read=12,100 write=0 → 92% hit

  Totals: read=64,467 write=4,000 → 84% hit | 5 LLM calls | $0.00 (claudeAuth)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Visualize prompt cache hits across every LLM call for an agent run.",
    )
    p.add_argument("agent_id", nargs="?", help="Agent ID (prefix match supported)")
    p.add_argument("--all", action="store_true", help="Show all agents in the log")
    p.add_argument("--since", default="30m", help="Time window for --all (e.g. 5m, 1h)")
    p.add_argument(
        "--log",
        default=None,
        help="Path to worker log file (default: auto-detect navi-worker-log.txt)",
    )
    p.add_argument("--json", action="store_true", help="Output as JSON instead of tree")
    return p.parse_args()


def _find_log_files(explicit: Optional[str]) -> List[Path]:
    if explicit:
        return [Path(explicit)]
    repo_root = Path(__file__).parent.parent.parent
    worker_candidates = [
        Path("agents/navi-worker-log.txt"),
        Path("navi-worker-log.txt"),
        Path(__file__).parent.parent / "navi-worker-log.txt",
    ]
    backend_candidates = [
        Path("back-end/backend-logs.log"),
        repo_root / "back-end" / "backend-logs.log",
    ]
    found: List[Path] = []
    for c in worker_candidates:
        if c.exists():
            found.append(c)
            break
    for c in backend_candidates:
        if c.exists():
            found.append(c)
            break
    if not found:
        print("ERROR: Cannot find navi-worker-log.txt or backend-logs.log. Use --log to specify path.", file=sys.stderr)
        sys.exit(1)
    return found


def _parse_since(since: str) -> timedelta:
    m = re.match(r"^(\d+)\s*(s|m|h|d)$", since.strip())
    if not m:
        return timedelta(minutes=30)
    val, unit = int(m.group(1)), m.group(2)
    return {"s": timedelta(seconds=val), "m": timedelta(minutes=val),
            "h": timedelta(hours=val), "d": timedelta(days=val)}[unit]


_DEV_LOG_RE = re.compile(
    r"^\x1b\[\d+m\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+INFO\s+\[.*?\]\s+llm\.cache\s+(.*?)\x1b\[0m$"
)

_DEV_KV_RE = re.compile(r"(\w+)=((?:\S+))")


def _parse_dev_log_line(line: str) -> Optional[Dict[str, Any]]:
    m = _DEV_LOG_RE.match(line)
    if not m:
        return None
    timestamp, kv_str = m.group(1), m.group(2)
    entry: Dict[str, Any] = {"event": "llm.cache", "timestamp": timestamp, "source": "backend"}
    for km in _DEV_KV_RE.finditer(kv_str):
        key, val = km.group(1), km.group(2)
        if val == "true":
            entry[key] = True
        elif val == "false":
            entry[key] = False
        elif val == "undefined":
            entry[key] = None
        else:
            try:
                entry[key] = int(val)
            except ValueError:
                try:
                    entry[key] = float(val)
                except ValueError:
                    entry[key] = val
    return entry


def _read_cache_events(log_paths: List[Path], agent_id: Optional[str], since: Optional[timedelta]) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    cutoff = datetime.now(timezone.utc) - since if since else None

    for log_path in log_paths:
        is_backend = "backend" in log_path.name
        with open(log_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                entry: Optional[Dict[str, Any]] = None
                try:
                    parsed = json.loads(line)
                    if not isinstance(parsed, dict):
                        continue
                    entry = parsed
                    if entry and entry.get("event") != "llm.cache":
                        entry = None
                except json.JSONDecodeError:
                    if "llm.cache" in line:
                        entry = _parse_dev_log_line(line)

                if entry is None:
                    continue

                if is_backend and "source" not in entry:
                    entry["source"] = "backend"

                if agent_id:
                    eid = entry.get("agent_id") or ""
                    if not str(eid).startswith(agent_id):
                        continue

                if cutoff:
                    ts_str = entry.get("timestamp", "")
                    try:
                        ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
                        if ts < cutoff:
                            continue
                    except (ValueError, TypeError):
                        pass

                events.append(entry)

    events.sort(key=lambda e: e.get("timestamp", ""))
    return events


def _group_by_agent(events: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for e in events:
        aid = e.get("agent_id") or "unbound"
        groups[aid].append(e)
    return dict(groups)


def _fmt_tokens(n: int) -> str:
    if n >= 1000:
        return f"{n:,}"
    return str(n)


def _cache_stats(e: Dict[str, Any]) -> Dict[str, int | str]:
    """Return provider-correct prompt-cache totals for a logged LLM call."""
    cached_total = e.get("cache_total_input")
    if isinstance(cached_total, (int, float)) and cached_total > 0:
        total_input = int(cached_total)
        accounting = str(e.get("cache_accounting") or "logged")
    else:
        model = str(e.get("actual_model") or "")
        prompt = int(e.get("prompt_tokens", 0) or 0)
        read = int(e.get("cache_read", 0) or 0)
        write = int(e.get("cache_write", 0) or 0)
        if model.endswith("-claude"):
            total_input = prompt + read + write
            accounting = "exclusive"
        else:
            total_input = max(prompt, read + write)
            accounting = "inclusive"

    read = int(e.get("cache_read", 0) or 0)
    write = int(e.get("cache_write", 0) or 0)
    pct = round(read / total_input * 100) if total_input > 0 else 0
    uncached = max(total_input - read - write, 0)
    return {
        "total_input": total_input,
        "uncached_input": uncached,
        "cache_hit_pct": pct,
        "cache_accounting": accounting,
    }


def _render_tree(agent_id: str, events: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    total_read = 0
    total_write = 0
    total_prompt = 0
    total_completion = 0
    total_cache_input = 0
    claude_calls = 0
    waterfall_calls = 0

    lines.append(f"  Agent {agent_id[:12]}")

    for i, e in enumerate(events):
        is_last = i == len(events) - 1
        prefix = "  └── " if is_last else "  ├── "

        call_site = e.get("call_site", "unknown")
        source = e.get("source", "worker")
        if source == "backend":
            call_site = f"{call_site} [chat]"
        model = e.get("actual_model", "unknown")
        is_claude = e.get("is_claude", False)
        cache_read = e.get("cache_read", 0) or 0
        cache_write = e.get("cache_write", 0) or 0
        cache = _cache_stats(e)
        cache_pct = cache["cache_hit_pct"]
        prompt = e.get("prompt_tokens", 0) or 0
        completion = e.get("completion_tokens", 0) or 0

        total_read += cache_read
        total_write += cache_write
        total_prompt += prompt
        total_completion += completion
        total_cache_input += int(cache["total_input"])
        if is_claude:
            claude_calls += 1
        else:
            waterfall_calls += 1

        if is_claude:
            model_short = model.replace("-claude", "") + " ↑claude"
        else:
            model_short = model

        cache_str = f"read={_fmt_tokens(cache_read)} write={_fmt_tokens(cache_write)} → {cache_pct}% hit"
        lines.append(f"{prefix}{call_site:<20} {model_short:<28} Cache: {cache_str}")

    total_pct = round(total_read / total_cache_input * 100) if total_cache_input > 0 else 0
    cost_note = "$0" if waterfall_calls == 0 else f"${(total_prompt * 3 + total_completion * 15) / 1_000_000:.4f}"

    lines.append("")
    lines.append(
        f"  Totals: read={_fmt_tokens(total_read)} write={_fmt_tokens(total_write)} "
        f"→ {total_pct}% hit | {len(events)} LLM calls "
        f"({claude_calls} claude, {waterfall_calls} waterfall) | {cost_note}"
    )
    return "\n".join(lines)


def _render_json(groups: Dict[str, List[Dict[str, Any]]]) -> str:
    out = {}
    for agent_id, events in groups.items():
        total_read = sum(e.get("cache_read", 0) or 0 for e in events)
        total_write = sum(e.get("cache_write", 0) or 0 for e in events)
        total_input = sum(int(_cache_stats(e)["total_input"]) for e in events)
        out[agent_id] = {
            "calls": [
                {
                    "call_site": e.get("call_site"),
                    "model": e.get("actual_model"),
                    "is_claude": e.get("is_claude", False),
                    "prompt_tokens": e.get("prompt_tokens", 0),
                    "completion_tokens": e.get("completion_tokens", 0),
                    "cache_read": e.get("cache_read", 0),
                    "cache_write": e.get("cache_write", 0),
                    "cache_hit_pct": _cache_stats(e)["cache_hit_pct"],
                    "cache_total_input": _cache_stats(e)["total_input"],
                    "cache_accounting": _cache_stats(e)["cache_accounting"],
                }
                for e in events
            ],
            "totals": {
                "cache_read": total_read,
                "cache_write": total_write,
                "cache_hit_pct": round(total_read / total_input * 100) if total_input > 0 else 0,
                "llm_calls": len(events),
            },
        }
    return json.dumps(out, indent=2)


def main() -> None:
    args = _parse_args()
    if not args.agent_id and not args.all:
        print("Usage: agent_cache.py <agent_id> | --all [--since 5m]", file=sys.stderr)
        sys.exit(1)

    log_paths = _find_log_files(args.log)
    since = _parse_since(args.since) if args.all else None
    events = _read_cache_events(log_paths, args.agent_id, since)

    if not events:
        print("No llm.cache events found" + (f" for {args.agent_id}" if args.agent_id else ""), file=sys.stderr)
        print(f"  Log files: {', '.join(str(p) for p in log_paths)}", file=sys.stderr)
        print("  Hint: ensure the worker/backend is running with updated code that emits llm.cache events", file=sys.stderr)
        sys.exit(1)

    groups = _group_by_agent(events)

    if args.json:
        print(_render_json(groups))
        return

    print()
    print("=" * 70)
    print("  Agent Cache Report")
    print("=" * 70)
    print()

    for agent_id, agent_events in groups.items():
        print(_render_tree(agent_id, agent_events))
        print()

    if len(groups) > 1:
        all_events = [e for evts in groups.values() for e in evts]
        total_read = sum(e.get("cache_read", 0) or 0 for e in all_events)
        total_write = sum(e.get("cache_write", 0) or 0 for e in all_events)
        total_input = sum(int(_cache_stats(e)["total_input"]) for e in all_events)
        total_pct = round(total_read / total_input * 100) if total_input > 0 else 0
        print(
            f"  Grand total: read={_fmt_tokens(total_read)} write={_fmt_tokens(total_write)} "
            f"→ {total_pct}% hit | {len(all_events)} LLM calls across {len(groups)} agents"
        )
        print()


if __name__ == "__main__":
    main()
