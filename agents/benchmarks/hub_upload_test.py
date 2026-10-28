"""Tests for hub_upload — env-gated, best-effort run-bundle upload."""

import gzip
import io
import json
import socket
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from benchmarks.hub_upload import (
    DEFAULT_HUB_URL,
    HubVisibilityError,
    _fallback_canonicalize_agent_tree,
    _fallback_tree_child_transcript_count,
    durable_open_agent_url,
    fit_bundle_to_upload_limit,
    hub_upload_enabled,
    is_ephemeral_hub_url,
    mirror_run_bundle_to_durable_hub,
    prepare_run_bundle_for_upload,
    resolve_hub_upload_url,
    upload_run_bundle,
    upload_timeout_for_payload,
)


def _serve(record: list, *, decoded_limit: int | None = None):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            decoded = gzip.decompress(raw) if self.headers.get("Content-Encoding") == "gzip" else raw
            if decoded_limit is not None and len(decoded) > decoded_limit:
                self.send_response(413)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            record.append(
                {
                    "path": self.path,
                    "api_key": self.headers.get("X-API-Key"),
                    "user_id": self.headers.get("X-User-Id"),
                    "content_encoding": self.headers.get("Content-Encoding"),
                    "body": json.loads(decoded or b"{}"),
                }
            )
            payload = b'{"run": {"run_id": "x"}}'
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_hub_transport_explicit_retry_keeps_group_member_and_physical_attempt(monkeypatch):
    record = []
    server, url = _serve(record)
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.setenv("BENCHMARK_HUB_GROUP_RUN_ID", "original-fifty-group")
    monkeypatch.setenv("RUN_BENCH_CAMPAIGN_JOB_ID", "r001-j0001")
    monkeypatch.setenv("RUN_BENCH_CAMPAIGN_RUN", "1")
    monkeypatch.setenv("RUN_BENCH_CAMPAIGN_TOTAL_JOBS", "50")
    monkeypatch.setenv("RUN_BENCH_CAMPAIGN_STARTED_AT", "2026-10-07T22:42:56+00:00")
    try:
        for attempt in (1, 2):
            monkeypatch.setenv("RUN_BENCH_CAMPAIGN_ATTEMPT", str(attempt))
            bundle = {"run_id": f"physical-attempt-{attempt}", "tasks": [{"name": "unchanged-task", "passed": False,
                      "status": "INFRA_ERROR" if attempt == 1 else "FAILED", "lifecycle_stage": "released"}]}
            assert upload_run_bundle(bundle, required=True)
        bodies = [request['body'] for request in record]
        assert [body['run_id'] for body in bodies] == ['physical-attempt-1', 'physical-attempt-2']
        assert [body['group_attempt'] for body in bodies] == [1, 2]
        assert all(body['group_member_id'] == 'r001-j0001' and body['group_total'] == 50 for body in bodies)
        assert all(body['group_run_id'] == 'original-fifty-group' and body['group_timestamp'] == '2026-10-07T22:42:56+00:00' for body in bodies)
        assert bodies[0]['tasks'][0]['passed'] is False and bodies[0]['tasks'][0]['status'] == 'INFRA_ERROR'
        assert bodies[1]['tasks'][0]['passed'] is False and bodies[1]['tasks'][0]['status'] == 'FAILED'
        with pytest.raises(ValueError, match='attempt identity changed'):
            upload_run_bundle({**bundle, 'group_attempt': 1}, required=True)
        assert len(record) == 2
    finally:
        server.shutdown()
        server.server_close()


def test_hub_transport_keeps_complete_transcripts_without_diagnostic_blobs(monkeypatch):
    """The same decoded-size boundary accepts full FE transcripts, not raw logs."""
    import pytest

    record = []
    server, url = _serve(record, decoded_limit=4096)
    task = {
        "name": "fixture-fanout",
        "agent_id": "root",
        "passed": False,
        "tree_agent_count": 2,
        "lifecycle_stage": "released",
        "logs": {
            "messages": [{"role": "USER", "message": "fixture goal"}],
            "tree": {
                "child": {"parent_agent_id": "root", "status": "COMPLETED", "messages": [{"message": "child result"}]}
            },
            "worker_logs": ["x" * 8192],
            "backend_logs": ["diagnostic"],
            "realtime_logs": [{"event": "diagnostic"}],
        },
    }
    bundle = {"run_id": "fixture-terminal", "tasks": [task]}
    original = json.dumps(bundle, sort_keys=True)
    try:
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
        request = urllib.request.Request(
            url + "/api/benchmarks/runs",
            data=gzip.compress(original.encode()),
            headers={"Content-Encoding": "gzip", "Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30)
        assert exc.value.code == 413
        exc.value.close()
        assert upload_run_bundle(bundle, required=True)
        stored = record[0]["body"]["tasks"][0]
        assert stored["logs"] == {"messages": task["logs"]["messages"], "tree": task["logs"]["tree"]}
        assert stored["passed"] is False and stored["lifecycle_stage"] == "released"
        assert json.dumps(bundle, sort_keys=True) == original
    finally:
        server.shutdown()


def test_upload_timeout_scales_with_payload_size():
    """Mass-agent bundles (~40MB+) must not keep a flat 30s Hub POST deadline."""
    assert upload_timeout_for_payload(0) == 30.0
    assert upload_timeout_for_payload(1024) == 30.0 + 1024 / (512 * 1024)
    # ~47MB mass-agent smoke bundle needs well above 30s.
    forty_seven_mb = 47 * 1024 * 1024
    timeout = upload_timeout_for_payload(forty_seven_mb)
    assert timeout >= 120.0
    assert timeout <= 300.0
    assert upload_timeout_for_payload(512 * 1024 * 1024) == 300.0


def test_oversized_bundle_is_fitted_by_dropping_oldest_worker_logs():
    """A 26-task run record was 125MB, nearly all raw worker log lines; the Hub
    answered 413 and a fully passing run exited non-zero."""
    line = "x" * 200

    def task(name: str, lines: int) -> dict:
        return {
            "name": name,
            "passed": True,
            "logs": {
                "messages": [{"role": "USER", "text": f"goal of {name}"}],
                "worker_logs": [f"{index:06d} {line}" for index in range(lines)],
            },
        }

    bundle = {"run_id": "r1", "tasks": [task("big", 4000), task("small", 200)]}
    limit = 300_000
    fitted = fit_bundle_to_upload_limit(bundle, max_bytes=limit)

    assert len(json.dumps(fitted).encode("utf-8")) <= limit
    big, small = fitted["tasks"]
    assert big["logs"]["messages"] == bundle["tasks"][0]["logs"]["messages"], "transcripts are never trimmed"
    assert small["logs"]["worker_logs"] == bundle["tasks"][1]["logs"]["worker_logs"], "only the heaviest task is cut"
    kept = big["logs"]["worker_logs"]
    assert kept and kept[-1].startswith("003999"), "the newest lines are the ones kept"
    assert big["logs"]["worker_logs_omitted_for_upload"] == 4000 - len(kept)
    assert len(bundle["tasks"][0]["logs"]["worker_logs"]) == 4000, "the on-disk record is not mutated"

    assert fit_bundle_to_upload_limit(bundle, max_bytes=10_000_000) is bundle, "a bundle that fits is sent as is"


def test_oversized_bundle_deduplicates_identical_owned_root_logs():
    """One root's full tree is already present on its task; upload it once."""
    logs = {"messages": [{"role": "USER", "text": "x" * 1000}], "tree": {"child": {"messages": ["y" * 1000]}}}
    root = {"root_agent_id": "agent-1", "task_name": "mass-agent", "logs": logs}
    bundle = {
        "run_id": "r2",
        "tasks": [{"name": "mass-agent", "agent_id": "agent-1", "logs": logs,
                   "owned_roots": [root, {"root_agent_id": "agent-2", "logs": {"messages": ["other"]}}]}],
    }
    limit = 3200
    assert len(json.dumps(bundle).encode()) > limit
    fitted = fit_bundle_to_upload_limit(bundle, max_bytes=limit)

    assert len(json.dumps(fitted).encode()) <= limit
    task = fitted["tasks"][0]
    assert task["logs"] == logs
    assert task["owned_roots"][0] == {"root_agent_id": "agent-1", "task_name": "mass-agent"}
    assert task["owned_roots"][1]["logs"] == {"messages": ["other"]}
    assert bundle["tasks"][0]["owned_roots"][0]["logs"] == logs


def test_hub_requests_preserve_external_proxy_routing(monkeypatch):
    """Both publication and visibility use the user's route outside loopback."""
    from benchmarks.hub_upload import verify_run_visible

    calls = []

    class Response:
        status = 201

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def read(self, *_args):
            return b'{"run":{"run_id":"fixture-route"}}'

    class Opener:
        def open(self, request, **_kwargs):
            calls[-1][1].append(request.get_method())
            return Response()

    def build_opener(*handlers):
        calls.append((handlers, []))
        return Opener()

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    for base in ("https://hub.example", "http://localhost.example", "http://127.0.0.1.example"):
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", base)
        assert upload_run_bundle({"run_id": "fixture-route"}, required=True)
        verify_run_visible("fixture-route")
        assert calls[-2:] == [((), ["POST"]), ((), ["GET"])]
    for base in ("http://localhost:8767", "http://127.0.0.1:8767", "http://[::1]:8767"):
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", base)
        assert upload_run_bundle({"run_id": "fixture-route"}, required=True)
        verify_run_visible("fixture-route")
        for handlers, methods in calls[-2:]:
            assert len(handlers) == 1
            assert isinstance(handlers[0], urllib.request.ProxyHandler)
            assert handlers[0].proxies == {}
            assert methods in (["POST"], ["GET"])


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("BENCHMARK_HUB_UPLOAD_URL", raising=False)
    assert hub_upload_enabled() is False
    assert upload_run_bundle({"run_id": "r"}) is False


def test_resolve_hub_upload_url_prefers_explicit_env(monkeypatch):
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "https://hub.example/")
    assert resolve_hub_upload_url("http://localhost:3201") == "https://hub.example"


def test_resolve_hub_upload_url_uses_local_stack_when_unset(monkeypatch):
    monkeypatch.delenv("BENCHMARK_HUB_UPLOAD_URL", raising=False)
    assert resolve_hub_upload_url("http://localhost:3201/") == "http://localhost:3201"
    assert resolve_hub_upload_url("http://127.0.0.1:3201") == "http://127.0.0.1:3201"


def test_resolve_hub_upload_url_defaults_to_prod_for_non_local(monkeypatch):
    monkeypatch.delenv("BENCHMARK_HUB_UPLOAD_URL", raising=False)
    assert resolve_hub_upload_url("https://navi-j9a9.onrender.com") == DEFAULT_HUB_URL
    assert resolve_hub_upload_url(None) == DEFAULT_HUB_URL


def test_is_ephemeral_hub_url():
    assert is_ephemeral_hub_url("http://localhost:3201") is True
    assert is_ephemeral_hub_url("http://127.0.0.1:3201/") is True
    assert is_ephemeral_hub_url(DEFAULT_HUB_URL) is False
    assert is_ephemeral_hub_url(None) is False


def test_durable_open_agent_url():
    assert (
        durable_open_agent_url("42cc9eb7-bca7-4d87-8373-faadcd33f8ef")
        == "https://www.roselabs.ai/?agent-id=42cc9eb7-bca7-4d87-8373-faadcd33f8ef"
    )


def test_mirror_skips_when_primary_already_durable(monkeypatch):
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", DEFAULT_HUB_URL)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "k")
    assert mirror_run_bundle_to_durable_hub({"run_id": "r"}) is False


def test_mirror_dual_writes_ephemeral_hub_to_prod(monkeypatch):
    record: list = []
    server, url = _serve(record)
    try:
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:3201")
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "test-key")
        monkeypatch.delenv("CURSOR_AGENT", raising=False)
        monkeypatch.setattr(
            "benchmarks.hub_upload.DEFAULT_HUB_URL",
            url,
        )
        assert mirror_run_bundle_to_durable_hub({"run_id": "run-durable", "tasks": [{"name": "t", "agent_id": "a1"}]})
        assert len(record) == 1
        assert record[0]["body"]["run_id"] == "run-durable"
    finally:
        server.shutdown()


def test_uploads_bundle_with_auth_headers(monkeypatch):
    record: list = []
    server, url = _serve(record)
    try:
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "test-key")
        monkeypatch.setenv("BENCHMARK_HUB_USER_ID", "user-1")
        assert hub_upload_enabled() is True
        ok = upload_run_bundle({"run_id": "run-42", "tasks": []})
        assert ok is True
        assert len(record) == 1
        assert record[0]["path"] == "/api/benchmarks/runs"
        assert record[0]["api_key"] == "test-key"
        assert record[0]["user_id"] == "user-1"
        assert record[0]["content_encoding"] == "gzip"
        assert record[0]["body"]["run_id"] == "run-42"
        assert record[0]["body"]["source"] == "manual-run"
    finally:
        server.shutdown()


def test_large_bundle_uploads_with_gzip(monkeypatch):
    record: list = []
    server, url = _serve(record)
    try:
        monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "test-key")
        assert upload_run_bundle(
            {"run_id": "large-run", "tasks": [], "padding": "x" * (8 * 1024 * 1024)}, required=True
        )
        assert len(record) == 1
        assert record[0]["content_encoding"] == "gzip"
        assert record[0]["body"]["padding"] == "x" * (8 * 1024 * 1024)
    finally:
        server.shutdown()


def test_upload_failure_is_swallowed(monkeypatch):
    # nothing listening on this port → connection refused → False, no raise
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "k")
    assert upload_run_bundle({"run_id": "r"}) is False


def test_required_upload_retries_transient_disconnect(monkeypatch):
    attempts: list[int] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            attempts.append(1)
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            if len(attempts) == 1:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(201)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv(
            "BENCHMARK_HUB_UPLOAD_URL",
            f"http://127.0.0.1:{server.server_address[1]}",
        )
        monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "test-key")
        monkeypatch.setattr("benchmarks.hub_upload.time.sleep", lambda _delay: None)
        assert upload_run_bundle({"run_id": "terminal-42", "tasks": []}, required=True)
        assert len(attempts) == 2
    finally:
        server.shutdown()


def test_hub_transport_starting_upload_cannot_reconcile_a_programming_error_as_success(monkeypatch):
    from benchmarks import hub_upload

    methods = []

    class Opener:
        def open(self, request, timeout):
            methods.append(request.get_method())
            if request.get_method() == "POST":
                raise ValueError("controlled invalid transport invocation")
            return io.BytesIO(b'{"run":{"run_id":"fixture-programming-error"}}')

    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "https://fixture.invalid")
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.setattr(hub_upload, "_hub_opener", lambda base: Opener())
    monkeypatch.setattr(hub_upload.time, "sleep", lambda seconds: None)
    with pytest.raises(HubVisibilityError) as failure:
        hub_upload.register_starting_run({"run_id": "fixture-programming-error", "tasks": []})
    assert isinstance(failure.value.__cause__, ValueError)
    assert methods == ["POST"], "programming errors must not be acknowledged by an unrelated visible row"


def test_prepare_run_bundle_strips_tool_usage_tree_and_keeps_child_transcripts():
    body = prepare_run_bundle_for_upload(
        {
            "run_id": "r",
            "tasks": [
                {
                    "name": "test-mass-agent-run-0",
                    "agent_id": "root-1",
                    "tree_agent_count": 2,
                    "logs": {
                        "tree": {
                            "root_agent_id": "root-1",
                            "agent_count": 2,
                            "tool_usage_count": 9,
                            "child-a": {
                                "parent_agent_id": "root-1",
                                "goal": "research A",
                                "status": "COMPLETED",
                                "messages": [{"role": "ASSISTANT", "message": "A done"}],
                            },
                        }
                    },
                }
            ],
        }
    )
    tree = body["tasks"][0]["logs"]["tree"]
    assert set(tree.keys()) == {"child-a"}
    assert tree["child-a"]["messages"][0]["message"] == "A done"


def test_required_upload_rejects_empty_fanout_transcripts():
    try:
        prepare_run_bundle_for_upload(
            {
                "run_id": "r",
                "tasks": [
                    {
                        "name": "test-mass-agent-run-0",
                        "agent_id": "root-1",
                        "tree_agent_count": 54,
                        "logs": {
                            "tree": {
                                "root_agent_id": "root-1",
                                "agent_count": 54,
                                "tool_usage_count": 9,
                            }
                        },
                    }
                ],
            },
            required=True,
        )
    except HubVisibilityError as exc:
        assert "child transcripts" in str(exc)
    else:
        raise AssertionError("expected HubVisibilityError for empty fan-out chips")


def test_fallback_tree_helpers_drop_tool_usage_rollup():
    raw = {
        "root_agent_id": "root-1",
        "agent_count": 2,
        "root-1": {"parent_agent_id": None, "goal": "g", "status": "ok", "messages": []},
        "child-1": {
            "parent_agent_id": "root-1",
            "goal": "explore",
            "status": "ok",
            "messages": [{"role": "ASSISTANT", "message": "wrap-up"}],
        },
    }
    tree = _fallback_canonicalize_agent_tree(raw)
    assert "root_agent_id" not in tree
    assert "agent_count" not in tree
    assert set(tree) == {"root-1", "child-1"}
    assert _fallback_tree_child_transcript_count(raw, "root-1") == 1


def test_missing_key_skips(monkeypatch):
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:1")
    monkeypatch.delenv("BENCHMARK_HUB_API_KEY", raising=False)
    monkeypatch.delenv("BACKEND_API_KEY", raising=False)
    assert upload_run_bundle({"run_id": "r"}) is False


def _run_hub_upload_script(script, bundle, *, cwd, extra_env=None):
    import os
    import subprocess
    import sys

    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"PYTHONPATH", "BENCHMARK_HUB_UPLOAD_URL", "BENCHMARK_HUB_API_KEY", "BACKEND_API_KEY"}
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(script), "--upload-final", str(bundle)],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_hub_upload_script_resolves_benchmarks_without_pythonpath(tmp_path):
    """Cloudbench runs `python agents/benchmarks/hub_upload.py` with empty PYTHONPATH."""
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    script = repo / "agents/benchmarks/hub_upload.py"
    bundle = tmp_path / "bundle.json"
    bundle.write_text('{"run_id": "script-path", "tasks": []}')
    proc = _run_hub_upload_script(script, bundle, cwd=repo)
    combined = f"{proc.stdout}\n{proc.stderr}"
    assert "No module named 'benchmarks'" not in combined, combined
    assert "ModuleNotFoundError" not in combined, combined


def test_hub_upload_script_survives_colliding_benchmarks_package(tmp_path):
    """Cloudbench copies can put a different `benchmarks` package first on sys.path."""
    from pathlib import Path

    colliding = tmp_path / "collide"
    (colliding / "benchmarks").mkdir(parents=True)
    (colliding / "benchmarks" / "__init__.py").write_text("PACKAGE = 'collider'\n")
    bundle = tmp_path / "bundle.json"
    bundle.write_text('{"run_id": "collide", "tasks": []}')
    repo = tmp_path / "repo"
    bench = repo / "agents" / "benchmarks"
    bench.mkdir(parents=True)
    src = Path(__file__).resolve().parent
    (bench / "hub_upload.py").write_text((src / "hub_upload.py").read_text())
    proc = _run_hub_upload_script(
        bench / "hub_upload.py",
        bundle,
        cwd=repo,
        extra_env={"PYTHONPATH": str(colliding)},
    )
    combined = f"{proc.stdout}\n{proc.stderr}"
    assert "No module named 'benchmarks.logs'" not in combined, combined
    assert "ModuleNotFoundError" not in combined, combined


def test_hub_upload_copied_script_works_without_sibling_logs(tmp_path):
    """cloudbench-multi-workstream historically copied only hub_upload.py."""
    from pathlib import Path

    repo = tmp_path / "repo"
    bench = repo / "agents" / "benchmarks"
    bench.mkdir(parents=True)
    src = Path(__file__).resolve().parent
    (bench / "hub_upload.py").write_text((src / "hub_upload.py").read_text())
    bundle = tmp_path / "bundle.json"
    bundle.write_text('{"run_id": "copied-only", "tasks": [{"name": "t", "logs": {"tree": {"root_agent_id": "x"}}}]}')
    proc = _run_hub_upload_script(bench / "hub_upload.py", bundle, cwd=repo)
    combined = f"{proc.stdout}\n{proc.stderr}"
    assert "ModuleNotFoundError" not in combined, combined


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))


def test_live_response_preserves_phase_and_startup_label():
    from benchmarks.hub_upload import live_response_matches

    task = {
        "name": "fixture",
        "status": "starting",
        "passed": None,
        "agent_id": None,
        "lifecycle_stage": "starting",
        "startup_label": "Loading services",
    }
    bundle = {"run_id": "fixture-parent", "tasks": [task]}
    stored = {**bundle, "live": True}
    assert live_response_matches(bundle, stored)
    for key in ("lifecycle_stage", "startup_label"):
        assert not live_response_matches(bundle, {**stored, "tasks": [{k: v for k, v in task.items() if k != key}]})


def _one_fleet_aggregate_tick(source):
    """Retain the real tick; its persistent owner loop belongs to the controller."""
    assert "def aggregate_tick():" in source
    assert source.count("\nwhile True:\n") == 1
    return source.split("\nwhile True:\n", 1)[0] + "\naggregate_tick()\n"


def _run_owned_live_projection(argv, *, env=None):
    """Bound and join only this fixture's new process group, including heredoc child."""
    import os
    import signal
    import subprocess

    from benchmarks.fixture_host_guard import FIXTURE_DRAIN_SECONDS, FIXTURE_HOST_GUARD_SECONDS

    process = subprocess.Popen(
        argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    except BaseException:
        # The leader may already have exited while an owned child holds the pipes.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate(timeout=FIXTURE_DRAIN_SECONDS)
        raise
    result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    result.check_returncode()
    return result


@pytest.mark.parametrize("producer", ["startup", "aggregate", "terminal"])
def test_live_response_preserves_phase_and_startup_label_with_stable_fleet_timestamp(tmp_path, monkeypatch, producer):
    """One 50-task fleet retains its identity and original clock through release."""
    import os
    from datetime import datetime, timezone
    from pathlib import Path

    from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function
    from benchmarks.hub_upload import live_bundle_from_report_card

    repo = (
        Path(os.environ["CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST"])
        if "CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST" in os.environ
        else Path(__file__).resolve().parents[2]
    )
    fleet = Path(os.environ.get("CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST", repo / "scripts/run-bench-fleet")).read_text()
    run_id = "fixture-timestamp"
    directory = tmp_path / run_id
    directory.mkdir()
    names = [f"fixture-{index:03d}" for index in range(50)]
    started = 1791331914
    expected = datetime.fromtimestamp(started, timezone.utc).isoformat()
    definitions = fleet[
        fleet.index("write_startup_card() {") : fleet.index(
            "start_central_hub() {", fleet.index("write_startup_card() {")
        )
    ]
    setup = (
        'FLEET_DIR="$1"\nROOT_DIR="$2"\nRUN_ID=fixture-timestamp\nFLEET_CONTROLLER_STARTED_EPOCH='
        + str(started)
        + "\nBENCHES=("
        + " ".join(names)
        + ")\nCATALOG_MODES=("
        + " ".join(["real"] * len(names))
        + ")\nSIM_ON_CSV=\n"
    )
    startup = definitions + "\n" + setup + 'write_startup_card "verifying environment"\n'

    def execute(command):
        _run_owned_live_projection(
            ["bash", "-c", command, "timestamp-control", str(directory), str(repo)]
        )

    execute(startup)
    if producer == "aggregate":
        marker = 'env FLEET_DIR="$FLEET_DIR" UNIFIED_DIR="$UNIFIED_DIR" DASH_BASE="$DASH_BASE"'
        start = fleet.index(marker)
        end = fleet.index("\nPY\n", start) + len("\nPY\n")
        command = (
            setup + 'UNIFIED_DIR="$FLEET_DIR/_batch"\nDASH_BASE=8765\nSELF_MANAGED_HUB_RUN=0\n'
            + _one_fleet_aggregate_tick(fleet[start:end]) + "PY\n"
        )
        phases = ("queued", "running", "evaluated", "teardown", "released")
    elif producer == "terminal":
        command = (
            _extract_fleet_function(fleet, "finalize_terminal_projection() {")
            + "\n"
            + setup
            + "PROVISION_POOL=\n"
            + 'AGGREGATE_RUNS_SCRIPT="$ROOT_DIR/scripts/cloudbench-aggregate-runs.py"\n'
            + "finalize_terminal_projection 0\n"
        )
        phases = ("teardown", "released", "released")
    else:
        command = definitions + "\n" + setup + 'write_startup_card "provisioning"\n'
        phases = ("starting", "starting")
    record = []
    server, url = _serve(record)
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    try:
        for phase in phases:
            for index, name in enumerate(names):
                child = directory / name
                child.mkdir(exist_ok=True)
                if phase == "starting" or phase == "queued":
                    continue
                terminal = producer == "terminal" or (phase != "running" and index < 2)
                status = ("passed" if index % 2 == 0 else "failed") if terminal else "running"
                row = {"name": name, "status": status, "agent_url": f"https://www.roselabs.ai/?agent-id=root-{index}"}
                live = child / "cloudbench-live"
                live.mkdir(exist_ok=True)
                (live / "report-card.json").write_text(json.dumps({"per_task": [row]}))
                task = {
                    "name": name,
                    "status": status.upper(),
                    "passed": status == "passed",
                    "agent_id": f"root-{index}",
                    "agent_url": row["agent_url"],
                }
                (child / "cloudbench-run.json").write_text(json.dumps({"tasks": [task]}))
                if phase == "teardown":
                    (child / "benchmark-child.finished").touch()
                elif phase == "released":
                    (child / "bench-e2e.finished-epoch").write_text(str(started + 60))
            execute(command)
            card = json.loads((directory / "_batch/report-card.json").read_text())
            bundle = (
                json.loads((directory / "_batch/run.json").read_text())
                if producer == "terminal"
                else live_bundle_from_report_card(card, run_id=run_id, source="direct-cloud-fleet")
            )
            assert bundle["timestamp"] == expected, "live fleet publication lost its stable controller-start timestamp"
            assert bundle["run_id"] == run_id
            assert [task["name"] for task in bundle["tasks"]] == names
            if phase in ("starting", "queued", "running"):
                assert all(task["passed"] is None for task in bundle["tasks"])
            else:
                assert [task["passed"] for task in bundle["tasks"][:2]] == [True, False]
                expected_stage = "evaluated" if phase == "evaluated" else phase
                assert all(task["lifecycle_stage"] == expected_stage for task in bundle["tasks"][:2])
            assert upload_run_bundle(bundle, live=producer != "terminal", required=True)
        assert {item["body"]["run_id"] for item in record} == {run_id}
        assert {item["body"]["timestamp"] for item in record} == {expected}
        assert all([task["name"] for task in item["body"]["tasks"]] == names for item in record)
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize(
    ("child_exit", "prior_status", "expected_status", "expected_passed"),
    [
        (None, None, "queued", None),
        (125, None, "error", False),
        (0, None, "error", False),
        (125, "queued", "error", False),
        (1, "passed", "passed", True),
        (0, "failed", "failed", False),
    ],
)
def test_live_response_preserves_phase_and_startup_label_for_terminal_startup(
    tmp_path, monkeypatch, child_exit, prior_status, expected_status, expected_passed
):
    """A finished child without a task result cannot remain a queued placeholder."""
    import os
    import sys
    from datetime import datetime, timezone
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    fleet = Path(os.environ.get("CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST", repo / "scripts/run-bench-fleet")).read_text()
    source = fleet.split("# ── ONE aggregated batch dashboard", 1)[1]
    aggregate = source.split("<<'PY'", 1)[1].split("\n", 1)[1].split("\nPY\n", 1)[0]
    aggregate = _one_fleet_aggregate_tick(aggregate)
    names = [f"fixture-{index:03d}" for index in range(50)]
    batch = tmp_path / "_batch"
    batch.mkdir()
    (batch / "benches.json").write_text(json.dumps([{"name": name, "mode": "REAL"} for name in names]))
    child = tmp_path / names[0]
    child.mkdir()
    (child / "bench-e2e.started-epoch").write_text("1791364506\n")
    if child_exit is not None:
        (child / "benchmark-child.finished").write_text(f"{child_exit}\n")
    if prior_status is not None:
        live = child / "cloudbench-live"
        live.mkdir()
        row = {"name": names[0], "status": prior_status}
        if prior_status in {"passed", "failed"}:
            row["agent_url"] = "https://www.roselabs.ai/?agent-id=owned-root"
            row["outcome_sha256"] = "a" * 64
        (live / "report-card.json").write_text(json.dumps({"per_task": [row]}))
    record = []
    server, url = _serve(record)
    env = dict(
        os.environ,
        FLEET_DIR=str(tmp_path),
        UNIFIED_DIR=str(batch),
        ROOT_DIR=str(repo),
        DASH_BASE="8765",
        FLEET_CONTROLLER_STARTED_EPOCH="1791364019",
        SELF_MANAGED_HUB_RUN="1",
        BENCHMARK_HUB_PARENT_RUN_ID="fixture-terminal-startup",
        BENCHMARK_HUB_API_KEY="fixture-key",
        BENCHMARK_HUB_UPLOAD_URL=url,
        PYTHONPATH=str(repo / "agents"),
    )
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    env.pop("BENCHMARK_HUB_GROUP_RUN_ID", None)
    try:
        _run_owned_live_projection(
            [sys.executable, "-c", aggregate, str(batch / "report-card.json")], env=env
        )
        assert record, "the real live projection was not published"
        bundle = record[-1]["body"]
        assert bundle["run_id"] == "fixture-terminal-startup"
        assert bundle["timestamp"] == datetime.fromtimestamp(1791364019, timezone.utc).isoformat()
        assert [task["name"] for task in bundle["tasks"]] == names
        task = bundle["tasks"][0]
        assert task["status"] == expected_status, "terminal startup remained queued"
        assert task["passed"] is expected_passed
        assert task["lifecycle_stage"] == ("teardown" if child_exit is not None else "starting")
        assert all(task["status"] == "queued" and task["passed"] is None for task in bundle["tasks"][1:])
        if prior_status not in {"passed", "failed"}:
            assert task["agent_id"] is None
            assert task["outcome_sha256"] is None
            assert task["duration_seconds"] is None
            assert task["llm_call_count"] is None
        else:
            assert task["agent_id"] == "owned-root"
            assert task["outcome_sha256"] == "a" * 64
    finally:
        server.shutdown()
        server.server_close()


def test_hub_transport_projects_every_owned_root_without_changing_evidence():
    import copy
    message = {"role": "TOOL", "message": "complete untrusted page evidence", "metadata": {"step": 32}}
    stage_logs = {"messages": [message], "tree": {"root": {"parent_agent_id": None, "goal": "unchanged", "status": "COMPLETED", "messages": [message]}}, "worker_logs": ["duplicated private process output"], "backend_logs": ["duplicated backend output"], "realtime_logs": ["duplicated realtime output"], "cloud_cleanup_evidence": {"root_agent_id": "root", "sealed": True}, "archive_manifest_ref": "r2://owned/root"}
    records = [{"root_agent_id": "root", "role": "fixture_first_run", "stage_outcome": "completed", "creation": {"source": "create_agent_return", "root_agent_id": "root"}, "logs": copy.deepcopy(stage_logs)}, {"root_agent_id": "graded", "role": "graded", "stage_outcome": "FAILED", "logs": copy.deepcopy(stage_logs)}]
    bundle = {"run_id": "same-run", "tasks": [{"name": "same-task", "agent_id": "graded", "passed": False, "status": "FAILED", "logs": copy.deepcopy(stage_logs), "owned_roots": records}]}
    before = copy.deepcopy(bundle)
    projected = prepare_run_bundle_for_upload(bundle, required=True)
    for owner, original in zip([projected["tasks"][0], *projected["tasks"][0]["owned_roots"]], [before["tasks"][0], *before["tasks"][0]["owned_roots"]]):
        for key in ("worker_logs", "backend_logs", "realtime_logs"):
            assert key not in owner["logs"], "nested owned-root diagnostics bypass Hub transport projection"
        assert owner["logs"]["messages"] == original["logs"]["messages"]
        assert owner["logs"]["tree"] == original["logs"]["tree"]
        for key in ("cloud_cleanup_evidence", "archive_manifest_ref"):
            assert owner["logs"][key] == original["logs"][key]
        assert {k:v for k,v in owner.items() if k not in {"logs", "owned_roots"}} == {k:v for k,v in original.items() if k not in {"logs", "owned_roots"}}
    assert bundle == before
    assert projected["tasks"][0]["passed"] is False


@pytest.mark.parametrize('boundary', ['success', 'open_timeout', 'read_timeout', 'bad_ack', 'bad_echo'])
def test_live_upload_attempt_has_source_bound_request_join(tmp_path, monkeypatch, boundary):
    import hashlib
    import re
    from pathlib import Path
    from benchmarks import hub_upload as subject

    monkeypatch.setenv('BENCHMARK_HUB_API_KEY', 'fixture-secret-never-record')
    monkeypatch.setenv('BENCHMARK_HUB_UPLOAD_URL', 'https://fixture.invalid')
    captured = []

    class Response:
        status = 201
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, *args):
            if boundary == 'read_timeout':
                raise TimeoutError('fixture-secret-never-record')
            bundle = json.loads(gzip.decompress(captured[-1][0].data))
            stored = dict(bundle, live=True)
            if boundary == 'bad_ack': stored['run_id'] = 'foreign'
            return json.dumps({'run': stored}).encode()
        @property
        def headers(self):
            value = captured[-1][0].get_header('X-request-id')
            return {'X-Request-Id': value if boundary != 'bad_echo' else 'unsafe\nsecret'}

    class Opener:
        def open(self, request, timeout):
            captured.append((request, timeout))
            if boundary == 'open_timeout': raise TimeoutError('fixture-secret-never-record')
            return Response()

    monkeypatch.setattr(subject, '_hub_opener', lambda base: Opener())
    state = tmp_path / 'publication.json'
    result = subject.publish_live_report_card({'per_task': [{'name': 'fixture-task', 'status': 'queued'}]}, run_id='fixture-run', state_path=state)
    assert result is (boundary in {'success', 'bad_echo'})
    event = json.loads(state.with_suffix('.events.jsonl').read_text())
    request_id = captured[0][0].get_header('X-request-id')
    assert isinstance(request_id, str) and re.fullmatch('[0-9a-f]{12}', request_id)
    attempt = event['attempts'][0]
    assert attempt['request_id'] == request_id and attempt['attempt'] == 1
    assert attempt['source_sha256'] == hashlib.sha256(Path(subject.__file__).read_bytes()).hexdigest()
    assert attempt['effective_timeout'] == captured[0][1]
    assert attempt['payload_bytes'] == len(gzip.decompress(captured[0][0].data))
    assert attempt['compressed_bytes'] == len(captured[0][0].data)
    assert attempt['phase'] == {'open_timeout': 'open', 'read_timeout': 'read', 'bad_ack': 'verify'}.get(boundary, 'complete')
    assert attempt['response_id_matches'] is (True if boundary in {'success', 'bad_ack', 'read_timeout'} else None)
    assert attempt['preparation_seconds'] >= 0 and attempt['attempt_seconds'] >= 0
    assert {'epoch', 'elapsed_seconds', 'verified', 'task_counts'} <= event.keys()
    assert state.exists() is result
    assert 'fixture-secret-never-record' not in json.dumps(event)
    assert 'unsafe' not in json.dumps(event)


def test_upload_attempt_join_preserves_required_retry_and_reconciliation(monkeypatch):
    from benchmarks import hub_upload as subject
    monkeypatch.setenv('BENCHMARK_HUB_API_KEY', 'fixture-secret')
    monkeypatch.setenv('BENCHMARK_HUB_UPLOAD_URL', 'https://fixture.invalid')
    requests, reconciliations, sleeps, events = [], [], [], []
    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            raise TimeoutError('fixture-secret')
    monkeypatch.setattr(subject, '_hub_opener', lambda base: Opener())
    monkeypatch.setattr(subject.time, 'sleep', sleeps.append)
    monkeypatch.setattr(subject, '_upload_committed', lambda *a, **k: reconciliations.append(k) or len(reconciliations) == 4)
    assert subject.upload_run_bundle({'run_id': 'fixture-run', 'tasks': []}, required=True, attempt_events=events)
    assert len(requests) == len(events) == len(reconciliations) == 4
    assert sleeps == [1, 2, 4, 4]
    assert len({event['request_id'] for event in events}) == 4
    assert all(e['phase'] == 'open' for e in events)
    assert all(k['timeout'] == 5.0 for k in reconciliations)


def test_upload_join_records_http_failure_without_changing_required_exhaustion(monkeypatch):
    from benchmarks import hub_upload as subject
    monkeypatch.setenv('BENCHMARK_HUB_API_KEY', 'fixture-secret')
    monkeypatch.setenv('BENCHMARK_HUB_UPLOAD_URL', 'https://fixture.invalid')
    events, payloads, sleeps = [], [], []
    class Opener:
        def open(self, request, timeout):
            payloads.append(request.data)
            raise urllib.error.HTTPError('https://fixture.invalid', 503, 'fixture-secret', {}, io.BytesIO(b'fixture-secret'))
    monkeypatch.setattr(subject, '_hub_opener', lambda base: Opener())
    monkeypatch.setattr(subject.time, 'sleep', sleeps.append)
    monkeypatch.setattr(subject, '_upload_committed', lambda *a, **k: False)
    with pytest.raises(subject.HubVisibilityError):
        subject.upload_run_bundle({'run_id': 'fixture-run', 'tasks': []}, required=True, attempt_events=events)
    assert len(events) == len(payloads) == 4 and len(set(payloads)) == 1
    assert sleeps == [1, 2, 4, 4]
    assert all(e['status'] == 503 and e['error_class'] == 'HTTPError' and e['phase'] == 'open' for e in events)
    assert 'fixture-secret' not in json.dumps(events)


def test_upload_join_private_event_write_failure_keeps_verified_result(tmp_path, monkeypatch):
    from pathlib import Path
    from benchmarks import hub_upload as subject
    monkeypatch.setenv('BENCHMARK_HUB_API_KEY', 'fixture-secret')
    monkeypatch.setenv('BENCHMARK_HUB_UPLOAD_URL', 'https://fixture.invalid')
    class Response:
        status = 201
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, *args): return b'{"run":{}}'
    class Opener:
        def open(self, request, timeout): return Response()
    monkeypatch.setattr(subject, '_hub_opener', lambda base: Opener())
    monkeypatch.setattr(subject, 'live_response_matches', lambda *a: True)
    original_open = Path.open
    def guarded_open(self, *a, **kw):
        if self.suffix == '.jsonl': raise OSError('fixture diagnostic write refusal')
        return original_open(self, *a, **kw)
    monkeypatch.setattr(Path, 'open', guarded_open)
    state = tmp_path / 'publication.json'
    assert subject.publish_live_report_card({'per_task': []}, run_id='fixture-run', state_path=state)
    assert state.exists()


class _FakeClock:
    """Deterministic wall/monotonic clock; sleeping advances both."""

    def __init__(self, start: float = 1_792_320_000.0):
        self.now = start

    def time(self):
        return self.now

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(0.0, seconds)


def _serve_hub(behavior):
    """A Hub fake whose POST/GET responses come from ``behavior(method, path, body)``."""
    log = []

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            decoded = gzip.decompress(raw) if self.headers.get("Content-Encoding") == "gzip" else raw
            body = json.loads(decoded) if decoded else None
            log.append((method, self.path, body))
            status, payload = behavior(method, self.path, body)
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            self._reply("POST")

        def do_GET(self):
            self._reply("GET")

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}", log


def _echo_live(method, path, body):
    if method == "POST":
        return 201, {"run": {**body, "live": "live=1" in path}}
    return 404, {"error": "Run not found"}


def _copy_card(index: int, *, status: str, label: str) -> dict:
    return {
        "timestamp": "2026-10-18T10:40:58+00:00",
        "per_task": [{
            "name": f"task-{index:03d}",
            "status": status,
            "agent_url": f"https://www.roselabs.ai/?agent-id=root-{index}" if status != "queued" else None,
            "lifecycle_stage": "evaluated" if status in ("passed", "failed") else "starting",
            "startup": {"label": label},
        }],
    }


def test_hub_transport_campaign_live_publishers_share_one_hub_budget(tmp_path, monkeypatch):
    """Thirty copies on one controller offer at most the host's share of Hub writes.

    2026-10-18 run600c: every copy re-posted on each startup-label change and
    every 15 s, so 600 copies offered ~18 POST/s to a Hub that commits ~4-6/s;
    the FIFO backlog outgrew every client timeout and terminal uploads failed.
    """
    import benchmarks.hub_upload as hub

    clock = _FakeClock()
    monkeypatch.setattr(hub, "time", clock)
    server, url, log = _serve_hub(_echo_live)
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    monkeypatch.setenv("BENCHMARK_HUB_PUBLICATION_BUDGET_FILE", str(tmp_path / "budget.json"))
    rate = 0.1  # 2 uploads/s across 20 shards
    monkeypatch.setenv("BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND", str(rate))
    # One shard: 30 copies; verdicts arrive at half the share (600 per ~20 min globally).
    copies, seconds = 30, 1000
    finished = {}
    try:
        for tick in range(seconds):
            for index in range(copies):
                # Startup labels change every tick; each copy finishes once.
                done = tick >= 330 + index * 20
                status = ("passed" if index % 2 else "failed") if done else "running"
                card = _copy_card(index, status=status, label=f"step {tick}")
                state = tmp_path / f"copy-{index}.json"
                if hub.publish_live_report_card(card, run_id=f"copy-{index}", state_path=state) and done:
                    stored = json.loads(state.read_text())["signature"][0][1]
                    if stored == status:
                        finished.setdefault(index, tick)
            clock.sleep(1.0)
        posts = [entry for entry in log if entry[0] == "POST"]
        burst = max(2.0, min(30.0, rate * 20))
        assert len(posts) <= burst + rate * seconds + 1, (
            f"{len(posts)} live POSTs exceed the host budget of {rate}/s over {seconds}s"
        )
        # Evaluated outcomes outrank label churn: every copy's verdict lands.
        assert sorted(finished) == list(range(copies))
        assert max(finished[i] - (330 + i * 20) for i in finished) <= 60
    finally:
        server.shutdown()
        server.server_close()


def test_hub_transport_live_publisher_backs_off_when_the_hub_is_saturated(tmp_path, monkeypatch):
    """A failed live write waits with exponential backoff instead of every 1 s tick."""
    import benchmarks.hub_upload as hub

    clock = _FakeClock()
    monkeypatch.setattr(hub, "time", clock)
    server, url, log = _serve_hub(lambda method, path, body: (503, {"error": "busy"}))
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    monkeypatch.setenv("BENCHMARK_HUB_PUBLICATION_BUDGET_FILE", str(tmp_path / "budget.json"))
    monkeypatch.setenv("BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND", "100")
    state = tmp_path / "copy.json"
    try:
        for tick in range(600):
            card = _copy_card(0, status="running", label=f"step {tick}")
            assert hub.publish_live_report_card(card, run_id="copy-0", state_path=state) is False
            clock.sleep(1.0)
        posts = [entry for entry in log if entry[0] == "POST"]
        # 15 s doubling to a 300 s cap with 0.5-1.5 jitter: at most ~8 in 10 min.
        assert 3 <= len(posts) <= 10, f"{len(posts)} retries in 600 s; saturated Hub was not backed off"
        # Only a verified response writes the coalescing projection.
        assert not state.exists()
        assert json.loads(state.with_suffix(".backoff.json").read_text())["failures"] == len(posts)
    finally:
        server.shutdown()
        server.server_close()


def _final_bundle():
    return {
        "run_id": "fixture-final",
        "timestamp": "2026-10-18T10:40:58+00:00",
        "suite": "cloud-fleet",
        "source": "direct-cloud-fleet",
        "status": "passed",
        "tasks": [{"name": "task-000", "status": "PASSED", "passed": True, "agent_id": "root-0",
                   "lifecycle_stage": "released"}],
    }


@pytest.mark.parametrize("committed_while_failing", [False, True])
def test_hub_transport_terminal_publication_is_patient_and_reconciles_before_replay(tmp_path, monkeypatch, committed_while_failing):
    """A saturated Hub gets a bounded patient window, read back before every replay."""
    import benchmarks.hub_upload as hub

    clock = _FakeClock()
    monkeypatch.setattr(hub, "time", clock)
    stored = {}
    posts = []

    def behavior(method, path, body):
        if method == "POST":
            posts.append(body)
            if committed_while_failing and len(posts) == 3:
                # The Hub keeps processing after the client gives up.
                stored["run"] = {**body, "live": False}
            if len(posts) <= 6:
                return 503, {"error": "busy"}
            stored["run"] = {**body, "live": False}
            return 201, {"run": {"run_id": body["run_id"]}}
        if "run" in stored:
            return 200, {"run": stored["run"]}
        return 404, {"error": "Run not found"}

    server, url, log = _serve_hub(behavior)
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    monkeypatch.setenv("BENCHMARK_HUB_PUBLICATION_BUDGET_FILE", str(tmp_path / "budget.json"))
    monkeypatch.setenv("BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS", "900")
    try:
        began = clock.now
        assert hub.publish_terminal_run_bundle(_final_bundle()) is True
        methods = [entry[0] for entry in log]
        # Never two mutations without an intervening exact read-back.
        assert all(not (a == b == "POST") for a, b in zip(methods, methods[1:])), methods
        assert methods.count("POST") == (3 if committed_while_failing else 7)
        assert clock.now - began <= 900
        # The slot is released for the next copy on this host.
        assert json.loads((tmp_path / "budget.json").read_text())["terminal"] == {}
    finally:
        server.shutdown()
        server.server_close()


def test_hub_transport_terminal_publication_fails_closed_at_its_window(tmp_path, monkeypatch):
    import benchmarks.hub_upload as hub

    clock = _FakeClock()
    monkeypatch.setattr(hub, "time", clock)
    server, url, log = _serve_hub(lambda method, path, body: (503, {"error": "busy"}) if method == "POST"
                                  else (404, {"error": "Run not found"}))
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", url)
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    monkeypatch.setenv("BENCHMARK_HUB_PUBLICATION_BUDGET_FILE", str(tmp_path / "budget.json"))
    monkeypatch.setenv("BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS", "600")
    try:
        began = clock.now
        with pytest.raises(HubVisibilityError):
            hub.publish_terminal_run_bundle(_final_bundle())
        assert clock.now - began <= 600 + 1
        # Exponential backoff to a 60 s cap: a bounded number of replays.
        assert 8 <= [entry[0] for entry in log].count("POST") <= 20
    finally:
        server.shutdown()
        server.server_close()


def test_hub_transport_terminal_slots_bound_in_flight_bundles_and_preempt_live_writes(tmp_path, monkeypatch):
    """Hub memory holds every queued terminal body; one host never sends more than its slots."""
    import os
    import subprocess
    import sys
    import time as real_time
    from pathlib import Path

    import benchmarks.hub_upload as hub

    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("BENCHMARK_HUB_API_KEY", "fixture-key")
    monkeypatch.setenv("BENCHMARK_HUB_PUBLICATION_BUDGET_FILE", str(tmp_path / "budget.json"))
    monkeypatch.setenv("BENCHMARK_HUB_TERMINAL_CONCURRENCY", "1")
    probe = (
        "import sys,time\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import benchmarks.hub_upload as hub\n"
        "try:\n"
        "    with hub.terminal_publication_slot(deadline=time.monotonic() + float(sys.argv[2])):\n"
        "        print('held')\n"
        "except hub.HubVisibilityError:\n"
        "    print('refused')\n"
    )
    agents = str(Path(hub.__file__).resolve().parents[1])
    with hub.terminal_publication_slot(deadline=real_time.monotonic() + 5):
        # A pending terminal publication defers lower-value live writes on this host.
        assert hub.acquire_live_upload(priority=False) is False
        assert hub.acquire_live_upload(priority=True) is True
        other = subprocess.run([sys.executable, "-c", probe, agents, "2"], capture_output=True, text=True,
                               env=dict(os.environ), timeout=60)
        assert other.stdout.strip() == "refused", other.stderr
    after = subprocess.run([sys.executable, "-c", probe, agents, "5"], capture_output=True, text=True,
                           env=dict(os.environ), timeout=60)
    assert after.stdout.strip() == "held", after.stderr
    # A slot whose owner died is reclaimed through its native process birth.
    state = json.loads((tmp_path / "budget.json").read_text())
    state["terminal"] = {"999999": {"birth": "proc-start:gone:1", "since": 0, "holding": True}}
    (tmp_path / "budget.json").write_text(json.dumps(state))
    with hub.terminal_publication_slot(deadline=real_time.monotonic() + 5):
        pass


def test_hub_transport_campaign_member_identity_survives_cross_host_pid_reuse(tmp_path, monkeypatch):
    """Sharded controllers reuse PID+second; each member still owns one distinct Hub record.

    2026-10-18 run600c: 24 Hub run IDs were shared by 48 copies on different
    controllers; every write of the second member failed with
    "Benchmark Hub group membership changed".
    """
    import os
    import subprocess
    from pathlib import Path

    from benchmarks.cloudbench_dependency_sync_test import _extract_fleet_function

    repo = Path(__file__).resolve().parents[2]
    fleet = (repo / "scripts/run-bench-fleet").read_text()
    function = _extract_fleet_function(fleet, "require_in_app_hub_visibility() {")
    record = []
    server, url = _serve(record)
    try:
        published = []
        for member in ("r001-j0002", "r001-j0006"):
            directory = tmp_path / member / "20261018-103918-16718"
            (directory / "_batch").mkdir(parents=True)
            (directory / "_batch/report-card.json").write_text(json.dumps({"tasks": []}))
            env = dict(
                os.environ,
                BENCHMARK_HUB_UPLOAD_URL=url,
                BENCHMARK_HUB_API_KEY="fixture-key",
                BENCHMARK_HUB_PUBLICATION_BUDGET_FILE=str(tmp_path / "budget.json"),
                BENCHMARK_HUB_GROUP_RUN_ID="original600-1792319287448456235",
                RUN_BENCH_CAMPAIGN_JOB_ID=member,
                RUN_BENCH_CAMPAIGN_RUN="1",
                RUN_BENCH_CAMPAIGN_TOTAL_JOBS="600",
                RUN_BENCH_CAMPAIGN_STARTED_AT="2026-10-18T10:28:00+00:00",
                RUN_BENCH_CAMPAIGN_ATTEMPT="1",
            )
            script = (
                function
                + f'\nHUB_UPLOAD_HELPER="{repo}/agents/benchmarks/hub_upload.py"\nROOT_DIR="{repo}"\n'
                + f'FLEET_DIR="{directory}"\nRUN_ID=20261018-103918-16718\nINHERITED_HUB_RUN_ID=\n'
                + 'require_in_app_hub_visibility\nprintf "%s\\n" "$BENCHMARK_HUB_PARENT_RUN_ID"\n'
            )
            result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=120)
            assert result.returncode == 0, result.stderr
            hub_run = result.stdout.strip().splitlines()[-1]
            assert (directory / "_batch/hub-run-id").read_text().strip() == hub_run
            published.append(hub_run)
        assert published[0] != published[1]
        assert all(run.startswith("20261018-103918-16718-m") for run in published)
        assert [item["body"]["run_id"] for item in record] == published
        assert [item["body"]["group_member_id"] for item in record] == ["r001-j0002", "r001-j0006"]
    finally:
        server.shutdown()
        server.server_close()
    # Standalone fleets keep their historical identity.
    monkeypatch.delenv("BENCHMARK_HUB_GROUP_RUN_ID", raising=False)
    from benchmarks.hub_upload import hub_run_id_for

    assert hub_run_id_for("20261018-103918-16718") == "20261018-103918-16718"


def test_archived_diagnostic_projection_requires_authenticated_bindings():
 from benchmarks.hub_upload import project_archived_diagnostics
 import copy, hashlib
 diagnostic={'history':['private control']};bundle={'run_id':'run','tasks':[{'agent_id':'root','passed':False,'logs':{'messages':[{'text':'kept'}],'tree':{},'wmh_retirement':diagnostic}}]}
 canonical={'path':'canonical.json','size':1,'sha256':'a'*64};native={'path':'native.json','size':1,'sha256':'b'*64};manifest=[canonical,native];digest=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest();receipt={'full_readback_verified':True,'files':2,'bucket':'trace-archive','key':'private/control.enc','encryption_key_id':'control','ciphertext_sha256':'c'*64,'manifest_sha256':digest};binding={'run_id':'run','member':native,'diagnostic_sha256':hashlib.sha256(json.dumps(diagnostic,sort_keys=True,separators=(',',':')).encode()).hexdigest()};ref={k:receipt[k] for k in ['bucket','key','encryption_key_id','ciphertext_sha256','manifest_sha256']};ref.update(canonical=canonical,retirements={'root':binding});trusted=copy.deepcopy({'bundle_sha256':hashlib.sha256(json.dumps(bundle,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'canonical':canonical,'run_id':'run','retirements':{'root':binding}})
 def verify(_):return receipt,manifest,trusted
 before=json.dumps(bundle,sort_keys=True);out=project_archived_diagnostics(bundle,ref,verify_archive=verify);assert json.dumps(bundle,sort_keys=True)==before and out['tasks'][0]['logs']['messages']==bundle['tasks'][0]['logs']['messages'] and out['tasks'][0]['passed'] is False
 attacked=copy.deepcopy(bundle);attacked['tasks'][0]['logs']['wmh_retirement']={'changed':'unarchived'};bad=copy.deepcopy(ref);bad['retirements']['root']['diagnostic_sha256']=hashlib.sha256(json.dumps({'changed':'unarchived'},sort_keys=True,separators=(',',':')).encode()).hexdigest()
 try:project_archived_diagnostics(attacked,bad,verify_archive=verify)
 except HubVisibilityError:pass
 else:raise AssertionError('Caller cannot selfattest unarchived substitution')
 print('PASS small owning immutable projection + changed-inline/matchingdigest substitution rejection')


def test_live_projection_fixture_joins_inherited_pipe_after_leader_exit(tmp_path, monkeypatch):
    """The direct command can exit while its owned child retains both pipes."""
    import subprocess
    import sys
    from benchmarks import fixture_host_guard

    monkeypatch.setattr(fixture_host_guard, "FIXTURE_HOST_GUARD_SECONDS", 0.2)
    started = tmp_path / "pipe-child-started"
    command = (
        "import subprocess,sys; "
        "subprocess.Popen([sys.executable, '-c', "
        + repr("from pathlib import Path; import time; Path(" + repr(str(started)) + ").touch(); time.sleep(60)")
        + "])"
    )
    with pytest.raises(subprocess.TimeoutExpired):
        _run_owned_live_projection([sys.executable, "-c", command])
    assert started.exists(), "the inherited-pipe child must actually have started"
