#!/usr/bin/env python3
"""Exercise the real terminal collector across a delayed guest seal and transfer."""

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
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


def exercise(
    *,
    seal_after: int,
    deadline: int,
    file_delay: float,
    recovery: bool = False,
    terminal_cleanup_failure: bool = False,
    terminal_clean_without_seal: bool = False,
    seal_during_shutdown: bool = False,
    transport_fault: tuple[str, str] | None = None,
    blocked_manifest: bool = False,
    expect_deadline: bool = False,
    forbidden_manifest: bool = False,
    socket_fault: str | None = None,
    wmh_log: bool = False,
    guest_diagnostics: bool = False,
):
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
    if wmh_log:
        files["wmh-serve-log.txt"] = b"wmh_step_committed prediction_ms=10000\n"
    if guest_diagnostics:
        files["guest-diagnostics.jsonl"] = b'{"backend_pool_limit": 30, "pg": {"by_state": {"active": 30}}}\n'
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
            if parts.path == "/driver-health":
                self.send_error(
                    410 if transport_fault and transport_fault[0] == "ack" else 202
                )
                return
            if parts.path.startswith("/cloudbench-driver-clean-"):
                data = token.encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if parts.path == "/shutdown-health":
                self.send_error(
                    500
                    if terminal_cleanup_failure
                    else 204
                    if terminal_clean_without_seal or seal_during_shutdown
                    else 202,
                    "driver exited without cleanup acknowledgement"
                    if terminal_cleanup_failure
                    else "cleanup pending",
                )
                return
            assert parts.path == "/runtime-evidence"
            if not parts.query:
                manifest_calls += 1
                if socket_fault and manifest_calls == 1:
                    # Exercise an actual peer reset before HTTP headers, rather
                    # than an exception injected above urllib's owning read.
                    self.close_connection = True
                    if socket_fault == "reset":
                        self.connection.setsockopt(
                            socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
                        )
                    else:
                        assert socket_fault == "disconnect"
                        self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                if forbidden_manifest:
                    self.send_error(403)
                    return
                if blocked_manifest:
                    time.sleep(deadline + 0.5)
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
            try:
                self.wfile.write(data)
            except BrokenPipeError:
                assert blocked_manifest

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
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
            argv = (
                [sys.executable, str(ROOT / "scripts/cloudbench-collect-runtime-evidence.py"),
                 str(destination), str(server.server_port), token, machine, str(deadline)]
                if recovery else
                ["bash", "-c", command, "collector-test", str(destination),
                 str(server.server_port), token, machine, str(deadline)]
            )
            if transport_fault:
                # Inject the exact urllib transport exception before delegating
                # all successful reads to the authenticated real HTTP fixture.
                bootstrap = """
import json, runpy, sys, urllib.error, urllib.request
from urllib.parse import urlsplit
stage, kind = json.loads(sys.argv.pop(1))
native_open = urllib.request.OpenerDirector.open
raised = False
def open_with_fault(self, request, *args, **kwargs):
    global raised
    path = urlsplit(request.full_url).path
    target = {"manifest": "/runtime-evidence", "shutdown": "/shutdown-health",
              "driver": "/driver-health", "ack": "/cloudbench-driver-clean-"}[stage]
    if path.startswith(target) and (not raised or kind == "persistent-timeout"):
        raised = True
        if kind == "url":
            raise urllib.error.URLError(ConnectionRefusedError("fixture proxy unavailable"))
        raise TimeoutError("fixture socket read timed out")
    return native_open(self, request, *args, **kwargs)
urllib.request.OpenerDirector.open = open_with_fault
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
assert raised, "transport fault was never exercised"
"""
                assert recovery
                argv = [
                    sys.executable,
                    "-c",
                    bootstrap,
                    json.dumps(transport_fault),
                    *argv[1:],
                ]
            started = time.monotonic()
            result = subprocess.run(
                argv,
                env={**os.environ, "CLOUDBENCH_BARRIER_TOKEN": "test-secret"},
                capture_output=True, text=True, timeout=deadline + 5,
            )
            elapsed = time.monotonic() - started
            if forbidden_manifest:
                assert result.returncode != 0 and "HTTP Error 403" in result.stderr
                assert manifest_calls == 1
                if elapsed >= 1.5:
                    print(f"WARNING: forbidden manifest observation took {elapsed:.3f}s")
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
                return
            if terminal_cleanup_failure or terminal_clean_without_seal:
                assert result.returncode != 0
                expected_error = (
                    "driver exited without cleanup acknowledgement"
                    if terminal_cleanup_failure else
                    "guest shutdown without sealed runtime evidence"
                )
                assert expected_error in result.stderr
                if elapsed >= 1.5:
                    print(f"WARNING: terminal cleanup observation took {elapsed:.3f}s")
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
                return
            if seal_after < 100 and not expect_deadline:
                assert result.returncode == 0, result.stderr[-600:]
                capture = destination / "runtime-evidence"
                assert json.loads((capture / "manifest.json").read_text()) == manifest
                for name, data in files.items():
                    assert (capture / name).read_bytes() == data
                assert manifest_calls >= seal_after + 2
            else:
                assert result.returncode != 0
                assert "terminal runtime evidence deadline expired" in result.stderr
                if elapsed >= deadline + 1:
                    print(f"WARNING: runtime evidence deadline observation took {elapsed:.3f}s")
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def test_delayed_seal_then_complete_transfer():
    exercise(seal_after=2, deadline=5, file_delay=0.14)


def test_unsealed_guest_fails_closed_at_deadline():
    exercise(seal_after=1000, deadline=1, file_delay=0)


def test_recovery_collector_after_delayed_seal():
    exercise(seal_after=2, deadline=5, file_delay=0.14, recovery=True)


def test_recovery_collector_keeps_pending_on_timeout():
    exercise(seal_after=1000, deadline=1, file_delay=0, recovery=True)


def test_recovery_collector_stops_on_terminal_cleanup_failure():
    exercise(seal_after=1000, deadline=3, file_delay=0, recovery=True,
             terminal_cleanup_failure=True)


def test_collectors_stop_on_clean_shutdown_without_run_result():
    for recovery in (False, True):
        exercise(seal_after=1000, deadline=3, file_delay=0, recovery=recovery,
                 terminal_clean_without_seal=True)


def guest_inventory_includes_optional_wmh_log():
    """The guest seals the served WMH log when present, never through a link."""
    import runpy

    status = runpy.run_path(str(ROOT / "scripts/cloudbench-status-server.py"))
    token = "test-run-1"
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory) / "repo/.context/cloudbench"
        (context / "logs").mkdir(parents=True)
        for name, text in {
            "services.json": json.dumps({"status": "stopped", "env": {"worker_processes": 1}}),
            "run.json": "{}", "stack.log": "stack\n", "logs/backend.log": "backend\n",
            "logs/worker.log": "worker\n", f"cloudbench-stack-cleanup-{token}.status": f"state=clean\ntoken={token}\n",
        }.items():
            (context / name).write_text(text)
        assert "wmh-serve-log.txt" not in status["runtime_evidence_context_paths"](context, token)
        (context / "wmh-serve-log.txt").write_text("wmh_step_committed\n")
        manifest = status["runtime_evidence_context_manifest"](context, token, "abcdef12345678")
        assert manifest["files"]["wmh-serve-log.txt"]["bytes"] == len("wmh_step_committed\n")
        (context / "wmh-serve-log.txt").unlink()
        (context / "wmh-serve-log.txt").symlink_to(context / "stack.log")
        try:
            status["runtime_evidence_context_paths"](context, token)
        except ValueError as error:
            assert "unsafe runtime evidence" in str(error)
        else:
            raise AssertionError("a linked WMH log was admitted as runtime evidence")


def guest_diagnostics_sampler_and_inventory():
    """The bounded sampler writes CPU, pool and pg_stat_activity samples that the
    guest inventory seals as optional runtime evidence."""
    import runpy

    status = runpy.run_path(str(ROOT / "scripts/cloudbench-status-server.py"))
    token = "test-run-1"
    with tempfile.TemporaryDirectory() as directory:
        bin_dir = Path(directory) / "bin"
        bin_dir.mkdir()
        psql = bin_dir / "psql"
        psql.write_text(
            "#!/bin/sh\n"
            "case \"$*\" in *pg_stat_activity*) ;; *) exit 2 ;; esac\n"
            "echo '{\"connections\": 33, \"max_connections\": 100, \"database_clients\": 30,"
            " \"by_state\": {\"active\": 30}, \"by_wait\": {\"Lock:transactionid\": 4},"
            " \"longest_active_s\": 2.5, \"longest_idle_in_transaction_s\": 0}'\n"
        )
        psql.chmod(0o755)
        context = Path(directory) / "repo/.context/cloudbench"
        (context / "logs").mkdir(parents=True)
        for name, text in {
            "services.json": json.dumps({"status": "stopped", "env": {"worker_processes": 1}}),
            "run.json": "{}", "stack.log": "stack\n", "logs/backend.log": "backend\n",
            "logs/worker.log": "worker\n", f"cloudbench-stack-cleanup-{token}.status": f"state=clean\ntoken={token}\n",
        }.items():
            (context / name).write_text(text)
        assert "guest-diagnostics.jsonl" not in status["runtime_evidence_context_paths"](context, token)
        output = context / "guest-diagnostics.jsonl"
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/cloudbench-guest-diagnostics.py"), str(output),
             "postgresql://postgres:postgres@localhost:5432/victoria", "30", "0.05", "2"],
            env={**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"},
            capture_output=True, text=True, timeout=30, check=False,
        )
        assert result.returncode == 0, result.stderr
        samples = [json.loads(line) for line in output.read_text().splitlines()]
        assert len(samples) == 2, samples
        for sample in samples:
            assert sample["backend_pool_limit"] == 30
            assert sample["pg"]["database_clients"] == 30 and sample["pg"]["by_wait"] == {"Lock:transactionid": 4}
            assert sample["pg"]["longest_active_s"] == 2.5
            assert len(sample["load"]) == 3 and sample["cpus"] >= 1
            assert sample["cpu_busy_pct"] is None or 0 <= sample["cpu_busy_pct"] <= 100
            assert "postgres:postgres" not in json.dumps(sample)
        manifest = status["runtime_evidence_context_manifest"](context, token, "abcdef12345678")
        assert manifest["files"]["guest-diagnostics.jsonl"]["bytes"] == output.stat().st_size

        # CPU mode split: hypervisor steal (a throttled shared-cpu guest) must be
        # told apart from the guest's own user/system work. Exact arithmetic on
        # synthetic /proc/stat counters, then the live fields on every sample.
        sampler = runpy.run_path(str(ROOT / "scripts/cloudbench-guest-diagnostics.py"))
        before = [100, 0, 50, 700, 50, 0, 0, 0]
        after = [160, 0, 90, 740, 60, 0, 10, 40]
        # total delta 200 = user 60, system 40 + softirq 10, idle 40, iowait 10, steal 40.
        assert sampler["cpu_mode_pct"](before, after) == {
            "user": 30.0, "system": 25.0, "iowait": 5.0, "steal": 20.0,
        }, sampler["cpu_mode_pct"](before, after)
        assert sampler["cpu_mode_pct"](before, before) is None
        for sample in samples:
            assert set(sample["cpu_mode_pct"]) == {"user", "system", "iowait", "steal"}, sample
            assert sum(sample["cpu_mode_pct"].values()) <= 100.5, sample

        # Per-process attribution: a saturated guest must name the processes
        # that burned the interval's CPU (descend-full69 P3: 99% busy guest,
        # starved worker, no way to tell backend from Postgres from others).
        burner = subprocess.Popen(
            [sys.executable, "-c", "import sys\nwhile True: pass", "--password=secret-arg"],
        )
        try:
            attributed = Path(directory) / "attributed.jsonl"
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/cloudbench-guest-diagnostics.py"), str(attributed),
                 "postgresql://postgres:postgres@localhost:5432/victoria", "30", "0.5", "2"],
                env={**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"},
                capture_output=True, text=True, timeout=30, check=False,
            )
        finally:
            burner.kill()
            burner.wait()
        assert result.returncode == 0, result.stderr
        samples = [json.loads(line) for line in attributed.read_text().splitlines()]
        assert len(samples) == 2, samples
        for sample in samples:
            top = sample["top_processes"]
            assert 0 < len(top) <= 8, top
            assert [row["cpu_pct"] for row in top] == sorted((row["cpu_pct"] for row in top), reverse=True)
            assert all(set(row) == {"pid", "comm", "cpu_pct"} for row in top), top
            assert "secret-arg" not in json.dumps(sample)
        burned = [row for sample in samples for row in sample["top_processes"] if row["pid"] == burner.pid]
        assert burned and max(row["cpu_pct"] for row in burned) >= 50, samples
        assert burned[0]["comm"].startswith("python"), burned


def exercise_read_transition(case: str):
    if case == "guest-diagnostics":
        guest_diagnostics_sampler_and_inventory()
        for recovery in (False, True):
            exercise(seal_after=0, deadline=3, file_delay=0, recovery=recovery, guest_diagnostics=True)
    elif case == "wmh-serve-log":
        guest_inventory_includes_optional_wmh_log()
        for recovery in (False, True):
            exercise(seal_after=0, deadline=3, file_delay=0, recovery=recovery, wmh_log=True)
    elif case == "seal-transition":
        for recovery in (False, True):
            exercise(
                seal_after=1,
                deadline=3,
                file_delay=0,
                recovery=recovery,
                seal_during_shutdown=True,
            )
    elif case in ("socket-reset", "socket-disconnect"):
        for recovery in (False, True):
            exercise(
                seal_after=0,
                deadline=3,
                file_delay=0,
                recovery=recovery,
                socket_fault=case.removeprefix("socket-"),
            )
    elif case == "terminal-failures":
        test_collectors_stop_on_clean_shutdown_without_run_result()
        test_recovery_collector_stops_on_terminal_cleanup_failure()
    elif case == "deadline-during-read":
        exercise(
            seal_after=0,
            deadline=1,
            file_delay=0,
            recovery=True,
            blocked_manifest=True,
            expect_deadline=True,
        )
    elif case == "persistent-timeout":
        exercise(
            seal_after=0,
            deadline=1,
            file_delay=0,
            recovery=True,
            transport_fault=("manifest", "persistent-timeout"),
            expect_deadline=True,
        )
    elif case == "http-rejection":
        exercise(
            seal_after=0,
            deadline=3,
            file_delay=0,
            recovery=True,
            forbidden_manifest=True,
        )
    else:
        stage, kind = case.split("-")
        exercise(
            seal_after=0 if stage == "manifest" else 1,
            deadline=3,
            file_delay=0,
            recovery=True,
            transport_fault=(stage, kind),
        )


READ_TRANSITIONS = (
    "wmh-serve-log",
    "guest-diagnostics",
    "seal-transition",
    "manifest-url",
    "manifest-timeout",
    "socket-reset",
    "socket-disconnect",
    "shutdown-url",
    "driver-timeout",
    "ack-url",
    "persistent-timeout",
    "deadline-during-read",
    "http-rejection",
    "terminal-failures",
)


if __name__ == "__main__":
    test_delayed_seal_then_complete_transfer()
    test_unsealed_guest_fails_closed_at_deadline()
    test_recovery_collector_after_delayed_seal()
    test_recovery_collector_keeps_pending_on_timeout()
    test_recovery_collector_stops_on_terminal_cleanup_failure()
    test_collectors_stop_on_clean_shutdown_without_run_result()
    for transition in READ_TRANSITIONS:
        exercise_read_transition(transition)
    print("PASS: terminal collector waits for exact seal, transfers, and fails closed on timeout")
