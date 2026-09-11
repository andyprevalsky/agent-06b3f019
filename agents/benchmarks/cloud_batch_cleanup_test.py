"""Behavioral regression gates for late recordings and exact cloud cleanup."""

import asyncio
import copy
import functools
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from benchmarks import cloud_batch_cleanup as cleanup
from benchmarks import run_benchmark as bench

ROOT = "00000000-0000-4000-8000-000000000001"
CHILD = "00000000-0000-4000-8000-000000000002"


def async_case(function):
    @functools.wraps(function)
    def run():
        return asyncio.run(function())

    run.async_case = function
    return run


def browser_rows(task="browser-one", *, attached=True):
    rows = [
        {
            "text": "started",
            "metadata": {"toolName": "spawn_browser_agent", "task_id": task, "action_type": "task_started"},
        },
        {
            "text": "complete",
            "metadata": {"toolName": "spawn_browser_agent", "task_id": task, "action_type": "task_complete"},
        },
    ]
    if attached:
        rows.append(
            {
                "text": "recording",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "task_id": task,
                    "action_type": "recording",
                    "toolStatus": "FINISHED",
                    "recording_view_url": "https://recording.example/video",
                },
            }
        )
    return rows


def test_browser_without_recording_row_fails_durable_readiness():
    assert not bench._agent_messages_ready_for_durable_browser_evidence(browser_rows(attached=False))
    assert bench._agent_messages_ready_for_durable_browser_evidence(browser_rows())
    code = [
        {"metadata": {"task_id": "browser-one", "toolName": "spawn_claude_code_agent", "action_type": "task_complete"}}
    ]
    assert bench._agent_messages_ready_for_durable_browser_evidence(code)
    assert not bench._agent_messages_ready_for_durable_browser_evidence(code + browser_rows(attached=False))
    encoded = [{"metadata": json.dumps(row["metadata"])} for row in browser_rows()]
    assert bench._agent_messages_ready_for_durable_browser_evidence(encoded)


@async_case
async def test_final_archive_refreshes_normalized_child_transcripts():
    logs = {"messages": [{"message": "stale root"}], "tree": {CHILD: {"messages": [{"message": "stale child"}]}}}
    infos = [{"agent_id": ROOT}, {"agent_id": CHILD, "parent_agent_id": ROOT}]
    snapshots = {ROOT: {"messages": [{"text": "fresh root"}]}, CHILD: {"messages": browser_rows()}}

    async def fetch(_url, aid):
        return copy.deepcopy(snapshots[aid])

    with patch.object(bench, "get_agent_tree", AsyncMock(return_value=infos)), patch.object(bench, "get_agent", fetch):
        refreshed = await bench._refresh_browser_archive_snapshot(
            "http://localhost:1", ROOT, {"_benchmark": {"kept": True}}, logs, expected_agent_ids={ROOT, CHILD}
        )
    assert refreshed["_benchmark"] == {"kept": True}
    assert logs["messages"][0]["message"] == "fresh root"
    assert logs["tree"][CHILD]["messages"][-1]["message"] == "recording"
    assert logs["tree"][CHILD]["messages"][-1]["metadata"]["toolStatus"] == "FINISHED"


@async_case
async def test_archive_deadline_bounds_slow_fetch_and_rejects_incomplete_tree():
    async def slow_fetch(*_args):
        await asyncio.sleep(10)
        return {"messages": []}

    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", slow_fetch),
    ):
        with pytest.raises(TimeoutError):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, {}, timeout_seconds=0.01)
    with patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])):
        with pytest.raises(RuntimeError, match="omitted"):
            await bench._refresh_browser_archive_snapshot(
                "http://localhost:1", ROOT, {}, {}, expected_agent_ids={ROOT, CHILD}
            )


@async_case
async def test_archive_does_not_accept_terminal_without_recording():
    with (
        patch.object(bench, "get_agent_tree", AsyncMock(return_value=[{"agent_id": ROOT}])),
        patch.object(bench, "get_agent", AsyncMock(return_value={"messages": browser_rows(attached=False)})),
    ):
        with pytest.raises(TimeoutError):
            await bench._refresh_browser_archive_snapshot("http://localhost:1", ROOT, {}, {}, timeout_seconds=0.01)


@async_case
async def test_owned_batch_defers_all_early_archive_paths():
    archive = AsyncMock(return_value="unexpected")
    with (
        patch.object(cleanup, "contract", return_value=(Path("/tmp/status"), "token")),
        patch.object(bench, "archive_agent_finalize", archive),
    ):
        for force in (False, True):
            ref, _ = await bench.finalize_archive_and_score_world_model(
                "http://localhost:1", ROOT, "fixture", force=force
            )
            assert ref is None
        assert not archive.called


def result(aid):
    return SimpleNamespace(
        agent_id=aid,
        name=aid,
        logs={},
        passed=False,
        benchmark_status="FAILED",
        status="PAUSED",
        failure_reason="test timeout",
    )


@async_case
async def test_batch_continues_exact_cleanup_after_recording_or_delete_failure():
    for failure in ("recording", "delete", "pause", "query"):
        events = []

        async def pause(_url, aid):
            events.append(("pause", aid))
            return not (failure == "pause" and aid == ROOT)

        def query(_url, aid):
            events.append(("query", aid))
            if failure == "query" and aid == ROOT:
                raise RuntimeError("database unavailable")
            return {"tree_agent_ids": [aid], "browser_sessions": []}

        async def snapshot(_url, aid, _data, logs, **_kwargs):
            events.append(("snapshot", aid))
            if failure == "recording" and aid == ROOT:
                raise RuntimeError("recording absent")
            logs["messages"] = [{"message": "terminal"}]
            return {"messages": [{}]}

        async def archive(_url, aid, _name, **kwargs):
            assert kwargs["owned_batch_final"] is True
            events.append(("archive", aid))
            return "archive-ref", {}

        async def delete(_url, aid):
            events.append(("delete", aid))
            if failure == "delete" and aid == ROOT:
                raise RuntimeError("delete failed")

        def close(_url, aid, _before):
            events.append(("release", aid))
            return {"root_agent_id": aid}

        results = [result(ROOT), result(CHILD)]
        with (
            patch.object(bench, "pause_agent", pause),
            patch.object(cleanup, "exact_root_sessions", query),
            patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
            patch.object(bench, "finalize_archive_and_score_world_model", archive),
            patch.object(bench, "delete_agent", delete),
            patch.object(cleanup, "close_exact_root_sessions", close),
        ):
            with pytest.raises(RuntimeError):
                await bench._finalize_owned_cloud_batch("http://localhost:1", results, {})
        assert events[:2] == [("pause", ROOT), ("pause", CHILD)]
        assert (
            events.index(("snapshot", CHILD))
            < events.index(("archive", CHILD))
            < events.index(("delete", CHILD))
            < events.index(("release", CHILD))
        )
        if failure == "recording":
            assert ("delete", ROOT) in events and ("release", ROOT) in events
            assert ("archive", ROOT) not in events


@async_case
async def test_missing_create_response_never_proves_zero_allocation():
    for results in ([], [result("")]):
        with pytest.raises(RuntimeError, match="(unknown root|no proven root)"):
            await bench._finalize_owned_cloud_batch("http://localhost:1", results, {})


def test_provider_cleanup_rejects_drift_and_requires_sealed_descendants():
    before = {
        "root_exists": True,
        "root_deleted": False,
        "unsealed_tree_agent_ids": [ROOT],
        "tree_agent_ids": [ROOT],
        "browser_sessions": [{"agent_id": ROOT, "provider": "kernel", "session_id": "session123"}],
    }
    after = {**before, "root_deleted": True, "unsealed_tree_agent_ids": []}
    drift = {
        **after,
        "browser_sessions": after["browser_sessions"]
        + [{"agent_id": ROOT, "provider": "kernel", "session_id": "late12345"}],
    }
    releases = []

    def release(provider, sid, _paths):
        releases.append((provider, sid))
        return 404, "receipt-digest"

    with (
        patch.object(cleanup, "exact_root_sessions", side_effect=[after, drift]),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        with pytest.raises(RuntimeError, match="changed"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before)
    assert releases == [("kernel", "session123")]
    with (
        patch.object(cleanup, "exact_root_sessions", side_effect=RuntimeError("unsealed child")),
        patch.object(cleanup.runpy, "run_path") as load_provider,
    ):
        with pytest.raises(RuntimeError, match="unsealed"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before)
        load_provider.assert_not_called()


def test_exact_database_proof_rejects_live_child_and_foreign_stack():
    import os
    import runpy

    recovery = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory)
        manifest = {
            "worktree": str(cleanup.REPO_ROOT),
            "benchmark_mode": True,
            "status": "running",
            "temporal_task_queue": "owned-queue",
            "ports": {"backend": 31001},
            "database": {"name": "owned_fixture", "port": 31006},
        }
        (context / "services.json").write_text(json.dumps(manifest))
        payload = {
            "root_exists": True,
            "root_deleted": True,
            "unsealed_tree_agent_ids": [CHILD],
            "tree_agent_ids": [ROOT, CHILD],
            "browser_sessions": [],
        }

        def query(_command, **kwargs):
            assert kwargs["database"] == "owned_fixture" and kwargs["port"] == 31006
            assert ROOT in kwargs["sql"] and "unsealed_tree_agent_ids" in kwargs["sql"]
            return json.dumps(payload)

        recovery["run_exact_psql"] = query
        environment = {
            "BENCHMARK_CLOUD_BATCH_CLEANUP": "true",
            "BENCHMARK_ISOLATED_RUN": "true",
            "BENCHMARK_INTERRUPT_CLEANUP_TOKEN": "owned-token",
            "BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE": str(context / "status"),
            "BENCHMARK_CONTEXT_DIR": directory,
            "TEMPORAL_TASK_QUEUE": "owned-queue",
        }
        with patch.dict(os.environ, environment), patch.object(cleanup.runpy, "run_path", return_value=recovery):
            with pytest.raises(RuntimeError, match="incomplete"):
                cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True)
            payload["unsealed_tree_agent_ids"] = []
            assert cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True) == payload
            with pytest.raises(RuntimeError, match="owned local stack"):
                cleanup.exact_root_sessions("https://production.example", ROOT)


def test_provider_rejection_does_not_skip_other_sessions_in_same_root():
    sealed = {"root_exists": True, "root_deleted": True, "unsealed_tree_agent_ids": [], "tree_agent_ids": [ROOT], "browser_sessions": [
        {"agent_id": ROOT, "provider": "kernel", "session_id": "owned0001"},
        {"agent_id": ROOT, "provider": "kernel", "session_id": "owned0002"},
    ]}
    calls = []
    def release(provider, sid, _paths):
        calls.append((provider, sid))
        if sid == "owned0001":
            raise RuntimeError("HTTP 503")
        return 404, "digest"
    with patch.object(cleanup, "exact_root_sessions", return_value=sealed) as verify, patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}):
        with pytest.raises(RuntimeError, match="HTTP 503"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, sealed)
    assert calls == [("kernel", "owned0001"), ("kernel", "owned0002")]
    assert verify.call_count == 2
