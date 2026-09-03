"""Blackbox tests for planner RAG (reference plans retrieved from the trace archive).

Covers: bundle -> entry extraction, incremental scanning, encrypted derived-index
storage (never under trace-archive/), BM25 retrieval + visibility + dedupe,
prompt-block formatting, injection position, prompt-cache prefix invariance,
fast-cache fingerprint invariance, the planner activity wiring, and timing.
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

from _test_utils import BlackboxResult, get_captured_requests, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent

_ENV_KEYS = [
    "TRACE_ARCHIVE_ENABLED",
    "TRACE_ARCHIVE_BACKEND",
    "TRACE_ARCHIVE_LOCAL_ROOT",
    "PLANNER_RAG_BACKEND",
    "PLANNER_RAG_LOCAL_DIR",
    "PLANNER_RAG_ENABLED",
    "FLY_APP_NAME",
    "ENVIRONMENT",
]


class _LocalArchive:
    """Temporary local trace archive + derived-index dir with env wiring."""

    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.archive_root = self.root / "trace-archive"
        self._old = {key: os.environ.get(key) for key in _ENV_KEYS}
        os.environ["TRACE_ARCHIVE_ENABLED"] = "1"
        os.environ["TRACE_ARCHIVE_BACKEND"] = "local"
        os.environ["TRACE_ARCHIVE_LOCAL_ROOT"] = str(self.archive_root)
        os.environ["PLANNER_RAG_BACKEND"] = "local"
        os.environ["PLANNER_RAG_LOCAL_DIR"] = str(self.root)
        os.environ["PLANNER_RAG_ENABLED"] = "1"
        os.environ.pop("FLY_APP_NAME", None)
        os.environ.pop("ENVIRONMENT", None)

    def close(self) -> None:
        for key, value in self._old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def __enter__(self) -> "_LocalArchive":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def _plan(title: str, tasks: list[tuple[str, str, list[str]]], join: str = "all") -> dict[str, Any]:
    return {
        "title": title,
        "join": join,
        "tasks": [
            {"task_idx": str(i), "goal": goal, "tool_name": tool, "depends_on": deps}
            for i, (tool, goal, deps) in enumerate(tasks)
        ],
    }


POPULATION_PLAN = _plan(
    "Tokyo x NYC population product",
    [
        ("spawn_general_purpose_agent", "Find the current population of Tokyo via explore web research", []),
        ("spawn_general_purpose_agent", "Find the current population of New York City via explore web research", []),
        ("reasoning", "Multiply both populations and report the product", ["0", "1"]),
    ],
)
FLIGHT_PLAN = _plan(
    "Book Paris flight",
    [
        ("spawn_explore_agent", "Find the cheapest nonstop SFO-CDG flights next month", []),
        ("spawn_browser_agent", "Book the selected flight end to end on the airline site", ["0"]),
    ],
)
PIZZA_PLAN = _plan(
    "Order pizza",
    [("spawn_browser_agent", "Order a large pepperoni pizza from Domino's for delivery", [])],
)


def _write_bundle(
    archive: _LocalArchive,
    root_id: str,
    goal: str,
    plan: dict[str, Any] | None,
    *,
    user_id: str = "user-a",
    task: str | None = None,
    status: str = "COMPLETED",
    passed: bool | None = True,
    finalized: bool = True,
    mode: str = "real",
    created_at: str = "2026-09-01T00:00:00.000Z",
    generated_at: str | None = None,
    planner_dump_ts: int = 1788400000000,
) -> None:
    from helpers.trace_archive import encrypt_artifact, store_encrypted_artifact

    dump_path = f"llm-updates/0123456789ab-{planner_dump_ts}-planner.json.gz.enc"
    refs = [{"ref": f"local://{root_id}/{dump_path}", "path": dump_path}] if plan is not None else []
    manifest = {
        "schema_version": 1,
        "root_agent_id": root_id,
        "benchmark_task_name": task,
        "generated_at": generated_at or created_at,
        "llm_trace_count": len(refs),
        "artifacts": refs,
        "world_model_mode": mode,
        "finalized": finalized,
        "benchmark_result": None if passed is None else {"passed": passed, "status": "PASSED" if passed else "FAILED"},
        "run": {
            "root_goal": goal,
            "root_status": status,
            "root_created_at": created_at,
            "user_id": user_id,
            "agent_ids": [root_id],
        },
        "sensitive": {"llm_trace_refs": refs},
    }
    public = {
        "schema_version": 1,
        "root_agent_id": root_id,
        "benchmark_task_name": task,
        "generated_at": generated_at or created_at,
        "llm_trace_count": len(refs),
    }
    bundle_dir = archive.archive_root / root_id
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / "manifest.public.json").write_text(json.dumps(public))

    def _store(path: str, payload: dict[str, Any]) -> None:
        encrypted = encrypt_artifact(json.dumps(payload).encode("utf-8"), path=path, content_type="application/json")
        assert encrypted is not None
        ciphertext, metadata = encrypted
        store_encrypted_artifact(root_agent_id=root_id, path=path, ciphertext=ciphertext, metadata=metadata)

    _store("manifest.json.gz.enc", manifest)
    if plan is not None:
        _store(dump_path, {"call_site": "planner", "output": {"content": json.dumps(plan)}})


POPULATION_GOAL = (
    "Find the current population of Tokyo and the current population of New York City. Use "
    "spawn_general_purpose_agent twice, then multiply the two populations together and report the product."
)


def _seed_corpus(archive: _LocalArchive) -> None:
    # Three runs of the same benchmark goal (dedupe target), newest passed run wins.
    _write_bundle(
        archive, "pop-1", POPULATION_GOAL, POPULATION_PLAN, task="spawn-sub-agents", created_at="2026-08-01T00:00:00Z"
    )
    _write_bundle(
        archive, "pop-2", POPULATION_GOAL, POPULATION_PLAN, task="spawn-sub-agents", created_at="2026-08-20T00:00:00Z"
    )
    _write_bundle(
        archive,
        "pop-3",
        POPULATION_GOAL,
        POPULATION_PLAN,
        task="spawn-sub-agents",
        created_at="2026-09-02T00:00:00Z",
        passed=False,
        status="FAILED",
    )
    # Private (non-benchmark) runs for two different users.
    _write_bundle(
        archive,
        "flight-a",
        "Book me the cheapest nonstop flight from SFO to Paris CDG next month",
        FLIGHT_PLAN,
        user_id="user-a",
    )
    _write_bundle(
        archive,
        "flight-b",
        "Book a nonstop flight to Paris for my Paris trip next month",
        FLIGHT_PLAN,
        user_id="user-b",
    )
    # Shared benchmark run with an unrelated goal.
    _write_bundle(
        archive, "pizza-1", "Order a large pepperoni pizza for delivery tonight", PIZZA_PLAN, task="order-pizza"
    )
    # Bundles that must be skipped.
    _write_bundle(archive, "no-dump", "Goal with no planner dump at all", None)
    _write_bundle(archive, "sim-1", "Simulated population run of Tokyo", POPULATION_PLAN, mode="simulated")
    _write_bundle(archive, "unfinished", "Population of Tokyo run still in flight", POPULATION_PLAN, finalized=False)


# ── extraction ─────────────────────────────────────────────────────────────


def test_extract_entry_from_local_bundle():
    from providers.planner_rag import extract_entry

    with _LocalArchive() as archive:
        _write_bundle(archive, "pop-1", POPULATION_GOAL, POPULATION_PLAN, task="spawn-sub-agents")
        entry, reason = extract_entry("pop-1")
        assert reason == "ok" and entry is not None
        assert entry.goal == POPULATION_GOAL
        assert entry.benchmark_task_name == "spawn-sub-agents"
        assert entry.user_id == "user-a" and entry.passed is True and entry.root_status == "COMPLETED"
        assert entry.plan.title == "Tokyo x NYC population product"
        assert [t.tool_name for t in entry.plan.tasks] == [
            "spawn_general_purpose_agent",
            "spawn_general_purpose_agent",
            "reasoning",
        ]
        assert entry.plan.tasks[2].depends_on == ("0", "1")


def test_extract_entry_skip_reasons():
    from providers.planner_rag import extract_entry

    with _LocalArchive() as archive:
        _write_bundle(archive, "no-dump", "goal", None)
        _write_bundle(archive, "failed", "goal", POPULATION_PLAN, status="FAILED", passed=False)
        _write_bundle(archive, "sim", "goal", POPULATION_PLAN, mode="simulated")
        _write_bundle(archive, "unfinished", "goal", POPULATION_PLAN, finalized=False)
        _write_bundle(archive, "bad-plan", "goal", {"title": "x", "join": "all", "tasks": []})
        assert extract_entry("no-dump")[1] == "no_llm_traces"
        assert extract_entry("failed")[1] == "not_successful:FAILED"
        assert extract_entry("sim")[1] == "simulated:simulated"
        assert extract_entry("unfinished")[1] == "not_finalized"
        assert extract_entry("bad-plan")[1] == "planner_dump_unparseable"
        assert extract_entry("missing")[1] == "no_public_manifest"


def test_extract_entry_uses_latest_planner_attempt():
    """A retried planner leaves several dumps; the accepted plan is the latest one."""
    from helpers.trace_archive import encrypt_artifact, store_encrypted_artifact
    from providers.planner_rag import extract_entry

    with _LocalArchive() as archive:
        _write_bundle(archive, "retry", "goal", FLIGHT_PLAN, planner_dump_ts=1788400000000)
        older = "llm-updates/aaaaaaaaaaaa-1788399000000-planner.json.gz.enc"
        encrypted = encrypt_artifact(
            json.dumps({"output": {"content": json.dumps(PIZZA_PLAN)}}).encode(),
            path=older,
            content_type="application/json",
        )
        assert encrypted is not None
        store_encrypted_artifact(root_agent_id="retry", path=older, ciphertext=encrypted[0], metadata=encrypted[1])
        # Rewrite manifest refs to include both dumps.
        from helpers.trace_archive import decrypt_and_validate_artifact, read_archive_artifact

        stored = read_archive_artifact(root_agent_id="retry", path="manifest.json.gz.enc")
        assert stored is not None
        manifest = json.loads(decrypt_and_validate_artifact(*stored))
        manifest["sensitive"]["llm_trace_refs"].append({"ref": "x", "path": older})
        enc = encrypt_artifact(
            json.dumps(manifest).encode(), path="manifest.json.gz.enc", content_type="application/json"
        )
        assert enc is not None
        store_encrypted_artifact(root_agent_id="retry", path="manifest.json.gz.enc", ciphertext=enc[0], metadata=enc[1])

        entry, reason = extract_entry("retry")
        assert reason == "ok" and entry is not None
        assert entry.plan.title == "Book Paris flight"


def test_scan_bundles_is_incremental_and_reprobes_transient():
    from helpers.trace_archive import list_archive_bundle_ids
    from providers.planner_rag import scan_bundles

    with _LocalArchive() as archive:
        _seed_corpus(archive)
        ids = list_archive_bundle_ids()
        entries, state, counts = scan_bundles(ids, scan_state={}, concurrency=4)
        assert {e.root_agent_id for e in entries} == {"pop-1", "pop-2", "flight-a", "flight-b", "pizza-1"}
        assert counts["ok"] == 5 and state["sim-1"] == "simulated:simulated"
        assert state["unfinished"] == "not_finalized" and state["no-dump"] == "no_llm_traces"

        # Second pass: nothing new except the transient "not_finalized" bundle is re-probed.
        entries2, state2, counts2 = scan_bundles(ids, scan_state=state, concurrency=4)
        assert entries2 == [] and sum(counts2.values()) == 1 and counts2 == {"not_finalized": 1}
        assert state2 == state


# ── store ──────────────────────────────────────────────────────────────────


def test_index_store_roundtrip_is_encrypted():
    from providers.planner_rag import PlanEntry, load_index_from_store, scan_bundles
    from providers.planner_rag import store

    with _LocalArchive() as archive:
        _seed_corpus(archive)
        from helpers.trace_archive import list_archive_bundle_ids

        entries, _, _ = scan_bundles(list_archive_bundle_ids(), scan_state={}, concurrency=4)
        ref = store.write_encrypted_json(
            store.INDEX_KEY,
            {"schema_version": 1, "generated_at": "2026-09-03T00:00:00Z", "entries": [e.to_dict() for e in entries]},
        )
        raw = Path(ref).read_bytes()
        assert b"Tokyo" not in raw and b"population" not in raw, "index must be encrypted at rest"
        assert Path(ref + ".meta.json").exists()

        index = load_index_from_store()
        assert index is not None and len(index) == 5
        restored = {e.root_agent_id: e for e in index.entries}
        assert restored["pop-2"] == PlanEntry.from_dict(
            next(e.to_dict() for e in entries if e.root_agent_id == "pop-2")
        )
        assert index.generated_at == "2026-09-03T00:00:00Z" and index.source == "local"


def test_store_never_writes_under_trace_archive_prefix():
    from providers.planner_rag import store

    with _LocalArchive():
        for key in ("trace-archive/x/manifest.json.gz.enc", "benchmark-hub/index.json", "evidence/x"):
            try:
                store.write_bytes(key, b"x", content_type="text/plain")
            except ValueError as exc:
                assert "read-only" in str(exc)
            else:
                raise AssertionError(f"write to {key} should have been refused")
        assert store.read_bytes("planner-rag/does-not-exist") is None


# ── retrieval ──────────────────────────────────────────────────────────────


def _corpus_index():
    from helpers.trace_archive import list_archive_bundle_ids
    from providers.planner_rag import PlannerRagIndex, scan_bundles

    entries, _, _ = scan_bundles(list_archive_bundle_ids(), scan_state={}, concurrency=4)
    return PlannerRagIndex(entries, generated_at="now", source="local")


def test_query_ranks_similar_goal_dedupes_and_applies_visibility():
    with _LocalArchive() as archive:
        _seed_corpus(archive)
        index = _corpus_index()
        hits = index.query("What is the product of the populations of Tokyo and New York City?", user_id="user-zzz")
        assert hits, "expected a population hit"
        assert hits[0].entry.root_agent_id == "pop-2", "newest PASSED duplicate must win the dedupe"
        ids = [h.entry.root_agent_id for h in hits]
        assert ids.count("pop-1") == 0 and ids.count("pop-3") == 0, "duplicate goals collapse to one exemplar"
        assert "flight-a" not in ids and "flight-b" not in ids, "private runs are hidden from other users"
        assert hits[0].coverage >= 0.5 and hits[0].score > 0

        # Own private run is visible to its owner; another user's is not.
        own = index.query("Book a nonstop flight to Paris next month", user_id="user-a")
        assert [h.entry.root_agent_id for h in own] == ["flight-a"]
        other = index.query("Book a nonstop flight to Paris next month", user_id="user-b")
        assert [h.entry.root_agent_id for h in other] == ["flight-b"]
        anonymous = index.query("Book a nonstop flight to Paris next month", user_id=None)
        assert anonymous == []


def test_query_excludes_unrelated_and_current_run():
    with _LocalArchive() as archive:
        _seed_corpus(archive)
        index = _corpus_index()
        assert index.query("Renew my passport at the downtown appointment center", user_id="user-a") == []
        assert index.query("", user_id="user-a") == []
        assert index.query(POPULATION_GOAL, user_id="user-a", k=0) == []
        hits = index.query(POPULATION_GOAL, user_id="user-a", exclude_root_agent_id="pop-2")
        assert hits and hits[0].entry.root_agent_id == "pop-1"


def test_format_reference_plans_block_shape_and_caps():
    from providers.planner_rag import MAX_BLOCK_CHARS, REFERENCE_PLANS_PREFIX, format_reference_plans

    with _LocalArchive() as archive:
        _seed_corpus(archive)
        index = _corpus_index()
        hits = index.query(POPULATION_GOAL, user_id="user-a")
        block = format_reference_plans(hits)
        assert block.startswith(REFERENCE_PLANS_PREFIX + "\n")
        assert "## Reference 1 — similarity" in block
        assert "[spawn_general_purpose_agent]" in block and "(depends_on: 0, 1)" in block
        assert 'Plan: "Tokyo x NYC population product" (join=all)' in block
        assert "structural references only" in block
        assert format_reference_plans([]) == ""

    # Oversized exemplars are capped, never unbounded.
    from providers.planner_rag import PlanEntry, ReferenceHit

    huge = PlanEntry.from_dict(
        {
            "id": "huge",
            "goal": "x" * 5000,
            "user_id": "u",
            "task": "t",
            "status": "COMPLETED",
            "passed": True,
            "ts": "2026-09-01",
            "plan": {
                "title": "t",
                "join": "all",
                "tasks": [{"goal": "y" * 2000, "tool_name": "reasoning", "depends_on": []}] * 40,
            },
        }
    )
    block = format_reference_plans([ReferenceHit(entry=huge, score=1.0, coverage=1.0)] * 5)
    assert len(block) <= MAX_BLOCK_CHARS + 1 and "[truncated]" in block


def test_insert_reference_plans_position_preserves_prefix_and_tail():
    from providers.planner_rag import insert_reference_plans

    messages = [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "GOAL: g\n\nPlan this goal into tasks."},
        {"role": "user", "content": "[TOOL]: previous output"},
        {"role": "user", "content": "[VALIDATION ERROR - Please fix]: cycle"},
    ]
    out = insert_reference_plans(messages, "# Reference Plans\n\nblock")
    assert out[0] is messages[0] and out[1] is messages[1]
    assert out[2] == {"role": "user", "content": "# Reference Plans\n\nblock"}
    assert out[-1] is messages[-1] and len(out) == len(messages) + 1
    assert insert_reference_plans(messages, None) is messages and insert_reference_plans(messages, "") is messages


def test_reference_block_leaves_prompt_cache_prefix_untouched():
    """claudeAuth request body: system blocks, tools and their cache_control are byte-identical with/without RAG."""
    from providers.planner_rag import insert_reference_plans
    from providers.rose.claude_auth import build_anthropic_body
    from providers.rose.pools import get_pool
    from utils.prompts import build_planner_system_prompt
    from utils.tool_schemas import PlannerResponse

    system_prompt = build_planner_system_prompt("tool schemas", "# User Context\n\nName: Test User")
    base = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"GOAL: {POPULATION_GOAL}\n\nPlan this goal into tasks."},
        {"role": "user", "content": "[TOOL]: some earlier output"},
    ]
    response_format = {
        "type": "json_schema",
        "json_schema": {"name": "PlannerResponse", "schema": PlannerResponse.model_json_schema()},
    }

    def body_for(messages):
        return build_anthropic_body(
            pool_spec=get_pool("rose-1-ultra"),
            messages=copy.deepcopy(messages),
            tools=None,
            tool_choice=None,
            response_format=response_format,
            max_tokens=16384,
            effort="max",
        )

    without = body_for(base)
    with_refs = body_for(
        insert_reference_plans(base, "# Reference Plans\n\n## Reference 1\nGoal: past goal\n- 0 [reasoning] x")
    )

    # Everything that participates in the cached prefix (tools -> system) is byte-identical.
    prefix_without = {k: v for k, v in without.items() if k != "messages"}
    prefix_with = {k: v for k, v in with_refs.items() if k != "messages"}
    assert prefix_with == prefix_without, "cached prefix (system/tools/output config) changed"
    cached_system = [b for b in with_refs["system"] if "cache_control" in b]
    assert len(cached_system) >= 2, "planner static prefix must carry global cache_control markers"

    # Consecutive user turns merge into one Anthropic message: [GOAL, reference block, TOOL].
    blocks_without = without["messages"][0]["content"]
    blocks_with = with_refs["messages"][0]["content"]
    assert len(blocks_with) == len(blocks_without) + 1
    assert blocks_with[0] == blocks_without[0], "GOAL block unchanged"
    assert blocks_with[1]["text"].startswith("# Reference Plans")
    assert blocks_with[-1]["text"] == blocks_without[-1]["text"]
    # The only per-call message breakpoint stays on the trailing block, as before.
    assert "cache_control" in blocks_with[-1] and "cache_control" not in blocks_with[1]


def test_reference_block_does_not_change_fast_cache_fingerprints():
    from providers.fast_cache import normalize
    from providers.planner_rag import insert_reference_plans

    base = [
        {"role": "system", "content": "static system"},
        {"role": "user", "content": "GOAL: g\n\nPlan this goal into tasks."},
    ]
    a = insert_reference_plans(base, "# Reference Plans\n\n## Reference 1\nGoal: alpha")
    b = insert_reference_plans(base, "# Reference Plans\n\n## Reference 1\nGoal: beta\n## Reference 2\nGoal: gamma")
    assert normalize.canonical_messages(a) == normalize.canonical_messages(b)
    assert normalize.position_request_fingerprint(
        {"messages": a, "pool": "rose-1-ultra"}
    ) == normalize.position_request_fingerprint({"messages": b, "pool": "rose-1-ultra"})
    assert normalize.canonical_messages(a) != normalize.canonical_messages(
        base + [{"role": "user", "content": "other"}]
    )


# ── end to end: retrieval function + planner activity wiring ───────────────


def _publish_local_index() -> None:
    from helpers.trace_archive import list_archive_bundle_ids
    from providers.planner_rag import scan_bundles, store

    entries, _, _ = scan_bundles(list_archive_bundle_ids(), scan_state={}, concurrency=4)
    store.write_encrypted_json(
        store.INDEX_KEY,
        {"schema_version": 1, "generated_at": "2026-09-03T00:00:00Z", "entries": [e.to_dict() for e in entries]},
    )


async def test_retrieve_reference_plans_end_to_end_with_timing():
    from providers.planner_rag import retrieve_reference_plans

    with _LocalArchive() as archive:
        _seed_corpus(archive)
        _publish_local_index()
        result = await retrieve_reference_plans(POPULATION_GOAL, user_id="user-a")
        assert result.message and result.message.startswith("# Reference Plans")
        assert [h.entry.root_agent_id for h in result.hits][0] == "pop-2"
        assert result.corpus_size == 5 and result.source == "local"
        for key in ("index_load", "query", "format", "total"):
            assert key in result.timing_ms, f"missing timing {key}"
        assert result.timing_ms["total"] < 1000, result.timing_ms
        summary = result.summary()
        assert summary["hits"][0]["root_agent_id"] == "pop-2" and summary["message_chars"] == len(result.message)


async def test_retrieve_reference_plans_without_index_is_noop():
    from providers.planner_rag import retrieve_reference_plans

    with _LocalArchive():
        result = await retrieve_reference_plans(POPULATION_GOAL, user_id="user-a")
        assert result.message is None and result.hits == [] and "total" in result.timing_ms


async def test_planner_activity_injects_reference_block_after_goal():
    import helpers.llm as llm
    from utils.tool_schemas import PlannerResponse

    captured: dict[str, Any] = {}

    async def fake_structured(**kwargs):
        captured.update(kwargs)
        return (
            PlannerResponse.model_validate(POPULATION_PLAN),
            {"prompt_tokens": 10, "completion_tokens": 5, "actual_model": "claude-test"},
            None,
        )

    original = llm.call_llm_structured_streaming
    llm.call_llm_structured_streaming = fake_structured  # type: ignore[assignment]
    try:
        with _LocalArchive() as archive:
            _seed_corpus(archive)
            _publish_local_index()
            messages = [
                {"role": "user", "content": f"GOAL: {POPULATION_GOAL}\n\nPlan this goal into tasks."},
                {"role": "user", "content": "[TOOL]: earlier tool output"},
            ]
            result = await llm.call_planner_llm_activity(
                messages,
                "rose-labs/rose-1-ultra",
                "tool schemas",
                "Name: Test User",
                None,
                claude_token_user_id="user-a",
            )
    finally:
        llm.call_llm_structured_streaming = original  # type: ignore[assignment]

    sent = captured["messages"]
    assert sent[0]["role"] == "system" and "# User Context" in sent[0]["content"]
    assert sent[1]["content"].startswith("GOAL: ")
    assert sent[2]["role"] == "user" and sent[2]["content"].startswith("# Reference Plans")
    assert sent[3]["content"] == "[TOOL]: earlier tool output"
    assert result["planner_rag"]["hits"][0]["root_agent_id"] == "pop-2"
    assert result["planner_rag"]["timing_ms"]["total"] >= 0
    assert result["result"]["title"] == POPULATION_PLAN["title"]


async def test_planner_activity_without_hits_sends_unchanged_messages():
    import helpers.llm as llm
    from utils.tool_schemas import PlannerResponse

    captured: dict[str, Any] = {}

    async def fake_structured(**kwargs):
        captured.update(kwargs)
        return PlannerResponse.model_validate(PIZZA_PLAN), {"prompt_tokens": 1, "completion_tokens": 1}, None

    original = llm.call_llm_structured_streaming
    llm.call_llm_structured_streaming = fake_structured  # type: ignore[assignment]
    try:
        with _LocalArchive() as archive:
            _seed_corpus(archive)
            _publish_local_index()
            messages = [{"role": "user", "content": "GOAL: Renew my passport downtown\n\nPlan this goal into tasks."}]
            result = await llm.call_planner_llm_activity(
                messages, "m", "tools", "", None, claude_token_user_id="user-a"
            )
    finally:
        llm.call_llm_structured_streaming = original  # type: ignore[assignment]
    assert [m["role"] for m in captured["messages"]] == ["system", "user"]
    assert result["planner_rag"]["hits"] == [] and result["planner_rag"]["message_chars"] == 0


def test_planner_goal_extraction():
    from helpers.llm import _planner_goal_from_messages

    assert (
        _planner_goal_from_messages(
            [{"role": "user", "content": "GOAL: buy milk\n\nPlan this goal into tasks."}], fallback=None
        )
        == "buy milk"
    )
    assert (
        _planner_goal_from_messages([{"role": "user", "content": "free text"}], fallback="durable goal")
        == "durable goal"
    )
    assert _planner_goal_from_messages([], fallback=None) == ""


def test_builder_cli_builds_local_index():
    with _LocalArchive() as archive:
        _seed_corpus(archive)
        env = {**os.environ, "PYTHONPATH": str(AGENTS_ROOT)}
        proc = subprocess.run(
            [
                sys.executable,
                str(AGENTS_ROOT / "scripts" / "build_planner_rag_index.py"),
                "--json",
                "--concurrency",
                "4",
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
        assert proc.returncode == 0, proc.stderr[-2000:]
        summary = json.loads(proc.stdout[proc.stdout.index("\n{\n") :])
        assert summary["total_entries"] == 5 and summary["backend"] == "local" and summary["published_ref"] is None
        assert (archive.root / "planner-rag" / "goal-plan-index.v1.json.gz.enc").exists()

        # Incremental second run scans only the transient bundle and keeps entries.
        proc2 = subprocess.run(
            [
                sys.executable,
                str(AGENTS_ROOT / "scripts" / "build_planner_rag_index.py"),
                "--json",
                "--concurrency",
                "4",
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )
        assert proc2.returncode == 0, proc2.stderr[-2000:]
        summary2 = json.loads(proc2.stdout[proc2.stdout.index("\n{\n") :])
        assert summary2["scanned_now"] == 1 and summary2["total_entries"] == 5


def test_no_outbound_http_calls():
    assert get_captured_requests() == [], get_captured_requests()


async def run_all_tests():
    print("planner-rag blackbox tests:")
    r = BlackboxResult()
    r.record("extract_entry_local_bundle", test_extract_entry_from_local_bundle)
    r.record("extract_entry_skip_reasons", test_extract_entry_skip_reasons)
    r.record("extract_entry_latest_attempt", test_extract_entry_uses_latest_planner_attempt)
    r.record("scan_bundles_incremental", test_scan_bundles_is_incremental_and_reprobes_transient)
    r.record("index_store_roundtrip_encrypted", test_index_store_roundtrip_is_encrypted)
    r.record("store_refuses_bundle_writes", test_store_never_writes_under_trace_archive_prefix)
    r.record("query_rank_dedupe_visibility", test_query_ranks_similar_goal_dedupes_and_applies_visibility)
    r.record("query_excludes_unrelated", test_query_excludes_unrelated_and_current_run)
    r.record("format_block_shape_caps", test_format_reference_plans_block_shape_and_caps)
    r.record("insert_position", test_insert_reference_plans_position_preserves_prefix_and_tail)
    r.record("prompt_cache_prefix_untouched", test_reference_block_leaves_prompt_cache_prefix_untouched)
    r.record("fast_cache_fingerprint_untouched", test_reference_block_does_not_change_fast_cache_fingerprints)
    await r.record_async("retrieve_end_to_end_timing", test_retrieve_reference_plans_end_to_end_with_timing)
    await r.record_async("retrieve_without_index_noop", test_retrieve_reference_plans_without_index_is_noop)
    await r.record_async("planner_activity_injects_block", test_planner_activity_injects_reference_block_after_goal)
    await r.record_async("planner_activity_no_hits", test_planner_activity_without_hits_sends_unchanged_messages)
    r.record("planner_goal_extraction", test_planner_goal_extraction)
    r.record("builder_cli_local", test_builder_cli_builds_local_index)
    r.record("no_outbound_http_calls", test_no_outbound_http_calls)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
