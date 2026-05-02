#!/usr/bin/env python3
"""
loopx_extract_context.py

Pulls relevant messages from the current Claude Code chat transcript so /loopx
can run without forcing Claude to repeat context verbatim in the goal prompt.

Strategy:
1. Find the current session's jsonl: ~/.claude/projects/<encoded-cwd>/<most-recent>.jsonl
   (encoded-cwd is `$PWD` with `/` -> `-`)
2. Read user + assistant messages in order.
3. Filter:
   - last N turns unconditionally (--turns, default 6)
   - PLUS any earlier turn whose text contains any --query keyword (case-insensitive)
4. Write a markdown file with role-labeled sections.

Usage:
  python3 scripts/loopx_extract_context.py \
    --query "loopx skill bash" \
    --turns 8 \
    --output .context/loopx/context.md

Exit codes:
  0 ok
  2 no transcript found (caller should fall back to a manual context dump)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def encoded_cwd(cwd: str) -> str:
    return cwd.replace("/", "-")


def find_transcript(cwd: str) -> Path | None:
    base = Path.home() / ".claude" / "projects" / encoded_cwd(cwd)
    if not base.is_dir():
        return None
    candidates = [p for p in base.glob("*.jsonl") if p.is_file()]
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def extract_text(msg: dict) -> str:
    content = msg.get("content") or msg.get("message", {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                if c.get("type") == "text" and c.get("text"):
                    parts.append(c["text"])
                elif c.get("type") == "tool_use":
                    name = c.get("name", "tool")
                    parts.append(f"[tool_use: {name}]")
                elif c.get("type") == "tool_result":
                    parts.append("[tool_result]")
        return "\n".join(parts)
    return ""


def load_turns(jsonl_path: Path) -> list[dict]:
    turns = []
    with jsonl_path.open() as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t not in ("user", "assistant"):
                continue
            text = extract_text(obj)
            if not text.strip():
                continue
            turns.append({
                "role": t,
                "text": text,
                "timestamp": obj.get("timestamp", ""),
            })
    return turns


def filter_turns(turns: list[dict], query_terms: list[str], last_n: int) -> list[dict]:
    if not turns:
        return []
    keep_idx: set[int] = set()
    if last_n > 0:
        for i in range(max(0, len(turns) - last_n), len(turns)):
            keep_idx.add(i)
    if query_terms:
        lower_terms = [q.lower() for q in query_terms if q.strip()]
        for i, turn in enumerate(turns):
            if any(term in turn["text"].lower() for term in lower_terms):
                keep_idx.add(i)
    return [turns[i] for i in sorted(keep_idx)]


def render(turns: list[dict], goal: str | None) -> str:
    lines = ["# loopx context", ""]
    if goal:
        lines += [f"**Goal:** {goal}", ""]
    if not turns:
        lines += ["_(no relevant turns found)_"]
        return "\n".join(lines) + "\n"
    for turn in turns:
        ts = turn["timestamp"]
        role = turn["role"].upper()
        header = f"## {role} — {ts}" if ts else f"## {role}"
        lines += [header, "", turn["text"].strip(), ""]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", default="", help="Space-separated keywords to grep for")
    ap.add_argument("--turns", type=int, default=6, help="Always include the last N turns")
    ap.add_argument("--output", required=True, help="Output markdown path")
    ap.add_argument("--goal", default="", help="Optional goal string to embed in header")
    ap.add_argument("--cwd", default=os.getcwd(), help="Workspace cwd (defaults to current)")
    ap.add_argument("--max-chars", type=int, default=80_000,
                    help="Truncate each turn's text above this length")
    args = ap.parse_args()

    transcript = find_transcript(args.cwd)
    if transcript is None:
        sys.stderr.write(f"[loopx_extract_context] no transcript found for cwd={args.cwd}\n")
        return 2

    turns = load_turns(transcript)
    query_terms = [t for t in args.query.split() if t]
    selected = filter_turns(turns, query_terms, args.turns)

    for t in selected:
        if len(t["text"]) > args.max_chars:
            t["text"] = t["text"][: args.max_chars] + "\n\n…(truncated)"

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render(selected, args.goal))
    sys.stderr.write(
        f"[loopx_extract_context] transcript={transcript.name} "
        f"turns_total={len(turns)} kept={len(selected)} -> {out_path}\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
