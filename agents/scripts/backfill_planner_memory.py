#!/usr/bin/env python3
"""Backfill the PlannerMemory history table from the trace archive (one-off, idempotent).

Going forward every archive finalize writes its history row itself; this script
only fills in the bundles that were finalized before the table existed. It reads
each bundle's encrypted manifest (root goal, status, benchmark verdict, mode) and
upserts one row per bundle through the internal backend API. Rows are upserted
by root agent id, so re-running is safe.

Usage:
    python scripts/backfill_planner_memory.py --stats                 # read the archive, report counts, cache rows
    python scripts/backfill_planner_memory.py --backend https://navi-j9a9.onrender.com   # upsert cached rows
    python scripts/backfill_planner_memory.py --backend http://localhost:3001 --limit 100

The row cache (.context/planner-memory-backfill.jsonl) lets the archive read and
the backend write run separately.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

import httpx

AGENTS_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENTS_ROOT.parent
sys.path.insert(0, str(AGENTS_ROOT))

CACHE_PATH = REPO_ROOT / ".context" / "planner-memory-backfill.jsonl"


def read_rows(concurrency: int = 64) -> tuple[list[dict[str, Any]], Counter]:
    """Read every bundle manifest; return history rows + skip reasons."""
    os.environ.setdefault("TRACE_ARCHIVE_BACKEND", "r2")
    from helpers.trace_archive import list_archive_bundle_ids
    from providers.planner_memory.bundle import read_bundle_json

    ids = list_archive_bundle_ids()
    reasons: Counter = Counter()

    def one(bundle_id: str) -> Optional[dict[str, Any]]:
        try:
            manifest = read_bundle_json(bundle_id, "manifest.json.gz.enc")
        except Exception as exc:
            reasons[f"error:{type(exc).__name__}"] += 1
            return None
        if manifest is None:
            reasons["no_manifest"] += 1
            return None
        run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
        goal = run.get("root_goal")
        if not isinstance(goal, str) or not goal.strip():
            reasons["no_goal"] += 1
            return None
        if manifest.get("finalized") is False:
            reasons["not_finalized"] += 1
            return None
        benchmark = manifest.get("benchmark_result") if isinstance(manifest.get("benchmark_result"), dict) else {}
        task = manifest.get("benchmark_task_name")
        reasons["ok"] += 1
        return {
            "id": bundle_id,
            "goal": goal.strip(),
            "user_id": run.get("user_id") if isinstance(run.get("user_id"), str) else None,
            "benchmark_task_name": task if isinstance(task, str) and task else None,
            "root_status": run.get("root_status") if isinstance(run.get("root_status"), str) else None,
            "passed": benchmark.get("passed") if isinstance(benchmark.get("passed"), bool) else None,
            "world_model_mode": str(manifest.get("world_model_mode") or "real"),
            "agent_created_at": run.get("root_created_at") if isinstance(run.get("root_created_at"), str) else None,
        }

    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(concurrency) as pool:
        for index, row in enumerate(pool.map(one, ids), start=1):
            if row:
                rows.append(row)
            if index % 10000 == 0:
                print(f"  {index}/{len(ids)} manifests read ({time.perf_counter() - started:.0f}s)", flush=True)
    return rows, reasons


def write_cache(rows: list[dict[str, Any]]) -> Path:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return CACHE_PATH


def load_cache() -> list[dict[str, Any]]:
    if not CACHE_PATH.exists():
        raise FileNotFoundError(f"{CACHE_PATH} missing; run --stats first")
    return [json.loads(line) for line in CACHE_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarize(rows: list[dict[str, Any]], reasons: Counter) -> dict[str, Any]:
    real = [r for r in rows if r["world_model_mode"] == "real"]
    benchmark = [r for r in real if r["benchmark_task_name"]]
    return {
        "bundles_scanned": sum(reasons.values()),
        "history_rows": len(rows),
        "eligible_real_world": len(real),
        "benchmark_rows": len(benchmark),
        "private_rows": len(real) - len(benchmark),
        "passed_rows": sum(
            1 for r in real if r["passed"] is True or (r["passed"] is None and r["root_status"] == "COMPLETED")
        ),
        "distinct_benchmark_tasks": len({r["benchmark_task_name"] for r in benchmark}),
        "distinct_goals": len({" ".join(r["goal"].split()) for r in real}),
        "skip_reasons": dict(reasons),
    }


async def upsert(rows: list[dict[str, Any]], *, backend: str, api_key: str, concurrency: int = 16) -> Counter:
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    outcome: Counter = Counter()
    semaphore = asyncio.Semaphore(concurrency)

    async def one(client: httpx.AsyncClient, row: dict[str, Any]) -> None:
        body = {k: v for k, v in row.items() if k != "id"}
        async with semaphore:
            try:
                resp = await client.put(f"{backend}/api/planner-memory/{row['id']}", headers=headers, json=body)
                outcome["ok" if resp.status_code == 200 else f"http_{resp.status_code}"] += 1
            except Exception as exc:
                outcome[f"error:{type(exc).__name__}"] += 1

    async with httpx.AsyncClient(timeout=30) as client:
        await asyncio.gather(*(one(client, row) for row in rows))
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stats", action="store_true", help="Read the archive, print counts, write the row cache")
    parser.add_argument("--backend", help="Backend base URL to upsert cached rows into")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=64)
    args = parser.parse_args()
    if args.stats:
        rows, reasons = read_rows(args.concurrency)
        path = write_cache(rows)
        print(json.dumps(summarize(rows, reasons), indent=1))
        print(f"cache: {path}")
        return 0
    if args.backend:
        api_key = os.environ.get("BACKEND_API_KEY") or ""
        if not api_key:
            print("BACKEND_API_KEY required")
            return 2
        rows = load_cache()
        rows = [r for r in rows if r["world_model_mode"] == "real"]
        if args.limit:
            rows = rows[: args.limit]
        outcome = asyncio.run(upsert(rows, backend=args.backend.rstrip("/"), api_key=api_key))
        print(json.dumps({"rows": len(rows), "outcome": dict(outcome)}, indent=1))
        return 0 if outcome.get("ok") == len(rows) else 1
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
