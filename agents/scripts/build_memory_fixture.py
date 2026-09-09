#!/usr/bin/env python3
"""Build a planner-memory fixture from archived bundles.

A memory fixture is a small JSON file of pre-compressed history rows that a
benchmark loads into its isolated stack's PlannerMemory table before the run
(``environment.memory_fixtures`` in tasks.json). Rows are built from real
passing bundles in the trace archive: transcript -> compressor -> record.

Usage:
    python scripts/build_memory_fixture.py --name blue-bottle-ferry-pickup-v1 \
        --bundle-id 1cba6647-b233-42f2-aafe-40fd6729494b [--bundle-id ...]
    python scripts/build_memory_fixture.py --name x --bundle-id ... --dry-run   # print, do not write

Output: agents/benchmarks/fixtures/memory/<name>.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

FIXTURE_DIR = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory"


def fixture_path(name: str) -> Path:
    return FIXTURE_DIR / f"{name}.json"


def load_fixture(name: str) -> dict:
    path = fixture_path(name)
    if not path.exists():
        raise FileNotFoundError(f"memory fixture not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


async def _build_row(bundle_id: str, *, model: str | None, semaphore: asyncio.Semaphore) -> dict:
    from providers.planner_memory import COMPRESSOR_VERSION, compress_transcript, load_bundle_transcript
    from providers.planner_memory.bundle import read_bundle_json

    async with semaphore:
        transcript = await asyncio.to_thread(load_bundle_transcript, bundle_id)
        if transcript is None:
            raise RuntimeError(f"bundle {bundle_id} has no readable transcript")
        if transcript.outcome != "passed":
            raise RuntimeError(
                f"bundle {bundle_id} did not complete ({transcript.outcome_note or transcript.outcome}); only completed runs become memories"
            )
        manifest = await asyncio.to_thread(read_bundle_json, bundle_id, "manifest.json.gz.enc") or {}
        run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
        benchmark = manifest.get("benchmark_result") if isinstance(manifest.get("benchmark_result"), dict) else {}
        record = await compress_transcript(transcript, model=model)
    print(
        f"  compressed {bundle_id[:8]} ({transcript.benchmark_task_name}): "
        f"{len(record.critical_path)} steps, {len(record.detours)} detours",
        flush=True,
    )
    return {
        "id": bundle_id,
        "goal": transcript.goal,
        "benchmark_task_name": transcript.benchmark_task_name,
        "passed": benchmark.get("passed") if isinstance(benchmark.get("passed"), bool) else None,
        "root_status": run.get("root_status"),
        "world_model_mode": manifest.get("world_model_mode") or "real",
        "agent_created_at": run.get("root_created_at"),
        "critical_path": record.model_dump(),
        "compressor_version": COMPRESSOR_VERSION,
        "source": {"bundle": bundle_id, "rows_in": len(transcript.rows), "rows_total": transcript.total_rows},
    }


async def build_rows(bundle_ids: list[str], *, model: str | None, concurrency: int = 4) -> list[dict]:
    semaphore = asyncio.Semaphore(max(1, concurrency))
    return list(await asyncio.gather(*(_build_row(b, model=model, semaphore=semaphore) for b in bundle_ids)))


def write_fixture(name: str, rows: list[dict], *, description: str) -> Path:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    path = fixture_path(name)
    payload = {
        "name": name,
        "description": description,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", required=True)
    parser.add_argument("--bundle-id", action="append", required=True, dest="bundle_ids")
    parser.add_argument("--description", default="")
    parser.add_argument("--model", default=None, help="Rose pool for the compressor (default: config)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()
    os.environ.setdefault("TRACE_ARCHIVE_BACKEND", "r2")
    rows = asyncio.run(build_rows(args.bundle_ids, model=args.model, concurrency=args.concurrency))
    if args.dry_run:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0
    path = write_fixture(args.name, rows, description=args.description)
    print(f"wrote {path} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
