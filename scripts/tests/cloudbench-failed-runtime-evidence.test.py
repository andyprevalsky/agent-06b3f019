#!/usr/bin/env python3
"""A failed stack teardown must not lose the guest's worker/stack logs.

descend-full69-20261023 P8: a stalled mass-agent leaf held the worker's
graceful shutdown for its whole 2100 s grace. run.sh recorded the stack
cleanup receipt as failed, the driver refused its clean ACK, the sealed
/runtime-evidence stayed 409, and the disposable teardown deleted the volume.
The only copy of worker.log was gone, so the hung activity was unrecoverable.

This drives the real guest status server and the real host collector
function from run-bench-cloud: a failed receipt yields a diagnostic-only
failed-runtime-evidence capture, while the sealed view, the ACK and the
pending owner marker stay exactly as they were.
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/run-bench-cloud").read_text()
TOKEN, MACHINE, SECRET = "fleet-run-0", "148edd419c51e8", "test-secret"
WORKER_LOG = b"activity call_llm_activity still running at graceful shutdown deadline\n"


def collector_function() -> str:
    match = re.search(r"(?ms)^cloudbench_collect_failed_runtime_evidence\(\).*?^}\n", SOURCE)
    assert match, "production failed-evidence collector function was not found"
    return match.group()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def write_guest(root: Path, *, receipt: str = "failed", services: str = "stopped",
                driver: str = "exited", ack: bool = False) -> None:
    context = root / "repo/.context/cloudbench"
    (context / "logs").mkdir(parents=True, exist_ok=True)
    files = {
        "services.json": json.dumps({"status": services, "env": {"worker_processes": 2}}),
        "run.json": "{}\n",
        "stack.log": "Owned worker supervisor did not finish graceful cleanup\n",
        "logs/backend.log": "backend stopped\n",
        "logs/worker.log": WORKER_LOG.decode(),
        "logs/worker.1.log": "worker one\n",
        f"cloudbench-stack-cleanup-{TOKEN}.status": f"version=2\ntoken={TOKEN}\nstate={receipt}\nstack_pid=1\n",
    }
    for name, text in files.items():
        (context / name).write_text(text)
    (root / "bench.log").write_text(f"RUNSTAMP-{TOKEN}\n")
    (root / "cloudbench-driver.state").write_text(driver + "\n")
    ack_path = root / f"cloudbench-driver-clean-{TOKEN}.ack"
    if ack:
        ack_path.write_text(TOKEN + "\n")
    else:
        ack_path.unlink(missing_ok=True)


class Guest:
    def __init__(self, root: Path) -> None:
        self.port = free_port()
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts/cloudbench-status-server.py"), "--directory", str(root),
             "--port", str(self.port), "--bind", "127.0.0.1", "--run-token", TOKEN],
            env={**os.environ, "CLOUDBENCH_BARRIER_TOKEN": SECRET, "FLY_MACHINE_ID": MACHINE},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise AssertionError("status server did not listen")

    def status(self, path: str) -> int:
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={
            "Authorization": f"Bearer {SECRET}", "X-Cloudbench-Run-Token": TOKEN,
            "X-Cloudbench-Machine-Id": MACHINE})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def close(self) -> None:
        self.process.terminate()
        self.process.wait(timeout=10)


def collect(port: int, destination: Path) -> subprocess.CompletedProcess:
    command = collector_function() + '\ncloudbench_collect_failed_runtime_evidence "$1" "$2" "$3" "$4" "$5"\n'
    return subprocess.run(
        ["bash", "-c", command, "failed-evidence-test", str(destination), str(port), TOKEN, MACHINE, "20"],
        env={**os.environ, "CLOUDBENCH_BARRIER_TOKEN": SECRET}, capture_output=True, text=True, timeout=40)


def test_failed_teardown_logs_are_collected_without_sealing() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root, output = Path(directory) / "data", Path(directory) / "bench"
        destination = output / "remote-logs"
        destination.mkdir(parents=True)
        (output / "runtime-evidence.pending").write_text(json.dumps({"run_token": TOKEN}))
        write_guest(root)
        guest = Guest(root)
        try:
            # The sealed view and the ACK stay closed for a failed teardown.
            assert guest.status("/runtime-evidence") == 409
            result = collect(guest.port, destination)
            assert result.returncode == 0, result.stderr[-800:]
        finally:
            guest.close()
        capture = destination / "failed-runtime-evidence"
        assert (capture / "logs/worker.log").read_bytes() == WORKER_LOG
        assert (capture / "stack.log").read_text().startswith("Owned worker supervisor")
        manifest = json.loads((capture / "manifest.json").read_text())
        assert manifest["stack_cleanup_state"] == "failed"
        assert manifest["diagnostic_only"] is True and manifest["proof_credit"] == 0
        assert set(manifest["files"]) >= {"logs/worker.log", "logs/worker.1.log", "stack.log", "services.json"}
        assert not (destination / "runtime-evidence").exists()
        assert (output / "runtime-evidence.pending").exists()
        assert not (root / f"cloudbench-driver-clean-{TOKEN}.ack").exists()


def test_failed_view_is_closed_outside_an_exited_failed_teardown() -> None:
    cases = {
        "clean ACK": dict(receipt="clean", ack=True),
        "clean receipt without ACK": dict(receipt="clean"),
        "pending receipt": dict(receipt="pending"),
        "driver still running": dict(driver="running"),
        "services still running": dict(services="running"),
    }
    for label, guest_state in cases.items():
        with tempfile.TemporaryDirectory() as directory:
            root, destination = Path(directory) / "data", Path(directory) / "remote-logs"
            destination.mkdir()
            write_guest(root, **guest_state)
            guest = Guest(root)
            try:
                assert guest.status("/failed-runtime-evidence") == 409, label
                result = collect(guest.port, destination)
            finally:
                guest.close()
            assert result.returncode != 0, label
            assert not (destination / "failed-runtime-evidence").exists(), label


def test_sealed_view_is_unchanged_for_a_clean_teardown() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "data"
        write_guest(root, receipt="clean", ack=True)
        guest = Guest(root)
        try:
            assert guest.status("/runtime-evidence") == 200
            assert guest.status("/runtime-evidence?file=logs%2Fworker.log") == 200
            assert guest.status("/failed-runtime-evidence") == 409
        finally:
            guest.close()


def test_controller_calls_the_collector_before_its_infra_exit() -> None:
    block = SOURCE[SOURCE.index('echo "❌ complete terminal runtime evidence could not be verified'):]
    block = block[:block.index("exit 70")]
    assert "cloudbench_collect_failed_runtime_evidence" in block


if __name__ == "__main__":
    test_failed_teardown_logs_are_collected_without_sealing()
    test_failed_view_is_closed_outside_an_exited_failed_teardown()
    test_sealed_view_is_unchanged_for_a_clean_teardown()
    test_controller_calls_the_collector_before_its_infra_exit()
    print("PASS: a failed stack teardown keeps its worker/stack logs as diagnostic-only evidence")
