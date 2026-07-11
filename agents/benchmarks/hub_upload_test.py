"""Tests for hub_upload — env-gated, best-effort run-bundle upload."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from benchmarks.hub_upload import hub_upload_enabled, upload_run_bundle


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


def test_missing_key_skips(monkeypatch):
    monkeypatch.setenv("BENCHMARK_HUB_UPLOAD_URL", "http://127.0.0.1:1")
    monkeypatch.delenv("BENCHMARK_HUB_API_KEY", raising=False)
    monkeypatch.delenv("BACKEND_API_KEY", raising=False)
    assert upload_run_bundle({"run_id": "r"}) is False


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
