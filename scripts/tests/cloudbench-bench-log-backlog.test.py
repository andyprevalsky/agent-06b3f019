#!/usr/bin/env python3
"""A large terminal bench.log burst drains completely; only runaway or stuck backlogs fail.

descend-full69-20261023 P8: the 51-agent test-mass-agent-run-0 terminal burst
is ~33.5 MiB. The host's former 128 x 256 KiB (32 MiB) chunk-count cap tripped
"bench.log backlog exceeded 128 bounded chunks before EOF" on all 10 copies,
truncating the host copy of the driver log and the guest's own FATAL lines.

This drives the production reader (read_bench_log + refresh_bench_log_checked)
and the production backlog step from run-bench-cloud, in the poll loop's
order, against the real guest status server serving a 40 MiB log.
"""

import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/run-bench-cloud").read_text()
TOKEN = "fleet-run-0"
CHUNK = 262144
FORMER_CAP_CHUNKS = 128


def function(name: str) -> str:
    match = re.search(rf"(?ms)^{re.escape(name)}\(\) {{.*?^}}\n", SOURCE)
    if match is None:  # the backlog step is defined inside the poll section, indented at column 0
        raise AssertionError(f"production function {name} was not found")
    return match.group()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


HARNESS = r'''
set -u
cloudbench_proxy_alive() { return 0; }
SSH_LOG="$WORK/ssh.log"; : > "$SSH_LOG"
BENCH_LOG_CHUNK_FILE="$WORK/chunk"; BENCH_LOG_HEADERS_FILE="$WORK/headers"
BENCH_LOG_GENERATION_FILE="$WORK/generation"; : > "$BENCH_LOG_GENERATION_FILE"
BENCH_LOG_PROGRESS_FILE="$WORK/progress"; : > "$BENCH_LOG_PROGRESS_FILE"
BENCH_LOG_HAS_MORE=0 BENCH_LOG_RESET=0 BENCH_LOG_CHUNKS_READ=0
backlog_bytes=0 backlog_active=0 backlog_failures=0
BENCH_LOG_BACKLOG_MAX_FAILURES=5
chunks=0 polls=0
while :; do
    polls=$((polls + 1))
    [ "$polls" -le 2000 ] || { echo "RESULT=runaway-test"; break; }
    if [ -n "${STOP_AFTER_BYTES:-}" ] && [ "$(wc -c < "$SSH_LOG")" -ge "$STOP_AFTER_BYTES" ]; then
        LOCAL_STATUS_PORT=1
    fi
    ok=0
    before="$(wc -c < "$SSH_LOG" | tr -d ' ')"
    refresh_bench_log_checked 4 && ok=1
    after="$(wc -c < "$SSH_LOG" | tr -d ' ')"
    chunks=$((chunks + BENCH_LOG_CHUNKS_READ))
    cloudbench_bench_log_backlog_step "$ok" "$((after - before))"
    case "$BACKLOG_DECISION" in
        drain) continue ;;
        retry) continue ;;
        idle) [ "$ok" = 1 ] && [ "$BENCH_LOG_HAS_MORE" = 0 ] && { echo "RESULT=eof"; break; }
              echo "RESULT=idle-failure"; break ;;
        *) echo "RESULT=$BACKLOG_DECISION"; break ;;
    esac
done
echo "CHUNKS=$chunks BYTES=$(wc -c < "$SSH_LOG" | tr -d ' ') BACKLOG=$backlog_bytes"
'''


def drain(log: bytes, *, max_bytes: int | None = None, stop_after: int | None = None) -> tuple[dict, bytes]:
    with tempfile.TemporaryDirectory() as directory:
        root, work = Path(directory) / "data", Path(directory) / "work"
        root.mkdir()
        work.mkdir()
        (root / "bench.log").write_bytes(log)
        port = free_port()
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts/cloudbench-status-server.py"), "--directory", str(root),
             "--port", str(port), "--bind", "127.0.0.1", "--run-token", TOKEN],
            env={**os.environ, "CLOUDBENCH_BARRIER_TOKEN": "test-secret"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                    break
                except OSError:
                    assert time.monotonic() < deadline, "status server did not listen"
                    time.sleep(0.05)
            script = "\n".join([
                function("read_bench_log"), function("cloudbench_response_header"),
                function("cloudbench_response_status"), function("cloudbench_store_log_generation"),
                function("refresh_bench_log_checked"), function("cloudbench_bench_log_backlog_step"), HARNESS])
            env = {**os.environ, "WORK": str(work), "LOCAL_STATUS_PORT": str(port),
                   "RUN_LOG_TOKEN": TOKEN, "BENCH_LOG_BACKLOG_MAX_BYTES": str(max_bytes or 536870912)}
            if stop_after is not None:
                env["STOP_AFTER_BYTES"] = str(stop_after)
            result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=600)
            fields = dict(item.split("=", 1) for line in result.stdout.splitlines()
                          for item in line.split() if "=" in item)
            return fields, (work / "ssh.log").read_bytes()
        finally:
            server.terminate()
            server.wait(timeout=10)


def burst(size: int) -> bytes:
    head = f"RUNSTAMP-{TOKEN}\nBenchmark interrupt cleanup status: state=clean started=1 completed=1\n".encode()
    line = b'                "value": "' + b"x" * 1000 + b'",\n'
    body = line * ((size - len(head)) // len(line) + 1)
    return head + body + f"::CLOUDBENCH-DONE:: token={TOKEN} exit=1\n".encode()


def test_mass_agent_sized_terminal_burst_drains_to_eof() -> None:
    log = burst(40 * 1024 * 1024)
    fields, copied = drain(log)
    assert fields.get("RESULT") == "eof", fields
    assert copied == log, "host copy differs from the guest bench.log"
    # The former fixed cap would have stopped this drain partway.
    assert int(fields["CHUNKS"]) > FORMER_CAP_CHUNKS, fields
    assert copied.endswith(f"::CLOUDBENCH-DONE:: token={TOKEN} exit=1\n".encode())


def test_backlog_beyond_the_byte_ceiling_still_fails() -> None:
    fields, copied = drain(burst(4 * 1024 * 1024), max_bytes=1024 * 1024)
    assert fields.get("RESULT") == "exceeded", fields
    assert len(copied) < 4 * 1024 * 1024


def test_backlog_that_stops_advancing_fails_after_bounded_retries() -> None:
    fields, copied = drain(burst(4 * 1024 * 1024), stop_after=CHUNK * 3)
    assert fields.get("RESULT") == "stuck", fields
    assert len(copied) < 4 * 1024 * 1024


def test_controller_has_no_chunk_count_cap() -> None:
    assert "BENCH_LOG_BACKLOG_MAX_CHUNKS" not in SOURCE
    loop = SOURCE[SOURCE.index('cloudbench_bench_log_backlog_step "$log_refresh_ok"'):]
    assert loop.index("exceeded)") < loop.index("A failed first/EOF read")


if __name__ == "__main__":
    test_controller_has_no_chunk_count_cap()
    test_mass_agent_sized_terminal_burst_drains_to_eof()
    test_backlog_beyond_the_byte_ceiling_still_fails()
    test_backlog_that_stops_advancing_fails_after_bounded_retries()
    print("PASS: terminal bench.log bursts drain by bytes; runaway and stuck backlogs fail closed")
