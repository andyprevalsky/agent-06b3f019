"""Strict copies must rendezvous before the existing fleet data-plane release."""

import fcntl
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS

ROOT = Path(__file__).resolve().parents[2]
ROOT = (
    Path(os.environ.get("CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST", str(ROOT / "scripts/run-bench-fleet")))
    .resolve()
    .parents[1]
)


def run_campaign(
    tmp_path: Path, *, strict=True, runs=3, concurrency=3, fail_job=0, fail_jobs=(), holdout_jobs=(), extra_env=None, tasks=None
):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    binary = tmp_path / "bin"
    binary.mkdir()
    events = tmp_path / "events.jsonl"
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index("release_start_barrier() {")
    release = source[start : source.index("\n}\n", start) + 3]
    infra_start = source.index("fleet_infra_stop_check() {")
    infra_stop = source[infra_start : source.index("\n}\n", infra_start) + 3]
    (binary / "event").write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "value = {'event': sys.argv[1], 'job': os.environ['RUN_BENCH_CAMPAIGN_JOB_ID'], "
        "'cohort': os.environ.get('RUN_BENCH_CAMPAIGN_COHORT'), 'at': time.monotonic_ns()}\n"
        "fd = os.open(os.environ['FIXTURE_EVENTS'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
        "os.write(fd, (json.dumps(value) + '\\n').encode()); os.close(fd)\n"
        "if value['event'] == 'execute' and value['job'] == 'r001-j0001':\n"
        " open(os.path.join(os.environ['FIXTURE_ROOT'], 'first-execute'), 'w').close()\n"
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
        "event started\n"
        "index=${RUN_BENCH_CAMPAIGN_JOB_ID##*-j}\nindex=$((10#$index))\n"
        "if [ $((index % 2)) -eq 0 ]; then\n"
        ' if [ "$FIXTURE_STRICT" = 0 ] && [ "$index" = 2 ]; then\n'
        '  while [ ! -e "$FIXTURE_ROOT/first-execute" ]; do sleep 0.05; done\n'
        " else sleep 1; fi\n"
        "fi\n"
        'case " $FIXTURE_FAIL_JOBS " in *" $index "*) sleep 1; exit 7 ;; esac\n'
        'out=$FIXTURE_ROOT/$RUN_BENCH_CAMPAIGN_JOB_ID\nmkdir -p "$out"\n'
        "RUN_ID=$RUN_BENCH_CAMPAIGN_JOB_ID\n"
        # A holdout reaches its own barrier later (slower provisioning) and its
        # live stack never becomes ready, so only its per-box window excludes it.
        'case " $FIXTURE_HOLDOUT_JOBS " in *" $index "*) sleep "$FIXTURE_HOLDOUT_SKEW"; : > "$out/fleet-child.log" ;; *)\n'
        'printf \'synchronized start barrier ready: %s\\n\' "$RUN_ID" > "$out/fleet-child.log"\n'
        "printf '12345\\n' > \"$out/status-proxy.port\" ;; esac\n"
        "SYNCHRONIZED_START=1\nSTART_BARRIER_WAIT_SECONDS=20\n"
        "PER_BOX_BARRIER_WAIT_SECONDS=20\nSTRICT_BARRIER=1\n"
        "CLOUDBENCH_BARRIER_TOKEN=fixture-only\nCLOUDBENCH_BARRIER_RELEASE_ATTEMPTS=1\n"
        'CHILD_PIDS=("$$")\nCHILD_OUT=("$out")\n'
        "CHILD_BENCH=(fixture)\nCHILD_MACHINE=(fixture)\n"
        "wait_for_mandatory_autoscaler_startup() { event ready; }\n"
        f"CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(ROOT / 'scripts'))}\n"
        "FLEET_INFRA_STOP_SENT=0\n"
        f"{infra_stop}\n"
        f"{release}\n"
        "release_start_barrier\n"
    )
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("RUN_BENCH_CAMPAIGN_") or key == "CLOUDBENCH_STRICT_BARRIER":
            env.pop(key)
    env.update(
        PATH=str(binary) + os.pathsep + str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
        CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="0",
        # This fixture tests barrier ordering, not physical disk reserve sizing.
        CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="1",
        CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB="1",
        CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB="0",
        FIXTURE_ROOT=str(tmp_path),
        FIXTURE_EVENTS=str(events),
        FIXTURE_FAIL_JOBS=" ".join(map(str, fail_jobs or (fail_job,))),
        FIXTURE_STRICT=str(int(strict)),
        FIXTURE_HOLDOUT_JOBS=" ".join(map(str, holdout_jobs)),
        FIXTURE_HOLDOUT_SKEW="4",
        **(extra_env or {}),
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
    ]
    for task in (tasks if tasks is not None else ("unchanged-task",)):
        command.extend(("--task", task))
    if strict:
        command.append("--forward-arg=--strict-barrier")
    cleanup_ticketed = strict or runs <= concurrency
    if cleanup_ticketed:
        # Full-width ordinary and strict campaigns bind real cleanup tickets to
        # committed fixture source; only strict mode adds a start rendezvous.
        for name in ("cloudbench-cleanup-tickets.py", "cloudbench-infra-canary-preflight.py"):
            (scripts / name).write_bytes((ROOT / "scripts" / name).read_bytes())
        (scripts / "run-fleet-infra-canary").write_text("#!/usr/bin/env bash\nexit 0\n")
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        subprocess.run(["git", "-C", str(tmp_path), "add", "scripts"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(tmp_path),
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "owning cleanup ticket source",
            ],
            check=True,
        )
        # Isolate the host-wide cleanup admission namespace, as the owning ticket fixture does.
        device = int.from_bytes(os.urandom(5), "big")
        admission = Path("/tmp") / ("rose-cloudbench-cleanup-admission-" + str(os.getuid())) / str(device)
        transport = tmp_path / "transport"
        transport.mkdir()
        (transport / "sitecustomize.py").write_text(
            "import os, stat\n"
            "prefix = os.environ['FIXTURE_RESERVE_PREFIX']\n"
            "def wrapper(original):\n"
            " def observed(path, *a, **k):\n"
            "  value = original(path, *a, **k)\n"
            "  if isinstance(path, (str, bytes, os.PathLike)) and os.path.abspath(os.fsdecode(path)).startswith(prefix) "
            "and stat.S_ISDIR(value.st_mode):\n"
            "   fields = list(value); fields[2] = int(os.environ['FIXTURE_DEVICE']); return os.stat_result(fields)\n"
            "  return value\n"
            " return observed\n"
            "os.stat = wrapper(os.stat); os.lstat = wrapper(os.lstat)\n"
        )
        env.update(
            PYTHONPATH=os.pathsep.join(filter(None, (str(transport), env.get("PYTHONPATH")))),
            FIXTURE_DEVICE=str(device),
            FIXTURE_RESERVE_PREFIX=str(tmp_path / ".git/cloudbench-fleet-ownership"),
        )
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    finally:
        if cleanup_ticketed:
            shutil.rmtree(admission, ignore_errors=True)
    summary = json.loads(next((tmp_path / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
    assert events.exists(), (result.returncode, result.stdout, result.stderr, summary)
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


def test_campaign_start_barrier_child_failure_releases_only_ready_survivors(tmp_path):
    result, summary, events = run_campaign(tmp_path, fail_job=3)
    assert result.returncode != 0
    executed = [event for event in events if event["event"] == "execute"]
    ready = [event for event in events if event["event"] == "ready"]
    assert len(executed) == len(ready) == 2, "failed-member-aborted-healthy-survivors"
    assert min(event["at"] for event in executed) > max(event["at"] for event in ready)
    assert not [event for event in events if event["event"] == "signalled"]
    assert len([event for event in events if event["event"] == "teardown"]) == 3
    assert summary["status"] == "failed"
    assert all(job["finished_at"] for job in summary["jobs"])
    assert [job["status"] for job in summary["jobs"]] == ["passed", "passed", "failed"]
    cohort = summary["startup_cohorts"][0]
    assert cohort["expected_count"] == 3 and cohort["released_count"] == 2
    assert cohort["failed_count"] == 1 and cohort["ready_count"] == 2
    manifest = json.loads(
        next((tmp_path / ".context/benchmarks/campaigns").glob("*/startup-cohorts/*/manifest.json")).read_text()
    )
    assert len(manifest["jobs"]) == 3, "failed-member-removed-from-custody-manifest"
    release = json.loads(
        next((tmp_path / ".context/benchmarks/campaigns").glob("*/startup-cohorts/*/release.json")).read_text()
    )
    assert len(release["jobs"]) == 2
    assert summary["jobs"][2]["job_id"] not in release["jobs"]


def test_campaign_start_barrier_excludes_a_late_holdout_before_ready_copies_expire(tmp_path):
    """2026-10-20 #16: 39/40 copies were ready, one SIM copy never was. Each
    fleet's per-box exclusion and its campaign barrier deadline are the same
    window from its own barrier start, so the holdout (which reached its barrier
    later) could only be excluded after every ready copy had already expired:
    the whole cohort failed. The campaign must exclude the holdout before the
    earliest ready copy's deadline and release the ready survivors."""
    result, summary, events = run_campaign(
        tmp_path, holdout_jobs=(3,), extra_env={"CLOUDBENCH_CAMPAIGN_HOLDOUT_MARGIN_SECONDS": "6"}
    )
    assert result.returncode != 0, "a holdout is still an infrastructure failure of the campaign"
    executed = {event["job"] for event in events if event["event"] == "execute"}
    assert executed == {"r001-j0001", "r002-j0002"}, result.stdout + result.stderr
    ready = [event["at"] for event in events if event["event"] == "ready"]
    assert min(event["at"] for event in events if event["event"] == "execute") > max(ready)
    assert [job["status"] for job in summary["jobs"]] == ["passed", "passed", "failed"]
    cohort = summary["startup_cohorts"][0]
    assert cohort["released_count"] == 2 and cohort["failed_count"] == 1
    assert [entry["job_id"] for entry in cohort["holdouts_excluded"]] == ["r003-j0003"]
    release = json.loads(
        next((tmp_path / ".context/benchmarks/campaigns").glob("*/startup-cohorts/*/release.json")).read_text()
    )
    assert sorted(release["jobs"]) == ["r001-j0001", "r002-j0002"]
    # The holdout leaves through its own owned teardown, never a KILL.
    assert {event["job"] for event in events if event["event"] == "teardown"} == {
        "r001-j0001",
        "r002-j0002",
        "r003-j0003",
    }
    assert "excluding holdout r003-j0003" in result.stdout


def test_campaign_start_barrier_all_failed_cohort_settles_and_later_cohort_progresses(tmp_path):
    result, summary, events = run_campaign(tmp_path, runs=4, concurrency=2, fail_jobs=(1, 2))
    assert result.returncode != 0
    assert summary["status"] == "failed"
    assert [job["status"] for job in summary["jobs"]] == ["failed", "failed", "passed", "passed"]
    cohorts = summary["startup_cohorts"]
    assert cohorts[0]["expected_count"] == cohorts[0]["failed_count"] == 2
    assert cohorts[0]["ready_count"] == cohorts[0]["released_count"] == 0
    assert cohorts[0]["status"] == "failed" and cohorts[0]["released_at"] is None
    assert cohorts[1]["released_count"] == cohorts[1]["expected_count"] == 2
    assert len([event for event in events if event["event"] == "execute"]) == 2
    assert len([event for event in events if event["event"] == "teardown"]) == 4
    assert not [event for event in events if event["event"] == "signalled"]


def test_campaign_start_barrier_rejects_excluded_job_and_wrong_pid_release(tmp_path):
    """A live parent cannot release a member absent from the exact release set."""
    parent = tmp_path / "startup-cohorts"
    parent.mkdir()
    job_id = "r001-j0001"
    controller_pid = os.getpid()
    with (parent / "parent.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name, release_jobs in [("excluded", {}), ("wrong-pid", {job_id: controller_pid + 1})]:
            directory = parent / name
            (directory / "ready").mkdir(parents=True)
            (directory / "manifest.json").write_text(json.dumps({"cohort_id": name, "jobs": {job_id: controller_pid}}))
            (directory / "release.json").write_text(json.dumps({"cohort_id": name, "jobs": release_jobs}))
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/cloudbench-campaign-barrier.py"),
                    "--deadline",
                    str(time.time() + 20),
                    "--controller-pid",
                    str(controller_pid),
                ],
                env=dict(
                    os.environ,
                    RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(directory),
                    RUN_BENCH_CAMPAIGN_JOB_ID=job_id,
                    RUN_BENCH_CAMPAIGN_COHORT=name,
                ),
                capture_output=True,
                text=True,
                timeout=40,
            )
            assert result.returncode != 0, f"{name}-release-accepted"
            assert "campaign release does not own this controller" in result.stderr


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


def test_campaign_start_barrier_original_polar_jobs_use_tilion_cap_in_two_strict_cohorts(tmp_path):
    """Offline scheduling qualification only; mock workers earn no benchmark credit.

    Four more original polar jobs than the real Tilion fleet cap for a Polar-only
    selection run as one cap-wide strict cohort and a second four-job cohort.
    """
    from collections import Counter

    polar = [task["name"] for task in json.loads((ROOT / "agents/benchmarks/polar_tasks.json").read_text())]
    env = dict(os.environ, CLOUDBENCH_BROWSER_PROVIDER="tilion")
    env.pop("CLOUDBENCH_PROVIDER_LIMITS_FILE", None)
    cap = subprocess.run(
        [sys.executable, str(ROOT / "scripts/cloudbench-provider-capacity.py"),
         "cap", "--browser-provider", "tilion", *[f"--task={task}" for task in polar]],
        env=env, capture_output=True, text=True, check=True,
    )
    # Tilion's own row admits 200 (250 browsers, 20% production reserve). Polar's
    # measured demand profile lifts Parallel to 147, so the unscoped Kernel row binds at 135.
    assert cap.stdout.strip() == "135", cap.stdout + cap.stderr
    width = int(cap.stdout.strip())
    tasks = polar[: width + 4]
    runs = 1
    result, summary, events = run_campaign(
        tmp_path, tasks=tasks, runs=runs, concurrency=width,
        # A cohort wider than the app delegating-guest ceiling (default 70) also needs the
        # fleet's own override; the launch preflight refuses it otherwise.
        extra_env={"CLOUDBENCH_BROWSER_PROVIDER": "tilion",
                   "CLOUDBENCH_PROVIDER_LIMITS_FILE": str(ROOT / "scripts/cloudbench-provider-limits.json"),
                   "CLOUDBENCH_DELEGATING_PRIMARY_CEILING": str(width)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    jobs = summary["jobs"]
    expected = [(f"r{run:03d}-j{(run - 1) * len(tasks) + offset:04d}", task, run)
                for run in range(1, runs + 1) for offset, task in enumerate(tasks, 1)]
    assert len(expected) == width + 4
    assert [(job["job_id"], job["task"], job["run"]) for job in jobs] == expected
    assert Counter(job["task"] for job in jobs) == Counter({task: runs for task in tasks})
    assert summary["peak_concurrency"] == width
    assert all(job["status"] == "passed" and job["finished_at"] for job in jobs)
    cohorts = summary["startup_cohorts"]
    assert [cohort["expected_count"] for cohort in cohorts] == [width, 4]
    assert [cohort["released_count"] for cohort in cohorts] == [width, 4]
    assert [cohort["failed_count"] for cohort in cohorts] == [0, 0]
    for kind in ("started", "ready", "execute", "teardown"):
        assert Counter(event["job"] for event in events if event["event"] == kind) == Counter(
            job["job_id"] for job in jobs
        ), kind
    first, second = {job[0] for job in expected[:width]}, {job[0] for job in expected[width:]}
    for ids in (first, second):
        ready = [event["at"] for event in events if event["job"] in ids and event["event"] == "ready"]
        execute = [event["at"] for event in events if event["job"] in ids and event["event"] == "execute"]
        assert max(ready) < min(execute), "strict cohort executed before every member was ready"
    assert max(event["at"] for event in events if event["job"] in first and event["event"] == "teardown") < min(
        event["at"] for event in events if event["job"] in second and event["event"] == "started"
    ), "later cohort started before all earlier owned workers tore down"
    active = peak = 0
    for event in sorted(events, key=lambda event: event["at"]):
        if event["event"] == "started":
            active += 1
            peak = max(peak, active)
        elif event["event"] == "teardown":
            active -= 1
            assert active >= 0
    assert active == 0 and peak <= width


def test_campaign_start_barrier_failed_infra_canary_runs_once_per_cohort_and_next_cohort_can_retry(tmp_path):
    canary = tmp_path / "canary.sh"
    calls = tmp_path / "canary-calls"
    canary.write_text('printf "called\\n" >> "$FIXTURE_CANARY_CALLS"\nexit 7\n')
    stamp = tmp_path / "passed"
    lock = tmp_path / "transaction.lock"
    cohort = tmp_path / "cohort-one"
    cohort.mkdir()
    env = dict(os.environ, RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(cohort), FIXTURE_CANARY_CALLS=str(calls))
    command = [
        sys.executable,
        str(ROOT / "scripts/cloudbench-infra-canary-preflight.py"),
        "--stamp",
        str(stamp),
        "--lock",
        str(lock),
        "--ttl-seconds",
        "300",
        "--width",
        "2",
        "--canary",
        str(canary),
        "--nested-controller-lock",
        "fixture-only",
    ]
    peers = [subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
    try:
        for peer in peers:
            peer.communicate(timeout=30)
        assert all(peer.returncode != 0 for peer in peers)
        assert calls.read_text().splitlines() == ["called"]
        assert not stamp.exists()

        next_cohort = tmp_path / "cohort-two"
        next_cohort.mkdir()
        env["RUN_BENCH_CAMPAIGN_BARRIER_DIR"] = str(next_cohort)
        retry = subprocess.run(command, env=env, capture_output=True, timeout=30)
        assert retry.returncode == 7
        assert calls.read_text().splitlines() == ["called", "called"]
        assert not stamp.exists()
    finally:
        for peer in peers:
            if peer.poll() is None:
                peer.terminate()
                try:
                    peer.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    peer.kill()
                    peer.wait(timeout=5)


def test_campaign_start_barrier_aborted_cohort_does_not_reuse_a_successful_infra_canary(tmp_path):
    cohort = tmp_path / "cohort"
    cohort.mkdir()
    (cohort / "abort.json").write_text('{"reason":"controller failed"}')
    stamp = tmp_path / "passed"
    stamp.write_text("actual previous canary success\n")
    canary = tmp_path / "canary.sh"
    canary.write_text("exit 0\n")
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench-infra-canary-preflight.py"),
            "--stamp",
            str(stamp),
            "--lock",
            str(tmp_path / "transaction.lock"),
            "--ttl-seconds",
            "300",
            "--width",
            "2",
            "--canary",
            str(canary),
            "--nested-controller-lock",
            "fixture-only",
        ],
        env=dict(os.environ, RUN_BENCH_CAMPAIGN_BARRIER_DIR=str(cohort)),
        capture_output=True,
        timeout=30,
    )
    assert result.returncode != 0


def test_campaign_start_barrier_infra_canary_caller_checks_aborted_cohort_before_fresh_cache(tmp_path):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index("fleet_infra_canary_preflight() {")
    function = source[start : source.index("\n}\n", start) + 3]
    stamp = tmp_path / "passed"
    stamp.write_text("actual fixture canary success\n")
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    calls = tmp_path / "canary-calls"
    (scripts / "run-fleet-infra-canary").write_text('printf "called\\n" >> "$FIXTURE_CANARY_CALLS"\nexit 97\n')
    runner = tmp_path / "caller.sh"
    runner.write_text(
        "set -eu\n"
        # Supply GNU stat's file metadata on both supported host platforms.
        "stat() {\n"
        ' [ "$#" -eq 3 ] && [ "$1" = "-c" ] && [ "$2" = "%Y" ] || return 99\n'
        f" {shlex.quote(sys.executable)} -c "
        "'import os, sys; print(int(os.stat(sys.argv[1]).st_mtime))' \"$3\"\n"
        "}\n"
        f"{function}\nfleet_infra_canary_preflight\n"
    )
    env = dict(os.environ)
    env.pop("RUN_BENCH_CAMPAIGN_BARRIER_DIR", None)
    env.update(
        ROOT_DIR=str(tmp_path),
        CLOUDBENCH_SCRIPT_SNAPSHOT=str(scripts),
        INFRA_CANARY_PREFLIGHT_SCRIPT=str(ROOT / "scripts/cloudbench-infra-canary-preflight.py"),
        FLEET_INFRA_CANARY_STAMP=str(stamp),
        FLEET_INFRA_CANARY_TTL_SECONDS="300",
        FIXTURE_CANARY_CALLS=str(calls),
        INFRA_PROBE="0",
        CLOUDBENCH_SKIP_INFRA_CANARY_PREFLIGHT="0",
        CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE="0",
        CLOUDBENCH_FAKE_DIR="",
        RECOVER_STALE_ONLY="0",
        PROVISION_POOL="",
    )
    standalone = subprocess.run(["bash", str(runner)], env=env, capture_output=True, timeout=30)
    assert standalone.returncode == 0, standalone.stdout + standalone.stderr
    assert not calls.exists()

    cohort = tmp_path / "cohort"
    cohort.mkdir()
    (cohort / "abort.json").write_text('{"reason":"controller failed"}')
    env["RUN_BENCH_CAMPAIGN_BARRIER_DIR"] = str(cohort)
    aborted = subprocess.run(["bash", str(runner)], env=env, capture_output=True, timeout=30)
    assert aborted.returncode != 0, aborted.stdout + aborted.stderr
    assert not calls.exists()
