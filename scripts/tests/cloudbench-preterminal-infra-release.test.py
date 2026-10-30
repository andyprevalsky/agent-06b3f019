#!/usr/bin/env python3
"""A declared pre-terminal infrastructure failure must end the child promptly.

Regression for Polar batch 1 job r002-j0026 (2026-10-20): the guest stopped
answering on the data plane, the poll loop declared "bench.log could not be
read after 5 bounded retries -- infrastructure failure", and the post-loop
runtime-evidence collector then waited the whole 7200 s wall-clock backstop
for a seal that no guest would ever produce. The job stayed "running" for two
hours until the campaign deadline TERM.

This executes the real read-gate failure branch and the real post-loop block
of scripts/run-bench-cloud (with the real confirm_guest_shutdown and
cloudbench_collect_runtime_evidence) against two fake status endpoints:

1. a black-holed data plane (connections accepted, never answered), and
2. a healthy data plane whose driver is still running and only seals after
   an authenticated POST /shutdown.

Both must leave the post-loop block with exit 70 well inside the bound, and
the healthy guest must receive the shutdown request.
"""

import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get("ROSE_PRETERMINAL_TEST_SOURCE", ROOT / "scripts/run-bench-cloud")).read_text()
BOUND_SECONDS = 60
BACKSTOP_SECONDS = 7200


def function(name: str) -> str:
    match = re.search(rf"(?ms)^{name}\(\) {{.*?^}}\n", SOURCE)
    assert match, f"production function {name} was not found"
    return match.group()


def read_failure_branch() -> str:
    match = re.search(
        r"(?ms)^        20\)\n(            echo \"❌ bench\.log could not be read after .*?)^            ;;\n",
        SOURCE,
    )
    assert match, "production bench.log read-failure branch was not found"
    return match.group(1)


def post_loop_block() -> str:
    start = SOURCE.index("\n# Preserve the complete remote driver and service logs before the EXIT trap")
    end = SOURCE.index("\nif [ \"${CLOUDBENCH_BOOT_LAUNCH:-0}\" != \"1\" ]; then", start)
    return SOURCE[start:end]


def initial_state() -> str:
    match = re.search(r'(?m)^DRIVER_DIED="0"\n(?:#.*\n)*(PRETERMINAL_INFRA_FAILURE="0"\n)?', SOURCE)
    assert match, "poll-loop state initialisation was not found"
    return match.group()


class BlackHole:
    """Accept TCP connections and never answer, like a relay to a stalled guest."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.held = []
        self.stop = False
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        self.sock.settimeout(0.2)
        while not self.stop:
            try:
                conn, _ = self.sock.accept()
                self.held.append(conn)
            except OSError:
                continue

    def close(self):
        self.stop = True
        for conn in self.held:
            conn.close()
        self.sock.close()


def live_driver_server(token: str, machine: str):
    state = {"shutdown_posts": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, code: int):
            self.send_response(code)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            assert self.headers.get("Authorization") == "Bearer test-secret"
            if self.path == "/shutdown":
                state["shutdown_posts"] += 1
                self.reply(202)
                return
            self.reply(404)

        def do_GET(self):
            assert self.headers.get("Authorization") == "Bearer test-secret"
            path = self.path.split("?", 1)[0]
            if path == "/shutdown-health":
                # 409 until the controller asks; then the stack cleanup acknowledges.
                self.reply(204 if state["shutdown_posts"] else 409)
            elif path == "/driver-health":
                self.reply(202)  # the driver is still running
            elif path == "/runtime-evidence":
                self.reply(409)  # never sealed by this fixture
            elif path.startswith("/cloudbench-driver-clean-"):
                self.reply(404)
            else:
                self.reply(404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state


def run_case(port: int, label: str):
    token, machine = "test-run-1", "abcdef12345678"
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR", "/var/tmp")) as raw:
        out = Path(raw) / "out"
        out.mkdir()
        row = {"version": 1, "run_token": token, "machine_id": machine}
        for name in ("runtime-evidence.pending", "runtime-evidence.owner.json"):
            (out / name).write_text(json.dumps(row) + "\n")
        ssh_log = Path(raw) / "bench.log"
        ssh_log.write_text("partial driver log\n")
        harness = "\n".join([
            "set -o pipefail",
            f"OUT_DIR={out}",
            f"SSH_LOG={ssh_log}",
            f"RUN_LOG_TOKEN={token}",
            f"FLEET_MACHINE_ID={machine}",
            "mid=$FLEET_MACHINE_ID",
            f"LOCAL_STATUS_PORT={port}",
            "CLOUDBENCH_FLEET_RUN_ID=test-fleet-run",
            "CLOUDBENCH_BOOT_LAUNCH=1",
            "CLOUDBENCH_CHILD_TERM_SECONDS=5",
            f"CLOUDBENCH_RUNTIME_EVIDENCE_SECONDS={BACKSTOP_SECONDS}",
            f"BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS={BACKSTOP_SECONDS}",
            "export CLOUDBENCH_BARRIER_TOKEN=test-secret",
            "BENCH_LOG_READ_MAX_FAILURES=5",
            "TIMED_OUT=0; FINISHED=0; BENCH_EXIT=''",
            initial_state(),
            "cloudbench_proxy_alive() { return 0; }",
            "publish_guest_shutdown_delivery_receipt() { return 0; }",
            "cloudbench_skip_held_driver_teardown_race() { return 1; }",
            "cloudbench_collect_terminal_log() { return 10; }",
            function("confirm_guest_shutdown"),
            function("cloudbench_collect_runtime_evidence"),
            # The poll loop's real declared-failure branch, then the real post-loop block.
            "while :; do",
            read_failure_branch(),
            "done",
            post_loop_block(),
            'echo "REACHED_ARTIFACT_RETRIEVAL"',
            "exit 0",
        ])
        started = time.monotonic()
        # Own process group: a hung collector must never outlive this test.
        child = subprocess.Popen(
            ["bash", "-c", harness], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True,
        )
        try:
            stdout, stderr = child.communicate(timeout=BOUND_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            _, stderr = child.communicate()
            raise AssertionError(
                f"{label}: declared bench.log infrastructure failure still waited for the "
                f"{BACKSTOP_SECONDS}s runtime-evidence backstop (> {BOUND_SECONDS}s); job would stay running\n{stderr}"
            ) from None
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        result = subprocess.CompletedProcess(child.args, child.returncode, stdout, stderr)
        elapsed = time.monotonic() - started
        output = result.stdout + result.stderr
        assert "bench.log could not be read after 5 bounded retries -- infrastructure failure" in output, output
        assert result.returncode == 70, f"{label}: expected exit 70, got {result.returncode}\n{output}"
        assert "REACHED_ARTIFACT_RETRIEVAL" not in output, output
        assert elapsed < BOUND_SECONDS, elapsed
        # The original exact owner stays pending for controller recovery.
        assert (out / "runtime-evidence.pending").is_file()
        return elapsed, output


def black_holed_case():
    hole = BlackHole()
    try:
        elapsed, output = run_case(hole.port, "black-holed data plane")
        assert "guest cleanup request failed" in output, output
        print(f"PASS: black-holed data plane -> exit 70 in {elapsed:.1f}s")
    finally:
        hole.close()


def live_driver_case():
    server, state = live_driver_server("test-run-1", "abcdef12345678")
    try:
        elapsed, output = run_case(server.server_address[1], "live driver")
        assert state["shutdown_posts"] == 1, state
        assert "guest browser/session cleanup acknowledged" in output, output
        print(f"PASS: live driver -> authenticated shutdown delivered, exit 70 in {elapsed:.1f}s")
    finally:
        server.shutdown()


def main():
    failures = []
    for case in (black_holed_case, live_driver_case):
        try:
            case()
        except AssertionError as error:
            failures.append(f"FAIL: {case.__name__}: {error}")
    for failure in failures:
        print(failure, file=sys.stderr)
    if failures:
        return 1
    print("PASS: cloudbench-preterminal-infra-release")
    return 0


if __name__ == "__main__":
    sys.exit(main())
