#!/usr/bin/env python3
"""Retrieval benchmark for planner memory: which scoring strategy + cutoff is best, proven on labels.

Labeled set (frozen in ``agents/benchmarks/fixtures/memory/retrieval-labels.json``,
built once from the trace archive with ``--build-labels``):
  * corpus rows: one archived run per (task, distinct goal text) — real root
    goals of benchmark runs (the runner appends task-specific constraints, so
    many tasks have several goal variants);
  * queries with positives: every task's human-written ``title`` and
    ``description`` from tasks.json, plus each goal variant queried against the
    *other* variants of the same task (lineage-excluded, WMH style);
  * negative queries: novel goals with no history at all (must return nothing).

The corpus is loaded into the local backend's history table under
``benchmark_task_name="retrieval-bench:<task>"`` and removed afterwards, so the
exact production search path (Postgres FTS + trigram + in-process scoring) is
what gets measured.

Metrics per strategy and cutoff: recall@1, recall@3, precision@k, F1 at the
cutoff, and negative-query false-positive rate. The winner (max F1 on the fit
split, verified on held-out) is what ``RetrievalConfig`` ships with; the
cemented test (tests/blackbox/memory_retrieval_bench.blackbox.py) replays the
frozen labels through pure scoring and pins the winner.

Usage:
    python benchmarks/memory_retrieval_bench.py --build-labels          # from R2 (needs creds), writes the labels file
    python benchmarks/memory_retrieval_bench.py --port 3001             # evaluate against the local backend
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import httpx

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

LABELS_PATH = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory" / "retrieval-labels.json"
TASKS_PATH = AGENTS_ROOT / "benchmarks" / "tasks.json"
BENCH_PREFIX = "retrieval-bench:"
THRESHOLDS = [round(0.05 * i, 2) for i in range(2, 19)]  # 0.10 .. 0.90
NEGATIVE_QUERIES = [
    "Draft a two-paragraph thank-you note to my landlord for fixing the heater and email it to me as plain text.",
    "Book me a haircut at a barbershop near the Ferry Building in San Francisco for Saturday morning.",
    "Translate my resume into Spanish and keep the formatting identical.",
    "Find three used road bikes under $600 within 20 miles of Oakland and summarize their condition.",
    "Set up a weekly reminder to water the plants every Sunday at 9am.",
    "Compare the last three iPhone models on battery life and camera quality in a short table.",
    "Write a haiku about the fog in San Francisco.",
    "Cancel my gym membership at 24 Hour Fitness and confirm the cancellation date.",
    "What is the capital of Mongolia and what is its population?",
    "Plan a four-day itinerary for Kyoto in November with one temple per day.",
    "Renew my passport at the downtown post office and tell me the earliest appointment.",
    "Summarize the plot of The Count of Monte Cristo in five bullet points.",
]


def _split_for(task: str) -> str:
    return "fit" if int(hashlib.sha256(task.encode()).hexdigest(), 16) % 2 == 0 else "held_out"


# ── labels ──────────────────────────────────────────────────────────────────


def build_labels(limit_per_task: int = 14) -> dict[str, Any]:
    """Read archived benchmark runs and freeze a labeled corpus (R2 credentials required)."""
    os.environ.setdefault("TRACE_ARCHIVE_BACKEND", "r2")
    from concurrent.futures import ThreadPoolExecutor

    from helpers.trace_archive import list_r2_bundle_ids, r2_bucket, r2_client
    from providers.planner_memory.bundle import read_bundle_json

    ids = list_r2_bundle_ids()
    client = r2_client()
    bucket = r2_bucket()

    def public(bundle_id: str) -> tuple[str, str | None, str]:
        try:
            raw = client.get_object(Bucket=bucket, Key=f"trace-archive/{bundle_id}/manifest.public.json")["Body"].read()
            manifest = json.loads(raw)
            return bundle_id, manifest.get("benchmark_task_name"), str(manifest.get("generated_at") or "")
        except Exception:
            return bundle_id, None, ""

    by_task: dict[str, list[tuple[str, str]]] = defaultdict(list)
    with ThreadPoolExecutor(64) as pool:
        for bundle_id, task, generated in pool.map(public, ids):
            if task and not task.startswith("polar") and task not in {"archive-blackbox", "chat-mode"}:
                by_task[task].append((bundle_id, generated))
    selected = []
    for task, items in by_task.items():
        items.sort(key=lambda x: x[1], reverse=True)
        selected.extend((task, bundle_id) for bundle_id, _ in items[:limit_per_task])

    def goal_of(item: tuple[str, str]) -> dict[str, Any] | None:
        task, bundle_id = item
        try:
            manifest = read_bundle_json(bundle_id, "manifest.json.gz.enc") or {}
        except Exception as exc:  # a corrupted bundle (e.g. ciphertext hash mismatch) must not sink the labels
            print(f"  skip {bundle_id[:8]} ({task}): {str(exc)[:80]}", flush=True)
            return None
        run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
        goal = run.get("root_goal")
        if not isinstance(goal, str) or not goal.strip():
            return None
        return {"id": bundle_id, "task": task, "goal": goal.strip()}

    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(32) as pool:
        for row in pool.map(goal_of, selected):
            if row:
                rows.append(row)
    # One corpus row per (task, distinct goal text); keep the newest id.
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        seen.setdefault((row["task"], row["goal"]), row)
    corpus = list(seen.values())
    tasks = {t["name"]: t for t in json.loads(TASKS_PATH.read_text(encoding="utf-8"))}
    queries: list[dict[str, Any]] = []
    for task in sorted({r["task"] for r in corpus}):
        meta = tasks.get(task) or {}
        for field in ("title", "description"):
            text = meta.get(field)
            if isinstance(text, str) and len(text.split()) >= 3:
                queries.append({"query": text, "positive_task": task, "kind": field, "exclude": None})
        variants = [r for r in corpus if r["task"] == task]
        if len(variants) >= 2:
            for variant in variants[:3]:
                queries.append(
                    {"query": variant["goal"], "positive_task": task, "kind": "goal_variant", "exclude": variant["id"]}
                )
    for text in NEGATIVE_QUERIES:
        queries.append({"query": text, "positive_task": None, "kind": "negative", "exclude": None})
    return {"corpus": corpus, "queries": queries, "tasks": sorted({r["task"] for r in corpus})}


# ── evaluation ──────────────────────────────────────────────────────────────


async def _search(base_url: str, api_key: str, query: str, exclude: str | None) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30) as client:
        body: dict[str, Any] = {"goal": query, "limit": 50}
        if exclude:
            body["exclude_root_agent_id"] = exclude
        resp = await client.post(f"{base_url}/api/planner-memory/search", headers={"X-API-Key": api_key}, json=body)
        resp.raise_for_status()
        return [
            c
            for c in resp.json().get("candidates", [])
            if str(c.get("benchmark_task_name") or "").startswith(BENCH_PREFIX)
        ]


def evaluate(candidates_by_query: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> dict[str, Any]:
    """Pure scoring over fetched candidates: metrics for every strategy × cutoff."""
    from providers.planner_memory.retrieval import STRATEGIES, RetrievalConfig, candidate_features, rank_hits

    # Features do not depend on strategy/threshold: compute once per (query, candidate).
    prepared = []
    for query, candidates in candidates_by_query:
        max_fts = max((float(c.get("fts_rank") or 0.0) for c in candidates), default=0.0)
        prepared.append(
            (query, candidates, [candidate_features(query["query"], c, max_fts_rank=max_fts) for c in candidates])
        )
    results: dict[str, Any] = {}
    for strategy in STRATEGIES:
        for threshold in THRESHOLDS:
            config = RetrievalConfig(strategy=strategy, min_score=threshold, relative_floor=0.0, k=3, passed_only=False)
            stats = {"fit": defaultdict(float), "held_out": defaultdict(float)}
            for query, candidates, features in prepared:
                hits = rank_hits(candidates, features, config)
                hit_tasks = [str(h.benchmark_task_name or "")[len(BENCH_PREFIX) :] for h in hits]
                if query["positive_task"] is None:
                    for split in ("fit", "held_out"):
                        stats[split]["neg_total"] += 1
                        stats[split]["neg_fp"] += 1 if hits else 0
                    continue
                split = _split_for(query["positive_task"])
                s = stats[split]
                s["pos_total"] += 1
                s["recall1"] += 1 if hit_tasks[:1] == [query["positive_task"]] else 0
                s["recall3"] += 1 if query["positive_task"] in hit_tasks[:3] else 0
                s["returned"] += len(hits)
                s["relevant_returned"] += sum(1 for t in hit_tasks if t == query["positive_task"])
                s["empty"] += 1 if not hits else 0
            summary = {}
            for split, s in stats.items():
                pos = s["pos_total"] or 1
                precision = (s["relevant_returned"] / s["returned"]) if s["returned"] else 0.0
                recall = s["recall3"] / pos
                f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
                neg_fp_rate = (s["neg_fp"] / s["neg_total"]) if s["neg_total"] else 0.0
                # Objective: F1 with the negative false-positive rate as a penalty (a memory
                # that bleeds into unrelated goals is worse than a missed memory).
                summary[split] = {
                    "queries": int(s["pos_total"]),
                    "recall@1": round(s["recall1"] / pos, 4),
                    "recall@3": round(recall, 4),
                    "precision": round(precision, 4),
                    "f1": round(f1, 4),
                    "empty_rate": round(s["empty"] / pos, 4),
                    "negative_fp_rate": round(neg_fp_rate, 4),
                    "objective": round(f1 * (1.0 - neg_fp_rate), 4),
                }
            results[f"{strategy}@{threshold}"] = summary
    return results


def pick_winner(results: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    best = max(
        results.items(),
        key=lambda kv: (kv[1]["fit"]["objective"], kv[1]["fit"]["recall@1"], -float(kv[0].split("@")[1])),
    )
    return best


async def run_bench(port: int, api_key: str) -> dict[str, Any]:
    base_url = f"http://localhost:{port}"
    labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    corpus = labels["corpus"]
    async with httpx.AsyncClient(timeout=30) as client:
        for row in corpus:
            body = {
                "goal": row["goal"],
                "benchmark_task_name": f"{BENCH_PREFIX}{row['task']}",
                "passed": True,
                "root_status": "COMPLETED",
            }
            resp = await client.put(f"{base_url}/api/planner-memory/{row['id']}", headers=headers, json=body)
            resp.raise_for_status()
    try:
        fetched: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for query in labels["queries"]:
            fetched.append((query, await _search(base_url, api_key, query["query"], query.get("exclude"))))
        results = evaluate(fetched)
    finally:
        async with httpx.AsyncClient(timeout=30) as client:
            for row in corpus:
                await client.delete(f"{base_url}/api/planner-memory/{row['id']}", headers=headers)
    winner, metrics = pick_winner(results)
    write_snapshot(labels, fetched)
    return {
        "corpus_rows": len(corpus),
        "queries": len(labels["queries"]),
        "tasks": len(labels["tasks"]),
        "winner": winner,
        "winner_metrics": metrics,
        "results": results,
    }


SNAPSHOT_PATH = LABELS_PATH.parent / "retrieval-candidates.json"


def write_snapshot(labels: dict[str, Any], fetched: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> Path:
    """Freeze what the production search path returned per query, compactly (goal texts stored once)."""
    goals: dict[str, dict[str, Any]] = {}
    per_query: list[dict[str, Any]] = []
    for query, candidates in fetched:
        rows = []
        for c in candidates:
            goals.setdefault(str(c["id"]), {"task": c.get("benchmark_task_name"), "goal": c.get("goal")})
            rows.append(
                [
                    str(c["id"]),
                    round(float(c.get("fts_rank") or 0.0), 6),
                    round(float(c.get("trgm_similarity") or 0.0), 6),
                ]
            )
        per_query.append({"query": query, "candidates": rows})
    payload = {
        "description": (
            "Frozen retrieval-bench snapshot: for every labeled query, the candidate ids the production search path "
            "(Postgres FTS + trigram) returned with their Postgres-computed features [id, fts_rank, trgm_similarity]; "
            "goal texts are stored once under `goals`. Rebuild with `python benchmarks/memory_retrieval_bench.py --port N`."
        ),
        "corpus_rows": len(labels["corpus"]),
        "queries": len(labels["queries"]),
        "tasks": len(labels["tasks"]),
        "goals": goals,
        "snapshot": per_query,
    }
    SNAPSHOT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return SNAPSHOT_PATH


def load_snapshot_fetched(snapshot: dict[str, Any]) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Inverse of write_snapshot: rebuild (query, candidates) pairs for evaluate()."""
    goals = snapshot["goals"]
    fetched = []
    for item in snapshot["snapshot"]:
        candidates = [
            {
                "id": cid,
                "benchmark_task_name": goals[cid]["task"],
                "goal": goals[cid]["goal"],
                "fts_rank": fts,
                "trgm_similarity": trgm,
                "passed": True,
                "root_status": "COMPLETED",
            }
            for cid, fts, trgm in item["candidates"]
        ]
        fetched.append((item["query"], candidates))
    return fetched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--build-labels", action="store_true")
    parser.add_argument("--port", type=int, default=3001)
    parser.add_argument("--out", default=str(AGENTS_ROOT / "benchmarks" / "runs" / "memory-retrieval-bench.json"))
    args = parser.parse_args()
    if args.build_labels:
        labels = build_labels()
        LABELS_PATH.parent.mkdir(parents=True, exist_ok=True)
        LABELS_PATH.write_text(json.dumps(labels, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(
            f"wrote {LABELS_PATH}: {len(labels['corpus'])} corpus rows, {len(labels['queries'])} queries, {len(labels['tasks'])} tasks"
        )
        return 0
    api_key = os.environ.get("BACKEND_API_KEY") or ""
    if not api_key:
        print("BACKEND_API_KEY required")
        return 2
    report = asyncio.run(run_bench(args.port, api_key))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"corpus={report['corpus_rows']} queries={report['queries']} tasks={report['tasks']}")
    print("winner:", report["winner"], json.dumps(report["winner_metrics"], indent=1))
    top = sorted(report["results"].items(), key=lambda kv: -kv[1]["fit"]["objective"])[:12]
    for name, m in top:
        print(
            f"  {name:14} fit: obj={m['fit']['objective']:.3f} r@1={m['fit']['recall@1']:.3f} r@3={m['fit']['recall@3']:.3f} p={m['fit']['precision']:.3f} negfp={m['fit']['negative_fp_rate']:.2f} | held_out: obj={m['held_out']['objective']:.3f} r@1={m['held_out']['recall@1']:.3f} p={m['held_out']['precision']:.3f} negfp={m['held_out']['negative_fp_rate']:.2f}"
        )
    print(f"report: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
