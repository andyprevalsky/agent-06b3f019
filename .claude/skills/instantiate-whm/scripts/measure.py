#!/usr/bin/env python3
"""Measure WMH provider prompt-cache and DEMO response-cache rates for one run.

Provider: llm.cache rows with call_site=wmh_world_model_distribution_v1;
denominator cache_total_input (never cache_uncached_input). Cache writes are
not reads. DEMO: llm.cache.replay (hit) / llm.cache.miss / llm.cache.stored
for the same call site. Cancelled native attempts have no final usage.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Untimed (policies v1/v2) and timed world-clock (policy v3) distribution calls.
CALL_SITES = ("wmh_world_model_distribution_v1", "wmh_world_model_timed_distribution_v1")
FIELD = re.compile(r"(\w+)=('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|\S+)")
EVENT = re.compile(r"\[\s*\w+\s*\]\s+(\S+)\s+(.*)$")


def parse(line: str) -> tuple[str, dict[str, str]] | None:
    match = EVENT.search(line)
    if match:
        event, rest = match.group(1), match.group(2)
    else:
        stripped = line.strip()
        if not stripped.startswith("{"):
            return None
        try:
            record = json.loads(stripped)
        except ValueError:
            return None
        event = str(record.get("event", ""))
        return event, {k: str(v) for k, v in record.items()}
    fields = {}
    for key, value in FIELD.findall(rest):
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            value = value[1:-1]
        fields[key] = value
    return event, fields


def measure(paths: list[Path]) -> dict:
    metered = []
    demo = {"replay": 0, "miss": 0, "stored": 0, "write_only": 0, "lookup_errors": 0}
    seen_metered = set()
    for path in paths:
        for line in path.read_text(errors="replace").splitlines():
            parsed = parse(line)
            if not parsed:
                continue
            event, fields = parsed
            if fields.get("call_site") not in CALL_SITES:
                continue
            if event == "llm.cache":
                identity = (path.name, line)
                if identity in seen_metered:
                    continue
                seen_metered.add(identity)
                metered.append(fields)
            elif event == "llm.cache.replay":
                demo["replay"] += 1
            elif event == "llm.cache.miss":
                demo["miss"] += 1
            elif event == "llm.cache.stored":
                demo["stored"] += 1
            elif event == "llm.cache.write_only":
                demo["write_only"] += 1
    total = sum(int(r.get("cache_total_input", 0) or 0) for r in metered)
    read = sum(int(r.get("cache_read", 0) or 0) for r in metered)
    write = sum(int(r.get("cache_write", 0) or 0) for r in metered)
    output = sum(int(r.get("completion_tokens", 0) or 0) for r in metered)
    lookups = demo["replay"] + demo["miss"]
    return {
        "call_sites": list(CALL_SITES),
        "provider_metered_requests": len(metered),
        "provider_requests_with_cached_input": sum(1 for r in metered if int(r.get("cache_read", 0) or 0) > 0),
        "provider_cached_input_tokens": read,
        "provider_total_input_tokens": total,
        "provider_cache_write_tokens": write,
        "provider_output_tokens": output,
        "provider_token_hit_pct": round(100.0 * read / total, 6) if total else None,
        # GPT-5.6+ (incl. gpt-6.1-sol) bills cache writes at 1.25x and reads at 0.05x.
        "provider_plain_input_tokens": max(total - read - write, 0),
        "provider_input_cost_vs_no_cache": (
            round((0.05 * read + 1.25 * write + max(total - read - write, 0)) / total, 4) if total else None
        ),
        "actual_models": sorted({r.get("actual_model", "") for r in metered}),
        "demo_hits": demo["replay"],
        "demo_misses": demo["miss"],
        "demo_lookups": lookups,
        "demo_hit_pct": round(100.0 * demo["replay"] / lookups, 6) if lookups else None,
        "demo_stores": demo["stored"],
        "demo_write_only": demo["write_only"],
        "metered_rows": metered,
    }


def native_attempts(session_dir: Path) -> dict:
    """Count native prediction attempts; cancelled attempts have no final usage."""
    attempts, errors, proposals = 0, {}, 0
    for path in sorted(session_dir.glob("*.json")):
        record = json.loads(path.read_text())
        if record.get("schema") == "rose.wmh_outcome_selection.v1":
            proposals += 1
            continue
        if record.get("schema") != "rose.wmh_native_prediction.v1":
            continue
        attempts += 1
        error = record.get("error")
        if isinstance(error, dict):
            errors[error.get("type", "unknown")] = errors.get(error.get("type", "unknown"), 0) + 1
    return {
        "native_attempts": attempts,
        "native_successful_responses": attempts - sum(errors.values()),
        "native_errors_by_type": errors,
        "validated_proposals": proposals,
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    session = None
    if args and args[0] == "--session-dir":
        session = Path(args[1])
        args = args[2:]
    result = measure([Path(arg) for arg in args])
    if session is not None:
        result.update(native_attempts(session))
    print(json.dumps(result, indent=1, sort_keys=True))
