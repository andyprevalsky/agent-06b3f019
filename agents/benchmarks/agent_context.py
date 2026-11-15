"""Print an agent's LLM context exactly as it was sent to the model.

Reads the local dumps written by `helpers.observability.dump_llm_context`,
or materializes production dump events from ClickHouse into
``<repo_root>/.llm-dumps/<agent_id>/<ts>-<span_id>-<call_site>.json``.
Emits one plain-text chunk per LLM call — no markdown, no truncation, no
decoration. Each turn is delimited by a fixed-width separator and a single
ROLE/CALL_SITE header line so it can be diffed across iterations.

Usage:
    python benchmarks/agent_context.py <agent_id>                   # all calls, in time order
    python benchmarks/agent_context.py <agent_id> --call-site explore_agent
    python benchmarks/agent_context.py <agent_id> --span d92418e460f9
    python benchmarks/agent_context.py <agent_id> --iter 12         # nth dump only (1-indexed)
    python benchmarks/agent_context.py <agent_id> --list            # one-line summary per dump
    python benchmarks/agent_context.py <agent_id> --from-clickhouse --list
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_ROOT = REPO_ROOT / "agents"
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))
DUMP_DIR = REPO_ROOT / ".llm-dumps"
SEP = "=" * 100
SUB = "-" * 100


def find_dumps(agent_id: str) -> List[Path]:
    base = DUMP_DIR / agent_id
    if not base.is_dir():
        return []
    return sorted(base.glob("*.json"), key=lambda p: p.name)


def parse_dump_filename(p: Path) -> Dict[str, str]:
    # <ts_ms>-<span_id>_<dump_id>-<call_site>.json (older dumps: <ts_ms>-<span_id>-<call_site>.json)
    stem = p.stem
    parts = stem.split("-", 2)
    span, _, dump_id = (parts[1] if len(parts) > 1 else "").partition("_")
    return {
        "ts_ms": parts[0] if len(parts) > 0 else "",
        "span_id": span,
        "dump_id": dump_id,
        "call_site": parts[2] if len(parts) > 2 else "",
    }


def _safe_filename_segment(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in value)[:64] or "unbound"


def _parse_fly_raw_message(raw: str) -> Optional[Dict[str, Any]]:
    try:
        outer = json.loads(raw)
    except json.JSONDecodeError:
        return None
    message = outer.get("message")
    if isinstance(message, str) and message.startswith("{"):
        try:
            inner = json.loads(message)
        except json.JSONDecodeError:
            return None
        if isinstance(inner, dict):
            return inner
    if isinstance(outer, dict):
        return outer
    return None


def _decode_payload(event: Dict[str, Any]) -> Dict[str, Any]:
    if event.get("payload_encoding") != "gzip+base64":
        raise ValueError(f"unsupported payload encoding: {event.get('payload_encoding')}")
    compressed = base64.b64decode(event["payload_gzip_b64"])
    payload_bytes = gzip.decompress(compressed)
    expected_sha = event.get("payload_sha256")
    actual_sha = hashlib.sha256(payload_bytes).hexdigest()
    if expected_sha and expected_sha != actual_sha:
        raise ValueError(f"payload sha mismatch: expected {expected_sha}, got {actual_sha}")
    return json.loads(payload_bytes.decode("utf-8"))


def _dump_path_for_payload(agent_id: str, payload: Dict[str, Any]) -> Path:
    ts_ms = payload.get("ts_ms")
    if not ts_ms:
        ts_ms = payload.get("ingested_ms")
    if not ts_ms:
        ts_ms = str(int(datetime.now(timezone.utc).timestamp() * 1000))
    dump_id = _safe_filename_segment(str(payload.get("dump_id") or payload.get("span_id") or "dump"))
    call_site = _safe_filename_segment(str(payload.get("call_site") or "unspecified"))
    return DUMP_DIR / agent_id / f"{ts_ms}-{dump_id}-{call_site}.json"


def materialize_dump_events(agent_id: str, events: List[Dict[str, Any]]) -> int:
    by_dump_id: Dict[str, Path] = {}
    written = 0
    for event in events:
        event_name = event.get("event")
        payload = _decode_payload(event)
        dump_id = str(payload.get("dump_id") or event.get("dump_id") or "")
        if event_name == "llm.context.dumped":
            payload.setdefault("ts_ms", str(int(datetime.now(timezone.utc).timestamp() * 1000)))
            path = _dump_path_for_payload(agent_id, payload)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2))
            if dump_id:
                by_dump_id[dump_id] = path
            written += 1
            continue
        if event_name == "llm.context.dump_updated" and dump_id and dump_id in by_dump_id:
            path = by_dump_id[dump_id]
            existing = json.loads(path.read_text())
            for key, value in payload.items():
                if key in {"config", "extra"} and isinstance(value, dict):
                    merged = dict(existing.get(key) or {})
                    merged.update(value)
                    existing[key] = merged
                elif key not in {"agent_id", "span_id", "dump_id"}:
                    existing[key] = value
            path.write_text(json.dumps(existing, ensure_ascii=False, default=str, indent=2))
    return written


def fetch_clickhouse_dump_events(agent_id: str, *, since_hours: int, limit: int) -> List[Dict[str, Any]]:
    from benchmarks.logs import (
        CLICKHOUSE_DATABASE,
        CLICKHOUSE_ENDPOINT,
        CLICKHOUSE_PASSWORD,
        CLICKHOUSE_TABLE,
        CLICKHOUSE_USER,
    )

    if not (CLICKHOUSE_ENDPOINT and CLICKHOUSE_USER and CLICKHOUSE_PASSWORD):
        raise RuntimeError("CLICKHOUSE_ENDPOINT, CLICKHOUSE_USER, and CLICKHOUSE_PASSWORD are required")

    table = f"{CLICKHOUSE_DATABASE}.{CLICKHOUSE_TABLE}"
    query = f"""
SELECT raw
     , toString(toUnixTimestamp64Milli(ingested_at)) AS ingested_ms
FROM {table}
WHERE ingested_at >= now64(3) - toIntervalHour({{since_hours:UInt32}})
  AND raw LIKE '%llm.context.dump%'
  AND raw LIKE concat('%', {{agent_id:String}}, '%')
ORDER BY ingested_at ASC
LIMIT {{limit:UInt32}}
FORMAT JSONEachRow
"""
    params = {
        "param_since_hours": str(since_hours),
        "param_agent_id": agent_id,
        "param_limit": str(limit),
    }
    with httpx.Client(timeout=30) as client:
        resp = client.post(
            CLICKHOUSE_ENDPOINT,
            params=params,
            content=query,
            auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        )
    if resp.status_code != 200:
        raise RuntimeError(f"ClickHouse API {resp.status_code}: {resp.text[:300]}")

    events: List[Dict[str, Any]] = []
    for line in resp.text.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        raw = row.get("raw")
        if not isinstance(raw, str):
            continue
        event = _parse_fly_raw_message(raw)
        if event and event.get("event") in {"llm.context.dumped", "llm.context.dump_updated"}:
            if row.get("ingested_ms"):
                event["ingested_ms"] = row["ingested_ms"]
            events.append(event)
    return events


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
    ap.add_argument("--from-clickhouse", action="store_true", help="Fetch prod dump events from ClickHouse first")
    ap.add_argument("--since-hours", type=int, default=168, help="ClickHouse lookback window")
    ap.add_argument("--limit", type=int, default=1000, help="Max ClickHouse dump rows to fetch")
    args = ap.parse_args()

    if args.from_clickhouse:
        events = fetch_clickhouse_dump_events(args.agent_id, since_hours=args.since_hours, limit=args.limit)
        count = materialize_dump_events(args.agent_id, events)
        print(f"Materialized {count} dump(s) from ClickHouse into {DUMP_DIR / args.agent_id}", file=sys.stderr)

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
