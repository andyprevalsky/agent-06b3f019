"""Tests for hub_upload — env-gated, best-effort run-bundle upload."""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from benchmarks.hub_upload import (
    DEFAULT_HUB_URL,
    durable_open_agent_url,
    hub_upload_enabled,
    is_ephemeral_hub_url,
    mirror_run_bundle_to_durable_hub,
    resolve_hub_upload_url,
    upload_run_bundle,
)


def _serve(record: list):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            record.append(
                {
                    "path": self.path,
                    "api_key": self.headers.get("X-API-Key"),
                    "user_id": self.headers.get("X-User-Id"),
                    "body": json.loads(self.rfile.read(length) or b"{}"),
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
        assert mirror_run_bundle_to_durable_hub(
            {"run_id": "run-durable", "tasks": [{"name": "t", "agent_id": "a1"}]}
        )
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
        def do_POST(self):  # noqa: N802
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


def test_missing_key_skips(monkeypatch):
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:1")
    monkeypatch.delenv("BENCHMARK_HUB_API_KEY", raising=False)
    monkeypatch.delenv("BACKEND_API_KEY", raising=False)
    assert upload_run_bundle({"run_id": "r"}) is False


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
