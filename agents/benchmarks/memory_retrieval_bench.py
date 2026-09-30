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
``shortlist`` → the real judge LLM call → ``apply_verdict``.

Metrics per split (fit / held-out by task hash): recall@1 (the judge's single
injected memory is the right task), paraphrase recall@1, negative and
hard-negative false-positive rates. ``write_snapshot`` freezes each query's
candidates and judge verdict; tests/blackbox/memory_retrieval_bench.blackbox.py
replays it through ``shortlist``/``apply_verdict`` and pins the floors for $0.

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
JUDGE_CONCURRENCY = 4
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


def _disable_dump_archive() -> None:
    """Bench judge calls belong to no agent, so their LLM dumps are not archived.

    Archiving would otherwise POST each dump to the backend synchronously on the
    event loop (serializing judge calls ~1s apart under load) or, with async
    writes, keep the process alive at exit while the executor drains.
    """
    os.environ["TRACE_ARCHIVE_ENABLED"] = "0"


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
    """Pure metrics over per-query outcomes: {query, candidates, verdict}. Replays shortlist + verdict."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, JudgeVerdict, apply_verdict, shortlist

    equiv = equivalent_tasks(corpus)
    stats = {split: defaultdict(float) for split in ("fit", "held_out")}
    neg = defaultdict(float)
    for item in items:
        query = item["query"]
        hits = shortlist(item["candidates"], DEFAULT_CONFIG)
        verdict = item.get("verdict")
        chosen = apply_verdict(hits, JudgeVerdict.model_validate(verdict)) if hits and verdict else None
        chosen_task = str(chosen.benchmark_task_name or "")[len(BENCH_PREFIX) :] if chosen else None
        if query["positive_task"] is None:
            kind = "hard" if query["kind"] == "hard_negative" else "neg"
            neg[f"{kind}_total"] += 1
            neg[f"{kind}_fp"] += 1 if chosen else 0
            continue
        ok = equiv.get(query["positive_task"]) or {query["positive_task"]}
        s = stats[_split_for(query["positive_task"])]
        s["pos"] += 1
        correct = chosen_task in ok
        s["recall1"] += 1 if correct else 0
        s["shortlist_recall"] += (
            1 if any(str(h.benchmark_task_name or "")[len(BENCH_PREFIX) :] in ok for h in hits) else 0
        )
        s["wrong"] += 1 if chosen and not correct else 0
        if query["kind"] == "paraphrase":
            s["para"] += 1
            s["para_recall1"] += 1 if correct else 0
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
            "paraphrase_recall@1": round(s["para_recall1"] / (s["para"] or 1), 4),
            "shortlist_recall": round(s["shortlist_recall"] / pos, 4),
            "wrong_memory_rate": round(s["wrong"] / pos, 4),
        }
    return out


async def _judge(
    query: dict[str, Any], candidates: list[dict[str, Any]], sem: asyncio.Semaphore
) -> dict[str, Any] | None:
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, judge_candidates, shortlist

    hits = shortlist(candidates, DEFAULT_CONFIG)
    if not hits:
        return None
    async with sem:
        try:
            verdict = await judge_candidates(query["query"], hits, config=DEFAULT_CONFIG, agent_id=None, user_id=None)
        except Exception as exc:  # a judge error/timeout injects nothing in production too
            print(f"  judge error ({query['kind']}): {str(exc)[:120]}", flush=True)
            return {"match": None, "error": str(exc)[:120]}
    return verdict.model_dump()


async def run_bench(port: int, api_key: str) -> dict[str, Any]:
    from providers.planner_memory import client as backend
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    _disable_dump_archive()
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
        judge_sem = asyncio.Semaphore(JUDGE_CONCURRENCY)

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
            return {"query": query, "candidates": candidates, "verdict": await _judge(query, candidates, judge_sem)}

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
        per_query.append({"query": item["query"], "candidates": rows, "verdict": item["verdict"]})
    payload = {
        "description": (
            "Frozen retrieval-bench snapshot: for every labeled query, the candidates the production path returned "
            "(backend voyage-4 semantic search, [id, similarity]) and the judge verdict over the shortlist. Goal and "
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
        items.append({"query": entry["query"], "candidates": candidates, "verdict": entry["verdict"]})
    return items


async def rejudge_snapshot() -> dict[str, Any]:
    """Re-run only the judge over the frozen candidates (judge prompt/model iteration, no backend)."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    _disable_dump_archive()
    labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    items = load_snapshot_items(json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8")))
    judge_sem = asyncio.Semaphore(JUDGE_CONCURRENCY)

    async def one(item: dict[str, Any]) -> dict[str, Any]:
        return {**item, "verdict": await _judge(item["query"], item["candidates"], judge_sem)}

    items = await asyncio.gather(*(one(item) for item in items))
    write_snapshot(labels, [item["query"] for item in items], items)
    return {
        "corpus_rows": len(labels["corpus"]),
        "queries": len(items),
        "config": DEFAULT_CONFIG.__dict__,
        "metrics": evaluate(items, labels["corpus"]),
    }


# ── real-trajectory evaluation (labels from real plans) ─────────────────────

TRAJECTORY_PREFIX = "retrieval-traj:"
TRAJECTORY_SNAPSHOT_PATH = LABELS_PATH.parent / "retrieval-trajectories-candidates.json"


def trajectory_metrics(items: list[dict[str, Any]], runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Relevance = each run's LLM-over-real-plans labels (memory_trajectory_labels); two slices per item.

    Only a run's labeled neighbors carry labels; an injected memory outside them
    counts as not relevant and is reported as `unlabeled_injections`.
    """
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, JudgeVerdict, apply_verdict, shortlist

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
            view = item[slice_name]
            hits = shortlist(view["candidates"], DEFAULT_CONFIG)
            verdict = view.get("verdict")
            chosen = apply_verdict(hits, JudgeVerdict.model_validate(verdict)) if hits and verdict else None
            chosen_relevant = bool(chosen and chosen.id in relevant_ids)
            s["queries"] += 1
            s["injected"] += 1 if chosen else 0
            s["injected_relevant"] += 1 if chosen_relevant else 0
            s["unlabeled_injections"] += 1 if chosen and chosen.id not in (query.get("neighbors") or []) else 0
            if relevant_ids:
                s["with_relevant"] += 1
                s["recall_hits"] += 1 if chosen_relevant else 0
                s["shortlist_has_relevant"] += 1 if any(h.id in relevant_ids for h in hits) else 0
            else:
                s["without_relevant"] += 1
                s["false_injections"] += 1 if chosen else 0
        out[slice_name] = {
            "queries": int(s["queries"]),
            "with_relevant": int(s["with_relevant"]),
            "precision": round(s["injected_relevant"] / (s["injected"] or 1), 4),
            "recall": round(s["recall_hits"] / (s["with_relevant"] or 1), 4),
            "shortlist_recall": round(s["shortlist_has_relevant"] / (s["with_relevant"] or 1), 4),
            "false_injection_rate": round(s["false_injections"] / (s["without_relevant"] or 1), 4),
            "without_relevant": int(s["without_relevant"]),
            "unlabeled_injections": int(s["unlabeled_injections"]),
        }
    return out


async def run_trajectory_bench(port: int, api_key: str, runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Index every run's goal through PUT, then query each run's own goal (excluding itself)."""
    from providers.planner_memory import client as backend
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    _disable_dump_archive()
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
    judge_sem = asyncio.Semaphore(JUDGE_CONCURRENCY)
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
            query = {"query": run["goal"], "kind": "trajectory"}
            all_verdict = await _judge(query, candidates, judge_sem)
            cross_verdict = all_verdict if len(cross) == len(candidates) else await _judge(query, cross, judge_sem)
            return {
                "id": run["id"],
                "all": {"candidates": candidates, "verdict": all_verdict},
                "cross_task": {"candidates": cross, "verdict": cross_verdict},
            }

        return await asyncio.gather(*(one(run) for run in runs))
    finally:
        async with httpx.AsyncClient(timeout=30) as client:
            for run in runs:
                await client.delete(f"{base_url}/api/planner-memory/{run['id']}", headers=headers)


def write_trajectory_snapshot(runs: list[dict[str, Any]], items: list[dict[str, Any]]) -> Path:
    """Freeze candidates ([id, similarity]) + verdicts per slice; goals live in the labels file."""
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    compact = [
        {
            "id": item["id"],
            **{
                name: {
                    "candidates": [[c["id"], round(c["similarity"], 6)] for c in item[name]["candidates"]],
                    "verdict": item[name]["verdict"],
                }
                for name in ("all", "cross_task")
            },
        }
        for item in items
    ]
    payload = {
        "description": (
            "Frozen real-trajectory snapshot: for each archived run in retrieval-trajectories.json, the "
            "production search candidates for its goal and the judge verdict, with and without same-task runs. "
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
            **{
                name: {"candidates": expand(entry[name]["candidates"]), "verdict": entry[name]["verdict"]}
                for name in ("all", "cross_task")
            },
        }
        for entry in snapshot["snapshot"]
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--build-labels", action="store_true")
    parser.add_argument("--rejudge", action="store_true", help="Re-run only the judge over the frozen snapshot")
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
    if args.rejudge:
        report = asyncio.run(rejudge_snapshot())
    else:
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
