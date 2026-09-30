"""Cemented retrieval benchmark for planner memory.

Replays two frozen snapshots of the production path (backend voyage-4 semantic
search candidates + the judge's verdict) through the in-process ``shortlist`` /
``apply_verdict`` and pins:

  * both snapshots were taken with the shipped ``RetrievalConfig`` (a config
    change must re-run the live bench and re-freeze);
  * labeled set: zero memories for novel goals; recall@1 and paraphrase recall@1
    floors on fit and held-out;
  * real-trajectory set (archived runs; relevance labeled by a strong model that
    sees both runs' real executed plans — benchmarks/memory_trajectory_labels.py):
    precision, recall and false-injection bounds, with and without same-task
    runs in the corpus.

The labeled set's hard negatives encode an older "same task only" rule; under
the planner's get_memories criteria several are useful memories, so they are
reported but not gated — plan-derived trajectory labels gate relevance instead.

Rebuild with ``python benchmarks/memory_retrieval_bench.py --port N`` and
``--port N --trajectories benchmark`` after changing the search path, the judge
prompt, the models, or the labels. Floors ratchet up only.
"""

from __future__ import annotations

import json
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = AGENTS_ROOT / "benchmarks" / "fixtures" / "memory"
SNAPSHOT = FIXTURES / "retrieval-candidates.json"
LABELS = FIXTURES / "retrieval-labels.json"
TRAJECTORIES = FIXTURES / "retrieval-trajectories.json"
TRAJECTORY_SNAPSHOT = FIXTURES / "retrieval-trajectories-candidates.json"

FIT_RECALL_FLOOR = 0.70
HELD_OUT_RECALL_FLOOR = 0.70
PARAPHRASE_RECALL_FLOOR = 0.80
MIN_CORPUS_ROWS = 150
MIN_QUERIES = 400

MIN_TRAJECTORY_RUNS = 150
# Measured 2026-09-30 (188 runs): all p=1.00 r=0.90 fi=0/8; cross-task p=0.99 r=0.85 fi=1/21.
TRAJECTORY_FLOORS = {
    "all": {"precision": 0.95, "recall": 0.85, "false_injection_rate": 0.15},
    "cross_task": {"precision": 0.95, "recall": 0.80, "false_injection_rate": 0.10},
}


def _snapshot() -> dict:
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def _metrics() -> dict:
    from benchmarks.memory_retrieval_bench import evaluate, load_snapshot_items

    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    return evaluate(load_snapshot_items(_snapshot()), labels["corpus"])


def _trajectory_metrics() -> dict:
    from benchmarks.memory_retrieval_bench import load_trajectory_items, trajectory_metrics

    runs = json.loads(TRAJECTORIES.read_text(encoding="utf-8"))["runs"]
    snapshot = json.loads(TRAJECTORY_SNAPSHOT.read_text(encoding="utf-8"))
    return trajectory_metrics(load_trajectory_items(snapshot, runs), runs)


def test_labels_and_snapshot_are_substantial_and_consistent():
    snap = _snapshot()
    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    assert snap["corpus_rows"] >= MIN_CORPUS_ROWS and len(labels["corpus"]) == snap["corpus_rows"]
    assert snap["queries"] >= MIN_QUERIES and len(snap["snapshot"]) == snap["queries"]
    kinds = {item["query"]["kind"] for item in snap["snapshot"]}
    assert {"title", "description", "goal_variant", "negative", "paraphrase", "hard_negative"} <= kinds
    assert all(doc["goal"].strip() for doc in snap["docs"].values())
    runs = json.loads(TRAJECTORIES.read_text(encoding="utf-8"))["runs"]
    trajectory = json.loads(TRAJECTORY_SNAPSHOT.read_text(encoding="utf-8"))
    assert len(runs) >= MIN_TRAJECTORY_RUNS and trajectory["runs"] == len(runs) == len(trajectory["snapshot"])
    assert all(run["plan"] and len(run["neighbors"]) >= 5 for run in runs)
    assert sum(1 for run in runs if run["relevant"]) >= 30, "enough runs with a labeled useful memory"


def test_snapshots_were_taken_with_the_shipped_config():
    from providers.planner_memory.retrieval import DEFAULT_CONFIG

    for path in (SNAPSHOT, TRAJECTORY_SNAPSHOT):
        assert json.loads(path.read_text(encoding="utf-8"))["config"] == DEFAULT_CONFIG.__dict__, (
            f"RetrievalConfig changed: re-run benchmarks/memory_retrieval_bench.py to re-freeze {path.name}"
        )


def test_shipped_pipeline_never_injects_for_novel_goals():
    metrics = _metrics()
    assert metrics["negatives"] >= 10
    assert metrics["negative_fp_rate"] == 0.0, metrics


def test_shipped_pipeline_meets_recall_floors():
    metrics = _metrics()
    assert metrics["fit"]["recall@1"] >= FIT_RECALL_FLOOR, metrics["fit"]
    assert metrics["held_out"]["recall@1"] >= HELD_OUT_RECALL_FLOOR, metrics["held_out"]
    for split in ("fit", "held_out"):
        assert metrics[split]["paraphrase_recall@1"] >= PARAPHRASE_RECALL_FLOOR, metrics[split]


def test_real_trajectories_meet_plan_relevance_floors():
    metrics = _trajectory_metrics()
    for slice_name, floors in TRAJECTORY_FLOORS.items():
        got = metrics[slice_name]
        assert got["precision"] >= floors["precision"], (slice_name, got)
        assert got["recall"] >= floors["recall"], (slice_name, got)
        assert got["false_injection_rate"] <= floors["false_injection_rate"], (slice_name, got)


def test_shortlist_is_deterministic_and_bounded():
    from providers.planner_memory.retrieval import DEFAULT_CONFIG, shortlist

    from benchmarks.memory_retrieval_bench import load_snapshot_items

    item = next(i for i in load_snapshot_items(_snapshot()) if i["query"]["kind"] == "paraphrase" and i["candidates"])
    first = shortlist(item["candidates"], DEFAULT_CONFIG)
    second = shortlist(item["candidates"], DEFAULT_CONFIG)
    assert [h.id for h in first] == [h.id for h in second]
    assert 1 <= len(first) <= DEFAULT_CONFIG.top_n
    assert all(DEFAULT_CONFIG.min_similarity <= h.similarity <= 1.0 for h in first)


async def run_all_tests():
    print("memory-retrieval-bench blackbox tests:")
    r = BlackboxResult()
    r.record("labels_snapshot_substantial", test_labels_and_snapshot_are_substantial_and_consistent)
    r.record("snapshots_match_shipped_config", test_snapshots_were_taken_with_the_shipped_config)
    r.record("no_memories_for_novel_goals", test_shipped_pipeline_never_injects_for_novel_goals)
    r.record("recall_floors", test_shipped_pipeline_meets_recall_floors)
    r.record("real_trajectory_floors", test_real_trajectories_meet_plan_relevance_floors)
    r.record("shortlist_deterministic_bounded", test_shortlist_is_deterministic_and_bounded)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
