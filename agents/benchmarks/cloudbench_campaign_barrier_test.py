"""Strict copies must rendezvous before the existing fleet data-plane release."""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run_campaign(tmp_path: Path, *, strict=True, runs=3, concurrency=3, fail_job=0):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    binary = tmp_path / "bin"
    binary.mkdir()
    events = tmp_path / "events.jsonl"
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index("release_start_barrier() {")
    release = source[start : source.index("\n}\n", start) + 3]
    (binary / "event").write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "value = {'event': sys.argv[1], 'job': os.environ['RUN_BENCH_CAMPAIGN_JOB_ID'], "
        "'cohort': os.environ.get('RUN_BENCH_CAMPAIGN_COHORT'), 'at': time.monotonic_ns()}\n"
        "fd = os.open(os.environ['FIXTURE_EVENTS'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
        "os.write(fd, (json.dumps(value) + '\\n').encode()); os.close(fd)\n"
    )
    (binary / "curl").write_text(
        f"#!{sys.executable}\n"
        "import subprocess, sys\n"
        "if 'POST' in sys.argv:\n"
        " subprocess.run(['event', 'execute'], check=True); print('204')\n"
    )
    for path in binary.iterdir():
        path.chmod(0o700)
    cli = scripts / "run-bench"
    cli.write_text(
        "#!/usr/bin/env bash\nset -eu\n"
        "trap 'event teardown' EXIT\n"
        "trap 'event signalled; exit 143' TERM\n"
        "index=${RUN_BENCH_CAMPAIGN_JOB_ID##*-j}\nindex=$((10#$index))\n"
        "if [ $((index % 2)) -eq 0 ]; then sleep 1; fi\n"
        'if [ "$index" -eq "$FIXTURE_FAIL_JOB" ]; then sleep 1; exit 7; fi\n'
        'out=$FIXTURE_ROOT/$RUN_BENCH_CAMPAIGN_JOB_ID\nmkdir -p "$out"\n'
        "RUN_ID=$RUN_BENCH_CAMPAIGN_JOB_ID\n"
        'printf \'synchronized start barrier ready: %s\\n\' "$RUN_ID" > "$out/fleet-child.log"\n'
        "printf '12345\\n' > \"$out/status-proxy.port\"\n"
        "SYNCHRONIZED_START=1\nSTART_BARRIER_WAIT_SECONDS=20\n"
        "PER_BOX_BARRIER_WAIT_SECONDS=20\nSTRICT_BARRIER=1\n"
        "CLOUDBENCH_BARRIER_TOKEN=fixture-only\nCLOUDBENCH_BARRIER_RELEASE_ATTEMPTS=1\n"
        'CHILD_PIDS=("$$")\nCHILD_OUT=("$out")\n'
        "CHILD_BENCH=(fixture)\nCHILD_MACHINE=(fixture)\n"
        "wait_for_mandatory_autoscaler_startup() { event ready; }\n"
        f"CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(ROOT / 'scripts'))}\n"
        f"{release}\n"
        "release_start_barrier\n"
    )
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("RUN_BENCH_CAMPAIGN_") or key == "CLOUDBENCH_STRICT_BARRIER":
            env.pop(key)
    env.update(
        PATH=str(binary) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
        FIXTURE_ROOT=str(tmp_path),
        FIXTURE_EVENTS=str(events),
        FIXTURE_FAIL_JOB=str(fail_job),
    )
    command = [
        sys.executable,
        str(ROOT / "scripts/run-bench-campaign.py"),
        "--root",
        str(tmp_path),
        "--runs",
        str(runs),
        "--concurrency",
        str(concurrency),
        "--task",
        "unchanged-task",
    ]
    if strict:
        command.append("--forward-arg=--strict-barrier")
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=40)
    summary = json.loads(next((tmp_path / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
    records = [json.loads(line) for line in events.read_text().splitlines()]
    return result, summary, records


def test_campaign_start_barrier_waits_for_every_ready_copy(tmp_path):
    result, summary, events = run_campaign(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    ready = [event["at"] for event in events if event["event"] == "ready"]
    executed = [event["at"] for event in events if event["event"] == "execute"]
    assert len(ready) == len(executed) == 3
    assert min(executed) > max(ready)
    assert summary["peak_concurrency"] == 3


def test_campaign_start_barrier_child_failure_aborts_without_partial_release_or_signals(tmp_path):
    result, summary, events = run_campaign(tmp_path, fail_job=3)
    assert result.returncode != 0
    assert not [event for event in events if event["event"] in {"execute", "signalled"}]
    assert len([event for event in events if event["event"] == "teardown"]) == 3
    assert summary["status"] == "failed"
    assert all(job["finished_at"] for job in summary["jobs"])


def test_campaign_start_barrier_preserves_non_strict_sliding_launch(tmp_path):
    result, _, events = run_campaign(tmp_path, strict=False)
    assert result.returncode == 0, result.stdout + result.stderr
    ready = [event["at"] for event in events if event["event"] == "ready"]
    executed = [event["at"] for event in events if event["event"] == "execute"]
    assert min(executed) < max(ready)


def test_campaign_start_barrier_bounds_and_releases_each_complete_cohort(tmp_path):
    result, summary, events = run_campaign(tmp_path, runs=5, concurrency=2)
    assert result.returncode == 0, result.stdout + result.stderr
    assert summary["peak_concurrency"] == 2
    assert len([event for event in events if event["event"] == "execute"]) == 5
    for first in (1, 3, 5):
        ids = {f"r{index:03d}-j{index:04d}" for index in range(first, min(first + 2, 6))}
        ready = [event["at"] for event in events if event["job"] in ids and event["event"] == "ready"]
        executed = [event["at"] for event in events if event["job"] in ids and event["event"] == "execute"]
        assert min(executed) > max(ready)
