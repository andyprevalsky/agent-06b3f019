#!/usr/bin/env python
"""Time planner-RAG retrieval against the configured index (R2 or local).

    cd agents && source venv/bin/activate
    python scripts/time_planner_rag.py                 # 5 sample goals x 3 rounds
    python scripts/time_planner_rag.py --rounds 5 --goal "Book a flight to Paris"
    python scripts/time_planner_rag.py --json

Reports per-call timings (index_load / query / format / total) as p50 / p95 /
max, plus what each goal retrieved, so speedups can be compared run over run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(AGENTS_ROOT / ".env")

from providers.planner_rag import load_index_from_store, retrieve_reference_plans, store  # noqa: E402

DEFAULT_GOALS = [
    "Find the current population of Tokyo and New York City and multiply them together",
    "Book me the cheapest nonstop flight from SFO to CDG next month and send me the confirmation",
    "Call the dentist and reschedule my appointment to next Tuesday afternoon",
    "Research the top 5 competitors of Notion and write a comparison table",
    "Order a large pepperoni pizza from Domino's for delivery tonight",
]


def _pct(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round((pct / 100.0) * (len(ordered) - 1))))
    return ordered[idx]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--goal", action="append", default=[], help="Goal(s) to time (default: 5 samples)")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--user-id", default="1f85ff25-6e29-4c1b-8739-f917bd101a30")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    goals = args.goal or DEFAULT_GOALS

    backend = store.storage_backend()
    cold_started = time.perf_counter()
    index = load_index_from_store()
    cold_ms = (time.perf_counter() - cold_started) * 1000
    if index is None:
        print(f"[planner-rag] no index available on backend={backend}", file=sys.stderr)
        return 1
    print(
        f"[planner-rag] backend={backend} corpus={len(index)} generated_at={index.generated_at} cold_load={cold_ms:.1f}ms"
    )

    per_call: list[dict[str, float]] = []
    hits_by_goal: dict[str, list[dict[str, object]]] = {}
    for round_idx in range(args.rounds):
        for goal in goals:
            result = await retrieve_reference_plans(goal, user_id=args.user_id)
            per_call.append(dict(result.timing_ms))
            if round_idx == 0:
                hits_by_goal[goal] = [
                    {
                        "id": h.entry.root_agent_id,
                        "task": h.entry.benchmark_task_name,
                        "score": h.score,
                        "coverage": h.coverage,
                    }
                    for h in result.hits
                ]

    stats = {}
    for key in ("index_load", "query", "format", "total"):
        values = [c.get(key, 0.0) for c in per_call]
        stats[key] = {
            "p50_ms": round(statistics.median(values), 2),
            "p95_ms": round(_pct(values, 95), 2),
            "max_ms": round(max(values), 2),
            "mean_ms": round(statistics.fmean(values), 2),
        }
    summary = {
        "backend": backend,
        "corpus": len(index),
        "calls": len(per_call),
        "cold_load_ms": round(cold_ms, 1),
        "stats": stats,
    }
    if args.json:
        print(json.dumps({**summary, "hits": hits_by_goal}, indent=2))
        return 0
    print(f"calls={len(per_call)}")
    for key, row in stats.items():
        print(f"  {key:<11} p50={row['p50_ms']:>8.2f}ms  p95={row['p95_ms']:>8.2f}ms  max={row['max_ms']:>8.2f}ms")
    for goal, hits in hits_by_goal.items():
        print(
            f"- {goal[:70]!r}: {len(hits)} hit(s) "
            + ", ".join(f"{h['task'] or h['id'][:8]}({h['coverage']})" for h in hits)
        )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
