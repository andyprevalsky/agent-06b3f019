"""Tests for hub_upload — env-gated, best-effort run-bundle upload."""

import gzip
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from benchmarks.hub_upload import (
    DEFAULT_HUB_URL,
    HubVisibilityError,
    _fallback_canonicalize_agent_tree,
    _fallback_tree_child_transcript_count,
    durable_open_agent_url,
    hub_upload_enabled,
    is_ephemeral_hub_url,
    mirror_run_bundle_to_durable_hub,
    prepare_run_bundle_for_upload,
    resolve_hub_upload_url,
    upload_run_bundle,
    upload_timeout_for_payload,
)


def _serve(record: list):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            decoded = gzip.decompress(raw) if self.headers.get("Content-Encoding") == "gzip" else raw
            record.append(
                {
                    "path": self.path,
                    "api_key": self.headers.get("X-API-Key"),
                    "user_id": self.headers.get("X-User-Id"),
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
        assert record[0]["body"]["run_id"] == "run-42"
        assert record[0]["body"]["source"] == "manual-run"
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
