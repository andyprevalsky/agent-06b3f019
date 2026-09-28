#!/usr/bin/env python3
"""Exercise the real terminal collector across a delayed guest seal and transfer."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/run-bench-cloud").read_text()
MATCH = re.search(r"(?ms)^cloudbench_collect_runtime_evidence\(\).*?^}\n", SOURCE)
assert MATCH, "production collector function was not found"
COLLECTOR = MATCH.group()


def exercise(*, seal_after: int, deadline: int, file_delay: float):
    token, machine = "test-run-1", "abcdef12345678"
    files = {
        "services.json": json.dumps({"status": "stopped", "env": {"worker_processes": 2}}).encode(),
        "run.json": b'{"run_id":"test-run-1"}\n',
        "stack.log": b"stack clean\n",
        "logs/backend.log": b"backend stopped\n",
        f"cloudbench-stack-cleanup-{token}.status": b"state=clean\n",
        "logs/worker.log": b"worker stopped\n",
        "logs/worker.1.log": b"worker one stopped\n",
    }
    manifest = {
        "version": 1,
        "run_token": token,
        "machine_id": machine,
        "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in files.items()},
    }
    manifest_calls = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            nonlocal manifest_calls
            assert self.headers.get("Authorization") == "Bearer test-secret"
            assert self.headers.get("X-Cloudbench-Run-Token") == token
            assert self.headers.get("X-Cloudbench-Machine-Id") == machine
            parts = urlsplit(self.path)
            assert parts.path == "/runtime-evidence"
            if not parts.query:
                manifest_calls += 1
                if manifest_calls <= seal_after:
                    self.send_error(409, "exact runtime is not sealed")
                    return
                data = json.dumps(manifest).encode()
            else:
                name = parse_qs(parts.query)["file"][0]
                data = files[name]
                time.sleep(file_delay)
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "bench"
            destination = output / "remote-logs"
            destination.mkdir(parents=True)
            owner = {"version": 1, "run_token": token, "machine_id": machine}
            for name in ("runtime-evidence.pending", "runtime-evidence.owner.json"):
                (output / name).write_text(json.dumps(owner))
            command = COLLECTOR + "\ncloudbench_collect_runtime_evidence \"$1\" \"$2\" \"$3\" \"$4\" \"$5\"\n"
            result = subprocess.run(
                ["bash", "-c", command, "collector-test", str(destination),
                 str(server.server_port), token, machine, str(deadline)],
                env={**os.environ, "CLOUDBENCH_BARRIER_TOKEN": "test-secret"},
                capture_output=True, text=True, timeout=deadline + 5,
            )
            if seal_after < 100:
                assert result.returncode == 0, result.stderr[-600:]
                capture = destination / "runtime-evidence"
                assert json.loads((capture / "manifest.json").read_text()) == manifest
                for name, data in files.items():
                    assert (capture / name).read_bytes() == data
                assert manifest_calls >= seal_after + 2
            else:
                assert result.returncode != 0
                assert "terminal runtime evidence deadline expired" in result.stderr
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_delayed_seal_then_complete_transfer():
    exercise(seal_after=2, deadline=5, file_delay=0.14)


def test_unsealed_guest_fails_closed_at_deadline():
    exercise(seal_after=1000, deadline=1, file_delay=0)


if __name__ == "__main__":
    test_delayed_seal_then_complete_transfer()
    test_unsealed_guest_fails_closed_at_deadline()
    print("PASS: terminal collector waits for exact seal, transfers, and fails closed on timeout")
