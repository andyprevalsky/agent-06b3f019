#!/usr/bin/env python3
"""Retrieval benchmark for planner memory, proven on labels through the production path.

Labeled sets (frozen under ``agents/benchmarks/fixtures/memory/``):
  * ``retrieval-labels.json`` (built once from the trace archive with
    ``--build-labels``): corpus rows = one archived run per (task, distinct goal
    text); positive queries = each task's ``title``/``description`` plus goal
    variants queried against the other variants (lineage-excluded); negatives =
    novel goals with no history.
  * ``retrieval-labels-extra.json``: 150 casual user-style paraphrases (2 per
    task, distinctive words avoided) and 60 hard negatives (same domain as a
    task, but replaying it would be wrong: different site or different action).

The corpus is written through ``PUT /api/planner-memory/:id`` (which embeds each
row: the voyage-4 goal vector) under
``benchmark_task_name="retrieval-bench:<task>"`` and removed afterwards. Every
query then runs the exact production path: backend semantic search →
``select_hits`` (top 3 distinct completed runs at cosine >= 0.70).

Metrics per split (fit / held-out by task hash): recall@1 (the top memory is the
right task), recall@3 (the right task is among the injected memories),
paraphrase recall, and negative / hard-negative injection rates.
``write_snapshot`` freezes each query's candidates;
tests/blackbox/memory_retrieval_bench.blackbox.py replays them through
``select_hits`` and pins the floors for $0.

``--trajectories benchmark|owner`` evaluates on real archived runs whose
relevance labels come from their actual executed plans
(benchmarks/memory_trajectory_labels.py).

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
EXTRA_LABELS_PATH = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory" / "retrieval-labels-extra.json"
TASKS_PATH = AGENTS_ROOT / "benchmarks" / "tasks.json"
BENCH_PREFIX = "retrieval-bench:"
SEARCH_LIMIT = 50
WRITE_CONCURRENCY = 12
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


def load_queries(labels: dict[str, Any]) -> list[dict[str, Any]]:
    extra = json.loads(EXTRA_LABELS_PATH.read_text(encoding="utf-8"))
    return list(labels["queries"]) + list(extra["paraphrases"]) + list(extra["hard_negatives"])


def equivalent_tasks(corpus: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Tasks whose corpus goals are byte-identical are interchangeable answers."""
    by_goal: dict[str, set[str]] = defaultdict(set)
    for row in corpus:
        by_goal[row["goal"].strip()].add(row["task"])
    equiv: dict[str, set[str]] = defaultdict(set)
    for tasks in by_goal.values():
        for task in tasks:
            equiv[task].update(tasks)
    return equiv


def _task_of(candidate: dict[str, Any]) -> str:
    return str(candidate.get("benchmark_task_name") or "")[len(BENCH_PREFIX) :]


def evaluate(items: list[dict[str, Any]], corpus: list[dict[str, Any]]) -> dict[str, Any]:
    """Pure metrics over per-query outcomes {query, candidates}, replayed through select_hits."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, select_hits

    equiv = equivalent_tasks(corpus)
    stats = {split: defaultdict(float) for split in ("fit", "held_out")}
    neg = defaultdict(float)
    for item in items:
        query = item["query"]
        tasks = [
            _task_of({"benchmark_task_name": h.benchmark_task_name})
            for h in select_hits(item["candidates"], DEFAULT_CONFIG)
        ]
        if query["positive_task"] is None:
            kind = "hard" if query["kind"] == "hard_negative" else "neg"
            neg[f"{kind}_total"] += 1
            neg[f"{kind}_fp"] += 1 if tasks else 0
            continue
        ok = equiv.get(query["positive_task"]) or {query["positive_task"]}
        s = stats[_split_for(query["positive_task"])]
        s["pos"] += 1
        s["recall1"] += 1 if tasks[:1] and tasks[0] in ok else 0
        s["recall3"] += 1 if any(t in ok for t in tasks) else 0
        s["injected"] += len(tasks)
        s["injected_ok"] += sum(1 for t in tasks if t in ok)
        if query["kind"] == "paraphrase":
            s["para"] += 1
            s["para_recall3"] += 1 if any(t in ok for t in tasks) else 0
    out: dict[str, Any] = {
        "negative_fp_rate": round(neg["neg_fp"] / (neg["neg_total"] or 1), 4),
        "hard_negative_fp_rate": round(neg["hard_fp"] / (neg["hard_total"] or 1), 4),
        "negatives": int(neg["neg_total"]),
        "hard_negatives": int(neg["hard_total"]),
    }
    for split, s in stats.items():
        pos = s["pos"] or 1
        out[split] = {
            "queries": int(s["pos"]),
            "recall@1": round(s["recall1"] / pos, 4),
            "recall@3": round(s["recall3"] / pos, 4),
            "paraphrase_recall@3": round(s["para_recall3"] / (s["para"] or 1), 4),
            "precision": round(s["injected_ok"] / (s["injected"] or 1), 4),
        }
    return out


async def run_bench(port: int, api_key: str) -> dict[str, Any]:
    from providers.planner_memory import client as backend
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    os.environ["BACKEND_API_URL"] = f"http://localhost:{port}"
    os.environ["BACKEND_API_KEY"] = api_key
    base_url = f"http://localhost:{port}"
    labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    queries = load_queries(labels)
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    corpus = labels["corpus"]
    write_sem = asyncio.Semaphore(WRITE_CONCURRENCY)

    async def put(client: httpx.AsyncClient, row: dict[str, Any]) -> None:
        body = {
            "goal": row["goal"],
            "benchmark_task_name": f"{BENCH_PREFIX}{row['task']}",
            "passed": True,
            "root_status": "COMPLETED",
        }
        async with write_sem:
            resp = await client.put(f"{base_url}/api/planner-memory/{row['id']}", headers=headers, json=body)
        resp.raise_for_status()

    async with httpx.AsyncClient(timeout=300) as client:
        await asyncio.gather(*(put(client, row) for row in corpus))
    print(f"indexed {len(corpus)} corpus rows (voyage-4 goal vectors)", flush=True)
    try:
        search_sem = asyncio.Semaphore(WRITE_CONCURRENCY)

        async def one(query: dict[str, Any]) -> dict[str, Any]:
            async with search_sem:
                found = await backend.search_memories(
                    query["query"],
                    user_id=None,
                    exclude_root_agent_id=query.get("exclude"),
                    limit=SEARCH_LIMIT,
                    passed_only=False,
                    min_similarity=DEFAULT_CONFIG.min_similarity,
                    timeout_s=60,
                )
            candidates = [
                {
                    "id": c["id"],
                    "goal": c["goal"],
                    "similarity": float(c["similarity"]),
                    "benchmark_task_name": c["benchmark_task_name"],
                    "passed": True,
                    "root_status": "COMPLETED",
                }
                for c in found
                if str(c.get("benchmark_task_name") or "").startswith(BENCH_PREFIX)
            ]
            return {"query": query, "candidates": candidates}

        items = await asyncio.gather(*(one(q) for q in queries))
    finally:
        async with httpx.AsyncClient(timeout=30) as client:
            for row in corpus:
                await client.delete(f"{base_url}/api/planner-memory/{row['id']}", headers=headers)
    metrics = evaluate(items, corpus)
    write_snapshot(labels, queries, items)
    return {"corpus_rows": len(corpus), "queries": len(queries), "config": DEFAULT_CONFIG.__dict__, "metrics": metrics}


SNAPSHOT_PATH = LABELS_PATH.parent / "retrieval-candidates.json"


def write_snapshot(labels: dict[str, Any], queries: list[dict[str, Any]], items: list[dict[str, Any]]) -> Path:
    """Freeze what the production path returned per query (goal texts stored once)."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    docs: dict[str, dict[str, Any]] = {}
    per_query: list[dict[str, Any]] = []
    for item in items:
        rows = []
        for c in item["candidates"]:
            docs.setdefault(c["id"], {"task": c["benchmark_task_name"], "goal": c["goal"]})
            rows.append([c["id"], round(c["similarity"], 6)])
        per_query.append({"query": item["query"], "candidates": rows})
    payload = {
        "description": (
            "Frozen retrieval-bench snapshot: for every labeled query, the candidates the production path returned "
            "(backend voyage-4 semantic search, [id, similarity]). Goal "
            "goal texts are stored once under `docs`. Rebuild with `python benchmarks/memory_retrieval_bench.py --port N`."
        ),
        "config": DEFAULT_CONFIG.__dict__,
        "corpus_rows": len(labels["corpus"]),
        "queries": len(queries),
        "docs": docs,
        "snapshot": per_query,
    }
    SNAPSHOT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return SNAPSHOT_PATH


def load_snapshot_items(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Inverse of write_snapshot: rebuild per-query items for evaluate()."""
    docs = snapshot["docs"]
    items = []
    for entry in snapshot["snapshot"]:
        candidates = [
            {
                "id": cid,
                "goal": docs[cid]["goal"],
                "similarity": sim,
                "benchmark_task_name": docs[cid]["task"],
                "passed": True,
                "root_status": "COMPLETED",
            }
            for cid, sim in entry["candidates"]
        ]
        items.append({"query": entry["query"], "candidates": candidates})
    return items


# ── real-trajectory evaluation (labels from real plans) ─────────────────────

TRAJECTORY_PREFIX = "retrieval-traj:"
TRAJECTORY_SNAPSHOT_PATH = LABELS_PATH.parent / "retrieval-trajectories-candidates.json"


def trajectory_metrics(items: list[dict[str, Any]], runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Relevance = each run's LLM-over-real-plans labels (memory_trajectory_labels); two slices per item.

    precision: share of injected memories that are useful; recall: queries with a
    useful run available whose injected set contains one; false injection: queries
    with no useful run that still get a memory. Only a run's labeled neighbors
    carry labels; injected memories outside them are reported as unlabeled.
    """
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, select_hits

    by_id = {run["id"]: run for run in runs}
    out: dict[str, Any] = {}
    for slice_name in ("all", "cross_task"):
        s: dict[str, float] = defaultdict(float)
        for item in items:
            query = by_id[item["id"]]
            relevant_ids = {
                rid
                for rid in query.get("relevant") or []
                if slice_name == "all" or query["task"] is None or by_id[rid]["task"] != query["task"]
            }
            hits = select_hits(item[slice_name]["candidates"], DEFAULT_CONFIG)
            useful = [h.id in relevant_ids for h in hits]
            s["queries"] += 1
            s["injected"] += len(hits)
            s["injected_useful"] += sum(useful)
            s["unlabeled_injections"] += sum(1 for h in hits if h.id not in (query.get("neighbors") or []))
            if relevant_ids:
                s["with_relevant"] += 1
                s["recall_hits"] += 1 if any(useful) else 0
            else:
                s["without_relevant"] += 1
                s["false_injections"] += 1 if hits else 0
        out[slice_name] = {
            "queries": int(s["queries"]),
            "with_relevant": int(s["with_relevant"]),
            "precision": round(s["injected_useful"] / (s["injected"] or 1), 4),
            "recall": round(s["recall_hits"] / (s["with_relevant"] or 1), 4),
            "false_injection_rate": round(s["false_injections"] / (s["without_relevant"] or 1), 4),
            "without_relevant": int(s["without_relevant"]),
            "avg_memories": round(s["injected"] / (s["queries"] or 1), 2),
            "unlabeled_injections": int(s["unlabeled_injections"]),
        }
    return out


async def run_trajectory_bench(port: int, api_key: str, runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Index every run's goal through PUT, then query each run's own goal (excluding itself)."""
    from providers.planner_memory import client as backend
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    os.environ["BACKEND_API_URL"] = f"http://localhost:{port}"
    os.environ["BACKEND_API_KEY"] = api_key
    base_url = f"http://localhost:{port}"
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    by_id = {run["id"]: run for run in runs}
    write_sem = asyncio.Semaphore(WRITE_CONCURRENCY)

    async def put(client: httpx.AsyncClient, run: dict[str, Any]) -> None:
        body = {
            "goal": run["goal"],
            "benchmark_task_name": f"{TRAJECTORY_PREFIX}{run['id']}",
            "passed": True,
            "root_status": "COMPLETED",
        }
        async with write_sem:
            resp = await client.put(f"{base_url}/api/planner-memory/{run['id']}", headers=headers, json=body)
        resp.raise_for_status()

    async with httpx.AsyncClient(timeout=300) as client:
        await asyncio.gather(*(put(client, run) for run in runs))
    print(f"indexed {len(runs)} trajectory runs", flush=True)
    search_sem = asyncio.Semaphore(WRITE_CONCURRENCY)
    try:

        async def one(run: dict[str, Any]) -> dict[str, Any]:
            async with search_sem:
                found = await backend.search_memories(
                    run["goal"],
                    user_id=None,
                    exclude_root_agent_id=run["id"],
                    limit=SEARCH_LIMIT,
                    passed_only=False,
                    min_similarity=DEFAULT_CONFIG.min_similarity,
                    timeout_s=60,
                )
            candidates = [
                {
                    "id": c["id"],
                    "goal": c["goal"],
                    "similarity": float(c["similarity"]),
                    "benchmark_task_name": by_id[c["id"]]["task"],
                    "passed": True,
                    "root_status": "COMPLETED",
                }
                for c in found
                if c["id"] in by_id
            ]
            cross = [c for c in candidates if run["task"] is None or c["benchmark_task_name"] != run["task"]]
            return {"id": run["id"], "all": {"candidates": candidates}, "cross_task": {"candidates": cross}}

        return await asyncio.gather(*(one(run) for run in runs))
    finally:
        async with httpx.AsyncClient(timeout=30) as client:
            for run in runs:
                await client.delete(f"{base_url}/api/planner-memory/{run['id']}", headers=headers)


def write_trajectory_snapshot(runs: list[dict[str, Any]], items: list[dict[str, Any]]) -> Path:
    """Freeze candidates ([id, similarity]) per slice; goals live in the labels file."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    compact = [
        {
            "id": item["id"],
            **{
                name: {"candidates": [[c["id"], round(c["similarity"], 6)] for c in item[name]["candidates"]]}
                for name in ("all", "cross_task")
            },
        }
        for item in items
    ]
    payload = {
        "description": (
            "Frozen real-trajectory snapshot: for each archived run in retrieval-trajectories.json, the "
            "production search candidates for its goal, with and without same-task runs. "
            "Rebuild with `python benchmarks/memory_retrieval_bench.py --port N --trajectories`."
        ),
        "config": DEFAULT_CONFIG.__dict__,
        "runs": len(runs),
        "snapshot": compact,
    }
    TRAJECTORY_SNAPSHOT_PATH.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return TRAJECTORY_SNAPSHOT_PATH


def load_trajectory_items(snapshot: dict[str, Any], runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {run["id"]: run for run in runs}

    def expand(rows: list[list[Any]]) -> list[dict[str, Any]]:
        return [
            {
                "id": cid,
                "goal": by_id[cid]["goal"],
                "similarity": sim,
                "benchmark_task_name": by_id[cid]["task"],
                "passed": True,
                "root_status": "COMPLETED",
            }
            for cid, sim in rows
        ]

    return [
        {
            "id": entry["id"],
            **{name: {"candidates": expand(entry[name]["candidates"])} for name in ("all", "cross_task")},
        }
        for entry in snapshot["snapshot"]
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--build-labels", action="store_true")
    parser.add_argument(
        "--trajectories",
        choices=["benchmark", "owner"],
        help="Evaluate on real archived runs labeled by their real plans (owner = local-only set, never frozen)",
    )
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
    if args.trajectories:
        from benchmarks.memory_trajectory_labels import COMMITTED_PATH, LOCAL_PATH

        api_key = os.environ.get("BACKEND_API_KEY") or ""
        if not api_key:
            print("BACKEND_API_KEY required")
            return 2
        path = COMMITTED_PATH if args.trajectories == "benchmark" else LOCAL_PATH
        runs = json.loads(path.read_text(encoding="utf-8"))["runs"]
        items = asyncio.run(run_trajectory_bench(args.port, api_key, runs))
        if args.trajectories == "benchmark":
            write_trajectory_snapshot(runs, items)
        metrics = trajectory_metrics(items, runs)
        print(json.dumps({"set": args.trajectories, "runs": len(runs), "metrics": metrics}, indent=1))
        return 0
    api_key = os.environ.get("BACKEND_API_KEY") or ""
    if not api_key:
        print("BACKEND_API_KEY required")
        return 2
    report = asyncio.run(run_bench(args.port, api_key))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"corpus={report['corpus_rows']} queries={report['queries']}")
    print(json.dumps(report["metrics"], indent=1))
    print(f"report: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
