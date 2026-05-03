"""Print an agent's LLM context exactly as it was sent to the model.

Reads the dumps written by `helpers.llm.dump_llm_context` to
``<repo_root>/.llm-dumps/<agent_id>/<ts>-<span_id>-<call_site>.json`` and
emits them as one plain-text chunk per LLM call — no markdown, no truncation,
no decoration. Each turn is delimited by a fixed-width separator and a single
ROLE/CALL_SITE header line so it can be diffed across iterations.

Usage:
    python benchmarks/agent_context.py <agent_id>                   # all calls, in time order
    python benchmarks/agent_context.py <agent_id> --call-site explore_agent
    python benchmarks/agent_context.py <agent_id> --span d92418e460f9
    python benchmarks/agent_context.py <agent_id> --iter 12         # nth dump only (1-indexed)
    python benchmarks/agent_context.py <agent_id> --list            # one-line summary per dump
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
DUMP_DIR = REPO_ROOT / ".llm-dumps"
SEP = "=" * 100
SUB = "-" * 100


def find_dumps(agent_id: str) -> List[Path]:
    base = DUMP_DIR / agent_id
    if not base.is_dir():
        return []
    return sorted(base.glob("*.json"), key=lambda p: p.name)


def parse_dump_filename(p: Path) -> Dict[str, str]:
    # <ts_ms>-<span_id>-<call_site>.json
    stem = p.stem
    parts = stem.split("-", 2)
    return {
        "ts_ms": parts[0] if len(parts) > 0 else "",
        "span_id": parts[1] if len(parts) > 1 else "",
        "call_site": parts[2] if len(parts) > 2 else "",
    }


def render_content(content: Any) -> str:
    """Flatten Anthropic-style content blocks into plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content)
    out: List[str] = []
    for c in content:
        if not isinstance(c, dict):
            out.append(str(c))
            continue
        t = c.get("type")
        if t == "text":
            out.append(c.get("text", ""))
        elif t == "tool_use":
            name = c.get("name", "?")
            inp = c.get("input", {})
            out.append(f"[tool_use name={name} input={json.dumps(inp, ensure_ascii=False)}]")
        elif t == "tool_result":
            tc = c.get("content", "")
            if isinstance(tc, list):
                tc = "\n".join(
                    x.get("text", json.dumps(x, ensure_ascii=False)) if isinstance(x, dict) else str(x)
                    for x in tc
                )
            tcid = c.get("tool_use_id", "")
            out.append(f"[tool_result tool_use_id={tcid}]\n{tc}")
        elif t == "image":
            src = c.get("source", {})
            out.append(f"[image media_type={src.get('media_type','?')} bytes={len(str(src.get('data','')))}]")
        else:
            out.append(json.dumps(c, ensure_ascii=False))
    return "\n".join(out)


def render_dump(p: Path, idx: int) -> str:
    meta = parse_dump_filename(p)
    with p.open() as f:
        d = json.load(f)
    msgs: List[Dict[str, Any]] = d.get("messages", [])
    model = d.get("model", "?")
    header = (
        f"{SEP}\n"
        f"DUMP #{idx}  call_site={meta['call_site']}  span={meta['span_id']}  "
        f"model={model}  msgs={len(msgs)}  bytes={p.stat().st_size}\n"
        f"file={p.name}\n"
        f"{SEP}"
    )
    parts: List[str] = [header]
    for m in msgs:
        role = (m.get("role") or "?").upper()
        body = render_content(m.get("content", ""))
        parts.append(f"{SUB}\n{role}\n{SUB}\n{body}")
    return "\n".join(parts)


def list_dumps(dumps: List[Path]) -> None:
    for i, p in enumerate(dumps, 1):
        meta = parse_dump_filename(p)
        with p.open() as f:
            d = json.load(f)
        msgs = d.get("messages", [])
        size = p.stat().st_size
        print(
            f"{i:3d}  {meta['ts_ms']}  span={meta['span_id']}  "
            f"call_site={meta['call_site']:<22}  msgs={len(msgs):2d}  bytes={size}"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("agent_id")
    ap.add_argument("--call-site", default=None, help="Filter by call_site")
    ap.add_argument("--span", default=None, help="Filter by span_id")
    ap.add_argument("--iter", type=int, default=None, help="Only print the N-th dump (1-indexed) after filtering")
    ap.add_argument("--list", action="store_true", help="One-line summary per dump, no body")
    args = ap.parse_args()

    dumps = find_dumps(args.agent_id)
    if not dumps:
        print(f"No dumps found at {DUMP_DIR / args.agent_id}", file=sys.stderr)
        return 1

    if args.call_site:
        dumps = [p for p in dumps if parse_dump_filename(p)["call_site"] == args.call_site]
    if args.span:
        dumps = [p for p in dumps if parse_dump_filename(p)["span_id"].startswith(args.span)]

    if not dumps:
        print("No dumps match the filters.", file=sys.stderr)
        return 1

    if args.list:
        list_dumps(dumps)
        return 0

    if args.iter is not None:
        if args.iter < 1 or args.iter > len(dumps):
            print(f"--iter {args.iter} out of range (have {len(dumps)} dumps)", file=sys.stderr)
            return 1
        dumps = [dumps[args.iter - 1]]

    for i, p in enumerate(dumps, 1):
        print(render_dump(p, i))

    return 0


if __name__ == "__main__":
    sys.exit(main())
