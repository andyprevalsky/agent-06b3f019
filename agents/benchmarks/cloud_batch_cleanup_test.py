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
            return {"root_user_id": ROOT, "tree_agent_ids": [aid], "browser_sessions": []}

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

        def close(_url, aid, _before, **_kwargs):
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
        pauses = [("pause", ROOT)] if failure != "query" else []
        pauses.append(("pause", CHILD))
        assert [event for event in events if event[0] == "pause"] == pauses
        assert max(events.index(event) for event in pauses) < events.index(("snapshot", CHILD))
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
            "root_user_id": ROOT,
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
            for invalid_owner in (None, "", 42, "not-a-user-id"):
                payload["root_user_id"] = invalid_owner
                with pytest.raises(RuntimeError, match="incomplete"):
                    cleanup.exact_root_sessions("http://localhost:31001", ROOT, require_deleted=True)
            payload["root_user_id"] = ROOT
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


def test_exact_provider_cleanup_identifies_client_without_accepting_forbidden():
    """Replay Steel's captured Cloudflare 1010 response at the real HTTP seam."""
    import hashlib
    import http.server
    import runpy
    import threading

    helper = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-exact-session-cleanup.py"))
    requests = []
    forbidden = b"error code: 1010"
    released = b'{"success":true}'

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.headers.get("User-Agent"), self.headers.get("Accept")))
            identified = bool(self.headers.get("User-Agent")) and not self.headers["User-Agent"].startswith("Python-urllib/")
            accepted = identified and self.headers.get("Accept") == "application/json" and "denied-session" not in self.path
            payload = released if accepted else forbidden
            self.send_response(200 if accepted else 403)
            self.send_header("Content-Type", "application/json" if accepted else "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.dict("os.environ", {"STEEL_API_KEY": "fixture-key", "STEEL_BASE_URL": f"http://127.0.0.1:{server.server_port}"}):
            status, digest = helper["provider_request"]("steel", "owned-session", ())
            assert status == 200 and digest == hashlib.sha256(released).hexdigest()
            with pytest.raises(helper["CleanupEvidenceError"], match="HTTP 403"):
                helper["provider_request"]("steel", "denied-session", ())
        assert len(requests) == 2
        assert requests[0][0] == "/v1/sessions/owned-session/release"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


@async_case
async def test_failed_batch_retains_ownership_and_each_failure_cause():
    before = {"root_user_id": ROOT, "tree_agent_ids": [ROOT], "browser_sessions": [{"agent_id": ROOT, "provider": "steel", "session_id": "owned-session"}]}
    row = result(ROOT)
    with (
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "_refresh_browser_archive_snapshot", AsyncMock(side_effect=TimeoutError())),
        patch.object(bench, "delete_agent", AsyncMock()),
        patch.object(cleanup, "close_exact_root_sessions", side_effect=RuntimeError("HTTP 403")),
    ):
        with pytest.raises(RuntimeError):
            await bench._finalize_owned_cloud_batch("http://localhost:1", [row], {})
    evidence = row.logs["cloud_cleanup_evidence"]
    assert evidence["before"] == before
    assert evidence["errors"] == ["archive: TimeoutError", "provider: HTTP 403"]
    assert "TimeoutError" in row.failure_reason and "HTTP 403" in row.failure_reason
    assert "cloud_provider_cleanup" not in row.logs


def test_failed_release_retains_terminal_database_and_successful_provider_receipts():
    before = {"tree_agent_ids": [ROOT], "browser_sessions": [
        {"agent_id": ROOT, "provider": "kernel", "session_id": "owned-kernel"},
        {"agent_id": ROOT, "provider": "steel", "session_id": "owned-steel"},
    ]}
    after = {**before, "root_deleted": True, "unsealed_tree_agent_ids": []}
    evidence = {}

    def release(provider, _sid, _paths):
        if provider == "steel":
            raise RuntimeError("HTTP 403")
        return 404, "digest"

    with (
        patch.object(cleanup, "exact_root_sessions", return_value=after),
        patch.object(cleanup.runpy, "run_path", return_value={"provider_request": release}),
    ):
        with pytest.raises(RuntimeError, match="HTTP 403"):
            cleanup.close_exact_root_sessions("http://localhost:1", ROOT, before, evidence=evidence)
    assert evidence["before"] == before
    assert evidence["after"] == evidence["final"] == after
    assert evidence["provider_receipts"] == [{"provider": "kernel", "session_id": "owned-kernel", "status": 404, "response_sha256": "digest"}]


def test_recovery_manifest_keeps_promoted_sessions_from_exact_database_evidence():
    import runpy

    helper = runpy.run_path(str(cleanup.REPO_ROOT / "scripts/cloudbench-exact-session-cleanup.py"))
    snapshot = {
        "root_exists": True, "tree_agent_ids": [ROOT, CHILD],
        "browser_sessions": [{"agent_id": CHILD, "provider": "steel", "session_id": "promoted-steel"}],
    }
    evidence = {"root_agent_id": ROOT, "before": snapshot}
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory).resolve()
        run = output / "run.json"
        backend = output / "backend.log"
        backend.write_text(f"root={ROOT}\nCreated Kernel browser session sessionId=original-kernel\n")
        args = SimpleNamespace(
            output_dir=str(output), owner="a" * 32, fleet_run_id="run-one", bench="task-one",
            machine_id="a123", guest_run_token="guest-one", run_json=str(run),
            backend_log=str(backend), quiescence_receipt=str(output / "quiescence.json"),
        )

        def publish(value):
            run.write_text(json.dumps({"tasks": [{"name": args.bench, "agent_id": ROOT, "logs": {"cloud_cleanup_evidence": value}}]}))

        with patch.dict(helper["provider_manifest"].__globals__, {"validate_quiescence": lambda *_args: "quiescence-digest"}):
            publish(evidence)
            manifest = helper["provider_manifest"](args)
            assert manifest["sessions"] == {"kernel": ["original-kernel"], "steel": ["promoted-steel"]}
            backend.write_text(f"root={ROOT}\n")
            assert helper["provider_manifest"](args)["sessions"] == {"kernel": [], "steel": ["promoted-steel"]}
            with pytest.raises(helper["CleanupEvidenceError"], match="recorded provider sessions"):
                helper["zero_provider_manifest"](args)
            backend.write_text(f"root={ROOT}\nCreated Kernel browser session sessionId=original-kernel\n")
            for bad in (
                None,
                {**evidence, "root_agent_id": CHILD},
                {**evidence, "before": {**snapshot, "tree_agent_ids": [ROOT]}},
                {**evidence, "before": {**snapshot, "browser_sessions": [{"agent_id": CHILD, "provider": "unknown", "session_id": "promoted-steel"}]}},
            ):
                publish(bad)
                with pytest.raises(helper["CleanupEvidenceError"]):
                    helper["provider_manifest"](args)


@async_case
async def test_deferred_cleanup_uses_exact_database_owner():
    import os
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    owners = {
        '00000000-0000-4000-8000-000000000001': bench.GATE_FIXTURE_TASK_USER_IDS['gate-kyc-card-mint'],
        '00000000-0000-4000-8000-000000000002': '00000000-0000-4000-8000-000000000104',
    }
    paused, requests = set(), []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            aid = self.path.split('/')[-2]
            user = self.headers.get('X-User-Id')
            requests.append(('pause', aid, user))
            status = 200 if owners.get(aid) == user else 404
            if status == 200:
                paused.add(aid)
            body = json.dumps({'success': status == 200}).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_DELETE(self):
            aid = self.path.split('/')[-1]
            requests.append(('delete', aid, self.headers.get('X-User-Id')))
            self.send_response(204)
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://localhost:{server.server_port}'

    def query(_url, aid):
        return {'root_user_id': owners[aid], 'tree_agent_ids': [aid], 'browser_sessions': []}

    async def snapshot(_url, aid, _data, _logs, **_kwargs):
        assert aid in paused, 'Owner-restricted pause failed before the recording barrier'
        assert bench._current_benchmark_user_id() == owners[aid]
        return {'messages': []}

    async def archive(_url, aid, _name, **_kwargs):
        assert bench._current_benchmark_user_id() == owners[aid]
        return 'fixture-archive', None

    def close(_url, aid, _before, **_kwargs):
        return {'root_agent_id': aid, 'root_deleted': True}

    async def run():
        results = [SimpleNamespace(agent_id=aid, name=aid, logs={}, passed=True,
                    benchmark_status='PASSED', status='ACTIVE', failure_reason=None) for aid in owners]
        await bench._finalize_owned_cloud_batch(base, results, {})
        assert all(r.passed for r in results)
        assert bench._current_benchmark_user_id() == bench.USER_ID
        assert os.environ['BENCHMARK_RUN_USER_ID'] == bench.USER_ID

    try:
        with (
            patch.dict(os.environ, {'BENCHMARK_RUN_USER_ID': bench.USER_ID, 'NO_PROXY': 'localhost,127.0.0.1'}),
            patch.object(bench, 'API_KEY', 'fixture-key'),
            patch.object(bench, '_auth_mode', 'api_key'),
            patch.object(bench, '_cached_headers', None),
            patch.object(bench, '_cached_headers_user_id', None),
            patch.object(bench.cloud_batch_cleanup, 'exact_root_sessions', query),
            patch.object(bench, '_refresh_browser_archive_snapshot', snapshot),
            patch.object(bench, 'finalize_archive_and_score_world_model', archive),
            patch.object(bench.cloud_batch_cleanup, 'close_exact_root_sessions', close),
        ):
            await run()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert requests == [('pause', aid, owner) for aid, owner in owners.items()] + [('delete', aid, owner) for aid, owner in owners.items()]


@async_case
async def test_cleanup_identity_isolated_and_reset_after_cancellation():
    import os
    ambient = bench.USER_ID
    fixture_owner = bench.GATE_FIXTURE_TASK_USER_IDS["gate-kyc-card-mint"]
    before = {"root_user_id": fixture_owner, "tree_agent_ids": [ROOT], "browser_sessions": []}
    entered, observed = asyncio.Event(), asyncio.Event()

    async def sibling():
        await entered.wait()
        assert bench._current_benchmark_user_id() == ambient
        assert os.environ["BENCHMARK_RUN_USER_ID"] == ambient
        observed.set()

    async def snapshot(*_args, **_kwargs):
        assert bench._current_benchmark_user_id() == fixture_owner
        entered.set()
        await observed.wait()
        raise asyncio.CancelledError()

    async def delete(*_args):
        assert bench._current_benchmark_user_id() == fixture_owner

    with (
        patch.dict(os.environ, {"BENCHMARK_RUN_USER_ID": ambient}),
        patch.object(cleanup, "exact_root_sessions", return_value=before),
        patch.object(bench, "pause_agent", AsyncMock(return_value=True)),
        patch.object(bench, "_refresh_browser_archive_snapshot", snapshot),
        patch.object(bench, "delete_agent", delete),
        patch.object(cleanup, "close_exact_root_sessions", return_value={"root_agent_id": ROOT}),
    ):
        observer = asyncio.create_task(sibling())
        try:
            async with asyncio.timeout(2):
                with pytest.raises(asyncio.CancelledError):
                    await bench._finalize_owned_cloud_batch("http://localhost:1", [result(ROOT)], {})
                await observer
        finally:
            observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)
        assert bench._current_benchmark_user_id() == ambient
        assert os.environ["BENCHMARK_RUN_USER_ID"] == ambient
