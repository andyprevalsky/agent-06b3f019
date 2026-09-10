"""Cemented retrieval benchmark for planner memory.

Replays the frozen labeled candidate snapshot (what the production search path
returned for every labeled query, with Postgres-computed features) through the
in-process scorer and pins:

  * the shipped ``RetrievalConfig`` is the argmax of the benchmark objective on
    the fit split across every strategy × cutoff (no silently worse config can
    be shipped);
  * zero false positives on the negative (no-history) queries on both splits;
  * objective ratchets on fit and held-out (never lowered).

Rebuild the snapshot with ``python benchmarks/memory_retrieval_bench.py --port N``
after changing the search SQL or the labels; rebuild labels with ``--build-labels``.
"""

from __future__ import annotations

import json
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
SNAPSHOT = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory" / "retrieval-candidates.json"
LABELS = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory" / "retrieval-labels.json"

FIT_OBJECTIVE_FLOOR = 0.60
HELD_OUT_OBJECTIVE_FLOOR = 0.50
MIN_CORPUS_ROWS = 150
MIN_QUERIES = 150


def _snapshot() -> dict:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def _results() -> dict:
    from benchmarks.memory_retrieval_bench import evaluate, load_snapshot_fetched

    return evaluate(load_snapshot_fetched(_snapshot()))


def _shipped_key() -> str:
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    return f"{DEFAULT_CONFIG.strategy}@{DEFAULT_CONFIG.min_score}"


def test_labels_and_snapshot_are_substantial_and_consistent():
    snap = _snapshot()
    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    assert snap["corpus_rows"] >= MIN_CORPUS_ROWS and len(labels["corpus"]) == snap["corpus_rows"]
    assert snap["queries"] >= MIN_QUERIES and len(snap["snapshot"]) == snap["queries"]
    kinds = {item["query"]["kind"] for item in snap["snapshot"]}
    assert {"title", "description", "goal_variant", "negative"} <= kinds
    assert sum(1 for item in snap["snapshot"] if item["query"]["kind"] == "negative") >= 10


def test_shipped_config_is_the_fit_argmax_and_meets_floors():
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, STRATEGIES

    assert DEFAULT_CONFIG.strategy in STRATEGIES
    results = _results()
    key = _shipped_key()
    assert key in results, f"shipped config {key} is not on the benchmark grid"
    shipped = results[key]
    best = max(results.values(), key=lambda m: m["fit"]["objective"])["fit"]["objective"]
    assert shipped["fit"]["objective"] >= best - 1e-9, (
        f"shipped {key} objective {shipped['fit']['objective']} < best {best}"
    )
    assert shipped["fit"]["objective"] >= FIT_OBJECTIVE_FLOOR, shipped["fit"]
    assert shipped["held_out"]["objective"] >= HELD_OUT_OBJECTIVE_FLOOR, shipped["held_out"]


def test_shipped_config_never_returns_memories_for_novel_goals():
    shipped = _results()[_shipped_key()]
    assert shipped["fit"]["negative_fp_rate"] == 0.0
    assert shipped["held_out"]["negative_fp_rate"] == 0.0


def test_scoring_is_deterministic_and_bounded():
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, score_candidates

    from benchmarks.memory_retrieval_bench import load_snapshot_fetched

    query, candidates = next((q, c) for q, c in load_snapshot_fetched(_snapshot()) if q["kind"] == "goal_variant" and c)
    first = score_candidates(query["query"], candidates, DEFAULT_CONFIG)
    second = score_candidates(query["query"], candidates, DEFAULT_CONFIG)
    assert [h.id for h in first] == [h.id for h in second]
    assert len(first) <= DEFAULT_CONFIG.k
    assert all(0.0 <= h.similarity <= 1.0 for h in first)


async def run_all_tests():
    print("memory-retrieval-bench blackbox tests:")
    r = BlackboxResult()
    r.record("labels_snapshot_substantial", test_labels_and_snapshot_are_substantial_and_consistent)
    r.record("shipped_config_argmax_and_floors", test_shipped_config_is_the_fit_argmax_and_meets_floors)
    r.record("no_memories_for_novel_goals", test_shipped_config_never_returns_memories_for_novel_goals)
    r.record("scoring_deterministic_bounded", test_scoring_is_deterministic_and_bounded)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
