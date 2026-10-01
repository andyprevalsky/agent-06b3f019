#!/usr/bin/env python3
"""Planner-memory relevance labels derived from real archived runs and their real plans.

A past run B is a useful memory for a new goal A when B's plan would help plan A
(the planner's get_memories criteria: reusable entry points/URLs, tool choices,
decomposition, session handling, pitfalls — never copied specifics). Labels are
produced by a strong model (LABEL_MODEL) that sees what both runs ACTUALLY
executed: each run's plan (tool calls with start URLs and task goals). The judge
under test only ever sees goals, so plans are privileged label information.

For every run, its LABEL_NEIGHBORS nearest runs by goal embedding are labeled
(`neighbors`), and the useful subset is stored as `relevant`.

Runs are finalized, successful, real-world runs listed by the prod PlannerMemory
table (export ids with the SQL below) and read from the R2 trace archive:

    COPY (SELECT id, COALESCE("benchmarkTaskName",''), COALESCE("rootStatus",''),
                 COALESCE(passed::text,''), <scope: owner|bench|other>
          FROM "PlannerMemory" WHERE "worldModelMode"='real'
            AND (passed = true OR (passed IS NULL AND "rootStatus"='COMPLETED')))
    TO STDOUT WITH CSV

Outputs:
  * fixtures/memory/retrieval-trajectories.json — benchmark runs only (committed);
  * .context/planner-memory/retrieval-trajectories-owner.json — the owner's own
    non-benchmark runs (local only, never committed).

Usage:
    python benchmarks/memory_trajectory_labels.py --ids ids.csv [--per-task 10] [--owner 600]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

AGENTS_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENTS_ROOT.parent
sys.path.insert(0, str(AGENTS_ROOT))

COMMITTED_PATH = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory" / "retrieval-trajectories.json"
LOCAL_PATH = REPO_ROOT / ".context" / "planner-memory" / "retrieval-trajectories-owner.json"

# Per-run benchmark names ("planner-memory-blackbox-1788921424-188147-31070") are one task.
_RUN_SUFFIX_RE = re.compile(r"-\d{9,}(?:-[0-9a-z]+)*$")
GENERIC_MECHANICS = {
    "spawn:browser",
    "spawn:explore",
    "spawn:general",
    "spawn:general_purpose",
    "attempt_completion",
    "set_plan",
    "request_user_approval",
    "agent_init",
    "send_message_to_user",
    "send_message_to_user_execute_phase",
    "send_message_to_user_plan_phase",
}
MAX_PLAN_CALLS = 12
PLAN_GOAL_CHARS = 400


def canonical_task(task: Optional[str]) -> Optional[str]:
    return _RUN_SUFFIX_RE.sub("", task) if task else None


def plan_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") != "ASSISTANT":
            continue
        metadata = message.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except ValueError:
                continue
        for call in metadata.get("tool_calls") or []:
            if isinstance(call, dict):
                calls.append(call)
    return calls


def read_run(root_agent_id: str) -> Optional[dict[str, Any]]:
    from providers.planner_memory.bundle import read_bundle_json, sanitize_memory_text

    try:
        manifest = read_bundle_json(root_agent_id, "manifest.json.gz.enc") or {}
        fixture = read_bundle_json(root_agent_id, "db/end.fixture.json.gz.enc") or {}
    except Exception as exc:  # a corrupted bundle must not sink the label set
        print(f"  skip {root_agent_id[:8]}: {str(exc)[:80]}", flush=True)
        return None
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    goal = run.get("root_goal")
    if not isinstance(goal, str) or not goal.strip():
        return None
    rows = fixture.get("rows") if isinstance(fixture.get("rows"), dict) else {}
    messages = [m for m in rows.get("Message") or [] if isinstance(m, dict)]
    calls = plan_calls(messages)
    plan = [
        {
            "tool": (f"spawn:{call.get('type')}" if call.get("tool") == "spawn_agent" else str(call.get("tool") or "")),
            "start_url": sanitize_memory_text(str(call.get("start_url") or ""))[:200] or None,
            "for_each": bool(call.get("items") or call.get("items_csv")),
            "goal": sanitize_memory_text(str(call.get("goal") or call.get("message") or ""))[:PLAN_GOAL_CHARS],
        }
        for call in calls
        if str(call.get("tool") or "") not in {"attempt_completion", "agent_init"}
    ][:MAX_PLAN_CALLS]
    if not plan:
        return None
    return {
        "id": root_agent_id,
        "task": canonical_task(manifest.get("benchmark_task_name") or None),
        "goal": goal.strip(),
        "plan": plan,
    }


def select_ids(ids_csv: Path, per_task: int, owner: int, seed: int) -> tuple[list[str], list[str]]:
    rows = [r for r in csv.reader(ids_csv.open()) if len(r) == 5]
    by_task: dict[str, list[str]] = defaultdict(list)
    owner_private: list[str] = []
    for root_id, task, _status, _passed, scope in rows:
        if task:
            by_task[canonical_task(task) or task].append(root_id)
        elif scope == "owner":
            owner_private.append(root_id)
    rng = random.Random(seed)
    bench: list[str] = []
    for task in sorted(by_task):
        ids = sorted(by_task[task])
        rng.shuffle(ids)
        bench.extend(ids[:per_task])
    owner_private.sort()
    rng.shuffle(owner_private)
    return bench, owner_private[:owner]


def build(ids: list[str]) -> list[dict[str, Any]]:
    with ThreadPoolExecutor(32) as pool:
        runs = [run for run in pool.map(read_run, ids) if run]
    # One entry per distinct goal text (identical reruns add no information).
    seen: dict[str, dict[str, Any]] = {}
    for run in runs:
        seen.setdefault(run["goal"], run)
    return list(seen.values())


# ── LLM relevance labels over real plans ────────────────────────────────────

LABEL_MODEL = "anthropic/claude-opus-5.5"
LABEL_NEIGHBORS = 12
EMBED_MODEL = "voyageai/voyage-4"

LABEL_PROMPT = """You are labeling training data for an AI assistant's planner memory.

The planner is about to plan a NEW goal. It can be shown ONE past run as a memory. The planner uses a memory to
reuse its entry points and URLs, tool choices, task decomposition, session handling, and known pitfalls, but never
copies names, prices, dates, quantities, or steps the goal does not call for. A past run is USEFUL when its plan
would help plan the new goal: same site, service, integration, or data source, or the same kind of task mechanics
(e.g. a for-each over rows, explore-only local data lookup, exactly one phone call, a price trigger, the same test
checkout flow), even if the specific item, store, date, person, or wording differs. It is NOT useful when it only
shares topic or location words and none of its plan would carry over.

You see what each run ACTUALLY executed (its plan: tool calls with their start URLs and task goals).

NEW GOAL:
{query_goal}
ITS ACTUAL PLAN:
{query_plan}

PAST RUNS:
{candidates}

Return JSON only: {{"useful": [<numbers of every past run that would be a useful memory>]}}"""


def _plan_text(run: dict[str, Any]) -> str:
    lines = []
    for call in run.get("plan") or []:
        parts = [call["tool"]]
        if call.get("for_each"):
            parts.append("for_each")
        if call.get("start_url"):
            parts.append(f"start_url={call['start_url']}")
        lines.append(f"- {' '.join(parts)}: {call.get('goal') or ''}")
    return "\n".join(lines) or "- (no tool calls)"


def _openrouter_key() -> str:
    for line in (AGENTS_ROOT / ".env").read_text().splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("OPENROUTER_API_KEY missing from agents/.env")


def _embed_goals(goals: list[str], key: str) -> "list[list[float]]":
    import httpx

    vectors: list[list[float]] = []
    for start in range(0, len(goals), 64):
        batch = [g[:24000] for g in goals[start : start + 64]]
        resp = httpx.post(
            "https://openrouter.ai/api/v1/embeddings",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": EMBED_MODEL, "input": batch},
            timeout=120,
        )
        resp.raise_for_status()
        vectors.extend(item["embedding"] for item in resp.json()["data"])
    return vectors


def nearest_neighbors(runs: list[dict[str, Any]], key: str, k: int = LABEL_NEIGHBORS) -> dict[str, list[str]]:
    """Top-k by goal embedding, plus the top-k among other tasks (the cross-task slice's candidates)."""
    import numpy as np

    matrix = np.asarray(_embed_goals([run["goal"] for run in runs], key), dtype=np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    sims = matrix @ matrix.T
    np.fill_diagonal(sims, -1.0)
    out: dict[str, list[str]] = {}
    for i, run in enumerate(runs):
        order = [int(j) for j in np.argsort(-sims[i])]
        overall = order[:k]
        other_task = [j for j in order if run["task"] is None or runs[j]["task"] != run["task"]][:k]
        out[run["id"]] = [runs[j]["id"] for j in dict.fromkeys(overall + other_task)]
    return out


def label_relevance(runs: list[dict[str, Any]], key: str) -> None:
    """Adds `neighbors` (top-k by goal embedding) and `relevant` (LLM-labeled useful subset) to every run."""
    import httpx

    by_id = {run["id"]: run for run in runs}
    neighbors = nearest_neighbors(runs, key)

    def one(run: dict[str, Any]) -> tuple[str, list[str]]:
        ids = neighbors[run["id"]]
        listing = "\n\n".join(
            f"[{n}] GOAL: {by_id[cid]['goal'][:1200]}\nPLAN:\n{_plan_text(by_id[cid])}" for n, cid in enumerate(ids, 1)
        )
        prompt = LABEL_PROMPT.format(query_goal=run["goal"][:2000], query_plan=_plan_text(run), candidates=listing)
        for attempt in range(4):
            try:
                resp = httpx.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {key}"},
                    json={"model": LABEL_MODEL, "messages": [{"role": "user", "content": prompt}], "max_tokens": 2000},
                    timeout=180,
                )
                resp.raise_for_status()
                text = resp.json()["choices"][0]["message"]["content"]
                picked = json.loads(text[text.index("{") : text.rindex("}") + 1]).get("useful") or []
                return run["id"], [ids[n - 1] for n in picked if isinstance(n, int) and 1 <= n <= len(ids)]
            except Exception as exc:
                print(f"  label retry {run['id'][:8]}: {str(exc)[:100]}", flush=True)
        raise RuntimeError(f"labeling failed for {run['id']}")

    with ThreadPoolExecutor(8) as pool:
        labels = dict(pool.map(one, runs))
    for run in runs:
        run["neighbors"] = neighbors[run["id"]]
        run["relevant"] = labels[run["id"]]


def label_stats(runs: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {run["id"]: run for run in runs}
    with_relevant = sum(1 for a in runs if a.get("relevant"))
    cross_task = sum(
        1 for a in runs if any(a["task"] is None or by_id[b]["task"] != a["task"] for b in a.get("relevant") or [])
    )
    return {"runs": len(runs), "queries_with_relevant": with_relevant, "queries_with_cross_task_relevant": cross_task}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ids", type=Path)
    parser.add_argument("--relabel", action="store_true", help="Recompute neighbors + labels on the existing files")
    parser.add_argument("--per-task", type=int, default=10)
    parser.add_argument("--owner", type=int, default=600)
    parser.add_argument("--seed", type=int, default=13)
    args = parser.parse_args()
    os.environ.setdefault("TRACE_ARCHIVE_BACKEND", "r2")
    if args.relabel:
        key = _openrouter_key()
        for path in (COMMITTED_PATH, LOCAL_PATH):
            data = json.loads(path.read_text(encoding="utf-8"))
            label_relevance(data["runs"], key)
            path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            print(path.name, label_stats(data["runs"]), flush=True)
        return 0
    if args.ids is None:
        parser.error("--ids is required unless --relabel")
    bench_ids, owner_ids = select_ids(args.ids, args.per_task, args.owner, args.seed)
    print(f"reading {len(bench_ids)} benchmark + {len(owner_ids)} owner runs from R2", flush=True)
    key = _openrouter_key()
    bench = build(bench_ids)
    label_relevance(bench, key)
    COMMITTED_PATH.write_text(
        json.dumps({"description": __doc__.split("\n\n")[0], "runs": bench}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print("benchmark:", label_stats(bench), "->", COMMITTED_PATH, flush=True)
    owner = build(owner_ids)
    label_relevance(owner, key)
    LOCAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_PATH.write_text(json.dumps({"runs": owner}, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(LOCAL_PATH, 0o600)
    print("owner (local only):", label_stats(owner), "->", LOCAL_PATH, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
