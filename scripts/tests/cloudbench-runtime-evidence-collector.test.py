#!/usr/bin/env python3
"""Exercise the real terminal collector across a delayed guest seal and transfer."""

import hashlib
import json
import math
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


# Deliberate truncated-body transport fixture: outlive urllib's six-second read
# budget without changing that production deadline or using a delay as synchronization.
STALLED_BODY_TRANSFER_SECONDS = 6.5

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
    file_fault: str | None = None,
    manifest_fault: str | None = None,
    transfer_fault: str | None = None,
    driver_log_stall: bool = False,
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
    if file_fault:
        # A multi-chunk sealed run record, so a fault lands mid-stream after
        # the collector has already written and hashed earlier 64 KiB reads.
        files["run.json"] = b'{"run_id":"test-run-1","pad":"' + b"x" * 300_000 + b'"}\n'
    file_calls: dict[str, int] = {}
    manifest = {
        "version": 1,
        "run_token": token,
        "machine_id": machine,
        "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in files.items()},
    }
    manifest_calls = 0
    transfer_calls = 0
    # Holds a stalled transfer open until the collector has exited, so the
    # client's own 6 s read timeout fires (never a server close) under load.
    release_stall = threading.Event()
    # Two ranges (262144-byte limit) so the stall hits a range at offset > 0;
    # the anchor check below proves the retried range continues the held bytes.
    driver_log = f"RUNSTAMP-{token}\n".encode() + b"".join(b"driver line %06d\n" % i for i in range(20000))
    log_generation = "0123456789abcdef0123456789abcdef"
    log_stalls = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            nonlocal manifest_calls, transfer_calls, log_stalls
            assert self.headers.get("Authorization") == "Bearer test-secret"
            assert self.headers.get("X-Cloudbench-Run-Token") == token
            assert self.headers.get("X-Cloudbench-Machine-Id") == machine
            parts = urlsplit(self.path)
            if parts.path == "/bench.log":
                query = parse_qs(parts.query)
                offset, limit = int(query["offset"][0]), int(query["limit"][0])
                # Mirror the status server: continuity is the sha256 of the 4096
                # bytes the collector already holds, else 409 (never retried).
                anchor = hashlib.sha256(driver_log[max(0, offset - 4096):offset]).hexdigest()
                if (self.headers.get("X-Cloudbench-Log-Anchor") != anchor
                        or self.headers.get("X-Cloudbench-Log-Generation") not in ("", log_generation)):
                    self.send_error(409, "bench log continuity changed")
                    return
                if offset == len(driver_log):
                    self.send_response(204)
                    self.send_header("X-Cloudbench-Log-Size", str(offset))
                    self.send_header("X-Cloudbench-Log-Generation", log_generation)
                    self.send_header("X-Cloudbench-Log-Continuity", "1")
                    self.end_headers()
                    return
                end = min(len(driver_log), offset + limit)
                body = driver_log[offset:end]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {offset}-{end - 1}/{len(driver_log)}")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Cloudbench-Log-Generation", log_generation)
                self.send_header("X-Cloudbench-Log-Continuity", "1")
                self.end_headers()
                if driver_log_stall and offset > 0 and not log_stalls:
                    log_stalls += 1
                    self.wfile.write(body[:4])
                    self.wfile.flush()
                    self.close_connection = True
                    release_stall.wait(deadline + 10)
                    return
                self.wfile.write(body)
                return
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
                if manifest_fault == "truncate" and manifest_calls == seal_after + 1:
                    # The first sealed manifest closes before Content-Length (a relay tunnel
                    # dropping mid-body); read(amt) returns the short body without IncompleteRead.
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data[: len(data) // 2])
                    self.wfile.flush()
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    return
            else:
                name = parse_qs(parts.query)["file"][0]
                data = files[name]
                file_calls[name] = file_calls.get(name, 0) + 1
                time.sleep(file_delay)
                if file_fault and name == "run.json":
                    if file_fault == "corrupt":
                        # Same length, different bytes: only the sealed hash
                        # can reject it.
                        data = data[:-4] + b'y"}\n'
                        assert len(data) == len(files[name]) and data != files[name]
                    elif file_fault == "stall" and file_calls[name] == 1 or file_fault == "truncate":
                        # Send the exact headers and a prefix, then stop: the
                        # stall outlives urllib's 6 s per-read budget (the
                        # 18:45:22-29 relay tunnel freeze); truncation closes
                        # the stream before Content-Length is satisfied.
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data[:100_000])
                        self.wfile.flush()
                        if file_fault == "stall":
                            time.sleep(STALLED_BODY_TRANSFER_SECONDS)
                        self.close_connection = True
                        try:
                            self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        return
                if transfer_fault and name == "logs/backend.log":
                    transfer_calls += 1
                    if transfer_fault == "corrupt":
                        # Same length, wrong bytes: integrity, not transport.
                        data = bytes(len(data))
                    elif transfer_fault == "persistent-reset" or transfer_calls == 1:
                        # Send the headers and part of the sealed body, then
                        # stall past the collector's 6 s socket read timeout
                        # (r001-j0010) or reset the connection mid-body.
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data[:4])
                        self.wfile.flush()
                        self.close_connection = True
                        if transfer_fault == "stall":
                            release_stall.wait(deadline + 10)
                        else:
                            assert transfer_fault == "persistent-reset"
                            self.connection.setsockopt(
                                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
                            )
                            self.connection.close()
                        return
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
                 str(destination), str(server.server_port), token, machine, str(deadline),
                 *(["--driver-log"] if driver_log_stall else [])]
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
            release_stall.set()
            if file_fault in ("corrupt", "truncate"):
                # Integrity failures are never retried; transport truncation is
                # retried only up to the bounded per-file attempt count.
                assert result.returncode != 0, result.stderr[-600:]
                if file_fault == "corrupt":
                    assert "runtime evidence hash mismatch" in result.stderr, result.stderr[-600:]
                    assert file_calls["run.json"] == 1, file_calls
                else:
                    assert "runtime evidence response ended early" in result.stderr, result.stderr[-600:]
                    assert file_calls["run.json"] == 3, file_calls
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
                return
            if forbidden_manifest:
                assert result.returncode != 0 and "HTTP Error 403" in result.stderr
                assert manifest_calls == 1
                if elapsed >= 1.5:
                    print(f"WARNING: forbidden manifest observation took {elapsed:.3f}s")
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
                return
            if transfer_fault in ("persistent-reset", "corrupt"):
                assert result.returncode != 0
                if transfer_fault == "corrupt":
                    assert "runtime evidence hash mismatch" in result.stderr, result.stderr[-600:]
                    assert transfer_calls == 1
                else:
                    assert "ConnectionResetError" in result.stderr, result.stderr[-600:]
                    assert transfer_calls == 3
                    assert elapsed < deadline, "persistent transport failure waited for the deadline"
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
                if file_fault == "stall":
                    # One stalled read restarts that exact file from byte 0 on
                    # a new request; the published copy is the verified retry.
                    assert file_calls["run.json"] == 2, file_calls
                    assert "sealed runtime evidence read run.json attempt 1/3" in result.stderr, result.stderr[-600:]
                    assert not list(destination.glob(".runtime-evidence-*")), list(destination.iterdir())
                if driver_log_stall:
                    assert log_stalls == 1
                    assert (destination / "cloudbench-driver.log").read_bytes() == driver_log
                    assert "cloudbench-driver.log attempt 1/3" in result.stderr, result.stderr[-600:]
                if transfer_fault == "stall":
                    # >= 2: a retry starved past 6 s under load may legitimately take a third read.
                    assert transfer_calls >= 2
                    assert "logs/backend.log attempt 1/3" in result.stderr, result.stderr[-600:]
            else:
                assert result.returncode != 0
                assert "terminal runtime evidence deadline expired" in result.stderr
                if elapsed >= deadline + 1:
                    print(f"WARNING: runtime evidence deadline observation took {elapsed:.3f}s")
                assert not (destination / "runtime-evidence").exists()
                assert (output / "runtime-evidence.pending").exists()
    finally:
        release_stall.set()
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


def _rca_capture(name, value):
    try:
        directory = os.environ.get("CPU_RCA_DIR")
        if directory:
            Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)
            Path(directory, name).write_text(json.dumps(value()))
    except Exception:
        pass  # Diagnostics must not change the fixture outcome or cleanup.


def assert_burner_attribution(samples, measurements, pid, born, clock_ticks):
    """Check the real tick oracle; host contention does not reserve half a core."""
    assert len(measurements) == len(samples) and samples
    used = 0
    for sample, row in zip(samples, measurements):
        before, after, elapsed = row["before"], row["after"], row["elapsed_s"]
        assert row["pid"] == pid and before[2] == after[2] == born, row
        assert row["clock_ticks"] == clock_ticks and elapsed > 0 and math.isfinite(elapsed), row
        delta = after[1] - before[1]
        assert delta >= 0, row
        used += delta
        expected = {"pid": pid, "comm": after[0], "cpu_pct": round(100 * delta / clock_ticks / elapsed, 1)}
        assert row["ranked"] == ([expected] if delta else []), row
        top = sample["top_processes"]
        visible = [item for item in top if item["pid"] == pid]
        if visible:
            assert visible == [expected] and expected["comm"].startswith("python"), (row, top)
        elif delta:
            assert len(top) == 8 and expected["cpu_pct"] <= top[-1]["cpu_pct"], (row, top)
    assert used > 0, "the native burner received no CPU: attribution was not exercised"


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
        # Exercise the real /proc parser and interval arithmetic across comm
        # renames and PID reuse without relying on the host scheduler.
        from types import SimpleNamespace
        from unittest.mock import patch

        def process_sample(comm, used, born):
            fields = ["0"] * 20
            fields[11], fields[19] = str(used), str(born)
            stat = "123 (" + comm + ") " + " ".join(fields)
            globals_ = sampler["process_ticks"].__globals__
            with patch.dict(globals_, {
                "os": SimpleNamespace(scandir=lambda _: [SimpleNamespace(name="123", path="unused")]),
                "Path": lambda *args: SimpleNamespace(read_text=lambda: stat),
            }):
                return sampler["process_ticks"]()

        renamed = sampler["top_processes"](
            process_sample("worker-old", 10000, 77), process_sample("worker-new", 10001, 77), 1.0
        )
        assert renamed == [{"pid": 123, "comm": "worker-new", "cpu_pct": round(100 / sampler["CLOCK_TICKS"], 1)}]
        assert sampler["top_processes"](
            process_sample("worker", 10000, 77), process_sample("worker", 20000, 88), 1.0
        ) == []
        assert sampler["top_processes"]({}, process_sample("worker", 20000, 88), 1.0) == []

        ticks = sampler["CLOCK_TICKS"]
        assert sampler["top_processes"](
            {10: ("python", 100, 1), 12: ("old", 100, 2)},
            {10: ("python", 100 + ticks, 1), 11: ("kworker", 100000, 3), 12: ("new", 100000, 4)},
            1.0,
        ) == [{"pid": 10, "comm": "python", "cpu_pct": 100.0}]
        for sample in samples:
            assert set(sample["cpu_mode_pct"]) == {"user", "system", "iowait", "steal"}, sample
            assert sum(sample["cpu_mode_pct"].values()) <= 100.5, sample

        # Per-process attribution: a saturated guest must name the processes
        # that burned the interval's CPU (descend-full69 P3: 99% busy guest,
        # starved worker, no way to tell backend from Postgres from others).
        burner = subprocess.Popen(
            [sys.executable, "-c", "import sys\nwhile True: pass", "--password=secret-arg"],
        )
        prior_cpu_rca_pid = os.environ.get("CPU_RCA_BURNER_PID")
        prior_cpu_rca_dir = os.environ.get("CPU_RCA_DIR")
        capture = Path(prior_cpu_rca_dir or directory, f"burner-{burner.pid}")
        os.environ["CPU_RCA_DIR"] = str(capture)
        os.environ["CPU_RCA_BURNER_PID"] = str(burner.pid)
        _rca_capture("burner-start.json", lambda: {"pid": burner.pid, "wall": time.time(), "monotonic": time.monotonic(), "stat": Path(f"/proc/{burner.pid}/stat").read_text()})
        try:
            born = sampler["process_ticks"]()[burner.pid][2]
            attributed = Path(directory) / "attributed.jsonl"
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/cloudbench-guest-diagnostics.py"), str(attributed),
                 "postgresql://postgres:postgres@localhost:5432/victoria", "30", "0.5", "2"],
                env={**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"},
                capture_output=True, text=True, timeout=30, check=False,
            )
        finally:
            _rca_capture("burner-final.json", lambda: {"pid": burner.pid, "wall": time.time(), "monotonic": time.monotonic(), "stat": Path(f"/proc/{burner.pid}/stat").read_text()})
            _rca_capture("attributed.json", lambda: [json.loads(line) for line in attributed.read_text().splitlines()])
            try:
                burner.kill()
                burner.wait()
            finally:
                _rca_capture("burner-joined.json", lambda: {"pid": burner.pid, "returncode": burner.returncode, "monotonic": time.monotonic()})
                if prior_cpu_rca_pid is None:
                    os.environ.pop("CPU_RCA_BURNER_PID", None)
                else:
                    os.environ["CPU_RCA_BURNER_PID"] = prior_cpu_rca_pid
                if prior_cpu_rca_dir is None:
                    os.environ.pop("CPU_RCA_DIR", None)
                else:
                    os.environ["CPU_RCA_DIR"] = prior_cpu_rca_dir
        assert result.returncode == 0, result.stderr
        samples = [json.loads(line) for line in attributed.read_text().splitlines()]
        assert len(samples) == 2, samples
        for sample in samples:
            top = sample["top_processes"]
            assert 0 < len(top) <= 8, top
            assert [row["cpu_pct"] for row in top] == sorted((row["cpu_pct"] for row in top), reverse=True)
            assert all(set(row) == {"pid", "comm", "cpu_pct"} for row in top), top
            assert "secret-arg" not in json.dumps(sample)
        captures = list(capture.glob("sampler-*.json"))
        assert len(captures) == 1, captures
        measurements = json.loads(captures[0].read_text())
        assert measurements["dropped"] == 0, measurements
        assert_burner_attribution(samples, measurements["samples"], burner.pid, born, ticks)

        # Keep a controlled >=50% oracle independent of the host's scheduling share.
        controlled = sampler["top_processes"]({123: ("python", 0, 1)}, {123: ("python", ticks, 1)}, 1.0)
        assert controlled == [{"pid": 123, "comm": "python", "cpu_pct": 100.0}]
        assert controlled[0]["cpu_pct"] >= 50
        measure = {"pid": 123, "before": ["python", 0, 1], "after": ["python", ticks, 1],
                   "elapsed_s": 1.0, "clock_ticks": ticks, "ranked": controlled}
        assert_burner_attribution([{"top_processes": controlled}], [measure], 123, 1, ticks)
        for bad in ({**measure, "after": ["python", ticks + 1, 1]},
                    {**measure, "after": ["python", ticks, 2]}):
            try:
                assert_burner_attribution([{"top_processes": controlled}], [bad], 123, 1, ticks)
            except AssertionError:
                pass
            else:
                raise AssertionError("wrong CPU delta or process birth was accepted")
        try:
            assert_burner_attribution([{"top_processes": [
                {"pid": index, "comm": "other", "cpu_pct": 50.0} for index in range(8)]}],
                [measure], 123, 1, ticks)
        except AssertionError:
            pass
        else:
            raise AssertionError("a target ranked above the cutoff was silently omitted")


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
    elif case == "manifest-truncate":
        # CodeRabbit PR #1865: a short final-manifest body is a retried TruncatedTransfer in both collectors.
        for recovery in (False, True):
            exercise(seal_after=0, deadline=30, file_delay=0, recovery=recovery, manifest_fault="truncate")
    elif case in ("file-stall", "file-truncate", "file-corrupt"):
        # Run the inline controller collector and the recovery helper together:
        # the stall case waits out a real 6 s socket read budget in each.
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=2) as pool:
            for future in [
                pool.submit(
                    exercise,
                    seal_after=0,
                    deadline=30,
                    file_delay=0,
                    recovery=recovery,
                    file_fault=case.removeprefix("file-"),
                )
                for recovery in (False, True)
            ]:
                future.result()
    elif case in ("transfer-stall", "transfer-persistent-reset", "transfer-corrupt"):
        # A sealed file read that stalls past the socket timeout is retried
        # from byte zero; a persistent transport failure stays bounded and a
        # hash mismatch is never retried.
        fault = case.removeprefix("transfer-")
        for recovery in (False, True):
            exercise(
                seal_after=0,
                deadline=20,
                file_delay=0,
                recovery=recovery,
                transfer_fault=fault,
            )
    elif case == "driver-log-stall":
        # The recovery collector's --driver-log range reads share the same
        # sealed-read retry; the retried range must keep offset and anchor exact.
        exercise(seal_after=0, deadline=20, file_delay=0, recovery=True, driver_log_stall=True)
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
    "file-stall",
    "file-truncate",
    "manifest-truncate",
    "file-corrupt",
    "shutdown-url",
    "driver-timeout",
    "ack-url",
    "persistent-timeout",
    "deadline-during-read",
    "http-rejection",
    "terminal-failures",
    "transfer-stall",
    "transfer-persistent-reset",
    "transfer-corrupt",
    "driver-log-stall",
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
