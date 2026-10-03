"""Own local worker processes through graceful shutdown and recording cleanup."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

# This entry point also serves run.sh before a venv is selected. Load the pure
# parser without helpers/__init__.py importing the application dependency graph.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
from generation_handoff import parse_shutdown_grace_seconds


def main() -> int:
    count = int(os.environ.get("WORKER_PROCESSES", "1"))
    if count < 1:
        raise ValueError("WORKER_PROCESSES must be positive")
    primary_log = Path(os.environ.get("NAVI_WORKER_LOG_FILE", "navi-worker-log.txt"))
    primary_log.parent.mkdir(parents=True, exist_ok=True)
    processes: list[subprocess.Popen] = []
    streams = []
    threads = []
    signalled: set[int] = set()
    stopping = False
    deadline = float("inf")
    # Honor the worker's existing activity drain and detached-recording bounds.
    grace = parse_shutdown_grace_seconds(os.environ.get("WORKER_SHUTDOWN_GRACE_PERIOD"))
    recording_grace = int(os.environ.get("BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS", "45")) + 20
    failed = False

    def signal_child(process: subprocess.Popen) -> None:
        if process.pid in signalled or process.poll() is not None:
            return
        signalled.add(process.pid)
        try:
            process.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass

    def stop(_signum: int = 0, _frame: object = None) -> None:
        nonlocal stopping, deadline
        if stopping:
            return
        stopping = True
        deadline = time.monotonic() + grace + recording_grace + 5
        for process in processes:
            signal_child(process)

    def mirror(source, destination) -> None:
        for line in iter(source.readline, b""):
            destination.write(line)
            destination.flush()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        source.close()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        try:
            for index in range(count):
                if stopping:
                    break
                path = (
                    primary_log
                    if index == 0
                    else primary_log.with_name(f"{primary_log.stem}.{index}{primary_log.suffix}")
                )
                output = path.open("wb")
                streams.append(output)
                environment = os.environ.copy()
                environment["WORKER_INDEX"] = str(index)
                if index:
                    environment.update(SDK_METRICS_PORT="0", HEALTH_CHECK_PORT="0")
                stream = index == 0 and os.environ.get("NAVI_WORKER_LOG_STREAM", "true") != "false"
                process = subprocess.Popen(
                    [sys.executable, "worker.py"],
                    env=environment,
                    stdout=subprocess.PIPE if stream else output,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                processes.append(process)
                # A signal can arrive before or after publishing the child.
                # Both paths use the same idempotent cancellation owner.
                if stopping:
                    signal_child(process)
                if stream:
                    thread = threading.Thread(target=mirror, args=(process.stdout, output), daemon=True)
                    thread.start()
                    threads.append(thread)
        except BaseException:
            failed = True
            stop()

        while any(process.poll() is None for process in processes):
            if not stopping and any(process.poll() is not None for process in processes):
                failed = True
                stop()
            if stopping and time.monotonic() >= deadline:
                failed = True
                # Only signal groups whose directly owned leader remains alive.
                # A completed worker must have released its own descendants.
                for process in processes:
                    if process.poll() is None:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                break
            time.sleep(0.05)
        # Share the remaining five-second margin in --shutdown-timeout across
        # all children; a kill request does not prove a native process exited.
        reap_deadline = time.monotonic() + 5
        for process in processes:
            try:
                if process.wait(timeout=max(0, reap_deadline - time.monotonic())) != 0:
                    failed = True
            except subprocess.TimeoutExpired:
                failed = True
        for thread in threads:
            thread.join(timeout=2)
            if thread.is_alive():
                failed = True
        return 1 if failed else 0
    finally:
        for output in streams:
            output.close()


if __name__ == "__main__":
    if sys.argv[1:] == ["--shutdown-timeout"]:
        print(
            parse_shutdown_grace_seconds(os.environ.get("WORKER_SHUTDOWN_GRACE_PERIOD"))
            + int(os.environ.get("BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS", "45"))
            + 30
        )
        raise SystemExit(0)
    raise SystemExit(main())
