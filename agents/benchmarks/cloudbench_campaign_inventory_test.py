"""Copy campaigns reuse the real inventory producer without borrowing ownership."""

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS

ROOT = Path(os.environ.get("CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST", Path(__file__).resolve().parents[2]))


# These controls own the inventory feed, not the shared Fly relay. The relay
# bootstraps real flyctl transport (b0fbd7742) and has its own offline owning
# control in cloudbench-cleanup-ticket-campaign.test.py, which disables it the
# same way for inventory-only cases. Applied after each environment scrub.
OFFLINE_WITHOUT_SHARED_RELAY = {"CLOUDBENCH_CAMPAIGN_SHARED_RELAY": "0"}


def assert_publication_process_retired(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    native = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True
    )
    if native.returncode == 0 and native.stdout.strip().startswith("Z"):
        return
    # An empty/failed probe is not proof of retirement. Recheck absence to
    # distinguish a process reaped during observation from an unavailable ps.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError(f"owned publication process {pid} remains: {native.stdout.strip()!r}")


def test_campaign_inventory_publication_retirement_distinguishes_live_zombie_and_absent(monkeypatch):
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        with pytest.raises(AssertionError, match="remains"):
            assert_publication_process_retired(live.pid)
        deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
        while True:
            state = subprocess.check_output(["ps", "-p", str(child.pid), "-o", "stat="], text=True).strip()
            if state.startswith("Z"):
                break
            assert time.monotonic() < deadline, "fixture child did not become terminal"
            time.sleep(0.01)
        # Intentionally do not poll/wait: hold our exact exited child unreaped.
        assert_publication_process_retired(child.pid)
        child.wait()
        assert_publication_process_retired(child.pid)
        with monkeypatch.context() as patch:
            patch.setattr(subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, "", "probe failed"))
            with pytest.raises(AssertionError):
                assert_publication_process_retired(live.pid)
    finally:
        child.wait()
        live.terminate()
        live.wait()


@pytest.mark.parametrize("failure", ("infra", "infra-strict", "infra-parent-owned", "task", "contradictory", "retained", "exhausted", "cutoff", "cutoff-no-retry", "retry-unverified", "retry-handle-missing", "lifecycle-failed"))
def test_campaign_inventory_retries_only_released_infra_without_restarting_peers(tmp_path, failure):
    """Exercise the real scheduler with owned child processes and terminal artifacts."""
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    cli = scripts / "run-bench"
    cli.write_text(f"#!/bin/bash\nexec {shlex.quote(sys.executable)} {shlex.quote(str(tmp_path / 'child.py'))} \"$@\"\n")
    child = r'''
import json, os, subprocess, sys, time
from pathlib import Path
root = Path(os.environ['FIXTURE_ROOT'])
task = sys.argv[1]
attempt = int(os.environ.get('RUN_BENCH_CAMPAIGN_ATTEMPT', '1'))
mode = os.environ['FIXTURE_FAILURE']
run_id = f'{task}-{attempt}'
fleet = root / '.context/fleet/runs' / run_id
(fleet / '_batch').mkdir(parents=True)
owner = run_id
audit = root / '.git/cloudbench-fleet-audits' / owner
audit.mkdir(parents=True)
status = 'INFRA_ERROR' if task == 'broken' and (attempt == 1 or mode == 'exhausted') else 'PASSED'
if task == 'broken' and mode == 'task':
    status = 'FAILED'
if task == 'broken' and mode == 'lifecycle-failed':
    status = 'PASSED'
row = {'name': task, 'status': status, 'passed': status == 'PASSED', 'lifecycle_stage': 'released'}
if mode == 'contradictory' and task == 'broken':
    row['passed'] = True
if mode == 'retained' and task == 'broken':
    row['lifecycle_stage'] = 'teardown'
    (root / '.git/cloudbench-fleet-ownership' / owner).mkdir(parents=True)
(fleet / '_batch/run.json').write_text(json.dumps({'run_id': run_id, 'tasks': [row]}))
# The fleet verifies a genuinely evaluated FAILED task; a released attempt whose
# mandatory autoscaler failed (controller exit 2) keeps a failed lifecycle.
lifecycle_failed = status == 'INFRA_ERROR' or (mode == 'lifecycle-failed' and task == 'broken')
(fleet / '_batch/lifecycle.json').write_text(json.dumps({
    'run_id': run_id, 'fleet_owner_token': owner, 'workspace_root': str(root),
    'status': 'failed' if lifecycle_failed else 'verified', 'hub_publication_failed': False}))
meta = f'run_id={run_id}\nfleet_owner_token={owner}\nworkspace_root={root}\nstatus=provider-teardown-verified\n'
(audit / 'meta').write_text(meta)
(audit / 'provider-teardown-verified.epoch').write_text(str(time.time()))
(fleet / 'teardown-ownership.path').write_text(str(audit))
(fleet / 'teardown-ownership').mkdir()
(fleet / 'teardown-ownership/meta').write_text(meta)
(fleet / 'teardown-ownership/provider-teardown-verified.epoch').write_bytes((audit / 'provider-teardown-verified.epoch').read_bytes())
fd = os.open(root / 'events.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
os.write(fd, (json.dumps({'task': task, 'attempt': attempt, 'event': 'started'}) + '\n').encode())
os.close(fd)
if not (mode == 'retry-handle-missing' and task == 'broken' and attempt == 2):
    print(f'    {root}/scripts/run-bench monitor {fleet}', flush=True)
if mode == 'retry-unverified' and task == 'broken' and attempt == 2:
    (audit / 'provider-teardown-verified.epoch').unlink()
if os.environ.get('RUN_BENCH_CAMPAIGN_BARRIER_DIR') and status != 'INFRA_ERROR':
    subprocess.run([sys.executable, os.environ['FIXTURE_BARRIER'], '--deadline', str(time.time()+60),
                    '--controller-pid', str(os.getpid())], check=True)
if task == 'healthy' and mode.startswith('infra'):
    while not (root / 'retry-started').exists():
        time.sleep(0.05)
if task == 'broken' and attempt == 2:
    (root / 'retry-started').touch()
fd = os.open(root / 'events.jsonl', os.O_WRONLY | os.O_APPEND)
os.write(fd, (json.dumps({'task': task, 'attempt': attempt, 'event': 'finished'}) + '\n').encode())
os.close(fd)
sys.exit(2 if mode == 'lifecycle-failed' and task == 'broken' else 0 if status == 'PASSED' else 1)
'''
    (tmp_path / "child.py").write_text(child)
    uploader = tmp_path / "agents/benchmarks/hub_upload.py"
    uploader.parent.mkdir(parents=True)
    uploader.write_text(
        "import argparse, hashlib, json, os, sys\n"
        "args=sys.argv[1:]; record=json.load(open(args[1])); ack=args[args.index('--publication-ack')+1]\n"
        "json.dump({'pid':os.getpid(),'token':args[args.index('--publication-token')+1],"
        "'record_sha256':hashlib.sha256(json.dumps(record,sort_keys=True).encode()).hexdigest()},open(ack,'w'))\n"
    )
    command = [sys.executable, str(ROOT / "scripts/run-bench-campaign.py"), "--root", str(tmp_path),
               "--runs", "1", "--concurrency", "2", "--task", "broken", "--task", "healthy",
               "--retry-infra", "0" if failure == "cutoff-no-retry" else "1", "--e2e-timeout", "5400"]
    if failure.startswith("cutoff"):
        command += ["--e2e-started-at", str(time.time() - 5401)]
    elif failure == "infra-strict":
        command += ["--forward-arg=--strict-barrier"]
        # A strict cohort binds its committed cleanup-ticket interpreter and
        # runs the parent infra-canary preflight; reuse a fresh retained PASS
        # stamp with a canary that refuses if it is ever actually executed.
        for name in ("cloudbench-cleanup-tickets.py", "cloudbench-infra-canary-preflight.py"):
            shutil.copyfile(ROOT / "scripts" / name, scripts / name)
        (scripts / "run-fleet-infra-canary").write_text("#!/bin/bash\nexit 97\n")
        (scripts / "run-fleet-infra-canary").chmod(0o700)
        (tmp_path / ".context").mkdir(exist_ok=True)
        (tmp_path / ".context/fleet-infra-canary.last-pass").write_text("retained canonical PASS\n")
        for git_command in (["init", "-q"], ["add", "scripts", "agents"],
                            ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]):
            subprocess.run(["git", *git_command], cwd=tmp_path, check=True, capture_output=True)
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("RUN_BENCH_CAMPAIGN_") and not key.startswith("BENCHMARK_HUB_")}
    env.update(FIXTURE_ROOT=str(tmp_path), FIXTURE_FAILURE=failure, CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="0",
               FIXTURE_BARRIER=str(ROOT / 'scripts/cloudbench-campaign-barrier.py'))
    # Match the owning cleanup-ticket fixture: test retries, not host disk capacity.
    env.update(CLOUDBENCH_CLEANUP_DISK_RESERVE_MB="1",
               CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB="1",
               CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB="0")
    if failure == "infra-parent-owned":
        # A Hub-dispatched campaign (run-bench-hub-poller) leaves group publication to its parent.
        env["BENCHMARK_HUB_PARENT_RUN_ID"] = "fixture-parent"
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    summaries = list((tmp_path / ".context/benchmarks/campaigns").glob("*/summary.json"))
    assert summaries, result.stdout + result.stderr
    summary = json.loads(summaries[0].read_text())
    events = [json.loads(line) for line in (tmp_path / 'events.jsonl').read_text().splitlines()] if (tmp_path / 'events.jsonl').exists() else []
    broken = next(job for job in summary['jobs'] if job['task'] == 'broken')
    started = [event for event in events if event['event'] == 'started']
    assert len(summary['jobs']) == summary['total_jobs'] == 2
    if failure.startswith('cutoff'):
        assert not started and result.returncode != 0
        assert summary['e2e_timeout_exceeded']
        assert (summaries[0].parent / 'hub-group-publication-ack.private.json').is_file(), 'cutoff skipped terminal group publication'
    elif failure in {'infra', 'infra-strict', 'infra-parent-owned', 'exhausted', 'retry-unverified', 'retry-handle-missing'}:
        assert len([event for event in started if event['task'] == 'broken']) == 2, (result.returncode, result.stdout, result.stderr, summary)
        assert len([event for event in started if event['task'] == 'healthy']) == 1
        assert len(broken['attempts']) == 2 and broken['attempts'][0]['task_status'] == 'INFRA_ERROR'
        assert len({attempt['log'] for attempt in broken['attempts']}) == 2
        assert result.returncode == (0 if failure in {'infra', 'infra-strict', 'infra-parent-owned'} else 1), result.stdout + result.stderr
        if failure == 'infra-parent-owned':
            assert summary['status'] == 'passed'
            assert not (summaries[0].parent / 'hub-group-publication-ack.private.json').exists()
        if failure.startswith('retry-'):
            previous, current = broken['attempts']
            assert previous['attempt'] == 1 and current['attempt'] == 2
            assert previous['run_id'] == previous['fleet_owner_token'] == 'broken-1'
            assert previous['resources_released'] is True and previous['infra_failure'] is True
            assert previous['released_at_epoch'] > 0 and previous['retry_blocked'] is None
            assert current['controller_exit_code'] == 0 and current['resources_released'] is False
            assert current['retry_blocked'] == (
                'physical run handle unavailable' if failure == 'retry-handle-missing'
                else 'terminal result or release remains unverified'
            )
            for key in ('run_id', 'fleet_dir', 'fleet_owner_token', 'task_status',
                        'infra_failure', 'terminal_task', 'released_at_epoch'):
                assert current[key] is None, f'current attempt inherited prior {key}'
                assert broken.get(key) is None, f'current job inherited prior {key}'
        if failure.startswith('infra'):
            retry = next(index for index, event in enumerate(events) if event['task'] == 'broken' and event['attempt'] == 2 and event['event'] == 'started')
            peer_end = next(index for index, event in enumerate(events) if event['task'] == 'healthy' and event['event'] == 'finished')
            assert retry < peer_end, 'retry unnecessarily waited for the healthy peer'
        if failure == 'infra-strict':
            cohort = summary['startup_cohorts'][0]
            assert cohort['expected_count'] == 2 and cohort['released_count'] == cohort['failed_count'] == 1
    else:
        assert len([event for event in started if event['task'] == 'broken']) == 1
        assert result.returncode == (0 if failure == 'task' else 1 if failure != 'lifecycle-failed' else 2), (
            result.stdout + result.stderr)
        if failure == 'lifecycle-failed':
            # Released resources and a PASSED row alone are not a healthy attempt.
            assert broken['status'] != 'passed' and summary['status'] != 'passed'
            assert broken['attempts'][0]['resources_released'] is True
            assert broken['attempts'][0]['lifecycle_verified'] is False


@pytest.mark.parametrize('explicit_concurrency', (False, True))
@pytest.mark.parametrize('stress_defaults', (False, True))
def test_campaign_inventory_normal_cli_forwards_original_clock_and_bounded_retry(tmp_path, explicit_concurrency, stress_defaults):
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    (tmp_path / 'agents').mkdir()
    shutil.copyfile(ROOT / 'scripts/run-bench', scripts / 'run-bench')
    shutil.copyfile(ROOT / 'scripts/cloudbench_catalog.py', scripts / 'cloudbench_catalog.py')
    # run-bench reads the sharded operator's per-controller copy bound.
    shutil.copyfile(ROOT / 'scripts/cloudbench-shard-coordinator.py', scripts / 'cloudbench-shard-coordinator.py')
    report_contract = tmp_path / '.claude/shared/benchmark-report-format.txt'
    report_contract.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / '.claude/shared/benchmark-report-format.txt', report_contract)
    receipt = tmp_path / 'dispatch.json'
    (scripts / 'run-bench-campaign.py').write_text(
        'import json, os, sys\n'
        "json.dump(sys.argv[1:], open(os.environ['FIXTURE_DISPATCH'], 'w'))\n")
    arguments = ['demo-fleet-alpha', 'demo-fleet-beta', '--retry-infra', '1', '--e2e-timeout', '5400',
                 '--e2e-started-at', '1791410000', '--timeout', '1200']
    if explicit_concurrency:
        arguments += ['--concurrency', '1']
    if stress_defaults:
        arguments += ['--stress-defaults', '-k', '3']
    result = subprocess.run(['bash', str(scripts / 'run-bench'), *arguments], capture_output=True, text=True,
                            env={**os.environ, 'FIXTURE_DISPATCH': str(receipt),
                                 'RUN_BENCH_CATALOG_UNDER_TEST': str(ROOT / 'agents/benchmarks/tasks.json')},
                            timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stdout + result.stderr
    actual = json.loads(receipt.read_text())
    assert ('--stress-defaults' in actual) == stress_defaults
    assert f'--runs={3 if stress_defaults else 1}' in actual
    assert '--retry-infra=1' in actual and '--e2e-timeout=5400' in actual and '--e2e-started-at=1791410000' in actual
    assert f'--concurrency={1 if explicit_concurrency else 2}' in actual
    assert '--task=demo-fleet-alpha' in actual and '--task=demo-fleet-beta' in actual
    assert actual[-2:] == ['--forward-arg=--timeout', '--forward-arg=1200']


@pytest.mark.parametrize("runner_mode", ("installed", "node", "npx", "missing"))
def test_campaign_inventory_seed_get_empty_runner_keeps_native_bash_fallbacks(tmp_path, runner_mode):
    root = tmp_path / "checkout"
    backend = root / "back-end"
    backend.mkdir(parents=True)
    binary = tmp_path / "bin"
    binary.mkdir()
    calls = tmp_path / "calls"
    dump = tmp_path / "canonical.dump"
    environment = {
        **os.environ,
        "PATH": str(binary) + ":/usr/bin:/bin",
        "SEED_RUNNER_MODE": runner_mode,
        "SEED_RUNNER_CALLS": str(calls),
    }
    runner = (
        "#!/bin/sh\n"
        'case "$1" in --experimental-strip-types)\n'
        ' if [ "$2" = -e ]; then [ "$SEED_RUNNER_MODE" = node ]; exit $?; fi\n'
        ' shift;; --yes) shift; [ "$1" = tsx ] || exit 94; shift;; esac\n'
        'printf "%s\\n" "$0" >> "$SEED_RUNNER_CALLS"\n'
        '[ "$1 $2 $3" = "scripts/seed-dump-cache.ts get fixture-token" ] || exit 95\n'
        '[ "$SEED_RUNNER_MODE" != missing ] || exit 1\n'
        'printf "complete-owned-canonical-fixture" > "$4"\n'
    )
    for name in ("node", "npx"):
        executable = binary / name
        executable.write_text(runner)
        executable.chmod(0o700)
    # Fault retries are still the real helper's five attempts. The offline
    # negative control needs no wall delay between deterministic missing reads.
    (binary / "sleep").write_text("#!/bin/sh\nexit 0\n")
    (binary / "sleep").chmod(0o700)
    if runner_mode == "installed":
        installed = backend / "node_modules/.bin/tsx"
        installed.parent.mkdir(parents=True)
        installed.write_text(runner)
        installed.chmod(0o700)
    result = subprocess.run(
        ["/bin/bash", str(ROOT / "scripts/cloudbench-seed-get.sh"), str(root), "fixture-token", str(dump)],
        env=environment,
        text=True,
        capture_output=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    assert "unbound variable" not in result.stderr, result.stderr
    assert result.returncode == (1 if runner_mode == "missing" else 0), result.stderr
    entries = calls.read_text().splitlines()
    expected = "tsx" if runner_mode == "installed" else "node" if runner_mode == "node" else "npx"
    assert all(Path(entry).name == expected for entry in entries)
    assert len(entries) == (5 if runner_mode == "missing" else 1)
    if runner_mode == "missing":
        assert not dump.exists()
    else:
        assert dump.read_bytes() == b"complete-owned-canonical-fixture"


def producer_source(root):
    lib = root / "scripts/lib/cloudbench-inventory.sh"
    if lib.exists():
        return lib.read_text()
    text = (root / "scripts/run-bench-fleet").read_text()
    block = text[text.index("# ── ONE shared inventory stream") : text.index("is_sim_on() {")]
    for name in ("resolve_fly_token", "registry_meta_value", "fly_with_timeout"):
        start = text.index(name + "() {")
        block = text[start : text.index("\n}\n", start) + 3] + "\n" + block
    return block


def run_consumers(tmp_path, *, shared=True, death=False, refresh=False, auth=False, production_only=False, post_canary=False, admission_wait=False, mutation=False, borrowed_transport_delay=False, native_read_delay=0):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "lib").mkdir()
    if production_only:
        (scripts / "cloudbench-production-only-tasks.py").write_text("import sys; sys.exit(0)\n")
    for name in ("cloudbench-env.sh",):
        shutil.copyfile(ROOT / "scripts/lib" / name, scripts / "lib" / name)
    for name in ("cloudbench-machine-readiness.py", "cloudbench-campaign-inventory.sh"):
        origin = ROOT / "scripts" / name
        if origin.exists():
            shutil.copyfile(origin, scripts / name)
    (scripts / "lib/cloudbench-inventory.sh").write_text(producer_source(ROOT))
    binary = tmp_path / "bin"
    binary.mkdir()
    machines = tmp_path / "machines.private.json"
    actual = os.environ.get("CLOUDBENCH_INVENTORY_NATIVE_PAYLOAD")
    if actual:
        shutil.copyfile(actual, machines)
        target = next(row["id"] for row in json.loads(machines.read_text()) if row.get("state") == "started")
    else:
        machines.write_text(
            json.dumps(
                [
                    {
                        "id": "fixture1",
                        "name": "fixture-one",
                        "state": "started",
                        "config": {"init": {"exec": ["sleep", "infinity"]}},
                    }
                ]
            )
        )
        target = "fixture1"
    machines.chmod(0o600)
    volumes = tmp_path / "volumes.private.json"
    volumes.write_text("[]")
    calls = tmp_path / "calls.safe.jsonl"
    fly = binary / "flyctl"
    fly.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "from pathlib import Path\n"
        "kind=sys.argv[1]\n"
        "if os.environ.get('FIXTURE_POST_CANARY') == '1' and os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID') and os.environ.get('CLOUDBENCH_CAMPAIGN_INVENTORY_DIR'): sys.exit(1)\n"
        "time.sleep(float(os.environ['FIXTURE_NATIVE_READ_DELAY']))\n"
        "if os.environ.get('FIXTURE_EXPECT_AUTH'): assert os.environ.get('FLY_API_TOKEN') == os.environ['FIXTURE_EXPECT_AUTH'], 'wrong selected credential'\n"
        "payload=Path(os.environ['FIXTURE_'+kind.upper()]).read_bytes()\n"
        "fd=os.open(os.environ['FIXTURE_CALLS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n"
        "os.write(fd,(json.dumps({'kind':kind,'decoded_bytes':len(payload),'role':'borrower' if os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID') else 'publisher','job_id':os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID')})+'\\n').encode());os.close(fd)\n"
        "sys.stdout.buffer.write(payload);sys.stdout.buffer.flush()\n"
        "if os.environ.get('FIXTURE_BORROWED_TRANSPORT_DELAY') == '1' and os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID') and kind == 'machines': time.sleep(10)\n"
    )
    fly.chmod(0o700)
    # This fixture controls only the parent HTTP transport boundary. The real
    # publisher, lock, generation publication and both borrowed consumers run.
    (scripts / "cloudbench-campaign-machines.py").write_text(
        "import os,json,sys\nfrom pathlib import Path\n"
        "if os.environ.get('FIXTURE_EXPECT_AUTH'): assert os.environ.get('FLY_API_TOKEN') == os.environ['FIXTURE_EXPECT_AUTH']\n"
        "payload=Path(os.environ['FIXTURE_MACHINES']).read_bytes()\n"
        "fd=os.open(os.environ['FIXTURE_CALLS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n"
        "os.write(fd,(json.dumps({'kind':'machines','decoded_bytes':len(payload),'role':'publisher-http-transport','job_id':os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID')})+'\\n').encode());os.close(fd)\n"
        "sys.stdout.buffer.write(payload)\n"
    )
    boundary = ""
    if post_canary:
        fleet = (ROOT / "scripts/run-bench-fleet").read_text()
        boundary = fleet.split("fleet_infra_canary_preflight || exit $?\n", 1)[1].split(
            "# ── Clone one machine per bench", 1)[0]
        start = fleet.index("admit_app_capacity_with_wait() {")
        admission = fleet[start:fleet.index("\n}\n", start) + 3]
        admission += (
            'CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1\n'
            'fixture_capacity_calls=0\n'
            'enforce_app_capacity_guard() {\n'
            ' fixture_capacity_calls=$((fixture_capacity_calls + 1))\n'
            ' CAPACITY_ADMISSION_RETRYABLE=1\n'
            + (' [ "$fixture_capacity_calls" -gt 1 ] || return 1\n' if admission_wait else '')
            + ' python3 -c \'import json,sys; assert json.load(sys.stdin) == json.load(open(sys.argv[1]))\' "$FIXTURE_MACHINES" <<< "$warm_json"\n'
            '}\n'
        )
        boundary = admission + boundary
    cli = scripts / "run-bench"
    cli.write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\n"
        'FLEET_DIR="$FIXTURE_ROOT/$RUN_BENCH_CAMPAIGN_JOB_ID"\nmkdir -p "$FLEET_DIR"\n'
        'APP=navi-whisper-lux-bench\nFLEET_OWNER_HOST="$(hostname)"\n'
        f"MACHINE_READINESS_SCRIPT={str(scripts / 'cloudbench-machine-readiness.py')!r}\n"
        f"source {str(scripts / 'lib/cloudbench-env.sh')!r}\n"
        f"source {str(scripts / 'lib/cloudbench-inventory.sh')!r}\n"
        'FLY_API_TOKEN="$(resolve_fly_token)"\nexport FLY_API_TOKEN\n'
        'FLY() { flyctl "$@"; }\n'
        'finish() { if declare -F stop_owned_machines_snapshot_loop >/dev/null; then stop_owned_machines_snapshot_loop; else cloudbench_terminate_tree_and_wait 30 "$SNAPSHOT_LOOP_PID"; fi; touch "$FLEET_DIR/closed"; }\n'
        "trap finish EXIT\ntrap 'exit 143' TERM\n"
        + boundary
        + "start_machines_snapshot_loop\n"
        'if [ "${CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION:-0}" = 1 ]; then\n'
        ' python3 -c \'import json,os;from pathlib import Path;a=json.loads(os.environ["CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY"]);d=Path(os.environ["CLOUDBENCH_CAMPAIGN_INVENTORY_DIR"]);assert a["directory"]==str(d.resolve());assert a["owner"]==dict(line.split("=",1) for line in (d/"owner").read_text().splitlines());Path(os.environ["FIXTURE_ROOT"],os.environ["RUN_BENCH_CAMPAIGN_JOB_ID"],"authority.json").write_text(json.dumps(a))\'\n'
        'fi\n'
        # A standalone fixture owns its publisher and cancels it on EXIT. Join
        # the first asynchronous refresh before ending the scenario whose
        # assertion counts that refresh; startup only joins the initial read.
        'if [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ]; then\n'
        ' while [ "$(python3 -c \'import json,os;print(sum(row["kind"]=="machines" and row.get("job_id")==os.environ["RUN_BENCH_CAMPAIGN_JOB_ID"] for row in map(json.loads,open(os.environ["FIXTURE_CALLS"]))))\')" -lt 2 ] || [ -e "$INVENTORY_REFRESH_LOCK" ]; do sleep 0.1; done\n'
        'fi\n'
        'if [ "$FIXTURE_DEATH" = 1 ]; then\n'
        ' if [[ "$RUN_BENCH_CAMPAIGN_JOB_ID" == *j0002 ]]; then\n'
        '  while [ "$(python3 -c \'import json,os;print(sum(json.loads(s)["kind"]=="machines" for s in open(os.environ["FIXTURE_CALLS"])))\')" -lt 2 ] || [ -e "$INVENTORY_REFRESH_LOCK" ]; do sleep 0.1; done\n'
        '  kill "$SNAPSHOT_LOOP_PID"\n'
        " fi\n"
        ' touch "$FLEET_DIR/paused-before-gate";\n'
        ' if [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ]; then exit 0; fi\n'
        " while :; do sleep 1; done\n"
        "fi\n"
        'touch "$FLEET_DIR/ready"\n'
        # Parent contention budget stays four seconds; borrower observation has
        # six seconds so the parent's unchanged 0..2-second jitter is not a race.
        'if [ "$FIXTURE_BORROWED_TRANSPORT_DELAY" = 1 ]; then CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=6; fi\n'
        'if [[ "$RUN_BENCH_CAMPAIGN_JOB_ID" == *j0002 ]]; then\n'
        ' while [ ! -e "$FIXTURE_ROOT/r001-j0001/closed" ]; do sleep 0.1; done\n'
        ' inventory_machine_field "$FIXTURE_TARGET" state > "$FLEET_DIR/state"\n'
        ' if [ "$FIXTURE_REFRESH" = 1 ]; then\n'
        '  while [ "$(python3 -c \'import json,os;print(sum(json.loads(s)["kind"]=="machines" for s in open(os.environ["FIXTURE_CALLS"])))\')" -lt 2 ] || [ -e "$INVENTORY_REFRESH_LOCK" ]; do sleep 0.1; done\n'
        '  prior="$(machines_snapshot_identity)"; refresh_machines_snapshot_after "$prior"; test "$prior" != "$(machines_snapshot_identity)"; fi\n'
        "fi\n"
    )
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("RUN_BENCH_CAMPAIGN_") or key.startswith("CLOUDBENCH_CAMPAIGN_"):
            env.pop(key)
    env.update(OFFLINE_WITHOUT_SHARED_RELAY)
    env.update(
        PATH=str(binary)
        + os.pathsep
        + "/opt/homebrew/bin:"
        + str(Path(sys.executable).parent)
        + os.pathsep
        + env.get("PATH", ""),
        FLY_API_TOKEN="offline-fixture-only",
        FIXTURE_ROOT=str(tmp_path),
        FIXTURE_MACHINES=str(machines),
        FIXTURE_VOLUMES=str(volumes),
        FIXTURE_CALLS=str(calls),
        FIXTURE_TARGET=target,
        FIXTURE_DEATH=str(int(death)),
        FIXTURE_REFRESH=str(int(refresh)),
        FIXTURE_POST_CANARY=str(int(post_canary)),
        FIXTURE_NATIVE_READ_DELAY=str(native_read_delay),
        CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=str(int(shared)),
        CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=str(int(mutation)),
        CLOUDBENCH_SNAPSHOT_POLL_SECONDS="1" if refresh else "60",
        FIXTURE_BORROWED_TRANSPORT_DELAY=str(int(borrowed_transport_delay)),
    )
    if borrowed_transport_delay:
        env.update(CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS="6",
                   CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS="4")
    if auth:
        env["FLY_BENCH_API_TOKEN"] = "offline-bench-token-selected-123456789"
        env["FLY_API_TOKEN"] = "offline-injected-token-unselected"
        env["FIXTURE_EXPECT_AUTH"] = env["FLY_BENCH_API_TOKEN"]
    result = subprocess.run(
        [
            sys.executable,
            str(Path(os.environ.get("CLOUDBENCH_CAMPAIGN_SCRIPT_UNDER_TEST", ROOT / "scripts/run-bench-campaign.py"))),
            "--root",
            str(tmp_path),
            "--runs",
            "1",
            "--concurrency",
            "2",
            "--task",
            "first",
            "--task",
            "second",
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    records = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
    summary = json.loads(next((tmp_path / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
    return result, records, summary, machines.stat().st_size


def test_campaign_inventory_two_consumers_share_one_native_feed_and_leave_parent_owner_alive(tmp_path):
    result, calls, summary, payload_bytes = run_consumers(tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    machines = [call for call in calls if call["kind"] == "machines"]
    # The unchanged producer does one initial read and one first loop read.
    assert len(machines) == 2, calls
    assert sum(call["decoded_bytes"] for call in machines) == payload_bytes * 2
    assert (tmp_path / "r001-j0002/state").read_text() == "started"
    assert all(job["controller_exit_code"] == 0 for job in summary["jobs"])
    feed = Path(summary["shared_inventory"]["directory"])
    assert not (feed / "owner").exists()
    assert not (feed / "inventory-refresh.wait").exists()


def test_campaign_inventory_dead_owner_cancels_paused_startup_and_joins_clean_terminal(tmp_path):
    result, calls, summary, _ = run_consumers(tmp_path, death=True)
    assert result.returncode != 0
    assert summary["status"] == "failed" and summary["finished_at"]
    assert all(job["finished_at"] for job in summary["jobs"])
    for job in summary["jobs"]:
        assert (tmp_path / job["job_id"] / "paused-before-gate").exists()
        assert (tmp_path / job["job_id"] / "closed").exists()
    assert len([call for call in calls if call["kind"] == "machines"]) == 2, calls


@pytest.mark.parametrize("native_read_delay", (0, 0.1))
def test_campaign_inventory_post_mutation_refresh_keeps_native_generation_and_ordinary_fleet_ownership(tmp_path, native_read_delay):
    result, calls, _, _ = run_consumers(tmp_path, refresh=True)
    assert result.returncode == 0, result.stdout + result.stderr
    # The fixture's borrower observes the initial and one periodic parent read,
    # then requires its post-mutation refresh to publish a new generation. The
    # parent's 1-second poll may add further periodic reads under host load;
    # every native read must still belong to the one parent publisher.
    machines = [call for call in calls if call["kind"] == "machines"]
    assert len(machines) >= 3, calls
    assert all(call["role"] == "publisher-http-transport" and call["job_id"] is None for call in machines), calls
    ordinary = tmp_path / "ordinary"
    ordinary.mkdir()
    result, calls, summary, _ = run_consumers(ordinary, shared=False, native_read_delay=native_read_delay)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "shared_inventory" not in summary
    assert len([call for call in calls if call["kind"] == "machines"]) == 4, calls


def test_campaign_inventory_borrowed_refresh_cannot_block_parent_with_native_completion_delay(tmp_path):
    result, calls, summary, _ = run_consumers(tmp_path, refresh=True, borrowed_transport_delay=True)
    feed = Path(summary["shared_inventory"]["directory"])
    publisher_log = (feed / "publisher.private.log").read_text()
    assert result.returncode == 0, result.stdout + result.stderr + publisher_log
    assert not any(call["role"] == "borrower" for call in calls), calls
    assert "timed out waiting for the serialized inventory refresh" not in publisher_log
    assert all(job["controller_exit_code"] == 0 for job in summary["jobs"])
    assert (tmp_path / "r001-j0002/state").read_text() == "started"
    assert not (feed / "owner").exists()


def test_campaign_inventory_reuses_existing_fleet_credential_precedence(tmp_path):
    result, _, summary, _ = run_consumers(tmp_path, auth=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert summary["status"] == "passed"


def test_campaign_inventory_keeps_existing_production_only_mode_free_of_shared_fly_feed(tmp_path):
    result, _, summary, _ = run_consumers(tmp_path, production_only=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "shared_inventory" not in summary


# The owning campaign uses the actual seed client against a loopback object store.
# No paid provider, Hub upload, credentials, or guest restore is used by these controls.
def seed_fixture(tmp_path, monkeypatch):
    import importlib.util
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    root = tmp_path / "workspace"
    root.mkdir()
    for relative in (
        "scripts/run-bench-campaign.py",
        "scripts/cloudbench-campaign-seed.py",
        "scripts/cloudbench-seed-get.sh",
        # The campaign planner reads its sibling provider-capacity contract.
        "scripts/cloudbench-provider-capacity.py",
        "scripts/cloudbench-provider-limits.json",
        # Strict cohorts bind their committed cleanup-ticket interpreter.
        "scripts/cloudbench-cleanup-tickets.py",
        "scripts/cloudbench-infra-canary-preflight.py",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        origin = (
            Path(os.environ.get("CLOUDBENCH_SEED_CAMPAIGN_UNDER_TEST", candidate / relative))
            if relative == "scripts/run-bench-campaign.py"
            else candidate / relative
        )
        shutil.copyfile(origin, target)
    for relative in (
        "scripts/cloudbench-campaign-barrier.py",
        "scripts/cloudbench-campaign-inventory.sh",
        "scripts/cloudbench-port-lease.py",
        "scripts/cloudbench-machine-readiness.py",
        "scripts/lib/cloudbench-env.sh",
        "scripts/lib/cloudbench-inventory.sh",
        "agents/benchmarks/seed_cache_path.py",
        "back-end/prisma/schema.prisma",
        "back-end/scripts/seed-dump-cache.ts",
        "back-end/package.json",
    ):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    # Strict cohorts run the parent infra-canary preflight. These seed controls
    # reuse a fresh retained PASS stamp (as the owning cleanup-ticket campaign
    # control does) and a canary that refuses if it is ever actually executed.
    (root / "scripts/run-fleet-infra-canary").write_text("#!/bin/bash\nexit 97\n")
    (root / "scripts/run-fleet-infra-canary").chmod(0o700)
    (root / ".context").mkdir()
    (root / ".context/fleet-infra-canary.last-pass").write_text("retained canonical PASS\n")
    # The 50-member cohort's default cleanup floors (51 x (256 + 32) MiB) would
    # tie these seed controls to ~15 GB of real host free space; size them like
    # the owning cleanup-ticket campaign controls instead.
    # The copied root has no back-end/.env; name the fleet's browser provider so
    # the provider-scoped Tilion capacity row does not bind this Kernel fixture.
    monkeypatch.setenv("CLOUDBENCH_BROWSER_PROVIDER", "kernel")
    monkeypatch.setenv("CLOUDBENCH_CLEANUP_DISK_RESERVE_MB", "1")
    monkeypatch.setenv("CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB", "1")
    monkeypatch.setenv("CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB", "0")
    # The publisher's Machines list uses its direct HTTP transport; this offline
    # fixture controls only that boundary with an empty app inventory.
    (root / "scripts/cloudbench-campaign-machines.py").write_text("import sys\nsys.stdout.buffer.write(b'[]')\n")
    # These controls run the real host seed GET (cloudbench-seed-get.sh -> tsx)
    # through the checkout's installed Node trees. An unprovisioned worktree used
    # to fail six cases with a bare FileNotFoundError on the missing seed probe.
    assert any((ROOT / tree / "node_modules/.bin/tsx").exists() for tree in (".", "back-end")), (
        f"seed preflight controls need this checkout's Node dependencies: no tsx under {ROOT}/node_modules "
        "or back-end/node_modules; install them or run scripts/prepare-deploy-worktree.sh"
    )
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    (root / "back-end/node_modules").symlink_to(ROOT / "back-end/node_modules", target_is_directory=True)
    for command in (
        ["git", "init", "-q"],
        ["git", "add", "scripts", "agents", "back-end/prisma", "back-end/scripts", "back-end/package.json"],
        ["git", "-c", "user.name=Local control", "-c", "user.email=control@localhost", "commit", "-qm", "fixture"],
    ):
        subprocess.run(command, cwd=root, check=True, capture_output=True)
    body = b"local-complete-fixture-control\n" * 8192
    calls = []

    class Storage(BaseHTTPRequestHandler):
        # The seed client always addresses /<bucket>/<key>. Dev-box port
        # forwarders probe each new local listener at `/` (e.g. a sprite-daemon
        # `HEAD /`); those are host traffic, not storage calls under test.
        def do_GET(self):
            if self.path == "/":
                self.send_error(404)
                return
            calls.append(("GET", self.path))
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            if self.path == "/":
                self.send_error(404)
                return
            calls.append(("HEAD", self.path))
            self.send_error(500)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Storage)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for key in list(os.environ):
        if key.startswith(("RUN_BENCH_CAMPAIGN_", "CLOUDBENCH_CAMPAIGN_")):
            monkeypatch.delenv(key)
    for key, value in OFFLINE_WITHOUT_SHARED_RELAY.items():
        monkeypatch.setenv(key, value)
    for key, value in {
        "R2_ACCOUNT_ID": "offline-fixture-account",
        "R2_ACCESS_KEY_ID": "offline-fixture-key-id",
        "R2_SECRET_ACCESS_KEY": "offline-fixture-secret-only",
        "R2_BUCKET_TRACE_ARCHIVE": "fixture-bucket",
        "R2_ENDPOINT": f"http://127.0.0.1:{server.server_port}",
        "BENCHMARK_HUB_GROUP_RUN_ID": "offline-fixture-no-posts",
        "FLY_BENCH_API_TOKEN": "offline-fixture-token",
        "TZ": "UTC",
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
        "PATH": str(Path(sys.executable).parent) + os.pathsep + "/opt/homebrew/bin:" + os.environ["PATH"],
    }.items():
        monkeypatch.setenv(key, value)
    spec = importlib.util.spec_from_file_location("cohort_seed_fixture", root / "scripts/cloudbench-campaign-seed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return root, module, server, thread, calls, body


def test_campaign_inventory_seed_preflight_without_optional_dotenv(tmp_path, monkeypatch):
    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    try:
        (root / "back-end/.env").write_text(
            "# local selector control\nR2_ACCOUNT_ID = 'file-account'\n"
            'R2_BUCKET_TRACE_ARCHIVE="file-bucket"\nR2_ACCESS_KEY_ID=file-key\n'
        )
        for key in ("R2_ACCOUNT_ID", "R2_BUCKET_TRACE_ARCHIVE", "R2_ACCESS_KEY_ID"):
            monkeypatch.delenv(key)
        # -S is the supported system-Python situation: no optional site packages.
        script = (
            "import json,runpy,sys;from pathlib import Path;"
            "m=runpy.run_path(sys.argv[1]);r=Path(sys.argv[2]);"
            "print(json.dumps(m['fixture'](r,r/'scripts')))"
        )
        result = subprocess.run(
            [sys.executable, "-S", "-c", script, str(root / "scripts/cloudbench-campaign-seed.py"), str(root)],
            capture_output=True,
            timeout=60,
        )
        assert result.returncode == 0, "system Python cannot bind the owned canonical fixture"
        expected = {
            "R2_ACCOUNT_ID": "file-account",
            "R2_ENDPOINT": os.environ["R2_ENDPOINT"],
            "R2_BUCKET_TRACE_ARCHIVE": "file-bucket",
            "R2_ACCESS_KEY_ID": "file-key",
        }
        assert json.loads(result.stdout)["selector_sha256"] == module.digest(
            json.dumps(expected, sort_keys=True).encode()
        )
        assert calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_honors_existing_deadline_before_get(tmp_path, monkeypatch):
    import time

    root, _module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(root / "scripts/cloudbench-campaign-seed.py"),
                "standalone",
                "--root",
                str(root),
                "--out-dir",
                str(directory),
                "--deadline",
                str(time.time() - 1),
            ],
            capture_output=True,
            timeout=60,
        )
        assert result.returncode != 0, "expired owner budget still performed and accepted a full GET"
        assert calls == [] and not list(directory.glob("seed-probe-*"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_campaign_cancellation_drains_get(tmp_path, monkeypatch):
    import signal
    import time

    root, _module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    process = None
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        fly.write_text('#!/usr/bin/env bash\nprintf "[]\\n"\n')
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        helper = root / "scripts/cloudbench-seed-get.sh"
        helper.write_text('#!/usr/bin/env bash\nexec "' + sys.executable + '" "$1/scripts/blocked-get.py" "$3"\n')
        (root / "scripts/blocked-get.py").write_text(
            "import json,os,subprocess,sys,time\nfrom pathlib import Path\n"
            "root=Path(__file__).parents[1]\n"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)'])\n"
            "(root/'get-started.json').write_text(json.dumps({'pid':os.getpid(),'child':child.pid}))\n"
            "try:\n"
            " while not (root/'release-get').exists(): time.sleep(0.1)\n"
            " Path(sys.argv[1]).write_bytes(b'complete-offline-fixture')\n"
            "finally:\n child.terminate();child.wait()\n"
        )
        (root / "scripts/run-bench").write_text('#!/usr/bin/env bash\ntouch "$PWD/unexpected-child"\n')
        command = [
            sys.executable,
            str(root / "scripts/run-bench-campaign.py"),
            "--root",
            str(root),
            "--runs",
            "2",
            "--concurrency",
            "2",
            "--task",
            "local-fixture-control",
            "--forward-arg=--strict-barrier",
        ]
        with (root / "campaign.private.log").open("wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            guard = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
            while not (root / "get-started.json").exists():
                assert process.poll() is None and time.monotonic() < guard, "blocked owning GET did not start"
                time.sleep(0.1)
            owned = json.loads((root / "get-started.json").read_text())
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=15)
                joined = True
            except subprocess.TimeoutExpired:
                joined = False
            assert joined, "campaign cancellation did not interrupt its owned full GET"
        summary = json.loads(next((root / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
        assert process.returncode == 143 and summary["status"] == "cancelled"
        assert not (root / "unexpected-child").exists()
        assert not list(root.glob(".context/benchmarks/campaigns/*/startup-cohorts/*/seed-proof.private.json"))
        assert not list(root.glob(".context/benchmarks/campaigns/*/startup-cohorts/*/seed-probe-*"))
        assert not (Path(summary["shared_inventory"]["directory"]) / "owner").exists()
        for pid in (owned["pid"], owned["child"], summary["shared_inventory"]["publisher_pid"]):
            native = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            assert not native.stdout.strip() or native.stdout.strip().startswith("Z"), (
                "owned helper retained live resources"
            )
        assert calls == []
    finally:
        (root / "release-get").touch()
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=60)
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_exited_get_leader_drains_owned_descendant(tmp_path, monkeypatch):
    import signal
    import time

    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    started = root / "owned-get-child.json"
    (root / "scripts/cloudbench-seed-get.sh").write_text(
        '#!/usr/bin/env bash\nexec "' + sys.executable + '" "$1/scripts/orphan-get.py" "$3"\n'
    )
    (root / "scripts/orphan-get.py").write_text(
        "import json,subprocess,sys\nfrom pathlib import Path\n"
        "root=Path(__file__).parents[1]\n"
        "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(600)'])\n"
        "stamp=' '.join(subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart='],text=True).split())\n"
        "(root/'owned-get-child.json').write_text(json.dumps({'pid':child.pid,'birth':stamp}))\n"
        "Path(sys.argv[1]).write_bytes(b'complete-owned-fixture')\n"
        "# Exit the GET leader while its exact owned descendant is still live.\n"
    )
    try:
        transfer = module.get(root, root / "scripts", {"token": "owned-fixture"}, directory, time.time() + 60)
        owned = json.loads(started.read_text())
        state = subprocess.run(
            ["ps", "-p", str(owned["pid"]), "-o", "stat="], capture_output=True, text=True
        ).stdout.strip()
        assert transfer["exit_code"] == 0 and transfer["bytes"] == len(b"complete-owned-fixture")
        assert not state or state.startswith("Z"), "exited GET leader retained a live owned descendant"
        assert not list(directory.glob("seed-probe-*")) and calls == []
    finally:
        # RED must also release its fixture without signaling a reused PID.
        if started.is_file():
            owned = json.loads(started.read_text())
            if module._identity._process_start_matches(owned["pid"], owned["birth"]):
                try:
                    os.kill(owned["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    state = subprocess.run(
                        ["ps", "-p", str(owned["pid"]), "-o", "stat="], capture_output=True, text=True
                    ).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(0.05)
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_late_hash_cancellation_refuses_proof(tmp_path, monkeypatch):
    import hashlib
    import signal
    import time

    import pytest

    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    directory = root / "standalone"
    directory.mkdir()
    (root / "scripts/cloudbench-seed-get.sh").write_text('printf complete-owned-fixture > "$3"\n')
    original = hashlib.sha256
    cancelled = []

    class CancelDuringHash:
        def __init__(self):
            self.inner = original()

        def update(self, chunk):
            if not cancelled:
                cancelled.append(True)
                os.kill(os.getpid(), signal.SIGTERM)
            self.inner.update(chunk)

        def hexdigest(self):
            return self.inner.hexdigest()

    try:
        with monkeypatch.context() as patch:
            patch.setattr(module.hashlib, "sha256", CancelDuringHash)
            with pytest.raises(ValueError, match="cancel"):
                module.get(root, root / "scripts", {"token": "owned-fixture"}, directory, time.time() + 60)
        assert cancelled and not list(directory.glob("seed-probe-*"))
        assert not (directory / "seed-proof.private.json").exists() and calls == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("e2e_limit", [False, True])
def test_campaign_inventory_seed_preflight_full_get_once_for_exact_50_and_standalone(tmp_path, monkeypatch, e2e_limit):
    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        fly.write_text('#!/usr/bin/env bash\nprintf "[]\\n"\n')
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        cli = root / "scripts/run-bench"
        cli.write_text("""#!/usr/bin/env bash
set -euo pipefail
root="$PWD"
if [ -n "${CLOUDBENCH_CAMPAIGN_SEED_PROOF:-}" ]; then
 python3 "$root/scripts/cloudbench-campaign-seed.py" consume --root "$root" --inventory "$CLOUDBENCH_CAMPAIGN_INVENTORY_DIR" --barrier "$RUN_BENCH_CAMPAIGN_BARRIER_DIR" --proof "$CLOUDBENCH_CAMPAIGN_SEED_PROOF" --job "$RUN_BENCH_CAMPAIGN_JOB_ID" --controller-pid "$$" --deadline "$(python3 -c 'import time;print(time.time()+60)')"
else
 token="$(python3 "$root/agents/benchmarks/seed_cache_path.py" --cache-token --pg-major 15 "$root/back-end/prisma/schema.prisma")"
 probe="$(mktemp)"
 trap 'rm -f "$probe"' EXIT
 bash "$root/scripts/cloudbench-seed-get.sh" "$root" "$token" "$probe"
fi
python3 "$root/scripts/cloudbench-campaign-barrier.py" --controller-pid "$$" --deadline "$(python3 -c 'import time;print(time.time()+60)')"
""")
        command = [
            sys.executable,
            str(root / "scripts/run-bench-campaign.py"),
            "--root",
            str(root),
            "--runs",
            "50",
            "--concurrency",
            "50",
            "--task",
            "local-fixture-control",
            "--forward-arg=--strict-barrier",
        ]
        if e2e_limit:
            command += ["--e2e-timeout", "90"]
        result = subprocess.run(command, env=dict(os.environ), capture_output=True, timeout=90)
        assert result.returncode == 0, "owning local campaign failed; inspect private test capture"
        summary = json.loads(next((root / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
        assert summary["status"] == "passed" and summary["peak_concurrency"] == 50
        assert len(summary["jobs"]) == 50 and all(job["controller_exit_code"] == 0 for job in summary["jobs"])
        feed = Path(summary["shared_inventory"]["directory"])
        assert not (feed / "owner").exists() and not (feed / "inventory-refresh.wait").exists()
        check = subprocess.run(
            ["ps", "-p", str(summary["shared_inventory"]["publisher_pid"]), "-o", "lstart="], capture_output=True
        )
        assert not check.stdout.strip()
        proof = next((root / ".context/benchmarks/campaigns").glob("*/startup-cohorts/*/seed-proof.private.json"), None)
        # This same control deliberately fails RED against the unchanged campaign:
        # every child made a full GET and there was no shared cohort proof.
        assert len(calls) == 1 and calls[0][0] == "GET"
        assert proof is not None
        payload = json.loads(proof.read_text())
        assert payload["get"]["bytes"] == len(body) and payload["get"]["sha256"] == module.digest(body)
        assert len(payload["members"]) == 50 and proof.stat().st_mode & 0o777 == 0o600
        standalone = root / "standalone"
        standalone.mkdir()
        original_read = Path.read_bytes

        def forbid_unbounded_dump_read(path):
            if path.name.startswith("seed-probe-"):
                raise AssertionError("host receipt must hash the completed full GET in bounded chunks")
            return original_read(path)

        monkeypatch.setattr(Path, "read_bytes", forbid_unbounded_dump_read)
        transfer = module.get(root, root / "scripts", module.fixture(root, root / "scripts"), standalone)
        assert transfer["bytes"] == len(body) and len(calls) == 2 and all(call[0] == "GET" for call in calls)
        assert not list(standalone.glob("seed-probe-*"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_rejects_foreign_owner_member_and_fixture_without_get(tmp_path, monkeypatch):
    import copy
    import fcntl
    import time

    import pytest

    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    campaign = root / "campaign"
    campaign.mkdir()
    inventory = campaign / "shared-inventory"
    inventory.mkdir()
    barrier = campaign / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": module.birth(os.getpid()),
        "token": "local-owner-fixture",
        "parent_pid": str(os.getpid()),
        "parent_start": module.birth(os.getpid()),
    }
    (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))
    (barrier / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
    try:
        proof = module.prepare(root, root / "scripts", inventory, barrier)
        original = json.loads(proof.read_text())
        # A real child can reach preflight between Popen and PID-map publication.
        import threading

        manifest_path = barrier / "manifest.json"
        manifest_path.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": None}}))

        def publish_pid():
            temporary = barrier / ".manifest.delayed-publication"
            temporary.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
            temporary.replace(manifest_path)

        publisher = threading.Timer(0.3, publish_pid)
        publisher.start()
        try:
            assert module.consume(
                root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 10
            )["bytes"] == len(body)
        finally:
            publisher.join()
        manifest_path.write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid() + 1}}))
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 10)
        publish_pid()
        assert module.consume(
            root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
        )["bytes"] == len(body)
        for field, key in (
            ("owner", "token"),
            ("owner", "parent_start"),
            ("fixture", "selector_sha256"),
            ("fixture", "source_sha"),
            ("fixture", "schema_sha256"),
            ("fixture", "token"),
        ):
            value = copy.deepcopy(original)
            value[field][key] = "foreign-fixture"
            proof.write_text(json.dumps(value))
            with pytest.raises(ValueError):
                module.consume(
                    root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
                )
        for name, value in (("members", ["foreign"]), ("cohort_id", "c999")):
            changed = copy.deepcopy(original)
            changed[name] = value
            proof.write_text(json.dumps(changed))
            with pytest.raises(ValueError):
                module.consume(
                    root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2
                )
        proof.write_text(json.dumps(original))
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "foreign", os.getpid(), time.time() + 2)
        lock.close()
        with pytest.raises(ValueError):
            module.consume(root, root / "scripts", inventory, barrier, proof, "fixture", os.getpid(), time.time() + 2)
        assert len(calls) == 1 and calls[0][0] == "GET"
    finally:
        if not lock.closed:
            lock.close()
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_failed_proof_publication_never_admits_controller(tmp_path, monkeypatch):
    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    try:
        binary = root / "bin"
        binary.mkdir()
        fly = binary / "flyctl"
        # Fail only atomic publication after the real complete GET has succeeded.
        fly.write_text("""#!/usr/bin/env bash
mkdir -p "$RUN_BENCH_CAMPAIGN_ROOT/$RUN_BENCH_CAMPAIGN_ID/startup-cohorts/c001/seed-proof.private.json"
printf '[]\n'
""")
        fly.chmod(0o700)
        monkeypatch.setenv("PATH", str(binary) + os.pathsep + os.environ["PATH"])
        monkeypatch.setenv("RUN_BENCH_CAMPAIGN_ID", "local-proof-write-failure")
        monkeypatch.setenv("RUN_BENCH_CAMPAIGN_ROOT", str(root / "campaigns"))
        (root / "scripts/run-bench").write_text('#!/usr/bin/env bash\ntouch "$PWD/unexpected-child"\nexit 0\n')
        result = subprocess.run(
            [
                sys.executable,
                str(root / "scripts/run-bench-campaign.py"),
                "--root",
                str(root),
                "--runs",
                "50",
                "--concurrency",
                "50",
                "--task",
                "local-fixture-control",
                "--forward-arg=--strict-barrier",
            ],
            env=dict(os.environ),
            capture_output=True,
            timeout=30,
        )
        summary = json.loads((root / "campaigns/local-proof-write-failure/summary.json").read_text())
        assert result.returncode == 1 and summary["status"] == "failed" and summary["finished_at"]
        assert summary["peak_concurrency"] == 0 and not (root / "unexpected-child").exists()
        assert len(summary["jobs"]) == 50 and all(job["controller_exit_code"] is None for job in summary["jobs"])
        assert summary["startup_cohorts"][0]["status"] == "aborted"
        feed = Path(summary["shared_inventory"]["directory"])
        assert not (feed / "owner").exists()
        check = subprocess.run(
            ["ps", "-p", str(summary["shared_inventory"]["publisher_pid"]), "-o", "lstart="], capture_output=True
        )
        assert not check.stdout.strip()
        assert len(calls) == 1 and calls[0][0] == "GET"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_campaign_inventory_seed_preflight_native_linux_owner_tick_and_legacy_formats(tmp_path):
    if not Path("/proc/self/stat").exists():
        import pytest

        pytest.skip("native Linux owner identity is verified in the existing offline Linux image")
    import fcntl
    import importlib.util

    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    spec = importlib.util.spec_from_file_location(
        "native_cohort_seed", candidate / "scripts/cloudbench-campaign-seed.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inventory = tmp_path / "shared-inventory"
    inventory.mkdir()
    barrier = tmp_path / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    native = subprocess.check_output(
        [
            "bash",
            "-c",
            'FLEET_DIR="$1"; source "$2"; source "$3"; inventory_pid_start_time "$4"',
            "native-seed-owner",
            str(inventory),
            str(ROOT / "scripts/lib/cloudbench-env.sh"),
            str(ROOT / "scripts/lib/cloudbench-inventory.sh"),
            str(os.getpid()),
        ],
        text=True,
    ).strip()
    assert native.startswith("proc-start:")
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": native,
        "token": "offline-native-owner",
        "parent_pid": str(os.getpid()),
        "parent_start": native,
    }

    def publish():
        (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))

    try:
        publish()
        assert module.owner(inventory, barrier) == authority
        for field in ("pid_start", "parent_start"):
            prefix, tick = native.rsplit(":", 1)
            authority[field] = prefix + ":" + str(int(tick) + 1)
            publish()
            try:
                module.owner(inventory, barrier)
            except ValueError:
                pass
            else:
                raise AssertionError("foreign native start tick was accepted")
            authority[field] = native
        legacy = subprocess.check_output(["ps", "-p", str(os.getpid()), "-o", "lstart="], text=True).strip()
        authority.update(pid_start=legacy, parent_start=legacy)
        publish()
        assert module.owner(inventory, barrier) == authority
    finally:
        lock.close()


def test_campaign_inventory_seed_preflight_preserves_parent_toolchain_path_for_both_paths(tmp_path):
    candidate = Path(os.environ.get("CLOUDBENCH_SEED_CANDIDATE_ROOT_UNDER_TEST", ROOT))
    fleet = Path(
        os.environ.get("CLOUDBENCH_SEED_FLEET_SCRIPT_UNDER_TEST", candidate / "scripts/run-bench-fleet")
    ).read_text()
    anchor = "# Detached fleet controllers can inherit a stripped PATH"
    assert anchor in fleet, "canonical preflight must retain the original parent PATH resolution"
    start = fleet.index(anchor, fleet.index('CLOUDBENCH_GUEST_PG_MAJOR="${'))
    end = fleet.index('if [ -n "${CLOUDBENCH_CAMPAIGN_SEED_PROOF:-}" ]; then', start)
    stanza = fleet[start:end]
    binary = tmp_path / "node_modules/.bin"
    binary.mkdir(parents=True)
    for name in ("node", "npx"):
        path = binary / name
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o700)
    command = (
        'set -eu\nROOT_DIR="$1"\nexport PATH=/usr/bin:/bin\n'
        + stanza
        + '\ncommand -v npx >/dev/null\ncommand -v node >/dev/null\nnode -e "process.exit(0)"\n'
    )
    for proof in ("", "advertised-owned-proof"):
        environment = dict(os.environ, CLOUDBENCH_CAMPAIGN_SEED_PROOF=proof)
        result = subprocess.run(
            ["bash", "-c", command, "seed-parent-path", str(tmp_path)], env=environment, capture_output=True, timeout=10
        )
        assert result.returncode == 0, "resolved Node/npm PATH did not survive in fleet parent"


def test_campaign_inventory_seed_preflight_normalizes_guest_pg_default_before_consume(tmp_path, monkeypatch):
    import fcntl
    import importlib.util
    import time

    root, module, server, thread, calls, body = seed_fixture(tmp_path, monkeypatch)
    campaign = root / "campaign"
    inventory = campaign / "shared-inventory"
    inventory.mkdir(parents=True)
    barrier = campaign / "startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    authority = {
        "app": "navi-whisper-lux-bench",
        "pid": str(os.getpid()),
        "pid_start": module.birth(os.getpid()),
        "token": "local-pg-default-owner",
        "parent_pid": str(os.getpid()),
        "parent_start": module.birth(os.getpid()),
    }
    (inventory / "owner").write_text("".join(f"{key}={value}\n" for key, value in authority.items()))
    (barrier / "manifest.json").write_text(json.dumps({"cohort_id": "c001", "jobs": {"fixture": os.getpid()}}))
    normalize = next(
        line
        for line in (ROOT / "scripts/run-bench-fleet").read_text().splitlines()
        if line.startswith('CLOUDBENCH_GUEST_PG_MAJOR="${')
    )
    spec = importlib.util.spec_from_file_location("native_seed_token", root / "agents/benchmarks/seed_cache_path.py")
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    try:
        for configured in (None, "", "15", "16"):
            if configured is None:
                monkeypatch.delenv("CLOUDBENCH_GUEST_PG_MAJOR", raising=False)
            else:
                monkeypatch.setenv("CLOUDBENCH_GUEST_PG_MAJOR", configured)
            proof = module.prepare(root, root / "scripts", inventory, barrier)
            fleet_pg = subprocess.check_output(
                [
                    "bash",
                    "-c",
                    normalize + '\nprintf "%s" "$CLOUDBENCH_GUEST_PG_MAJOR"',
                ],
                text=True,
            )
            payload = json.loads(proof.read_text())
            assert payload["fixture"]["pg_major"] == fleet_pg, "parent proof disagrees with fleet PG-major default"
            assert payload["fixture"]["token"] == seed.seed_cache_token(
                root / "back-end/prisma/schema.prisma", fleet_pg
            )
            monkeypatch.setenv("CLOUDBENCH_GUEST_PG_MAJOR", fleet_pg)
            assert module.consume(
                root,
                root / "scripts",
                inventory,
                barrier,
                proof,
                "fixture",
                os.getpid(),
                time.time() + 10,
            )["bytes"] == len(body)
        assert len(calls) == 4 and all(method == "GET" for method, _ in calls)
    finally:
        lock.close()
        server.shutdown()
        server.server_close()
        thread.join()


def _assert_publication_process_retired(pid, birth):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return {"pid": pid, "birth": birth, "state": "absent"}
    observed = subprocess.run(["ps", "-p", str(pid), "-o", "stat=,ppid=,pgid="], capture_output=True, text=True)
    assert observed.returncode == 0 and observed.stdout.strip(), f"unknown publication state for {pid}"
    identity = subprocess.run([sys.executable, str(ROOT / "scripts/process-identity.py"), str(pid)], capture_output=True, text=True)
    assert identity.returncode == 0 and identity.stdout.strip() == birth, f"publication birth changed or unreadable for {pid}"
    assert observed.stdout.strip().startswith("Z"), f"owned publication process {pid} remains executing: {observed.stdout.strip()}"
    state, ppid, pgid = observed.stdout.split()
    return {"pid": pid, "birth": birth, "state": state, "ppid": int(ppid), "pgid": int(pgid)}


def test_campaign_inventory_publication_retirement_distinguishes_owned_zombie():
    """A real unreaped exit is not an executing publication process."""
    child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
    identity = ROOT / "scripts/process-identity.py"
    try:
        birth = subprocess.check_output([sys.executable, str(identity), str(child.pid)], text=True).strip()
        with pytest.raises(AssertionError, match="remains executing"):
            _assert_publication_process_retired(child.pid, birth)
        child.stdin.close()
        deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
        while time.monotonic() < deadline:
            state = subprocess.check_output(["ps", "-p", str(child.pid), "-o", "stat="], text=True).strip()
            if state.startswith("Z"):
                break
            time.sleep(0.01)
        assert state.startswith("Z"), "controlled child did not reach native zombie state"
        with pytest.raises(AssertionError, match="birth changed or unreadable"):
            _assert_publication_process_retired(child.pid, birth + "-foreign")
        _assert_publication_process_retired(child.pid, birth)
    finally:
        if child.stdin is not None and not child.stdin.closed:
            child.stdin.close()
        child.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)


@pytest.mark.parametrize("phase", ["starting", "final"])
def test_campaign_inventory_group_publication_cancellation_retires_only_its_owned_processes(tmp_path, phase):
    """The real campaign must honor cancellation during both Hub handoffs."""
    import signal
    import time

    fixture = tmp_path / phase
    scripts = fixture / "scripts"
    scripts.mkdir(parents=True)
    uploader = fixture / "agents/benchmarks/hub_upload.py"
    uploader.parent.mkdir(parents=True)
    marker = fixture / "publication-owner.json"
    release = fixture / "release"
    admitted = fixture / "admitted"
    (scripts / "run-bench").write_text('#!/usr/bin/env bash\ntouch "$FIXTURE_ADMITTED"\nexit 0\n')
    uploader.write_text(
        "import json, os, subprocess, sys, time\n"
        "from pathlib import Path\n"
        'phase="starting" if "--register-starting" in sys.argv else "final"\n'
        'if phase != os.environ["FIXTURE_PHASE"]: sys.exit(0)\n'
        'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(120)"])\n'
        'marker=Path(os.environ["FIXTURE_MARKER"]); temporary=marker.with_suffix(".tmp")\n'
        'births={str(pid):subprocess.check_output([sys.executable,os.environ["FIXTURE_IDENTITY"],str(pid)],text=True).strip() for pid in (os.getpid(),child.pid)}\n'
        'temporary.write_text(json.dumps({"pid":os.getpid(),"child_pid":child.pid,"births":births})); temporary.replace(marker)\n'
        'while not Path(os.environ["FIXTURE_RELEASE"]).exists(): time.sleep(0.1)\n'
        "child.terminate(); child.wait()\n"
    )
    environment = dict(os.environ)
    for name in list(environment):
        if name.startswith(("RUN_BENCH_CAMPAIGN_", "CLOUDBENCH_CAMPAIGN_", "BENCHMARK_HUB_")):
            environment.pop(name)
    environment.update(OFFLINE_WITHOUT_SHARED_RELAY)
    environment.update(
        FIXTURE_PHASE=phase,
        FIXTURE_IDENTITY=str(ROOT / "scripts/process-identity.py"),
        FIXTURE_MARKER=str(marker),
        FIXTURE_RELEASE=str(release),
        FIXTURE_ADMITTED=str(admitted),
    )
    command = [
        sys.executable,
        str(Path(os.environ.get("CLOUDBENCH_CAMPAIGN_SCRIPT_UNDER_TEST", ROOT / "scripts/run-bench-campaign.py"))),
        "--root",
        str(fixture),
        "--runs",
        "1",
        "--concurrency",
        "1",
        "--task",
        "fixture",
    ]
    foreign = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    with (fixture / "campaign.private.log").open("w") as log:
        process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
            assert marker.exists(), "the actual Hub publication did not reach its owning boundary"
            owner = json.loads(marker.read_text())
            process.send_signal(signal.SIGTERM)
            try:
                result = process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
            except subprocess.TimeoutExpired:
                raise AssertionError(f"campaign cancellation remained blocked in {phase} publication") from None
            assert result == 143
            summary = json.loads(next((fixture / ".context/benchmarks/campaigns").glob("*/summary.json")).read_text())
            assert summary["status"] == "cancelled"
            assert summary["finished_at"]
            group = json.loads(next((fixture / ".context/benchmarks/campaigns").glob("*/hub-group.json")).read_text())
            assert group["run_group"]["status"] == summary["status"], (
                "cancelled campaign must leave the same terminal group status"
            )
            assert admitted.exists() == (phase == "final")
            assert summary["jobs"][0]["status"] == ("passed" if phase == "final" else "cancelled")
            assert foreign.poll() is None, "cancellation must preserve the unrelated process"
            observations = [
                _assert_publication_process_retired(owned_pid, owner["births"][str(owned_pid)])
                for owned_pid in (owner["pid"], owner["child_pid"])
            ]
            (fixture / "publication-retirement.safe.json").write_text(json.dumps(observations))
        finally:
            release.touch()
            try:
                process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            foreign.terminate()
            foreign.wait()


@pytest.mark.parametrize(
    "phase", ["starting", "final", "completed", "wrong_token", "wrong_digest", "wrong_pid", "wrong_json"]
)
def test_campaign_inventory_cancellation_reconciles_with_its_existing_hub_publisher(tmp_path, phase):
    """Actual HTTP publication must finish cancelled through the original owner."""
    import gzip
    import signal
    import threading
    import time
    import urllib.request
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    fixture = tmp_path / phase
    (fixture / "scripts").mkdir(parents=True)
    uploader = fixture / "agents/benchmarks/hub_upload.py"
    uploader.parent.mkdir(parents=True)
    owner_path, cancelled_path = fixture / "owner.json", fixture / "cancel-observed"
    admitted = fixture / "admitted"
    (fixture / "scripts/run-bench").write_text('#!/usr/bin/env bash\ntouch "$FIXTURE_ADMITTED"\nexit 0\n')
    actual = ROOT / "agents/benchmarks/hub_upload.py"
    uploader.write_text(
        "import json, os, runpy, signal\nfrom pathlib import Path\n"
        'Path(os.environ["FIXTURE_OWNER"]).write_text(json.dumps({"pid":os.getpid()}))\n'
        'with Path(os.environ["FIXTURE_OWNER"]).with_suffix(".jsonl").open("a") as journal: journal.write(str(os.getpid())+"\\n")\n'
        "install=signal.signal\n"
        "def observe(signum, handler):\n"
        "    if not callable(handler): return install(signum, handler)\n"
        "    def forward(*args):\n"
        '        Path(os.environ["FIXTURE_CANCELLED"]).touch()\n'
        "        return handler(*args)\n"
        "    return install(signum, forward)\n"
        "signal.signal=observe\n"
        f"runpy.run_path({str(actual)!r}, run_name='__main__')\n"
    )
    records, blocked, release = [], threading.Event(), threading.Event()

    class Hub(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                payload = gzip.decompress(payload)
            record = json.loads(payload)
            record["live"] = "live=1" in self.path
            records.append(record)
            target = ("live=1" in self.path) == (phase == "starting")
            if target and not blocked.is_set():
                blocked.set()
                release.wait(FIXTURE_HOST_GUARD_SECONDS)
            body = json.dumps({"run": record}).encode()
            self.send_response(201)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

        def do_GET(self):
            body = json.dumps({"run": records[-1]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Hub)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("RUN_BENCH_CAMPAIGN_", "CLOUDBENCH_CAMPAIGN_", "BENCHMARK_HUB_"))
    }
    environment.update(OFFLINE_WITHOUT_SHARED_RELAY)
    environment.update(
        BENCHMARK_HUB_UPLOAD_URL=url,
        BENCHMARK_HUB_API_KEY="fixture-key",
        FIXTURE_OWNER=str(owner_path),
        FIXTURE_CANCELLED=str(cancelled_path),
        FIXTURE_ADMITTED=str(admitted),
    )
    campaign = ROOT / "scripts/run-bench-campaign.py"
    completed_phase = phase not in ("starting", "final")
    if completed_phase:
        # Observe the real parent's wait boundary after the final publisher is
        # natively reaped, then deliver cancellation. No runtime timer changes.
        entrypoint = fixture / "campaign-main.py"
        entrypoint.write_text(
            "import json, os, runpy, signal, subprocess\nfrom pathlib import Path\n"
            "Original=subprocess.Popen\n"
            "class Observed(Original):\n"
            "    def wait(self, *args, **kwargs):\n"
            "        code=super().wait(*args, **kwargs)\n"
            "        if '--upload-final' in self.args and not getattr(self, '_injected', False):\n"
            "            self._injected=True\n"
            "            if '--publication-ack' in self.args:\n"
            "                path=Path(self.args[self.args.index('--publication-ack')+1])\n"
            "                ack=json.loads(path.read_text())\n"
            f"                field={{'wrong_token':'token','wrong_digest':'record_sha256','wrong_pid':'pid'}}.get({phase!r})\n"
            "                if field: ack[field]='foreign'; path.write_text(json.dumps(ack))\n"
            f"                if {phase!r} == 'wrong_json': path.write_text('{{invalid')\n"
            "            os.kill(os.getpid(),signal.SIGTERM)\n"
            "        return code\n"
            "subprocess.Popen=Observed\n"
            f"runpy.run_path({str(campaign)!r}, run_name='__main__')\n"
        )
        campaign = entrypoint
        release.set()
    command = [
        sys.executable,
        str(campaign),
        "--root",
        str(fixture),
        "--runs",
        "1",
        "--concurrency",
        "1",
        "--task",
        "fixture",
    ]
    with (fixture / "campaign.private.log").open("w") as log:
        process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
        try:
            assert blocked.wait(FIXTURE_HOST_GUARD_SECONDS), "real Hub transport never reached the held boundary"
            owner = json.loads(owner_path.read_text())
            if not completed_phase:
                process.send_signal(signal.SIGTERM)
                deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
                while not cancelled_path.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                release.set()
            assert process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS) == (0 if phase == "completed" else 143)
            directory = next((fixture / ".context/benchmarks/campaigns").iterdir())
            summary = json.loads((directory / "summary.json").read_text())
            local = json.loads((directory / "hub-group.json").read_text())
            with urllib.request.urlopen(url + "/api/benchmarks/runs/" + summary["campaign_id"]) as response:
                remote = json.load(response)["run"]
            terminal_status = "passed" if phase == "completed" else "cancelled"
            assert local["run_group"]["status"] == summary["status"] == terminal_status
            assert remote["run_group"]["status"] == ("passed" if completed_phase else terminal_status)
            assert remote["timestamp"] == local["timestamp"] == summary["started_at"]
            assert remote["run_group"]["finished_at"]
            assert remote["run_group"]["outcomes"] == local["run_group"]["outcomes"]
            assert remote["run_group"]["outcomes"][summary["jobs"][0]["job_id"]]["status"] == (
                "cancelled" if phase == "starting" else "passed"
            )
            assert admitted.exists() == (phase != "starting")
            assert remote["live"] is False
            assert cancelled_path.exists() == (not completed_phase)
            assert len(records) == (3 if phase == "final" else 2)
            owners = [int(pid) for pid in owner_path.with_suffix(".jsonl").read_text().splitlines()]
            assert len(owners) == (1 if phase == "starting" else 2), "reconciliation must not add a new publisher"
            assert owners[-1] == owner["pid"]
            for pid in owners:
                with pytest.raises(ProcessLookupError):
                    os.kill(pid, 0)
        finally:
            release.set()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
            server.shutdown()
            server.server_close()
            thread.join()


@pytest.mark.parametrize("shared", (True, False))
def test_campaign_inventory_post_canary_admission_uses_parent_feed_without_native_fanout(tmp_path, shared):
    # Run the actual post-canary caller, not a replacement fixture caller. Only
    # the downstream admission sink is controlled; it requires native payload.
    # Parent reads succeed; a redundant child-wide read fails like original j0044.
    result, calls, summary, _ = run_consumers(tmp_path, shared=shared, post_canary=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(job["controller_exit_code"] == 0 for job in summary["jobs"])
    assert len([call for call in calls if call["kind"] == "machines"]) == (2 if shared else 6)


def post_canary_boundary_subject(tmp_path):
    fleet = (ROOT / "scripts/run-bench-fleet").read_text()
    boundary = fleet.split("fleet_infra_canary_preflight || exit $?\n", 1)[1].split(
        "# ── Clone one machine per bench", 1)[0]
    admission_start = fleet.index("admit_app_capacity_with_wait() {")
    admission = fleet[admission_start:fleet.index("\n}\n", admission_start) + 3]
    script = tmp_path / "boundary.sh"
    script.write_text(
        'set -euo pipefail\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        'FLEET_DIR="$1"; APP=fixture-app; FLEET_OWNER_HOST="$(hostname)"\n'
        'export CLOUDBENCH_CAMPAIGN_INVENTORY_DIR="$FLEET_DIR"\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh"))}\n'
        'mkdir -p "$INVENTORY_INDEX/current"\n'
        'birth="$(inventory_pid_start_time $$)"\n'
        'printf "app=%s\\npid=%s\\npid_start=%s\\ntoken=fixture-token\\nparent_pid=%s\\nparent_start=%s\\n" '
        '"$APP" "$$" "$birth" "$$" "$birth" > "$INVENTORY_HOME/owner"\n'
        'printf "publisher_token=fixture-token\\nvalid_until=%s\\n" "$((INVENTORY_CLOCK_EPOCH + 120))" > "$INVENTORY_INDEX/current/health"\n'
        'printf "[]" > "$MACHINES_SNAPSHOT"\n'
        'printf "[]" > "$INVENTORY_INDEX/current/admission-machines.json"\n'
        'replace_line() { local path=$1 key=$2 value=$3; '
        'awk -F= -v key="$key" -v value="$value" \'$1 == key {$0=key "=" value} {print}\' '
        '"$path" > "$path.tmp"; mv "$path.tmp" "$path"; }\n'
        'case "$2" in\n'
        ' missing-health) rm "$INVENTORY_INDEX/current/health";;\n'
        ' empty-health) : > "$INVENTORY_INDEX/current/health";;\n'
        ' invalid-health) replace_line "$INVENTORY_INDEX/current/health" valid_until malformed;;\n'
        ' expired-health) replace_line "$INVENTORY_INDEX/current/health" valid_until 1;;\n'
        ' wrong-token) replace_line "$INVENTORY_INDEX/current/health" publisher_token foreign;;\n'
        ' publisher-birth) replace_line "$INVENTORY_HOME/owner" pid_start invalid;;\n'
        ' parent-birth) replace_line "$INVENTORY_HOME/owner" parent_start invalid;;\n'
        ' wrong-app) replace_line "$INVENTORY_HOME/owner" app foreign;;\n'
        ' missing-owner) rm "$INVENTORY_HOME/owner";;\n'
        ' missing-snapshot) rm "$MACHINES_SNAPSHOT" "$INVENTORY_INDEX/current/admission-machines.json";;\n'
        ' invalid-credentials|native-exit-75) unset CLOUDBENCH_CAMPAIGN_INVENTORY_DIR; SNAPSHOT_LOOP_PID="";;\n'
        'esac\n'
        'fixture_fault=$2\n'
        'FLY() { touch "$FLEET_DIR/native-read"; [ "$fixture_fault" != native-exit-75 ] || return 75; return 1; }\n'
        + admission
        + 'enforce_app_capacity_guard() { touch "$FLEET_DIR/admitted"; }\n'
        + 'CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1\n'
        + 'fixture_mode=${3:-negative}\n'
        + 'sleep() { touch "$FLEET_DIR/pending-observed"; '
        'if [ "$fixture_mode" = recovery ]; then command sleep "$1"; '
        'else SECONDS=$((SECONDS + 300)); fi; }\n'
        + boundary
    )
    return script


def test_campaign_inventory_post_canary_valid_feed_admits_without_native_read(tmp_path):
    script = post_canary_boundary_subject(tmp_path)
    result = subprocess.run(
        ["bash", str(script), str(tmp_path), "none"], capture_output=True, text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "admitted").exists()
    assert not (tmp_path / "pending-observed").exists()
    assert not (tmp_path / "native-read").exists()


@pytest.mark.parametrize("fault", (
    "missing-health", "expired-health", "empty-health", "invalid-health", "wrong-token", "publisher-birth",
    "parent-birth", "wrong-app", "missing-owner", "missing-snapshot", "invalid-credentials", "native-exit-75",
))
def test_campaign_inventory_post_canary_unknown_or_invalid_feed_withholds_admission(tmp_path, fault):
    script = post_canary_boundary_subject(tmp_path)
    result = subprocess.run(
        ["bash", str(script), str(tmp_path), fault], capture_output=True, text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS,
    )
    assert result.returncode != 0, result.stdout + result.stderr
    assert not (tmp_path / "admitted").exists(), "unknown native inventory admitted mutation"
    assert (tmp_path / "pending-observed").exists() == (fault in {"missing-health", "expired-health", "missing-snapshot"})
    assert (tmp_path / "native-read").exists() == (fault in {"invalid-credentials", "native-exit-75"}), (
        "unavailable shared feed fanned out into a native provider request", result.stderr)


@pytest.mark.parametrize("shared", (True, False))
def test_campaign_inventory_post_canary_admission_wait_keeps_feed_and_standalone_reads(tmp_path, shared):
    result, calls, summary, _ = run_consumers(
        tmp_path, shared=shared, post_canary=True, admission_wait=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(job["controller_exit_code"] == 0 for job in summary["jobs"])
    assert len([call for call in calls if call["kind"] == "machines"]) == (2 if shared else 8)


@pytest.mark.parametrize("fault", ("missing-health", "expired-health"))
def test_campaign_inventory_post_canary_live_feed_recovers_before_admission(tmp_path, fault):
    script = post_canary_boundary_subject(tmp_path)
    process = subprocess.Popen(
        ["bash", str(script), str(tmp_path), fault, "recovery"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + FIXTURE_HOST_GUARD_SECONDS
        while not (tmp_path / "pending-observed").exists() and process.poll() is None:
            assert time.monotonic() < deadline, "fixture host guard"
            time.sleep(0.01)
        assert (tmp_path / "pending-observed").exists(), "temporary feed loss aborted before re-observation"
        assert not (tmp_path / "admitted").exists(), "unknown feed admitted mutation"
        assert not (tmp_path / "native-read").exists(), "missing feed fanned out to provider"
        health = tmp_path / "inventory/current/health"
        temporary = health.with_suffix(".tmp")
        temporary.write_text(f"publisher_token=fixture-token\nvalid_until={int(time.time()) + 120}\n")
        temporary.replace(health)
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert process.returncode == 0, stdout + stderr
        assert (tmp_path / "admitted").exists()
        assert not (tmp_path / "native-read").exists()
        assert "inventory temporarily unavailable" in stderr
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)


@pytest.mark.parametrize('fault', ['none', 'recovering', 'expired', 'foreign-volume', 'foreign-machine', 'multiple-mounts', 'boolean-size', 'malformed-json', 'foreign-token', 'missing-publisher', 'wrong-path'])
def test_campaign_inventory_warm_volume_read_uses_exact_fresh_feed(tmp_path, fault):
    """A lost native status response must not defeat the owned inventory feed."""
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    definitions = []
    for name in ['machine_config_exact_read', 'warm_source_volume_size_from_inventory', 'machine_volume_size_gb', 'admit_app_capacity_with_wait']:
        marker = name + '() {'
        if marker in source:
            start = source.index(marker)
            definitions.append(source[start:source.index('\n}\n', start) + 3])
    start = source.index('WARM_SOURCE_SIZE_GB="$(machine_volume_size_gb')
    warm_admission = source[start:source.index('\nWORKER_POOL_SNAPSHOT_SIZE_GB=', start)]
    inventory = tmp_path / 'inventory'
    (inventory / 'current').mkdir(parents=True)
    stat = Path(f'/proc/{os.getpid()}/stat').read_text()
    birth = f"proc-start:{Path('/proc/sys/kernel/random/boot_id').read_text().strip()}:{stat[stat.rfind(')') + 2:].split()[19]}"
    machines = [{'id': 'aaaaaaaaaaaaaa', 'config': {'mounts': [{'volume': 'vol_fixture', 'path': '/data', 'size_gb': 40}]}}]
    if fault == 'foreign-volume': machines[0]['config']['mounts'][0]['volume'] = 'vol_foreign'
    if fault == 'foreign-machine': machines[0]['id'] = 'bbbbbbbbbbbbbb'
    if fault == 'multiple-mounts': machines[0]['config']['mounts'] *= 2
    if fault == 'boolean-size': machines[0]['config']['mounts'][0]['size_gb'] = True
    if fault == 'wrong-path': machines[0]['config']['mounts'][0]['path'] = '/foreign'
    snapshot = tmp_path / 'machines.json'
    snapshot.write_text(json.dumps(machines))
    (inventory / 'current/admission-machines.json').write_text(json.dumps(machines))
    if fault == 'malformed-json':
        snapshot.write_text('{invalid')
        (inventory / 'current/admission-machines.json').write_text('{invalid')
    health = inventory / 'current/health'
    valid = f'publisher_token=fixture\nvalid_until={int(time.time()) + 60}\n'
    health.write_text('publisher_token=fixture\nvalid_until=1\n' if fault in ['recovering', 'expired'] else valid)
    if fault == 'foreign-token': health.write_text(valid.replace('publisher_token=fixture', 'publisher_token=foreign'))
    if fault == 'recovering':
        import threading
        updater = threading.Thread(target=lambda: (time.sleep(0.2), health.write_text(valid)))
        updater.start()
    subject = tmp_path / 'subject.sh'
    subject.write_text('set -uo pipefail\n'
        + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        + 'APP=fixture-app\nFLEET_DIR="' + str(tmp_path) + '"\n'
        + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh"))}\n'
        + 'FLY() { echo native-status-attempt >> "$FIXTURE_CALLS"; return 75; }\n'
        + 'enforce_app_capacity_guard() { return 0; }\n'
        + 'CAPACITY_ADMISSION_RETRYABLE=1\n'
        + 'WARM_ID=aaaaaaaaaaaaaa\nVOL_ID=vol_fixture\n'
        + '\n'.join(definitions)
        + '\nadmit_app_capacity_with_wait || exit 1\n'
        + ('CAPACITY_ADMISSION_DEADLINE=$SECONDS\n' if fault == 'expired' else '')
        + warm_admission + '\nprintf "%s\\n" "$WARM_SOURCE_SIZE_GB"\n')
    environment = os.environ.copy()
    environment.update(SNAPSHOT_LOOP_PID=str(os.getpid()), SNAPSHOT_LOOP_PID_START=birth,
        SNAPSHOT_LOOP_TOKEN='fixture', INVENTORY_INDEX=str(inventory), MACHINES_SNAPSHOT=str(snapshot),
        CLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS='1', FIXTURE_CALLS=str(tmp_path / 'native-calls'))
    if fault == 'missing-publisher': environment['SNAPSHOT_LOOP_PID'] = ''
    # The sourced inventory owns these paths, using this explicit private feed.
    environment['CLOUDBENCH_CAMPAIGN_INVENTORY_DIR'] = str(tmp_path)
    (tmp_path / 'inventory').mkdir(exist_ok=True)
    result = subprocess.run(['bash', str(subject)], env=environment, capture_output=True, text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS)
    if fault == 'recovering': updater.join()
    if fault in ['none', 'recovering']:
        assert result.returncode == 0 and result.stdout.strip() == '40', result.stdout + result.stderr
    else:
        assert result.returncode != 0, 'unknown or foreign warm volume evidence was admitted'
    assert not (tmp_path / 'native-calls').exists(), 'warm size read fanned out past the parent feed'



def test_campaign_inventory_stress_boot_slots_are_shared_across_independent_fleets(tmp_path):
    """Two actual owning shell subjects must share one provider update permit."""
    source = (ROOT / 'scripts/run-bench-cloud').read_text()
    acquire = source[source.index('acquire_boot_config_update_slot() {'):source.index('\nboot_update_with_capacity_recovery() {')]
    release_start = source.index('release_boot_config_update_slot() {')
    release = source[release_start:source.index('\n}\n', release_start) + 3]
    shared = tmp_path / 'inventory'
    (shared / 'inventory').mkdir(parents=True)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    stat = Path(f'/proc/{os.getpid()}/stat').read_text()
    birth = f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
    (shared / 'owner').write_text(f'app=fixture-app\npid={os.getpid()}\npid_start={birth}\ntoken=fixture\nparent_pid={os.getpid()}\nparent_start={birth}\n')
    stress_publish_generation(shared / 'inventory')
    (shared / 'machines.json').write_text('[]')
    subject = tmp_path / 'subject.sh'
    timeout_start = source.index('_with_timeout() {')
    timeout = source[timeout_start:source.index('\n}\n', timeout_start) + 3]
    event = tmp_path / 'event.py'
    event.write_text('import os,time\nwith open(os.environ["FIXTURE_EVENTS"],"a") as f: f.write(f"start {os.getpid()} {time.monotonic()}\\n")\ntime.sleep(0.4)\nwith open(os.environ["FIXTURE_EVENTS"],"a") as f: f.write(f"end {os.getpid()} {time.monotonic()}\\n")\n')
    subject.write_text('set -euo pipefail\n' + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n' + 'MUTATION_OWNER_PID_START="$(cloudbench_pid_start_time $$)"\nBOOT_CONFIG_UPDATE_SLOT=""\n' + acquire + '\n' + release + '\n' + timeout
        + '\nacquire_boot_config_update_slot\n' + f'_with_timeout 3 python3 {shlex.quote(str(event))}\n'
        + 'BOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=1\nrelease_boot_config_update_slot\n')
    processes = []
    for number in range(2):
        environment = os.environ.copy()
        environment.update(CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1', CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=str(shared),
            CLOUDBENCH_CAPACITY_RESERVATION_ROOT=str(tmp_path / 'capacity'), APP='fixture-app', ROOT_DIR=str(ROOT),
            CLOUDBENCH_RUNTIME_SCRIPT_ROOT=str(ROOT / 'scripts'), CLOUDBENCH_BOOT_CONFIG_BARRIER=str(tmp_path / f'fleet{number}'),
            CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT='1', CLOUDBENCH_BOOT_CONFIG_SLOT_WAIT_SECONDS='5', FIXTURE_EVENTS=str(tmp_path / 'events'))
        environment['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'] = json.dumps({'directory': str(shared.resolve()), 'owner': dict(line.split('=', 1) for line in (shared / 'owner').read_text().splitlines()), 'source': stress_source_binding()})
        processes.append(subprocess.Popen(['bash', str(subject)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
    for process in processes:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert process.returncode == 0, stdout + stderr
    # Campaign owners receive independent tracked leases (0873fc18c); only a
    # provider rate response imposes shared backoff. Both fleets must have
    # been admitted through the shared feed and joined/released their leases.
    active = 0
    events = (tmp_path / 'events').read_text().splitlines()
    for event in events:
        active += 1 if event.split()[0] == 'start' else -1
    assert len(events) == 4 and active == 0
    assert (tmp_path / 'capacity/campaign-native-mutations').is_dir()
    assert not list((tmp_path / 'capacity').rglob('lease-*.json'))



def stress_publish_generation(index, token='fixture', valid_until=None):
    """Publish one complete feed generation the way the inventory publisher does.

    The mutation admission reads `current` as an atomic symlink to a complete
    `.generation-*` directory whose health names that same generation.
    """
    generation = index / '.generation-fixture'
    generation.mkdir(parents=True, exist_ok=True)
    if not (generation / 'admission-machines.json').exists():
        (generation / 'admission-machines.json').write_text('[]')
    expiry = int(time.time()) + 120 if valid_until is None else valid_until
    (generation / 'health').write_text(f'publisher_token={token}\nvalid_until={expiry}\ngeneration={generation.name}\n')
    current = index / 'current'
    if not current.is_symlink():
        current.symlink_to(generation.name)


def stress_source_binding():
    import hashlib
    return {'ref': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
            'sha256': {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest()
                       for name in ['cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py', 'run-bench-campaign.py', 'cloudbench-port-lease.py', 'lib/cloudbench-env.sh']}}



def stress_mutation_feed(tmp_path):
    directory = tmp_path / 'inventory'
    (directory / 'inventory').mkdir(parents=True)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    stat = Path(f'/proc/{os.getpid()}/stat').read_text()
    birth = f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
    (directory / 'owner').write_text(f'app=fixture-app\npid={os.getpid()}\npid_start={birth}\ntoken=fixture\nparent_pid={os.getpid()}\nparent_start={birth}\n')
    stress_publish_generation(directory / 'inventory')
    (directory / 'machines.json').write_text('[]')
    environment = os.environ.copy()
    environment.update(CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION='1', CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=str(directory),
        CLOUDBENCH_CAPACITY_RESERVATION_ROOT=str(tmp_path / 'capacity'), APP='fixture-app', ROOT_DIR=str(ROOT))
    owner = dict(line.split('=', 1) for line in (directory / 'owner').read_text().splitlines())
    environment['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'] = json.dumps({'directory': str(directory.resolve()), 'owner': owner, 'source': stress_source_binding()})
    environment['CLOUDBENCH_MUTATION_CALLER_START'] = birth
    return environment, directory



def test_campaign_inventory_stress_create_dispatch_is_shared_and_retry_is_paced(tmp_path):
    """Independent real FLY wrappers and repeated calls share app CREATE pacing."""
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    start = source.index('FLY() {')
    if source[start:source.index('\n', start)].endswith('}'):
        definition = source[start:source.index('\n', start)]
    else:
        definition = source[start:source.index('\n}', start) + 3]
    subject = tmp_path / 'create.sh'
    subject.write_text('set -euo pipefail\n' + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-archived-reuse.sh"))}\n' + 'FLEET_OWNER_PID_START="$(cloudbench_pid_start_time $$)"\nclone_timeout=6\nprivate_source_allows_provider_call() { return 0; }\n'
        'flyctl() { python3 -c \'import os,time;open(os.environ["FIXTURE_EVENTS"],"a").write(str(time.monotonic())+"\\n")\'; }\n'
        + definition + '\nFLY machine clone source\nFLY machine clone source\n')
    environment, _ = stress_mutation_feed(tmp_path)
    environment['FIXTURE_EVENTS'] = str(tmp_path / 'events')
    # Healthy creates are admitted concurrently (8b608784f); only an actual
    # provider rate response paces every independent wrapper's CREATE. Sample
    # the clock before the backoff call: its retry-after window starts inside
    # that subprocess, so a later sample would charge process exit to the pace.
    published = time.monotonic()
    backoff = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-campaign-mutation.py'), 'backoff',
        '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'), '--owner-pid', str(os.getpid()),
        '--response-code', '429', '--retry-after', '1'], env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert backoff.returncode == 0, backoff.stderr
    processes = [subprocess.Popen(['bash', str(subject)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    for process in processes:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert process.returncode == 0, stdout + stderr
    times = sorted(float(line) for line in (tmp_path / 'events').read_text().splitlines())
    assert len(times) == 4
    assert times[0] - published >= 0.9, 'a shared provider rate response did not pace independent CREATE wrappers'
    assert not list((tmp_path / 'capacity').rglob('lease-*.json'))



@pytest.mark.parametrize('fault', ['foreign-token', 'foreign-parent-birth', 'malformed-inventory', 'missing-health', 'expired-health'])
def test_campaign_inventory_stress_mutation_unknown_feed_never_grants(tmp_path, fault):
    environment, directory = stress_mutation_feed(tmp_path)
    if fault == 'foreign-token':
        stress_publish_generation(directory / 'inventory', token='foreign')
    elif fault == 'foreign-parent-birth':
        owner = directory / 'owner'
        owner.write_text(owner.read_text().replace('parent_start=proc-start:', 'parent_start=foreign:'))
    elif fault == 'malformed-inventory':
        # Admission never parses provider JSON (the publisher validates it once);
        # an incompletely published generation snapshot is the unknown feed here.
        (directory / 'machines.json').write_text('{}')
        (directory / 'inventory/current/admission-machines.json').write_text('')
    elif fault == 'missing-health':
        (directory / 'inventory/current/health').unlink()
    else:
        stress_publish_generation(directory / 'inventory', valid_until=1)
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-campaign-mutation.py'), 'acquire',
        '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'), '--owner-pid', str(os.getpid()), '--wait-seconds', '1'],
        env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode != 0
    assert not list((tmp_path / 'capacity').rglob('lease-*.json'))



def stress_owned_actor(tmp_path, environment, *, launch=True):
    actor = tmp_path / 'owner-actor.py'
    actor.write_text("""import json,os,subprocess,sys
from pathlib import Path
stat=Path(f'/proc/{os.getpid()}/stat').read_text()
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
birth=f"proc-start:{boot}:{stat[stat.rfind(')')+2:].split()[19]}"
common=[sys.executable,sys.argv[1],'--app','fixture-app','--root',sys.argv[2],'--owner-pid',str(os.getpid()),'--owner-start',birth]
def call(action,extra):
 result=subprocess.run([common[0],common[1],action,*common[2:],*extra],capture_output=True,text=True,check=True)
 return result.stdout.strip()
token=call('acquire',['--slots','1','--wait-seconds','2'])
print(token,flush=True)
for command in sys.stdin:
 command=command.strip()
 if command=='join':
  for action in ['start-native','join-native']:call(action,['--lease',token,'--native-owner-pid',str(os.getpid())])
 elif command=='release':call('release',['--lease',token])
 else:raise ValueError('unknown actor request')
 print('ok',flush=True)
if os.environ.get('FIXTURE_PARENT_DEATH_RESULT'):
 result=subprocess.run([common[0],common[1],'start-native',*common[2:],'--lease',token,'--native-owner-pid',str(os.getpid())],capture_output=True,text=True)
 Path(os.environ['FIXTURE_PARENT_DEATH_RESULT']).write_text(json.dumps({'returncode':result.returncode}))
""")
    if not launch:
        return actor
    process = subprocess.Popen([sys.executable, str(actor), str(ROOT / 'scripts/cloudbench-campaign-mutation.py'), str(tmp_path / 'capacity')],
        env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    token = process.stdout.readline().strip()
    assert token, process.stderr.read()
    return process, token



def stress_actor_request(process, action):
    process.stdin.write(action + '\n')
    process.stdin.flush()
    assert process.stdout.readline().strip() == 'ok'



@pytest.mark.parametrize('owner_dies', [False, True])
def test_campaign_inventory_stress_update_lease_requires_exact_cleanup_owner(tmp_path, owner_dies):
    environment, _ = stress_mutation_feed(tmp_path)
    owner, token = stress_owned_actor(tmp_path, environment)
    helper = [sys.executable, str(ROOT / 'scripts/cloudbench-campaign-mutation.py')]
    common = ['--app', 'fixture-app', '--root', str(tmp_path / 'capacity')]
    try:
        lease = tmp_path / 'capacity/campaign-native-mutations' / f'lease-{token}.json'
        wrong_release = subprocess.run(helper + ['release', *common, '--owner-pid', str(os.getpid()), '--lease', token],
            env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert wrong_release.returncode != 0
        assert lease.exists()
        if owner_dies:
            owner.terminate()
            owner.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
        # Leases are independent (0873fc18c): another owner is admitted with
        # its own key and never reclaims or replaces this unjoined lease.
        original = lease.read_bytes()
        independent = subprocess.run(helper + ['acquire', *common, '--owner-pid', str(os.getpid()), '--slots', '1', '--wait-seconds', '1'],
            env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert independent.returncode == 0, independent.stderr
        assert independent.stdout.strip() != token
        assert lease.exists(), 'caller death cannot prove its native child stopped'
        assert lease.read_bytes() == original
        if not owner_dies:
            stress_actor_request(owner, 'join')
            stress_actor_request(owner, 'release')
            assert not lease.exists()
    finally:
        if owner.poll() is None:
            owner.terminate()
            owner.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)



def test_campaign_inventory_stress_native_wrapper_cancellation_joins_before_slot_release(tmp_path):
    """TERM of the real timeout wrapper cannot release while its child lives."""
    import signal

    source = (ROOT / 'scripts/run-bench-cloud').read_text()
    definitions = []
    for name in ['acquire_boot_config_update_slot', 'release_boot_config_update_slot', '_with_timeout']:
        start = source.index(name + '() {')
        definitions.append(source[start:source.index('\n}\n', start) + 3])
    native = tmp_path / 'native.py'
    native.write_text('import json,os,signal,time\nfrom pathlib import Path\n'
        'def close(*_):\n time.sleep(0.2)\n Path(os.environ["FIXTURE_CLOSED"]).touch()\n raise SystemExit(0)\n'
        'signal.signal(signal.SIGTERM,close)\nPath(os.environ["FIXTURE_READY"]).write_text(json.dumps({"pid":os.getpid(),"wrapper":os.getppid()}))\ntime.sleep(30)\n')
    subject = tmp_path / 'cancel.sh'
    subject.write_text('set -euo pipefail\n' + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n' + 'MUTATION_OWNER_PID_START="$(cloudbench_pid_start_time $$)"\nBOOT_CONFIG_UPDATE_SLOT=""\n' + '\n'.join(definitions)
        + '\nacquire_boot_config_update_slot\n' + f'rc=0; _with_timeout 3 python3 {shlex.quote(str(native))} || rc=$?\n'
        + 'test "$rc" = 143\nBOOT_CONFIG_UPDATE_SLOT_NATIVE_JOINED=1\nrelease_boot_config_update_slot\n')
    environment, _ = stress_mutation_feed(tmp_path)
    environment.update(CLOUDBENCH_RUNTIME_SCRIPT_ROOT=str(ROOT / 'scripts'), CLOUDBENCH_BOOT_CONFIG_BARRIER=str(tmp_path / 'fleet'),
        CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT='1', CLOUDBENCH_BOOT_CONFIG_SLOT_WAIT_SECONDS='5',
        FIXTURE_READY=str(tmp_path / 'ready'), FIXTURE_CLOSED=str(tmp_path / 'closed'))
    process = subprocess.Popen(['bash', str(subject)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / 'ready').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (tmp_path / 'ready').exists()
        ready = json.loads((tmp_path / 'ready').read_text())
        os.kill(ready['wrapper'], signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert process.returncode == 0, stdout + stderr
        assert (tmp_path / 'closed').exists()
        assert not list((tmp_path / 'capacity').rglob('lease-*.json'))
        with pytest.raises(ProcessLookupError):
            os.kill(ready['pid'], 0)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)



def test_campaign_inventory_stress_exact_joined_receipt_recovers_dead_owner_for_next_cohort(tmp_path):
    environment, _ = stress_mutation_feed(tmp_path)
    helper = [sys.executable, str(ROOT / 'scripts/cloudbench-campaign-mutation.py')]
    common = ['--app', 'fixture-app', '--root', str(tmp_path / 'capacity')]
    owner, old_token = stress_owned_actor(tmp_path, environment)
    try:
        stress_actor_request(owner, 'join')
        owner.terminate()
        owner.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
        next_cohort = subprocess.run(helper + ['acquire', *common, '--owner-pid', str(os.getpid()), '--slots', '1', '--wait-seconds', '2'],
            env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert next_cohort.returncode == 0, next_cohort.stderr
        new_token = next_cohort.stdout.strip()
        assert new_token and new_token != old_token
        assert (tmp_path / 'capacity/campaign-native-mutations' / f'lease-{new_token}.json').is_file()
    finally:
        if owner.poll() is None:
            owner.terminate()
            owner.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)



def test_campaign_inventory_stress_parent_dies_after_admission_withholds_native_start(tmp_path):
    environment, directory = stress_mutation_feed(tmp_path)
    environment['FIXTURE_PARENT_DEATH_RESULT'] = str(tmp_path / 'parent-death-result.json')
    actor = stress_owned_actor(tmp_path, environment, launch=False)
    parent_script = tmp_path / 'actual-parent.py'
    parent_script.write_text("""import json,os,subprocess,sys
from pathlib import Path
stat=Path(f'/proc/{os.getpid()}/stat').read_text()
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
print(json.dumps({'pid':os.getpid(),'birth':f"proc-start:{boot}:{stat[stat.rfind(')')+2:].split()[19]}"}),flush=True)
environment=os.environ.copy()
environment['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY']=sys.stdin.readline().strip()
actor=subprocess.Popen([sys.executable,*sys.argv[1:]],env=environment,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
print(actor.stdout.readline().strip(),flush=True)
for _ in sys.stdin:pass
""")
    parent = subprocess.Popen([sys.executable, str(parent_script), str(actor), str(ROOT / 'scripts/cloudbench-campaign-mutation.py'), str(tmp_path / 'capacity')],
        env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        identity = json.loads(parent.stdout.readline())
        owner = directory / 'owner'
        fields = dict(line.split('=', 1) for line in owner.read_text().splitlines())
        fields.update(parent_pid=str(identity['pid']), parent_start=identity['birth'])
        owner.write_text(''.join(f'{key}={value}\n' for key, value in fields.items()))
        parent.stdin.write(json.dumps({'directory': str(directory.resolve()), 'owner': fields, 'source': stress_source_binding()}) + '\n')
        parent.stdin.flush()
        token = parent.stdout.readline().strip()
        assert token
        parent.terminate()
        parent.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)
        deadline = time.monotonic() + 5
        while not (tmp_path / 'parent-death-result.json').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        result = json.loads((tmp_path / 'parent-death-result.json').read_text())
        assert result['returncode'] != 0
        record = json.loads((tmp_path / 'capacity/campaign-native-mutations' / f'lease-{token}.json').read_text())
        assert record['native_pid'] is None and record['joined'] is False
    finally:
        if parent.poll() is None:
            parent.terminate()
            parent.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)



@pytest.mark.parametrize('fault', ['entire-foreign-feed', 'reused-caller-birth'])
def test_campaign_inventory_stress_rejects_substituted_authority(tmp_path, fault):
    environment, directory = stress_mutation_feed(tmp_path)
    owner = dict(line.split('=', 1) for line in (directory / 'owner').read_text().splitlines())
    environment['CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'] = json.dumps({'directory': str(directory.resolve()), 'owner': owner, 'source': stress_source_binding()})
    environment['CLOUDBENCH_MUTATION_CALLER_START'] = owner['pid_start']
    if fault == 'entire-foreign-feed':
        foreign = tmp_path / 'foreign'
        shutil.copytree(directory, foreign, symlinks=True)
        (foreign / 'owner').write_text((foreign / 'owner').read_text().replace('token=fixture', 'token=foreign'))
        stress_publish_generation(foreign / 'inventory', token='foreign')
        environment['CLOUDBENCH_CAMPAIGN_INVENTORY_DIR'] = str(foreign)
    else:
        environment['CLOUDBENCH_MUTATION_CALLER_START'] = owner['pid_start'].rsplit(':', 1)[0] + ':1'
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-campaign-mutation.py'), 'acquire',
        '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'), '--owner-pid', str(os.getpid()), '--wait-seconds', '1'],
        env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode != 0, 'substituted authority granted a native mutation permit'
    assert not list((tmp_path / 'capacity').rglob('lease-*.json'))



def test_campaign_inventory_stress_parent_mints_exact_authority_for_both_controllers(tmp_path):
    result, _, summary, _ = run_consumers(tmp_path, mutation=True)
    assert result.returncode == 0, result.stdout + result.stderr
    first = json.loads((tmp_path / 'r001-j0001/authority.json').read_text())
    second = json.loads((tmp_path / 'r001-j0002/authority.json').read_text())
    assert first == second
    assert first['directory'] == summary['shared_inventory']['directory']
    assert first['owner']['app'] == 'navi-whisper-lux-bench'
    assert int(first['owner']['parent_pid']) > 1 and first['owner']['parent_start']


@pytest.mark.parametrize("error", ["KeyError", "CalledProcessError", "TimeoutExpired"])
def test_campaign_inventory_startup_authority_failure_takes_the_failed_campaign_path(tmp_path, monkeypatch, error):
    """A relay/authority startup error before any controller fails the campaign normally."""
    wrapper = tmp_path / "campaign-under-test.py"
    wrapper.write_text(
        "import importlib.util,os,subprocess,sys\n"
        f"spec=importlib.util.spec_from_file_location('campaign_under_test',{str(ROOT / 'scripts/run-bench-campaign.py')!r})\n"
        "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\n"
        "def refuse(*args,**kwargs):\n"
        " kind=os.environ['FIXTURE_AUTHORITY_ERROR']\n"
        " if kind=='KeyError':raise KeyError('Organization')\n"
        " if kind=='CalledProcessError':raise subprocess.CalledProcessError(128,['git','rev-parse','HEAD'])\n"
        " raise subprocess.TimeoutExpired(['flyctl','status'],30)\n"
        "module.mutation_inventory_authority=refuse\n"
        "sys.exit(module.main())\n")
    monkeypatch.setenv("CLOUDBENCH_CAMPAIGN_SCRIPT_UNDER_TEST", str(wrapper))
    monkeypatch.setenv("FIXTURE_AUTHORITY_ERROR", error)
    result, _, summary, _ = run_consumers(tmp_path, mutation=True)
    assert result.returncode != 0
    assert "Traceback" not in result.stderr, result.stderr
    assert "Campaign inventory did not initialize" in result.stdout
    assert summary["shared_inventory_failed"] is True
    assert summary["status"] == "failed" and summary["finished_at"]


def test_campaign_inventory_stress_rejects_live_nonancestor_as_original_caller(tmp_path):
    environment, _ = stress_mutation_feed(tmp_path)
    foreign = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        stat = Path(f'/proc/{foreign.pid}/stat').read_text()
        environment['CLOUDBENCH_MUTATION_CALLER_START'] = f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
        helper = os.environ.get('CLOUDBENCH_MUTATION_HELPER_UNDER_TEST', str(ROOT / 'scripts/cloudbench-campaign-mutation.py'))
        result = subprocess.run([sys.executable, helper, 'acquire', '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'),
            '--owner-pid', str(foreign.pid), '--wait-seconds', '1'], env=environment, capture_output=True, text=True,
            timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert result.returncode != 0, 'live unrelated PID was accepted as the original caller'
        assert not list((tmp_path / 'capacity').rglob('lease-*.json'))
    finally:
        foreign.terminate()
        foreign.wait(timeout=FIXTURE_HOST_GUARD_SECONDS)



def test_campaign_inventory_stress_changed_helper_bytes_are_rejected_before_admission(tmp_path):
    environment, _ = stress_mutation_feed(tmp_path)
    altered = tmp_path / 'altered-source'
    altered.mkdir()
    for name in ['cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py']:
        source = Path(os.environ.get('CLOUDBENCH_MUTATION_HELPER_UNDER_TEST', str(ROOT / 'scripts' / name))) if name == 'cloudbench-campaign-mutation.py' else ROOT / 'scripts' / name
        shutil.copyfile(source, altered / name)
    helper = altered / 'cloudbench-campaign-mutation.py'
    helper.write_bytes(helper.read_bytes() + b'\n# changed authority byte\n')
    result = subprocess.run([sys.executable, str(helper), 'acquire', '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'),
        '--owner-pid', str(os.getpid()), '--wait-seconds', '1'], env=environment, capture_output=True, text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode != 0
    assert not (tmp_path / 'capacity').exists(), 'changed executable allocated admission state before source verification'



def test_campaign_inventory_stress_helper_preserves_sealed_snapshot_bytes(tmp_path):
    environment, _ = stress_mutation_feed(tmp_path)
    sealed = tmp_path / 'sealed-snapshot'
    sealed.mkdir()
    names = ['cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py']
    for name in names:
        shutil.copyfile(ROOT / 'scripts' / name, sealed / name)
    result = subprocess.run([sys.executable, str(sealed / names[0]), 'acquire', '--app', 'fixture-app', '--root', str(tmp_path / 'capacity'),
        '--owner-pid', str(os.getpid()), '--wait-seconds', '1'], env=environment, capture_output=True, text=True,
        timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stderr
    assert sorted(path.name for path in sealed.iterdir()) == sorted(names), 'helper wrote into its sealed executable snapshot'



def test_campaign_inventory_stress_controller_rejects_entire_executable_substitution(tmp_path):
    source_path = Path(os.environ.get('CLOUDBENCH_MUTATION_FLEET_UNDER_TEST', str(ROOT / 'scripts/run-bench-fleet')))
    source = source_path.read_text()
    start = source.index('FLY() {')
    definition = source[start:source.index('\n}\n', start) + 3]
    altered = tmp_path / 'altered-source'
    altered.mkdir()
    (altered / 'cloudbench-campaign-mutation.py').write_text('import os\nfrom pathlib import Path\nPath(os.environ["FIXTURE_MUTATION"]).touch()\n')
    subject = tmp_path / 'substituted.sh'
    subject.write_text('set -euo pipefail\n' + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        + 'FLEET_OWNER_PID_START="$(cloudbench_pid_start_time $$)"\nclone_timeout=3\nprivate_source_allows_provider_call() { return 0; }\n'
        + 'flyctl() { touch "$FIXTURE_MUTATION"; }\n' + definition + '\nFLY machine clone source\n')
    environment, _ = stress_mutation_feed(tmp_path)
    environment.update(CLOUDBENCH_SCRIPT_SNAPSHOT=str(altered), FIXTURE_MUTATION=str(tmp_path / 'mutation'))
    result = subprocess.run(['bash', str(subject)], env=environment, capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode != 0, 'substituted executable ran before caller verified its bytes'
    assert not (tmp_path / 'mutation').exists()



def test_campaign_inventory_stress_parent_rejects_identity_before_interpretation(tmp_path):
    """An entire substituted identity module must not execute before rejection."""
    import importlib.util

    checkout = tmp_path / 'controller'
    names = ('run-bench-campaign.py', 'cloudbench-campaign-mutation.py',
             'cloudbench-script-snapshot.py', 'cloudbench-port-lease.py', 'lib/cloudbench-env.sh')
    for name in names:
        destination = checkout / 'scripts' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'scripts' / name, destination)
    for args in (['init', '-q'], ['add', 'scripts'],
                 ['-c', 'user.name=Offline fixture', '-c', 'user.email=fixture@invalid',
                  '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Exact controller fixture']):
        subprocess.run(['git', '-C', str(checkout), *args], check=True, capture_output=True)
    marker = tmp_path / 'interpreted-untrusted-identity'
    (checkout / 'scripts/cloudbench-port-lease.py').write_text(
        f'from pathlib import Path\nPath({str(marker)!r}).touch()\n')
    spec = importlib.util.spec_from_file_location('stress_parent_subject', checkout / 'scripts/run-bench-campaign.py')
    campaign = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(campaign)
    with pytest.raises(ValueError):
        campaign.mutation_inventory_authority(tmp_path / 'absent-owner', None)
    assert not marker.exists(), 'parent interpreted substituted identity before immutable source comparison'



@pytest.mark.parametrize('fault,expected', [('valid', 0), ('missing-health', 75), ('expired-health', 75), ('missing-snapshot', 75), ('wrong-token', 1), ('publisher-birth', 1), ('parent-birth', 1), ('wrong-app', 1), ('missing-owner', 1), ('malformed-snapshot', 1)])
def test_campaign_inventory_stress_worker_admission_uses_validated_parent_feed(tmp_path, fault, expected):
    """Actual worker admission may not fan out when its parent feed is unknown."""
    script = post_canary_boundary_subject(tmp_path)
    fleet = (ROOT / 'scripts/run-bench-fleet').read_text()
    boundary = fleet.split('fleet_infra_canary_preflight || exit $?\n', 1)[1].split('# ── Clone one machine per bench', 1)[0]
    body = script.read_text(); assert body.endswith(boundary)
    def function(name):
        start = fleet.index(name + '() {')
        return fleet[start:fleet.index('\n}\n', start) + 3]
    script.write_text(body[:-len(boundary)] + '\n' + '\n'.join(function(n) for n in (
        'fleet_pid_start_time', 'fleet_pid_matches_start', 'capacity_reserve_slots', 'reserve_worker_machine_slot')) + '''
FLEET_OWNER_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RUN_ID=fixture-run
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNERSHIP_ROOT="$FLEET_DIR/ownership"
CAPACITY_RESERVATION_ROOT="$FLEET_DIR/capacity"
CLOUDBENCH_APP_MACHINE_CEILING=1
status=0
start_machines_snapshot_loop || status=$?
if [ "$status" = 0 ] || [ "$status" = 75 ]; then
 status=0
 reserve_worker_machine_slot fixture-first || status=$?
fi
printf '%s' "$status" > "$FLEET_DIR/worker-status"
if [ "$status" = 0 ]; then
 status=0; reserve_worker_machine_slot fixture-second || status=$?
 test "$status" = 1
 test "$(find "$CAPACITY_RESERVATION_ROOT/reservations" -type f | wc -l)" = 1
else
 test ! -d "$CAPACITY_RESERVATION_ROOT/reservations" || test -z "$(ls -A "$CAPACITY_RESERVATION_ROOT/reservations")"
fi
''')
    if fault == 'malformed-snapshot':
        script.write_text(script.read_text()
            .replace('printf "[]" > "$MACHINES_SNAPSHOT"', 'printf "[42]" > "$MACHINES_SNAPSHOT"')
            .replace('printf "[]" > "$INVENTORY_INDEX/current/admission-machines.json"',
                     'printf "[42]" > "$INVENTORY_INDEX/current/admission-machines.json"'))
    result = subprocess.run(['bash', str(script), str(tmp_path), fault], capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stdout + result.stderr
    assert int((tmp_path / 'worker-status').read_text()) == expected
    assert not (tmp_path / 'native-read').exists(), 'worker admission fanned out into provider API'



def test_campaign_inventory_plans_native_wmh_guests_for_simulate_tasks(tmp_path):
    """Wide (sharded) runs plan capacity from the fleet's own shape functions. A
    catalog simulate task boots a performance-8x/64 GB guest for the native WMH;
    the planner must load the SIM selection and count it, never error or plan
    it as a 4 GB guest."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('stress_campaign_sim', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    rows = [{'name': 'raise-5m-rose-labs-brex', 'requires_browser_agent': False, 'world_model_mode': 'simulate'},
            {'name': 'plain-fixture', 'requires_browser_agent': False}]
    result = module.stress_default_requirements(ROOT, rows, peak=2, baseline=None)
    assert result['planned_performance_cpu_units'] == 8
    assert result['planned_shared_cpu_units'] == 2
    assert result['planned_memory_mib'] == 65536 + 4096


def test_campaign_inventory_stress_defaults_derive_actual_vm_profiles_and_withhold_unknown_capacity(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location('stress_campaign_defaults', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    rows = [{'name': 'browser-fixture', 'requires_browser_agent': True}, {'name': 'plain-fixture', 'requires_browser_agent': False}]
    result = module.stress_default_requirements(ROOT, rows, peak=2, baseline=None)
    assert result['planned_shared_cpu_units'] == 6
    assert result['planned_memory_mib'] == 12288
    assert result['local_shared_cpu_governor_minimum'] is None
    assert result['local_machine_ceiling_minimum'] is None
    assert result['admission'] == 'withheld-unknown-native-capacity'
    known_inventory = [{'id': 'existing', 'state': 'started', 'config': {'guest': {'cpu_kind': 'shared', 'cpus': 1}}}]
    result = module.stress_default_requirements(ROOT, rows, peak=2, baseline=known_inventory)
    assert result['local_shared_cpu_governor_minimum'] == 27  # actual6+baseline1+original20
    assert result['local_machine_ceiling_minimum'] == 33  # baseline1+twofresh+two replacements+28 bounded worker slots
    assert result['worker_slots'] == 'dynamically-serialized-under-global-ceiling'
    assert result['admission'] == 'local-defaults-derived-native-guards-required'

    env = module.stress_default_environment(result, {})
    assert env['CLOUDBENCH_SHARED_CPU_GOVERNOR'] == '160'
    assert env['CLOUDBENCH_APP_MACHINE_CEILING'] == '56'
    assert env['CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION'] == '1'
    assert module.stress_default_environment(result, {'CLOUDBENCH_APP_MACHINE_CEILING': '1'})['CLOUDBENCH_APP_MACHINE_CEILING'] == '1'
    with pytest.raises(ValueError, match='unknown native baseline'):
        module.stress_default_environment(module.stress_default_requirements(ROOT, rows, peak=2, baseline=None), {})



@pytest.mark.parametrize('fault,expected', [('valid', 0), ('missing-health', 75), ('expired-health', 75), ('foreign-owner', 1), ('wrong-health-token', 1), ('malformed-snapshot', 1)])
def test_campaign_inventory_stress_default_baseline_preserves_feed_authority(tmp_path, fault, expected):
    import importlib.util
    spec = importlib.util.spec_from_file_location('stress_default_feed', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    directory = tmp_path / 'feed'; (directory / 'inventory/current').mkdir(parents=True)
    birth = subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True).strip()
    fields = {'app': 'navi-whisper-lux-bench', 'pid': str(os.getpid()), 'pid_start': birth,
              'token': 'fixture-stress-defaults', 'parent_pid': str(os.getpid()), 'parent_start': birth}
    owner = directory / 'owner'; owner.write_text(''.join(k+'='+v+'\n' for k,v in fields.items()))
    health = directory / 'inventory/current/health'; health.write_text('publisher_token='+fields['token']+'\nvalid_until='+str(int(time.time())+120)+'\n')
    machines = directory / 'machines.json'; machines.write_text('[]')
    authority = json.dumps({'directory': str(directory), 'owner': fields})
    if fault == 'missing-health': health.unlink()
    if fault == 'expired-health': health.write_text('publisher_token='+fields['token']+'\nvalid_until=1\n')
    if fault == 'foreign-owner': owner.write_text(owner.read_text().replace(fields['token'], 'foreign'))
    if fault == 'wrong-health-token': health.write_text('publisher_token=foreign\nvalid_until='+str(int(time.time())+120)+'\n')
    if fault == 'malformed-snapshot': machines.write_text('{')
    if expected == 1:
        with pytest.raises(ValueError): module.stress_inventory_baseline(ROOT, authority)
    else:
        status, baseline = module.stress_inventory_baseline(ROOT, authority)
        assert status == expected
        assert baseline == ([] if expected == 0 else None)
    assert owner.exists() and not (directory / 'native-read').exists()



def test_campaign_inventory_stress_defaults_refuses_wrong_load_before_controller_dispatch(tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/run-bench-campaign.py'), '--root', str(tmp_path), '--runs', '3', '--concurrency', '2', '--task', 'demo-fleet-alpha', '--task', 'demo-fleet-beta', '--stress-defaults'], capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode != 0
    assert 'requires 200 distinct tasks' in result.stderr
    assert not (tmp_path / '.context').exists()



@pytest.mark.parametrize('baseline', [[{'id':'bad','state':'started','config':3}], [{'id':'bad','state':'started','config':{'guest':{'cpu_kind':'shared','cpus':True}}}], [{'id':'duplicate','state':'stopped'},{'id':'duplicate','state':'stopped'}]])
def test_campaign_inventory_stress_defaults_invalid_native_baseline_refuses(tmp_path, baseline):
    import importlib.util
    spec = importlib.util.spec_from_file_location('stress_invalid_baseline', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with pytest.raises(ValueError):
        module.stress_default_requirements(ROOT, [{'name':'plain-fixture','requires_browser_agent':False}], peak=1, baseline=baseline)



def test_campaign_inventory_stress_defaults_count_three_simultaneous_copies():
    import importlib.util
    spec = importlib.util.spec_from_file_location('stress600_defaults', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    rows = [{'name': 'browser-fixture', 'requires_browser_agent': True}, {'name': 'plain-fixture', 'requires_browser_agent': False}]
    baseline = [{'id': 'existing', 'state': 'started', 'config': {'guest': {'cpu_kind': 'shared', 'cpus': 1}}}]
    result = module.stress_default_requirements(ROOT, rows, peak=6, repetitions=3, baseline=baseline)
    assert result['planned_peak'] == 6
    assert result['planned_shared_cpu_units'] == 18
    assert result['planned_memory_mib'] == 36864
    assert result['disk_floor_mib'] == 6 * 288
    assert result['worker_reservation_slots'] == 84
    assert result['local_shared_cpu_governor_minimum'] == 39
    assert result['local_machine_ceiling_minimum'] == 97
    with pytest.raises(ValueError, match='invalid stress peak'):
        module.stress_default_requirements(ROOT, rows, peak=7, repetitions=3, baseline=None)
    with pytest.raises(ValueError, match='invalid stress repetitions'):
        module.stress_default_requirements(ROOT, rows, peak=6, repetitions=True, baseline=None)



def test_campaign_inventory_stress600_plan_cli_counts_actual_three_copies(monkeypatch, capsys):
    import importlib.util
    import types
    spec = importlib.util.spec_from_file_location('stress600_cli', ROOT / 'scripts/run-bench-campaign.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    rows = [{'name': f'fixture-{i}', 'requires_browser_agent': i < 185} for i in range(200)]
    catalog = types.ModuleType('cloudbench_catalog')
    catalog.get_task_metadata = lambda path, names: rows
    monkeypatch.setitem(sys.modules, 'cloudbench_catalog', catalog)
    monkeypatch.setattr(sys, 'argv', ['campaign', '--root', str(ROOT), '--concurrency', '600', '--runs', '3', '--stress-defaults', '--stress-defaults-plan', *[arg for row in rows for arg in ('--task', row['name'])]])
    assert module.main() == 2
    plan = json.loads(capsys.readouterr().out)
    assert plan['planned_peak'] == 600
    assert plan['planned_shared_cpu_units'] == 2310
    assert plan['planned_memory_mib'] == 4730880
    assert plan['disk_floor_mib'] == 172800
    assert plan['worker_reservation_slots'] == 8400
    assert plan['native_org_quota_proven'] is False
    assert plan['local_machine_ceiling_minimum'] is None


@pytest.mark.parametrize("fault", ["legacy", "deadline", "unknown", "bool", "nan", "infinite", "zero", "negative", "string", "null"])
def test_campaign_inventory_seed_manifest_accepts_only_declared_deadline(tmp_path, fault):
    import importlib.util
    spec = importlib.util.spec_from_file_location("seed_manifest_deadline", ROOT / "scripts/cloudbench-campaign-seed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    barrier = tmp_path / "c001"
    barrier.mkdir()
    value = {"cohort_id": "c001", "jobs": {"r001-j0001": None}}
    if fault == "unknown":
        value["foreign_deadline"] = 1
    elif fault != "legacy":
        value["e2e_deadline_monotonic"] = {"deadline": time.monotonic()+60, "bool": True, "nan": float("nan"), "infinite": float("inf"), "zero": 0, "negative": -1, "string": "60", "null": None}[fault]
    (barrier / "manifest.json").write_text(json.dumps(value))
    if fault in ("legacy", "deadline"):
        assert module.manifest(barrier) == value
    else:
        with pytest.raises(ValueError):
            module.manifest(barrier)


def test_campaign_inventory_seed_preflight_refuses_deadline_changed_during_get(tmp_path, monkeypatch):
    import fcntl
    root, module, server, thread, calls, _body = seed_fixture(tmp_path, monkeypatch)
    inventory = root / "campaign/shared-inventory"
    inventory.mkdir(parents=True)
    barrier = root / "campaign/startup-cohorts/c001"
    barrier.mkdir(parents=True)
    lock = (barrier.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    authority = {"app": "navi-whisper-lux-bench", "pid": str(os.getpid()), "pid_start": module.birth(os.getpid()), "token": "local-deadline-fixture", "parent_pid": str(os.getpid()), "parent_start": module.birth(os.getpid())}
    (inventory / "owner").write_text("".join(f"{k}={v}\n" for k,v in authority.items()))
    value = {"cohort_id": "c001", "jobs": {"fixture": os.getpid()}, "e2e_deadline_monotonic": time.monotonic()+60}
    path = barrier / "manifest.json"
    path.write_text(json.dumps(value))
    original_get = module.get
    def changed_get(*args, **kwargs):
        result = original_get(*args, **kwargs)
        value["e2e_deadline_monotonic"] += 1
        path.write_text(json.dumps(value))
        return result
    monkeypatch.setattr(module, "get", changed_get)
    try:
        with pytest.raises(ValueError, match="membership changed"):
            module.prepare(root, root / "scripts", inventory, barrier)
        assert len(calls) == 1 and calls[0][0] == "GET"
        assert not (barrier / "seed-proof.private.json").exists()
    finally:
        lock.close()
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("fault", ["legacy", "deadline", "unknown", "bool", "nan", "infinite", "zero", "negative", "string", "null", "member-pid", "foreign-member"])
@pytest.mark.parametrize("consumer", ["capture", "pending"])
def test_campaign_inventory_cleanup_manifest_declared_deadline(tmp_path, fault, consumer):
    import ast, fcntl, hashlib, math, re, stat
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    block = source[source.index("import errno\n", source.index("reserve_cleanup_disk_space()")):].split("\nPY\n", 1)[0]
    tree = ast.parse(block)
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    scope = dict(Path=Path, os=os, json=json, math=math, fcntl=fcntl, hashlib=hashlib, re=re, stat=stat, subprocess=subprocess)
    exec(compile(ast.Module(body=functions, type_ignores=[]), "actual-cleanup-allocator", "exec"), scope)
    cohort = tmp_path / "startup-cohorts/c001"
    cohort.mkdir(parents=True)
    lock = (cohort.parent / "parent.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    job = "r001-j0001"
    value = {"cohort_id": "c001", "jobs": {job: os.getpid()}}
    if fault == "unknown": value["foreign_deadline"] = 1
    elif fault not in ("legacy", "member-pid", "foreign-member"):
        value["e2e_deadline_monotonic"] = {"deadline": time.monotonic()+60, "bool": True, "nan": float("nan"), "infinite": float("inf"), "zero": 0, "negative": -1, "string": "60", "null": None}[fault]
    if fault == "member-pid": value["jobs"][job] = True
    if fault == "foreign-member": value["jobs"] = {"r001-j0002": os.getpid()}
    (cohort / "manifest.json").write_text(json.dumps(value))
    scope.update(cohort_path=str(cohort), cohort_id="c001", job=job, owner_pid=os.getpid(), path=tmp_path/"reserve", preferred=512, headroom=256, minimum=32)
    scope["birth_snapshot"], scope["parent_snapshot"] = scope["capture_processes"]()
    info = (cohort.parent / "parent.lock").stat()
    group = {"directory": str(cohort), "members": [job], "consumed": {}, "parent_lock_identity": [info.st_dev, info.st_ino]}
    try:
        invoke = (lambda: scope["capture_cohort"]()) if consumer == "capture" else (lambda: scope["pending_members"](group))
        if fault in ("legacy", "deadline"):
            result = invoke()
            assert (result[1]["members"] == [job]) if consumer == "capture" else result == 1
        else:
            with pytest.raises(ValueError): invoke()
    finally:
        lock.close()


@pytest.mark.parametrize("case", ["absent", "empty", "three-empty"])
def test_campaign_inventory_empty_pool_avoids_native_reads(tmp_path, case):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    def function(name):
        start = source.index(name+"() {")
        end = source.index("\n}\n", start)+3
        return source[start:end]
    common = tmp_path / "common"
    (common / "cloudbench-pools").mkdir(parents=True)
    ids = common / "cloudbench-pools/current.ids"
    if case != "absent": ids.write_text("")
    ledger = tmp_path / "native-reads"
    script = tmp_path / "owning.sh"
    script.write_text("set -uo pipefail\n" + f"GIT_COMMON_DIR={shlex.quote(str(common))}\nPOOL_IDS_FILE={shlex.quote(str(ids))}\nAPP=navi-whisper-lux-bench\nFLEET_PRIMARY_VM_SIZE=shared-cpu-2x\nFLEET_PRIMARY_VM_MEMORY=4096\nUNAVAILABLE_POOL_IDS=()\nPOOL_INVENTORY_JSON=''\nFLEET_DIR={shlex.quote(str(tmp_path))}\n" +
        "FLY() { printf 'native-read\\n' >> "+shlex.quote(str(ledger))+"; printf '[]\\n'; }\n" +
        function("reconcile_pool") + "\n" + function("normalize_current_pool_shape") + "\n" + function("pool_write_shape_hints") + "\n" +
        "for i in "+("1 2 3" if case == "three-empty" else "1")+"; do reconcile_pool || exit $?; normalize_current_pool_shape || exit $?; pool_write_shape_hints || exit $?; done\n")
    result = subprocess.run(["bash",str(script)],capture_output=True,text=True,timeout=10)
    assert result.returncode == 0, result.stdout+result.stderr
    assert not ledger.exists(), "empty local pool must not issue app-wide native inventory reads in each controller"


@pytest.mark.parametrize("case", ["noop", "stale-mutation", "pool-mutation", "unknown", "bad-feed", "standalone"])
def test_campaign_inventory_reconciliation_refresh_contract(tmp_path, case):
    source = (ROOT / "scripts/run-bench-fleet").read_text()
    start = source.index('# Recovery may have removed active machines.')
    end = source.index('# ── App-wide capacity guard', start)
    block = source[start:end]
    # Include the real capture dependency introduced by the admission wait
    # repair; a missing extracted function is fixture failure, not feed failure.
    for name in ('campaign_inventory_wait', 'campaign_inventory_capture_once', 'campaign_inventory_capture'):
        function_start = source.index(name + '() {')
        block = source[function_start:source.index('\n}\n', function_start) + 3] + '\n' + block
    events = tmp_path / "events"
    script = tmp_path / "caller.sh"
    flags = {"noop": ("0", "0"), "stale-mutation": ("1", "0"), "pool-mutation": ("0", "1"), "bad-feed": ("0", "0"), "standalone": ("1", "1")}
    assignments = ""
    if case in flags:
        a, b = flags[case]
        assignments = f"FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED={a}\nFLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED={b}\n"
    script.write_text("set -uo pipefail\nAPP=fixture-app\n" + assignments +
        "CLOUDBENCH_CAMPAIGN_INVENTORY_DIR=" + ("''" if case == "standalone" else "fixture") + "\n" +
        "machines_snapshot_identity() { printf original-generation; }\n" +
        "refresh_machines_snapshot_after() { printf 'refresh:%s\n' \"$1\" >> " + shlex.quote(str(events)) + "; return 75; }\n" +
        "fleet_admission_machines_json() { printf 'compact\n' >> " + shlex.quote(str(events)) + "; " + ("return 75;" if case == "bad-feed" else "printf '[]';") + " }\n" +
        "FLY() { printf 'native\n' >> " + shlex.quote(str(events)) + "; printf '[]'; }\n" + block + "\nprintf '%s' \"$warm_json\"\n")
    result = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=10)
    observed = events.read_text().splitlines()
    if case in ("stale-mutation", "pool-mutation", "unknown"):
        assert result.returncode == 1
        assert observed == ["refresh:original-generation"]
    elif case == "bad-feed":
        assert result.returncode == 1
        assert observed == ["compact"]
    else:
        assert result.returncode == 0, result.stderr
        assert observed == (["native"] if case == "standalone" else ["compact"])
        assert result.stdout == "[]"


@pytest.mark.parametrize('fault', ['healthy', 'wrong-token', 'expired-health', 'parent-birth', 'missing-compact'])
def test_campaign_inventory_pool_reconciliation_borrows_compact_owned_feed(tmp_path, fault):
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    def function(name):
        start = source.index(name+'() {')
        return source[start:source.index('\n}\n', start)+3]
    common = tmp_path / 'common'
    (common / 'cloudbench-pools').mkdir(parents=True)
    ids = common / 'cloudbench-pools/current.ids'
    ids.write_text('abc123\n')
    compact = [{'id':'abc123', 'state':'stopped', 'config':{'guest':{'cpu_kind':'shared','cpus':2,'memory_mb':4096}}}]
    script = tmp_path / 'pool.sh'
    script.write_text('set -uo pipefail\n' +
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n' +
        'FLEET_DIR="$1"; APP=fixture-app; FLEET_OWNER_HOST="$(hostname)"\nexport CLOUDBENCH_CAMPAIGN_INVENTORY_DIR="$FLEET_DIR"\n' +
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh"))}\n' +
        'mkdir -p "$INVENTORY_INDEX/current"\nbirth="$(inventory_pid_start_time $$)"\n' +
        'printf "app=%s\\npid=%s\\npid_start=%s\\ntoken=fixture-token\\nparent_pid=%s\\nparent_start=%s\\n" "$APP" "$$" "$birth" "$$" "$birth" > "$INVENTORY_HOME/owner"\n' +
        'printf "publisher_token=%s\\nvalid_until=%s\\n" '+ ('foreign' if fault == 'wrong-token' else 'fixture-token') + ' '+ ('1' if fault == 'expired-health' else '"$((INVENTORY_CLOCK_EPOCH+120))"') +' > "$INVENTORY_INDEX/current/health"\n' +
        'printf "%s" '+shlex.quote(json.dumps(compact))+' > "$INVENTORY_INDEX/current/admission-machines.json"\n' +
        ('rm "$INVENTORY_INDEX/current/admission-machines.json"\n' if fault == 'missing-compact' else '') +
        ('sed -i "s/^parent_start=.*/parent_start=foreign/" "$INVENTORY_HOME/owner"\n' if fault == 'parent-birth' else '') +
        f'GIT_COMMON_DIR={shlex.quote(str(common))}\nPOOL_IDS_FILE={shlex.quote(str(ids))}\nPOOL_CLAIMS_DIR="$FLEET_DIR/claims"\n' +
        'FLEET_PRIMARY_VM_SIZE=shared-cpu-2x\nFLEET_PRIMARY_VM_MEMORY=4096\nUNAVAILABLE_POOL_IDS=()\n' +
        # A temporarily unavailable borrowed feed is withheld within the
        # original admission deadline; this control uses a one-second deadline.
        'CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=1\nCLOUDBENCH_CAPACITY_ADMISSION_RETRY_SECONDS=1\n' +
        'FLY() { touch "$FLEET_DIR/native-read"; return 97; }\n' +
        '\n'.join(function(n) for n in ['campaign_inventory_wait','campaign_inventory_capture_once','campaign_inventory_capture','pool_machine_inventory_index','pool_machine_indexed_state','pool_machine_state_from_json','pool_machine_shape_from_json','reconcile_pool','normalize_current_pool_shape','pool_write_shape_hints']) +
        '\nreconcile_pool || exit $?\nnormalize_current_pool_shape || exit $?\npool_write_shape_hints || exit $?\n[ "$FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED" = 0 ]\n')
    result = subprocess.run(['bash',str(script),str(tmp_path)],capture_output=True,text=True,timeout=10)
    assert (result.returncode == 0) == (fault == 'healthy'), result.stdout+result.stderr
    assert not (tmp_path/'native-read').exists(), 'shared pool read must never fall back to native transport'
    if fault == 'healthy':
        assert (tmp_path/'pool-shapes.tsv').read_text() == 'abc123 shared 2 4096\n'


@pytest.mark.parametrize('case', ['absent', 'foreign', 'live', 'dead-recovery-refused', 'resize-refused'])
def test_campaign_inventory_reconciliation_mutation_flags_are_parent_owned(tmp_path, case):
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    def function(name):
        start = source.index(name+'() {')
        return source[start:source.index('\n}\n',start)+3]
    root = tmp_path/'owners'
    root.mkdir()
    registry = root/'old'
    if case not in ('absent','resize-refused'):
        registry.mkdir()
        (registry/'meta').write_text('version=2\napp=fixture-app\ncleanup_policy=reap\nhost='+('foreign' if case=='foreign' else 'fixture-host')+'\n')
    ids = tmp_path/'pool.ids'
    ids.write_text('abc123\n')
    script = tmp_path/'flags.sh'
    script.write_text('set -uo pipefail\n'+
        f'FLEET_OWNERSHIP_ROOT={shlex.quote(str(root))}\nFLEET_REGISTRY_DIR=own\nFLEET_OWNER_HOST=fixture-host\nAPP=fixture-app\nFLEET_DIR={shlex.quote(str(tmp_path))}\nPOOL_IDS_FILE={shlex.quote(str(ids))}\nGIT_COMMON_DIR={shlex.quote(str(tmp_path/"common"))}\n'+
        'registry_meta_value() { awk -F= -v k="$2" \'$1==k {print substr($0,length(k)+2);exit}\' "$1"; }\n'+
        'fleet_registry_cleanup_state() { printf reap; }\nregistry_owner_alive() { return '+('0' if case=='live' else '1')+'; }\n'+
        'release_cleanup_disk_reserve() { return 0; }\nacquire_registry_recovery_lock() { return 0; }\nrelease_registry_recovery_lock() { return 0; }\n'+
        'recover_registry_audit_only_fresh() { [ "$FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ] || exit 98; return 1; }\n'+
        function('reconcile_stale_fleet_registries_full')+'\n'+function('reconcile_stale_fleet_registries')+'\n'+function('pool_machine_shape_from_json')+'\n'+function('normalize_current_pool_shape')+'\n'+
        'FLEET_PRIMARY_VM_SIZE=shared-cpu-2x\nFLEET_PRIMARY_VM_MEMORY=4096\n'+
        "POOL_INVENTORY_JSON='[{\"id\":\"abc123\",\"state\":\"stopped\",\"config\":{\"guest\":{\"cpu_kind\":\"shared\",\"cpus\":1,\"memory_mb\":1024}}}]'\n"+
        'resize_pool_machine() { [ "$FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ] || exit 98; return 1; }\n'+
        ('normalize_current_pool_shape; status=$?; [ "$status" = 1 ] && [ "$FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ]\n' if case=='resize-refused' else
         'reconcile_stale_fleet_registries; status=$?; [ "$status" = '+('1' if case=='dead-recovery-refused' else '0')+' ] && [ "$FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED" = '+('1' if case=='dead-recovery-refused' else '0')+' ]\n'))
    result = subprocess.run(['bash',str(script)],capture_output=True,text=True,timeout=10)
    assert result.returncode == 0, result.stdout+result.stderr


@pytest.mark.parametrize('case', ['valid', 'provider', 'malformed', 'wrong-type', 'missing', 'foreign', 'bad-epoch', 'duplicate'])
def test_pinned_snapshot_epoch_distinguishes_unknown_from_absence(tmp_path, case):
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    start = source.index('snapshot_created_epoch() {')
    function = source[start:source.index('\n}\n', start)+3]
    row = {'id': 'vs_owned', 'created_at': '2026-10-13T15:06:27Z'}
    payload = [row]
    if case in ('missing', 'foreign'):
        payload = [] if case == 'missing' else [dict(row, id='vs_foreign')]
    elif case == 'bad-epoch':
        payload = [dict(row, created_at='invalid')]
    elif case == 'duplicate':
        payload = [row, row]
    elif case == 'wrong-type':
        payload = {'id': 'vs_owned'}
    body = 'return 75' if case == 'provider' else 'printf %s '+shlex.quote('invalid-json' if case == 'malformed' else json.dumps(payload))
    result = subprocess.run(['bash', '-c', 'set -uo pipefail\nAPP=fixture-app\nVOL_ID=vol_owned\nFLY() { '+body+'; }\n'+function+'\nsnapshot_created_epoch vs_owned\n'], capture_output=True, text=True, timeout=10)
    if case == 'valid':
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == '1791903987'
    else:
        assert result.returncode == (1 if case in ('missing', 'foreign') else 75), result.stdout+result.stderr
        assert not result.stdout.strip()
        assert 'snapshot epoch' in result.stderr
        assert 'invalid-json' not in result.stderr


@pytest.mark.parametrize('case', ['valid', 'stale', 'wrong-node', 'wrong-python', 'wrong-snapshot', 'provider', 'malformed', 'captured'])
def test_pinned_snapshot_preflight_refuses_uncertainty_without_maintenance(tmp_path, case):
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    def function(name):
        start = source.index(name+'() {')
        return source[start:source.index('\n}\n', start)+3]
    state = tmp_path/'receipt'
    state.write_text(('foreign' if case=='wrong-node' else 'node')+' '+('foreign' if case=='wrong-python' else 'python')+' 1791903927 '+('vs_foreign' if case=='wrong-snapshot' else 'vs_owned')+'\n')
    snapshots = json.dumps([{'id':'vs_owned','created_at':'2026-10-12T15:06:27Z' if case=='stale' else '2026-10-13T15:06:27Z'}])
    native = 'return 75' if case=='provider' else 'printf %s '+shlex.quote('invalid-json' if case=='malformed' else snapshots)
    setup = 'SNAPSHOTS_JSON='+shlex.quote(snapshots)+'\nHYDRATED_WARM_DEPS_STATE="$(cat "$WARM_DEPS_STATE_FILE")"\n' if case=='captured' else 'HYDRATED_WARM_DEPS_STATE=""\n'
    script = 'set -uo pipefail\nPRIVATE_SOURCE_FILE=""\nAPP=fixture\nVOL_ID=vol_owned\nSNAP_ID=vs_owned\nROOT_DIR=fixture\nBENCH_REF=fixture\nwarm_json="[]"\nCLOUDBENCH_WARM_DEPS_AUTOREFRESH=0\nCLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)\nWARM_DEPS_STATE_FILE='+shlex.quote(str(state))+'\n'+setup+'FLY() { '+native+'; }\ncloudbench_node_dependency_fingerprint() { printf node; }\ncloudbench_manifest_fingerprint() { printf python; }\ngit() { return 0; }\n'+ '\n'.join(function(n) for n in ['warm_deps_recorded_state','snapshot_created_epoch','warm_deps_preflight'])+'\nwarm_deps_preflight\n'
    result = subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10)
    assert (result.returncode==0)==(case in ('valid','captured')), result.stdout+result.stderr
    if case in ('provider','malformed'):
        assert 'freshness could not be verified' in result.stderr
        assert 'STALE' not in result.stderr
    elif case not in ('valid','captured'):
        assert 'STALE' in result.stderr


@pytest.mark.parametrize('case', ['valid','missing','missing-hash','wrong-hash','wrong-path','symlink','unsafe-mode','foreign-owner','malformed','wrong-type','duplicate-id','missing-id','oversize'])
def test_configured_snapshot_inventory_file_authority(tmp_path, case):
    import hashlib
    source=(ROOT/'scripts/run-bench-fleet').read_text()
    start=source.index('configured_warm_snapshot_inventory() {')
    function=source[start:source.index('\n}\n',start)+3]
    path=tmp_path/'cloudbench-warm-snapshot-inventory.fixture.json'
    data=b'[{"id":"vs_owned"}]'
    if case=='malformed': data=b'invalid-json'
    if case=='wrong-type': data=b'{}'
    if case=='duplicate-id': data=b'[{"id":"vs_owned"},{"id":"vs_owned"}]'
    if case=='missing-id': data=b'[{}]'
    if case=='oversize': data=b' '*(2097153)
    path.write_bytes(data);path.chmod(0o600)
    digest=hashlib.sha256(data).hexdigest()
    if case=='missing':path.unlink()
    if case=='missing-hash':digest=''
    if case=='wrong-hash':digest='0'*64
    if case=='wrong-path':path=tmp_path/'foreign.json';path.write_bytes(data);path.chmod(0o600)
    if case=='symlink':
        target=tmp_path/'target';path.rename(target);path.symlink_to(target)
    if case=='unsafe-mode':path.chmod(0o644)
    script='set -uo pipefail\nGIT_COMMON_DIR='+shlex.quote(str(tmp_path))+'\nMACHINE_NAME=fixture\nCLOUDBENCH_WARM_SNAPSHOT_INVENTORY_FILE='+shlex.quote(str(path))+'\nCLOUDBENCH_WARM_SNAPSHOT_INVENTORY_SHA256='+shlex.quote(digest)+'\n'+function+'\nconfigured_warm_snapshot_inventory\n'
    if case=='foreign-owner':
        script="python3() { shift 4; command python3 -I -S -B -c 'import os,sys;uid=os.geteuid();os.geteuid=lambda:uid+1;exec(compile(sys.stdin.read(),\"<owner-negative>\",\"exec\"))' \"$@\"; }\n"+script
    result=subprocess.run(['bash','-c',script],capture_output=True,timeout=10)
    assert (result.returncode==0)==(case=='valid'), result.stderr
    if case=='valid': assert result.stdout==data
    else: assert not result.stdout and b'configured snapshot inventory refused' in result.stderr


@pytest.mark.parametrize('case',['valid','foreign-mount','foreign-app','wrong-node','wrong-python','pin-mismatch','missing-snapshot','incomplete','stale'])
def test_configured_snapshot_inventory_uses_current_donor_proof(tmp_path, case):
    import hashlib
    source=(ROOT/'scripts/run-bench-fleet').read_text()
    def function(name):
        start=source.index(name+'() {');return source[start:source.index('\n}\n',start)+3]
    start=source.index('if { [ -n "${CLOUDBENCH_WARM_SNAPSHOT_INVENTORY_FILE:-}" ]')
    end=source.index('\nelse\n    # `|| echo', start)
    block=source[start:end]+'\nfi\n'
    node='1'*64;python='2'*64
    key='rose_cloudbench_deps_'+hashlib.sha256((node+'\0'+python).encode()).hexdigest()[:32]
    machine={'id':'warm','config':{'mounts':[{'volume':'vol_owned'}],'metadata':{key:node+' '+python+' 1791903927 vs_owned vol_owned warm fixture-app'}}}
    if case=='foreign-mount':machine['config']['mounts'][0]['volume']='vol_foreign'
    snaps=[{'id':'vs_owned','created_at':'2026-10-13T15:06:27Z','status':'created','size':100}]
    if case=='missing-snapshot':snaps=[]
    if case=='incomplete':snaps[0]['status']='running'
    if case=='stale':snaps[0]['created_at']='1970-01-01T00:00:01Z'
    path=tmp_path/'cloudbench-warm-snapshot-inventory.fixture.json';path.write_text(json.dumps(snaps));path.chmod(0o600)
    script='set -uo pipefail\nsource '+shlex.quote(str(ROOT/'scripts/lib/cloudbench-env.sh'))+'\nGIT_COMMON_DIR='+shlex.quote(str(tmp_path))+'\nMACHINE_NAME=fixture\nROOT_DIR=fixture\nAPP='+('foreign-app' if case=='foreign-app' else 'fixture-app')+'\nWARM_ID=warm\nVOL_ID=vol_owned\nCLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)\nCLOUDBENCH_SNAPSHOT_ID='+('vs_foreign' if case=='pin-mismatch' else 'vs_owned')+'\nCLOUDBENCH_WARM_SNAPSHOT_INVENTORY_FILE='+shlex.quote(str(path))+'\nCLOUDBENCH_WARM_SNAPSHOT_INVENTORY_SHA256='+hashlib.sha256(path.read_bytes()).hexdigest()+'\nwarm_json='+shlex.quote(json.dumps([machine]))+'\ncloudbench_node_dependency_fingerprint() { printf '+('0'*64 if case=='wrong-node' else node)+'; }\ncloudbench_manifest_fingerprint() { printf '+('0'*64 if case=='wrong-python' else python)+'; }\nFLY() { echo FORBIDDEN_NATIVE >&2; exit 99; }\n'+function('configured_warm_snapshot_inventory')+'\n'+block+'\nprintf "%s" "$HYDRATED_WARM_DEPS_STATE"\n'
    result=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10)
    assert (result.returncode==0)==(case=='valid'),result.stdout+result.stderr
    assert 'FORBIDDEN_NATIVE' not in result.stderr
    if case=='valid': assert result.stdout.endswith(node+' '+python+' 1791903927 vs_owned')

@pytest.mark.parametrize('field', ['storage_ready', 'storage_failed'])
@pytest.mark.parametrize('case,expected', [('true', 0), ('false', 1), ('stale', 75), ('invalid-owner', 2), ('missing-record', 75), ('malformed-value', 2)])
def test_campaign_inventory_storage_observation_keeps_unknown_distinct(tmp_path, field, case, expected):
    """A stale/missing feed is not a healthy native unready/failed-state verdict."""
    source_path = os.environ.get("CLOUDBENCH_STORAGE_OBSERVATION_SOURCE")
    source = Path(source_path).read_text() if source_path else producer_source(ROOT)
    names = ['machine_storage_observed_field', 'machine_storage_ready', 'machine_storage_failed']
    parts = []
    for name in names:
        marker = name + '() {'
        if marker in source:
            start = source.index(marker)
            parts.append(source[start:source.index('\n}\n', start)+3])
    health = {'stale': 75, 'invalid-owner': 1}.get(case, 0)
    value = '1' if case == 'true' else 'bad' if case == 'malformed-value' else '0'
    function = 'machine_storage_ready' if field == 'storage_ready' else 'machine_storage_failed'
    script = ('set -u\n'
              + 'inventory_index_healthy() { return '+str(health)+'; }\n'
              + 'inventory_machine_field() { '+('return 1' if case == 'missing-record' else 'printf %s '+shlex.quote(value))+'; }\n'
              + '\n'.join(parts)+'\n'+function+' owned-target\n')
    result = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
    assert result.returncode == expected, (case, result.returncode, result.stderr)
    assert result.stdout == ''

@pytest.mark.parametrize('observation', [0, 1, 75, 2])
def test_campaign_inventory_clone_deadline_reports_unavailable_separately(tmp_path, observation):
    """Exercise the actual clone wait body, preserving the same deadline and refusal."""
    source_path = Path(os.environ.get('CLOUDBENCH_STORAGE_WAIT_SOURCE', ROOT / 'scripts/run-bench-fleet'))
    source = source_path.read_text()
    start = source.index('            while :; do\n                storage_status=0') if '            while :; do\n                storage_status=0' in source else source.index('            while ! machine_storage_ready "$target_id"; do')
    end = source.index('            if [ -n "$target_id" ]; then', start)
    script = ('set -u\nSECONDS=10\nstorage_deadline=0\ntarget_id=owned-target\n'
              + 'diagnostic_log='+shlex.quote(str(tmp_path/'clone.log'))+'\n'
              + 'machine_storage_ready() { return '+str(observation)+'; }\n'
              + 'machine_storage_failed() { return '+str(observation if observation in (75,2) else 1)+'; }\n'
              + 'machines_snapshot_identity() { printf owned-generation; }\n'
              + 'run_wait() {\n'+source[start:end]+'\n}\nrun_wait\n')
    result = subprocess.run(['bash', '-c', script], capture_output=True, text=True)
    if observation == 0:
        assert result.returncode == 0, result.stderr
        assert result.stderr == ''
    else:
        assert result.returncode == 1, result.stderr
        if observation in (75,2):
            assert 'observation unavailable (status='+str(observation)+')' in result.stderr
            assert 'not mountable' not in result.stderr
            assert 'status='+str(observation) in (tmp_path/'clone.log').read_text()
        else:
            assert 'storage was not mountable' in result.stderr
            assert 'observation unavailable' not in result.stderr

@pytest.mark.parametrize('handler', ['inherited-parent', 'legitimate-child', 'legitimate-child-blocked'])
def test_campaign_inventory_timeout_preserves_real_handler_ownership(tmp_path, handler):
    """An inherited parent trap is not evidence that the native child owns it."""
    source = producer_source(ROOT)
    start = source.index('fly_with_timeout() {')
    function = source[start:source.index('\n}\n', start)+3]
    marker = tmp_path/'exit-owner'
    child = '' if handler == 'inherited-parent' else 'trap '+shlex.quote('printf "child\\n" >> '+shlex.quote(str(marker))+'; '+('sleep 2' if handler.endswith('blocked') else ':'))+' EXIT; '
    script = ('set -u\n'+function+'\n'
              + 'trap '+shlex.quote('printf "parent\\n" >> '+shlex.quote(str(marker)))+' EXIT\n'
              + 'FLY() { '+child+'printf "[]"; }\n'
              + 'fly_with_timeout 1 machines list -a fixture --json\n')
    result = subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10)
    assert result.returncode == (142 if handler.endswith('blocked') else 0), result.stderr
    assert result.stdout.startswith('[]')
    rows=marker.read_text().splitlines()
    assert rows.count('parent') == 1
    assert rows.count('child') == (0 if handler == 'inherited-parent' else 1)

@pytest.mark.parametrize('mode', ['success', 'nonzero-json', 'running', 'exit-handler', 'detached-writer', 'marker-collision', 'regular-marker-collision'])
def test_campaign_inventory_native_completion_evidence_preserves_eof_contract(tmp_path, mode):
    """A return marker diagnoses completion; it never substitutes for EOF/status."""
    source_path = os.environ.get('CLOUDBENCH_COMPLETION_SOURCE')
    source = Path(source_path).read_text() if source_path else producer_source(ROOT)
    start = source.index('fly_with_timeout() {')
    function = source[start:source.index('\n}\n', start)+3]
    command = {
        'success': 'printf "[]"',
        'nonzero-json': 'printf "[]"; return 9',
        'running': 'printf "[]"; sleep 2',
        'exit-handler': "trap 'sleep 2' EXIT; printf '[]'",
        'detached-writer': 'sleep 2 & printf "[]"',
        'marker-collision': 'printf "[]"',
        'regular-marker-collision': 'printf "[]"; sleep 2',
    }[mode]
    prefix = ''
    protected = tmp_path/'protected'
    if mode in ('marker-collision', 'regular-marker-collision'):
        output = tmp_path/'controlled-output'
        protected.write_text('UNCHANGED')
        if mode == 'marker-collision':
            Path(str(output)+'.started').symlink_to(protected)
            Path(str(output)+'.returned').symlink_to(protected)
        else:
            Path(str(output)+'.returned').write_text('0\n')
        prefix = 'mktemp() { printf "%s\\n" '+shlex.quote(str(output))+'; }\n'
    result = subprocess.run(['bash', '-c', 'set -u\n'+function+'\n'+prefix+'FLY() { '+command+'; }\nfly_with_timeout 1 machines list -a fixture --json\n'], capture_output=True, text=True, timeout=10)
    expected = 142 if mode in ('running','exit-handler','detached-writer','regular-marker-collision') else 9 if mode == 'nonzero-json' else 0
    assert result.returncode == expected, result.stderr
    assert result.stdout.startswith('[]')
    if expected == 142:
        assert 'FLY_COMPLETION_TIMEOUT' in result.stderr
        assert 'fly_return_status='+('unknown' if mode in ('running','regular-marker-collision') else '0') in result.stderr
        assert 'shell_pid=' in result.stderr and 'fifo_read_status=' in result.stderr
    else:
        assert 'FLY_COMPLETION_TIMEOUT' not in result.stderr
    if mode == 'marker-collision':
        assert protected.read_text() == 'UNCHANGED'


@pytest.mark.parametrize('child', ['term-ignored', 'term-handled-then-blocked'])
def test_campaign_inventory_timeout_reaps_native_child_that_survives_term(tmp_path, child):
    """A deadline must not return while its native child survives TERM.

    2026-10-18 shard-03: flyctl ssh console/sftp children (PIDs 755, 4721,
    18956) outlived their 20-second wrapper by more than 40 minutes with ppid 1.
    TERM to the wrapper subshell reparented them before the KILL escalation.
    """
    source = producer_source(ROOT)
    start = source.index('fly_with_timeout() {')
    function = source[start:source.index('\n}\n', start)+3]
    pidfile = tmp_path/'native.pid'
    body = {
        'term-ignored': 'trap "" TERM; echo $$ > "$1"; exec sleep 30',
        # Like flyctl: TERM cancels a context, but a blocked session read never observes it.
        'term-handled-then-blocked': 'trap "echo cancelled >&2" TERM; echo $$ > "$1"; while :; do sleep 0.2; done',
    }[child]
    script = ('set -u\n'+function+'\n'
              + 'FLY() { bash -c '+shlex.quote(body)+' native '+shlex.quote(str(pidfile))+'; }\n'
              + 'fly_with_timeout 1 ssh console -a fixture --machine worker -C true\n')
    started = time.monotonic()
    result = subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
    elapsed = time.monotonic() - started
    native_pid = int(pidfile.read_text())
    try:
        alive = True
        try:
            state = Path('/proc', str(native_pid), 'stat').read_text().rsplit(') ', 1)[1].split()[0]
            alive = state not in ('Z', 'X')
        except FileNotFoundError:
            alive = False
        assert not alive, 'native child outlived its fly_with_timeout deadline'
        assert result.returncode == 142, result.stderr
        assert 'FLY_COMPLETION_TIMEOUT' in result.stderr
        assert elapsed < 10, elapsed
    finally:
        try:
            os.kill(native_pid, 9)
        except ProcessLookupError:
            pass


def test_campaign_inventory_completion_evidence_preserves_fly_noclobber_for_exit(tmp_path):
    source = producer_source(ROOT)
    start = source.index('fly_with_timeout() {')
    function = source[start:source.index('\n}\n', start)+3]
    marker = tmp_path/'handler-flags'
    handler = 'printf "%s" "$-" > '+shlex.quote(str(marker))
    script = function+'\nFLY() { set -C; trap '+shlex.quote(handler)+' EXIT; printf "[]"; }\nfly_with_timeout 1 machines list\n'
    result = subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout == '[]'
    assert 'C' in marker.read_text()

@pytest.mark.parametrize('setting', [None, '0', '10', 'invalid', '', '5', '10.0', 'true', '-1', 'missing', 'unsupported', 'no-process-group', 'cancel10'])
def test_campaign_inventory_controller_priority_opt_in_keeps_launch_owner(tmp_path, setting):
    """Real campaign children change priority without moving parent or PID custody."""
    if not hasattr(os, 'getpriority') or os.getpriority(os.PRIO_PROCESS, 0) != 0:
        pytest.skip('actual nice0 parent required for the scheduling contract')
    scripts = tmp_path/'scripts';scripts.mkdir()
    child = tmp_path/'child.py'
    child.write_text('import os,json,time,signal,sys\nfrom pathlib import Path\nr=Path(os.environ["PRIORITY_FIXTURE"])\npid=os.getpid()\nbirth=None\ntry:\n s=Path("/proc",str(pid),"stat").read_text();birth=s[s.rfind(")")+2:].split()[19]\nexcept OSError:pass\n(r/"child.json").write_text(json.dumps({"pid":pid,"parent":os.getppid(),"nice":os.getpriority(os.PRIO_PROCESS,0),"parent_nice":os.getpriority(os.PRIO_PROCESS,os.getppid()),"birth":birth,"sid":os.getsid(0),"parent_sid":os.getsid(os.getppid()),"pgid":os.getpgrp(),"tty":os.isatty(0),"autogroup":Path("/proc/self/autogroup").read_text().split()[0] if Path("/proc/self/autogroup").is_file() else None,"parent_autogroup":Path("/proc",str(os.getppid()),"autogroup").read_text().split()[0] if Path("/proc",str(os.getppid()),"autogroup").is_file() else None,"argv":sys.argv[1:]}))\ndef stop(*args):\n (r/"child-term").write_text(str(pid));sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nif os.environ.get("PRIORITY_CANCEL")=="1":\n while True:time.sleep(.02)\n')
    (scripts/'run-bench').write_text('#!/bin/bash\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(child))+' "$@"\n')
    env={k:v for k,v in os.environ.items() if not k.startswith(('RUN_BENCH_CAMPAIGN_', 'BENCHMARK_HUB_', 'CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE'))}
    env.update(PRIORITY_FIXTURE=str(tmp_path), CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY='0', CLOUDBENCH_CHILD_TERM_SECONDS='1')
    if setting is not None:env['CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE']='10' if setting in ('missing','unsupported','no-process-group','cancel10') else setting
    if setting=='cancel10':env['PRIORITY_CANCEL']='1'
    launcher=tmp_path/'launcher.py'
    patch=''
    if setting=='missing':patch='shutil.which=lambda name:None\n'
    if setting=='unsupported':
        fake=tmp_path/'unsupported-nice';fake.write_text('#!/bin/bash\nexit 2\n');fake.chmod(0o700)
        patch='shutil.which=lambda name:'+repr(str(fake))+'\n'
    if setting=='no-process-group':patch='inspect.signature=lambda function:inspect.Signature()\n'
    source_path = os.environ.get('CLOUDBENCH_CONTROLLER_PRIORITY_SOURCE')
    execution = ('from pathlib import Path\nexec(compile(Path('+repr(source_path)+').read_text(),'+repr(str(ROOT/'scripts/run-bench-campaign.py'))+',"exec"),{"__name__":"__main__","__file__":'+repr(str(ROOT/'scripts/run-bench-campaign.py'))+'})\n') if source_path else 'runpy.run_path('+repr(str(ROOT/'scripts/run-bench-campaign.py'))+',run_name="__main__")\n'
    launcher.write_text('import shutil,runpy,inspect\n'+patch+execution)
    command=[sys.executable,str(launcher),'--root',str(tmp_path),'--runs','1','--concurrency','1','--task','owned','--e2e-timeout','30']
    with (tmp_path/'stdout').open('w') as out, (tmp_path/'stderr').open('w') as err:
        process=subprocess.Popen(command,env=env,stdout=out,stderr=err)
        try:
            if setting=='cancel10':
                deadline=time.monotonic()+10
                while not (tmp_path/'child.json').exists() and time.monotonic()<deadline and process.poll() is None:time.sleep(.02)
                assert (tmp_path/'child.json').is_file(), (tmp_path/'stderr').read_text()
                process.terminate()
            process.wait(timeout=15)
        finally:
            if process.poll() is None:process.terminate();process.wait(timeout=5)
    if setting in ('invalid','','5','10.0','true','-1','missing','unsupported','no-process-group'):
        assert process.returncode!=0
        assert not (tmp_path/'child.json').exists()
        assert not (tmp_path/'.context/benchmarks/campaigns').exists()
    else:
        actual=json.loads((tmp_path/'child.json').read_text())
        assert actual['nice']==(10 if setting in ('10','cancel10') else 0)
        assert actual['parent']==process.pid and actual['parent_nice']==0
        assert actual['sid']==(actual['parent_sid'] if setting in ('10','cancel10') else actual['pid'])
        assert actual['pgid']==actual['pid'] and actual['tty'] is False
        if actual['autogroup'] is not None and actual['parent_autogroup'] is not None:
            assert (actual['autogroup']==actual['parent_autogroup']) == (setting in ('10','cancel10'))
        assert actual['argv']==['owned','--foreground']
        summary=json.loads(next((tmp_path/'.context/benchmarks/campaigns').glob('*/summary.json')).read_text())
        job=summary['jobs'][0]
        assert job['controller_pid']==actual['pid']
        if sys.platform.startswith('linux'):assert actual['birth'] is not None
        if setting=='cancel10':assert (tmp_path/'child-term').read_text()==str(actual['pid'])



def test_campaign_inventory_shared_session_cancel_keeps_other_groups(tmp_path):
    """The real killpg path drains one tree without touching its shared SID peers."""
    import importlib.util
    import inspect
    import signal

    if 'process_group' not in inspect.signature(subprocess.Popen).parameters:
        pytest.skip('process_group is unavailable')
    spec = importlib.util.spec_from_file_location('campaign_cancel', ROOT/'scripts/run-bench-campaign.py')
    campaign = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(campaign)
    child = tmp_path/'group-child.py'
    child.write_text(r'''
import json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1]);name=sys.argv[2];role=sys.argv[3]
owned=None
if role=='leader':
    owned=subprocess.Popen([sys.executable,__file__,str(root),name+'-grandchild','leaf'],close_fds=True)
    until=time.monotonic()+5
    while not (root/(name+'-grandchild.ready')).exists():
        if time.monotonic()>until:raise RuntimeError('grandchild readiness')
        time.sleep(.01)
def stop(*args):
    if owned is not None:owned.wait(timeout=5)
    (root/(name+'.term')).write_text(str(os.getpid()))
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
s=Path('/proc',str(os.getpid()),'stat').read_text()
(root/(name+'.ready')).write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'sid':os.getsid(0),'birth':s[s.rfind(')')+2:].split()[19]}))
while True:time.sleep(.02)
''')
    before = (os.getpid(), os.getsid(0), os.getpgrp())
    processes = []
    try:
        for name, role in [('first','leader'), ('sibling','leader'), ('publisher','leaf')]:
            command = [sys.executable, str(child), str(tmp_path), name, role]
            if name != 'publisher':command = [shutil.which('nice'), '-n', '10', *command]
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, process_group=0, close_fds=True)
            processes.append((name, process))
        until = time.monotonic()+8
        while not all((tmp_path/(name+'.ready')).exists() for name, _ in processes):
            assert time.monotonic()<until
            assert all(process.poll() is None for _, process in processes)
            time.sleep(.01)
        rows = {name:json.loads((tmp_path/(name+'.ready')).read_text()) for name, _ in processes}
        for name, process in processes:
            assert rows[name]['pid']==rows[name]['pgid']==process.pid
            assert rows[name]['sid']==before[1]
        first = processes[0][1]
        campaign.terminate_owned_children({first.pid:{'_process':first}})
        assert first.wait(timeout=5)==0
        assert (tmp_path/'first.term').read_text()==str(first.pid)
        grandchild = json.loads((tmp_path/'first-grandchild.ready').read_text())
        assert grandchild['pgid']==first.pid and grandchild['sid']==before[1]
        assert (tmp_path/'first-grandchild.term').read_text()==str(grandchild['pid'])
        with pytest.raises(ProcessLookupError):os.killpg(first.pid, 0)
        assert before==(os.getpid(), os.getsid(0), os.getpgrp())
        for name, process in processes[1:]:
            assert process.poll() is None and not (tmp_path/(name+'.term')).exists()
            current = Path('/proc',str(process.pid),'stat').read_text()
            assert current[current.rfind(')')+2:].split()[19]==rows[name]['birth']
        assert not (tmp_path/'sibling-grandchild.term').exists()
    finally:
        active = {process.pid:{'_process':process} for _, process in processes if process.poll() is None}
        campaign.terminate_owned_children(active)
        for _, process in processes:process.wait(timeout=5)
    for name in ('sibling', 'sibling-grandchild', 'publisher'):
        assert (tmp_path/(name+'.term')).exists()
    for _, process in processes:
        with pytest.raises(ProcessLookupError):os.killpg(process.pid, 0)


@pytest.mark.parametrize("mode", ["success", "machines-nonzero-json", "volumes-nonzero-json", "malformed-json"])
def test_campaign_inventory_cli_analytics_scoped_to_shared_reads(tmp_path, mode):
    """Only CLI analytics changes; real wrapper/status/JSON publication stay fail closed."""
    trace = tmp_path / "trace"
    script = (
        "set -u\nFLEET_DIR=" + shlex.quote(str(tmp_path))
        + "\nROOT_DIR=" + shlex.quote(str(ROOT)) + "\nAPP=fixture\n"
        + "source " + shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh")) + "\n"
        + "source " + shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh")) + "\n"
        + "MACHINE_READINESS_SCRIPT=" + shlex.quote(str(ROOT / "scripts/cloudbench-machine-readiness.py")) + "\n"
        + "export FLY_SEND_METRICS=1\n"
        + "FLY() { printf '%s %s\\n' \"$1\" \"${FLY_SEND_METRICS-unset}\" >> " + shlex.quote(str(trace)) + "; "
        + ("printf 'broken'; return 0; " if mode == "malformed-json" else "printf '[]'; ")
        + ("[ \"$1\" != machines ] || return 9; " if mode == "machines-nonzero-json" else "")
        + ("[ \"$1\" != volumes ] || return 8; " if mode == "volumes-nonzero-json" else "")
        + "return 0; }\n"
        + "status=0; _refresh_inventory_snapshot_unlocked || status=$?\n"
        + 'printf "parent_metrics=%s\\n" "$FLY_SEND_METRICS"\nexit "$status"\n'
    )
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)
    rows = trace.read_text().splitlines()
    assert rows == (["machines 0"] if mode == "machines-nonzero-json" else ["machines 0", "volumes 0"])
    assert result.stdout.strip() == "parent_metrics=1"
    assert result.returncode == (0 if mode == "success" else 1), result.stderr
    assert (tmp_path / "machines.json").exists() == (mode == "success")
    assert (tmp_path / "volumes.json").exists() == (mode == "success")
    if mode.endswith("nonzero-json"):
        assert not (tmp_path / "inventory" / "current").exists()

@pytest.mark.parametrize('case', ('ok', '401', '429', '500', '206', 'redirect', 'empty', 'object', 'truncated', 'trailing', 'duplicate', 'bad-guest', 'bad-init', 'trickle', 'oversize', 'late-owner', 'gzip-ok', 'gzip-truncated', 'gzip-crc', 'gzip-unknown', 'gzip-trailing', 'gzip-throttled'))
def test_campaign_inventory_full_http_transaction(tmp_path, case):
    """Exercise the actual publisher dispatch, full refresh, index and original deadline."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    machine = {'id': 'm1', 'name': 'clone', 'state': 'created', 'region': 'iad',
               'instance_id': 'instance1', 'private_ip': 'fdaa::1',
               'config': {'guest': {'cpus': 2, 'memory_mb': 2048, 'cpu_kind': 'shared'},
                          'mounts': [{'volume': 'v1', 'path': '/data', 'size_gb': 40}],
                          'init': {'cmd': ['sleep', 'infinity']}, 'metadata': {'owner': 'fixture'},
                          'env': {'PRIVATE_FIXTURE': 'not-a-real-secret'}, 'files': []},
               'checks': [{'name': 'bg_deployments_compat_x'}, {'name': 'keep'}]}
    events = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            events.append((self.path, self.headers.get('Authorization')))
            status = int(case) if case.isdigit() else 302 if case == 'redirect' else 200
            value = [machine, machine] if case == 'duplicate' else [machine]
            if case == 'bad-guest': machine['config']['guest']['cpus'] = True
            if case == 'bad-init': machine['config']['init']['cmd'] = 'sleep'
            if case == 'gzip-throttled':
                machine['config']['files'] = [{'guest_path': '/tmp/fixture', 'raw_value': 'x' * 1048576}]
            payload = json.dumps(value).encode()
            encoding = None
            if case.startswith('gzip-') and (case != 'gzip-throttled' or self.headers.get('Accept-Encoding') == 'gzip'):
                import gzip
                payload = gzip.compress(payload)
                encoding = 'br' if case == 'gzip-unknown' else 'gzip'
                if case == 'gzip-truncated': payload = payload[:-5]
                if case == 'gzip-trailing': payload += b'not-another-response'
                if case == 'gzip-crc': payload = payload[:-8] + bytes([payload[-8] ^ 1]) + payload[-7:]
            if case == 'empty': payload = b''
            if case == 'object': payload = b'{}'
            if case == 'truncated': payload = b'[{'
            if case == 'trailing': payload += b'{}'
            self.send_response(status)
            if status == 302: self.send_header('Location', 'http://127.0.0.1:9/forbidden')
            if encoding: self.send_header('Content-Encoding', encoding)
            self.send_header('Content-Length', str(268435457 if case == 'oversize' else len(payload)))
            self.end_headers()
            try:
                if case == 'gzip-throttled':
                    for offset in range(0, len(payload), 16384):
                        self.wfile.write(payload[offset:offset+16384]); self.wfile.flush(); time.sleep(.04)
                elif case == 'trickle':
                    for b in payload:
                        self.wfile.write(bytes([b])); self.wfile.flush(); time.sleep(.04)
                else: self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError): pass
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever); thread.start()
    bindir = tmp_path/'bin'; bindir.mkdir()
    cli = bindir/'flyctl'
    cli.write_text('#!/bin/bash\n[ "$1 $2" = "volumes list" ] || exit 91\nprintf \'[{"id":"v1","state":"created"}]\\n\'\n')
    cli.chmod(0o755)
    root = ROOT
    source = (root/'scripts/cloudbench-campaign-inventory.sh').read_text()
    dispatch = source[source.index('FLY() {'):source.index('\nSNAPSHOT_LOOP_PID=')]
    work = tmp_path/'inventory'; work.mkdir()
    lock = tmp_path/'publish.lock'; lock.write_text('token=actual\n')
    shell = ('source '+shlex.quote(str(root/'scripts/lib/cloudbench-inventory.sh'))+'\n'+dispatch+
             '\n_refresh_inventory_snapshot_unlocked\n')
    env = dict(os.environ, PATH=str(bindir)+':'+os.environ['PATH'], APP='fixture',
               SOURCE=str(root/'scripts'), FLEET_DIR=str(work),
               MACHINE_READINESS_SCRIPT=str(root/'scripts/cloudbench-machine-readiness.py'),
               FLY_API_TOKEN='offline-oauth', FLY_FLAPS_BASE_URL=f'http://127.0.0.1:{server.server_port}',
               FLY_API_HOSTNAME='https://wrong-endpoint.invalid', CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS='1')
    if case == 'late-owner':
        env.update(CLOUDBENCH_INVENTORY_REFRESH_LOCK=str(lock), CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN='foreign')
    started = time.monotonic()
    try:
        result = subprocess.run(['bash', '-c', shell], env=env, capture_output=True, timeout=8)
    finally:
        server.shutdown(); server.server_close(); thread.join()
    assert events == [('/v1/apps/fixture/machines', 'Bearer offline-oauth')]
    assert time.monotonic()-started < 8
    if case in ('ok', 'gzip-ok', 'gzip-throttled'):
        assert result.returncode == 0, result.stderr.decode()
        assert (work/'inventory/current/machines/m1').is_file()
        assert b'storage_ready=1' in (work/'inventory/current/machines/m1').read_bytes()
        assert json.loads((work/'machines.json').read_text())[0]['checks'] == [{'name': 'keep'}]
    else:
        assert result.returncode != 0
        assert not (work/'inventory/current').exists()


def test_campaign_inventory_full_http_pinned_cli_consumers(tmp_path):
    """The real pinned CLI and new full GET yield the same actual keyed/admission consumers."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    cli = Path('/home/boxes/.fly/bin/flyctl')
    if not cli.is_file(): pytest.skip('pinned offline CLI absent')
    import hashlib
    assert hashlib.sha256(cli.read_bytes()).hexdigest() == '5041b9a563fff170fda4238b47048e9a5e714fc7ed2304668fd44bcdcd3bef83'
    data = [{'id': 'm1', 'name': 'clone', 'state': 'created', 'region': 'iad', 'instance_id': 'v1', 'private_ip': 'fdaa::1',
             'config': {'guest': {'cpus': 2, 'memory_mb': 2048, 'cpu_kind': 'shared'}, 'init': {'cmd': ['sleep', 'infinity']},
                        'mounts': [{'volume': 'vol1', 'path': '/data', 'size_gb': 40}], 'metadata': {'fingerprint': 'abc'}, 'env': {'X': 'fixture'}, 'files': []},
             'checks': [{'name': 'bg_deployments_compat'}, {'name': 'bg_deployments_compat_xyz'}, {'name': 'xbg_deployments_compat'}, {'name': 'BG_DEPLOYMENTS_COMPAT'}]},
            {'id': 'm2', 'name': 'unreachable', 'state': 'stopped', 'config': None, 'host_status': 'unreachable'}]
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(data).encode(); self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def log_message(self,*_): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),H);thread=threading.Thread(target=server.serve_forever);thread.start()
    env=dict(os.environ, FLY_FLAPS_BASE_URL=f'http://127.0.0.1:{server.server_port}', FLY_API_TOKEN='offline-oauth', FLY_CONFIG_DIR=str(tmp_path),HOME=str(tmp_path),FLY_SEND_METRICS='0',FLY_NO_UPDATE_CHECK='1',CI='1',HTTP_PROXY='http://127.0.0.1:9',HTTPS_PROXY='http://127.0.0.1:9',NO_PROXY='127.0.0.1')
    (tmp_path/'config.yml').write_text('send_metrics: false\nauto_update: false\n')
    try:
        old=subprocess.run([str(cli),'machines','list','-a','fixture','--json'],env=env,capture_output=True,timeout=8)
        new=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-campaign-machines.py'),'fixture','3'],env=env,capture_output=True,timeout=8)
    finally: server.shutdown();server.server_close();thread.join()
    assert old.returncode==new.returncode==0,(old.stderr,new.stderr)
    readiness=ROOT/'scripts/cloudbench-machine-readiness.py'
    volumes=tmp_path/'volumes';volumes.write_text('[{"id":"vol1","state":"created"}]')
    roots=[]
    for name,raw in [('old',old.stdout),('new',new.stdout)]:
        path=tmp_path/name;path.write_bytes(raw);index=tmp_path/(name+'-index')
        subprocess.run([sys.executable,str(readiness),'--publish-index',str(path),str(volumes),str(index)],check=True,capture_output=True)
        roots.append(index/'current')
    for relative in ['machines/m1','machines/m2','names/clone','names/unreachable']:
        assert (roots[0]/relative).read_bytes()==(roots[1]/relative).read_bytes(),relative

    # Go adds unrelated zero/default fields. Compare every field consumed by
    # warm/source/shape/ownership readers, rather than inventing byte identity.
    def consumed(row):
        config = row.get('config') or {}
        return ({k: row.get(k) or '' for k in ('id','name','state','region','instance_id','private_ip')},
                {k: config.get(k) or {} for k in ('guest','init','metadata','env')},
                config.get('mounts') or [], [x.get('name','') for x in row.get('checks') or []])
    assert [consumed(x) for x in json.loads(old.stdout)] == [consumed(x) for x in json.loads(new.stdout)]


@pytest.mark.parametrize('token,refreshed,expected', (
    ('oauth', None, 'Bearer oauth'),
    ('bEaReR oauth1, oauth2', None, 'Bearer oauth1,oauth2'),
    ('FlyV1 Bearer oauth', None, 'Bearer oauth'),
    ('oauth,fm2_fixture', 'oauth,fm2_refreshed', 'FlyV1 fm2_refreshed'),
    ('fm1r_fixture,oauth', 'fm1a_a,fm2_b,oauth', 'FlyV1 fm1a_a,fm2_b'),
    ('fm2_fixture', '', None),
    ('', None, None),
))
def test_campaign_inventory_full_http_auth(tmp_path, monkeypatch, token, refreshed, expected):
    import importlib.util
    spec=importlib.util.spec_from_file_location('inventory_full_http',ROOT/'scripts/cloudbench-campaign-machines.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    cli=tmp_path/'flyctl';called=tmp_path/'called'
    cli.write_text('#!/bin/bash\nprintf called > '+shlex.quote(str(called))+'\nprintf %s '+shlex.quote(json.dumps({'token':refreshed}))+'\n')
    cli.chmod(0o755);monkeypatch.setenv('PATH',str(tmp_path)+':'+os.environ['PATH'])
    if expected is None:
        with pytest.raises(module.Refusal):module.authorization(token,time.monotonic()+2)
    else:assert module.authorization(token,time.monotonic()+2)==expected
    assert called.exists() == (refreshed is not None)

@pytest.mark.parametrize('cancel', (False, True))
def test_campaign_inventory_full_http_auth_deadline_and_owned_join(tmp_path, cancel):
    pidfile=tmp_path/'auth.pid';cli=tmp_path/'flyctl'
    child="import os,time;from pathlib import Path;Path("+repr(str(pidfile))+").write_text(str(os.getpid()));time.sleep(10)"
    cli.write_text('#!/bin/bash\nexec '+shlex.quote(sys.executable)+' -c '+shlex.quote(child)+'\n');cli.chmod(0o755)
    env=dict(os.environ, PATH=str(tmp_path)+':'+os.environ['PATH'],FLY_API_TOKEN='fm2_fixture',FLY_FLAPS_BASE_URL='http://127.0.0.1:9')
    process=subprocess.Popen([sys.executable,str(ROOT/'scripts/cloudbench-campaign-machines.py'),'fixture','1'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    until=time.monotonic()+2
    while not pidfile.exists() and process.poll() is None and time.monotonic()<until:time.sleep(.01)
    assert pidfile.exists()
    pid=int(pidfile.read_text());birth=Path('/proc',str(pid),'stat').read_text().split(') ',1)[1].split()[19]
    if cancel: process.terminate()
    stdout,stderr=process.communicate(timeout=4)
    assert process.returncode!=0 and not stdout
    try: assert Path('/proc',str(pid),'stat').read_text().split(') ',1)[1].split()[19]!=birth
    except FileNotFoundError:pass


@pytest.mark.parametrize('case', ['gzip-decoded-cap', 'gzip-wire-cap', 'identity-wire-cap'])
def test_campaign_inventory_compression_caps_wire_and_decoded_bytes(tmp_path, monkeypatch, case):
    import base64
    import gzip
    import importlib.util
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    spec = importlib.util.spec_from_file_location('bounded_gzip_fixture', ROOT/'scripts/cloudbench-campaign-machines.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'MAX_BYTES', 1024)
    content = base64.b64encode(os.urandom(4096)).decode() if case == 'gzip-wire-cap' else 'x' * 2048
    raw = json.dumps([{'id': 'm1', 'config': {'files': [{'raw_value': content}]}}]).encode()
    wire = raw if case == 'identity-wire-cap' else gzip.compress(raw)
    events = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            events.append(self.headers.get('Accept-Encoding'))
            self.send_response(200)
            if case != 'identity-wire-cap': self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(wire))); self.end_headers()
            try: self.wfile.write(wire)
            except (BrokenPipeError, ConnectionResetError): pass
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever); thread.start()
    monkeypatch.setenv('FLY_FLAPS_BASE_URL', f'http://127.0.0.1:{server.server_port}')
    monkeypatch.setenv('FLY_API_TOKEN', 'offline-oauth')
    monkeypatch.delenv('FLY_FORCE_INSTANCE_ID', raising=False)
    try:
        with pytest.raises(module.Refusal): module.fetch('fixture', 1)
    finally:
        server.shutdown(); server.server_close(); thread.join()
    assert events == ['gzip']
    if case == 'gzip-decoded-cap': assert len(wire) < 1024 < len(raw)
    else: assert len(wire) > 1024


@pytest.mark.parametrize("case", ("headers-hold", "body-hold", "crc", "success"))
def test_campaign_inventory_retains_private_typed_phase_evidence(tmp_path, case):
    """The actual publisher preserves its first unavailable boundary without changing authority."""
    import gzip
    import hashlib
    import stat
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    secret = "PRIVATE_PHASE_FIXTURE_NOT_DIAGNOSTIC"
    payload = json.dumps([{"id": "m1", "state": "created", "config": {
        "env": {"PRIVATE": secret}, "files": [], "mounts": [{"volume": "v1"}]}}]).encode()
    release = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if case == "headers-hold":
                release.wait(3)
            body = gzip.compress(payload)
            if case == "crc":
                body = body[:-8] + bytes([body[-8] ^ 1]) + body[-7:]
            self.send_response(200)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                if case == "body-hold":
                    self.wfile.write(body[:1])
                    self.wfile.flush()
                    release.wait(3)
                    self.wfile.write(body[1:])
                else:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    work = tmp_path / "inventory"
    work.mkdir(mode=0o700)
    binary = tmp_path / "flyctl"
    binary.write_text('#!/bin/bash\n[ "$1 $2" = "volumes list" ] || exit 91\nprintf \'[{"id":"v1","state":"created"}]\\n\'\n')
    binary.chmod(0o700)
    source = (ROOT / "scripts/cloudbench-campaign-inventory.sh").read_text()
    dispatch = source[source.index("FLY() {"):source.index("\nSNAPSHOT_LOOP_PID=")]
    shell = "source " + shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh")) + "\n" + dispatch + "\n_refresh_inventory_snapshot_unlocked\n"
    env = dict(os.environ, PATH=str(tmp_path) + ":" + os.environ["PATH"], APP="fixture",
               SOURCE=str(ROOT / "scripts"), FLEET_DIR=str(work),
               MACHINE_READINESS_SCRIPT=str(ROOT / "scripts/cloudbench-machine-readiness.py"),
               FLY_API_TOKEN="offline-" + secret, FLY_FLAPS_BASE_URL=f"http://127.0.0.1:{server.server_port}",
               CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS="1")
    env.pop("FLY_FORCE_INSTANCE_ID", None)
    try:
        result = subprocess.run(["bash", "-c", shell], env=env, capture_output=True, timeout=8)
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join()
    assert result.returncode == (0 if case == "success" else 1)
    diagnostics = work / "inventory-refresh-diagnostics"
    retained = diagnostics / ("phase.latest.private" if case == "success" else "failure.phase.private")
    assert retained.is_file(), "publisher erased the owning Machines failure phase"
    raw = retained.read_bytes()
    mode = retained.stat()
    assert mode.st_uid == os.getuid() and mode.st_nlink == 1 and stat.S_IMODE(mode.st_mode) == 0o600
    assert 0 < len(raw) <= 8192
    assert secret.encode() not in raw and b"127.0.0.1" not in raw and b"Authorization" not in raw
    rows = [json.loads(line) for line in raw.splitlines()]
    expected_sha = hashlib.sha256((ROOT / "scripts/cloudbench-campaign-machines.py").read_bytes()).hexdigest()
    assert all(row["source_sha256"] == expected_sha for row in rows)
    assert all(row["phase"] in {"setup", "auth", "headers", "body_read", "decompress", "json_parse", "validate", "encode", "fetch_return", "stdout_write", "complete"} for row in rows)
    last = rows[-1]
    if case == "success":
        assert last["phase"] == "complete"
        assert json.loads((work / "machines.json").read_bytes()) == json.loads(payload)
        assert (work / "inventory/current/machines/m1").is_file()
    else:
        expected = {"headers-hold": "headers", "body-hold": "body_read", "crc": "decompress"}[case]
        assert last["phase"] == expected and last["event"] == "failure"
        assert not (work / "inventory/current").exists(), "diagnostics granted publication"


@pytest.mark.parametrize("unsafe", ("existing", "symlink", "open-parent"))
def test_campaign_inventory_phase_sidecar_refusal_never_grants_authority(tmp_path, unsafe):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    holder = tmp_path / "holder"
    holder.mkdir(mode=0o700)
    path = holder / "sidecar"
    original = tmp_path / "original"
    original.write_bytes(b"protected-original")
    if unsafe == "existing":
        path.write_bytes(b"protected-original")
    elif unsafe == "symlink":
        path.symlink_to(original)
    else:
        holder.chmod(0o755)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    env = dict(os.environ, FLY_FLAPS_BASE_URL=f"http://127.0.0.1:{server.server_port}",
               FLY_API_TOKEN="offline-fixture", CLOUDBENCH_INVENTORY_PHASE_FILE=str(path))
    env.pop("FLY_FORCE_INSTANCE_ID", None)
    try:
        result = subprocess.run([sys.executable, str(ROOT / "scripts/cloudbench-campaign-machines.py"),
                                 "fixture", "1"], env=env, capture_output=True, timeout=4)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert result.returncode == 0 and json.loads(result.stdout) == []
    assert original.read_bytes() == b"protected-original"
    if unsafe in ("existing", "symlink"):
        assert path.read_bytes() == b"protected-original"
    else:
        assert not path.exists()


def test_campaign_inventory_phase_evidence_distinguishes_owned_term(tmp_path):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    release = threading.Event()
    body_started = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"[")
            self.wfile.flush()
            body_started.set()
            release.wait(4)
            try:
                self.wfile.write(b"]")
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    holder = tmp_path / "private"
    holder.mkdir(mode=0o700)
    sidecar = holder / "phases"
    env = dict(os.environ, FLY_FLAPS_BASE_URL=f"http://127.0.0.1:{server.server_port}",
               FLY_API_TOKEN="offline-fixture", CLOUDBENCH_INVENTORY_PHASE_FILE=str(sidecar))
    env.pop("FLY_FORCE_INSTANCE_ID", None)
    process = subprocess.Popen([sys.executable, str(ROOT / "scripts/cloudbench-campaign-machines.py"),
                                "fixture", "3"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    def birth():
        value = Path(f"/proc/{process.pid}/stat").read_text()
        return value[value.rfind(")") + 2:].split()[19]
    owner_birth = birth()
    try:
        assert body_started.wait(2)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            rows = [json.loads(line) for line in sidecar.read_text().splitlines()]
            if rows[-1]["phase"] == "body_read":
                break
            time.sleep(.005)
        assert rows[-1]["phase"] == "body_read" and process.poll() is None and birth() == owner_birth
        process.terminate()
        stdout, _ = process.communicate(timeout=4)
        assert process.returncode == 1 and stdout == b""
        rows = [json.loads(line) for line in sidecar.read_text().splitlines()]
        assert rows[-1]["event"] == "failure" and rows[-1]["phase"] == "body_read"
        assert rows[-1]["signal"] == "term"
    finally:
        release.set()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=4)
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize('fault,expected', [
    ('new-healthy', 0), ('same-generation', 1), ('stale-new-recovers', 0),
    ('stale-new-expires', 1), ('foreign-token', 1), ('malformed-health', 1),
    ('publisher-birth-changed', 1), ('parent-birth-changed', 1),
    ('publisher-dead', 1), ('parent-dead', 1), ('foreign-token-transition', 1),
    ('publisher-birth-transition', 1), ('missing-generation', 1), ('identity-race', 1),
    ('caller-deadline', 1), ('expired-caller', 1),
])
def test_campaign_inventory_borrowed_refresh_waits_for_same_owned_healthy_generation(tmp_path, fault, expected):
    # Real health/PID-birth/token checks. Only the existing wait tick is controlled
    # to publish a generation or advance the same SECONDS clock without sleeping.
    script = tmp_path / 'wait.sh'
    script.write_text(
        'set -euo pipefail\nFLEET_DIR="$1"; APP=fixture; FLEET_OWNER_HOST="$(hostname)"\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh"))}\n'
        'mkdir -p "$INVENTORY_INDEX/current"\n'
        'SNAPSHOT_LOOP_PID=$$; SNAPSHOT_LOOP_PID_START="$(inventory_pid_start_time $$)"\n'
        'SNAPSHOT_LOOP_TOKEN=fixture; INVENTORY_PUBLISHER_BORROWED=1\n'
        'INVENTORY_CAMPAIGN_PARENT_PID=$$; INVENTORY_CAMPAIGN_PARENT_START="$SNAPSHOT_LOOP_PID_START"\n'
        'CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=4; ticks=0\n'
        'FLY() { touch "$FLEET_DIR/native-called"; return 91; }\n'
        'health() { printf "publisher_token=%s\\nvalid_until=%s\\ngeneration=%s\\n" "$1" "$2" "$3" > "$INVENTORY_INDEX/current/health.tmp"; mv "$INVENTORY_INDEX/current/health.tmp" "$INVENTORY_INDEX/current/health"; }\n'
        'health fixture "$((INVENTORY_CLOCK_EPOCH+120))" old\n'
        'case "$2" in\n'
        ' new-healthy) health fixture "$((INVENTORY_CLOCK_EPOCH+120))" new;;\n'
        ' stale-new-*) health fixture 1 new;;\n'
        ' foreign-token) health foreign "$((INVENTORY_CLOCK_EPOCH+120))" new;;\n'
        ' malformed-health) health fixture invalid new;;\n'
        ' publisher-birth-changed) SNAPSHOT_LOOP_PID_START=wrong;;\n'
        ' parent-birth-changed) INVENTORY_CAMPAIGN_PARENT_START=wrong;;\n'
        ' publisher-dead) (exit 0) & SNAPSHOT_LOOP_PID=$!; wait "$SNAPSHOT_LOOP_PID"; SNAPSHOT_LOOP_PID_START=wrong;;\n'
        ' parent-dead) (exit 0) & INVENTORY_CAMPAIGN_PARENT_PID=$!; wait "$INVENTORY_CAMPAIGN_PARENT_PID"; INVENTORY_CAMPAIGN_PARENT_START=wrong;;\n'
        ' missing-generation) health fixture "$((INVENTORY_CLOCK_EPOCH+120))" "";;\n'
        ' identity-race)\n'
        '   health fixture "$((INVENTORY_CLOCK_EPOCH+120))" new\n'
        '   eval "$(declare -f machines_snapshot_identity | sed \'1s/machines_snapshot_identity/original_identity/\')"\n'
        '   machines_snapshot_identity() { if [ -e "$FLEET_DIR/identity-seen" ]; then health foreign "$((INVENTORY_CLOCK_EPOCH+120))" unsafe; else touch "$FLEET_DIR/identity-seen"; fi; original_identity; };;\n'
        'esac\n'
        'inventory_refresh_wait_tick() { ticks=$((ticks+1)); SECONDS=$((SECONDS+1)); case "$fault" in stale-new-recovers) health fixture "$((INVENTORY_CLOCK_EPOCH+120))" new;; foreign-token-transition) health foreign "$((INVENTORY_CLOCK_EPOCH+120))" new;; publisher-birth-transition) SNAPSHOT_LOOP_PID_START=wrong;; esac; }\n'
        # The function runs in the parent shell; its state and budget cannot reset
        # in a command-substitution subshell on each pending observation.
        'fault="$2"\n'
        # Unsetting SECONDS removes Bash's wall-clock binding: the controlled
        # tick is then the only clock, so host load cannot expire the budget early.
        'unset SECONDS; SECONDS=0\n'
        'deadline=$((SECONDS+20)); [ "$fault" != caller-deadline ] || deadline=$((SECONDS+2))\n'
        '[ "$fault" != expired-caller ] || deadline="$SECONDS"\n'
        'status=0; refresh_machines_snapshot_after old "$deadline" || status=$?\n'
        'printf "%s %s\\n" "$status" "$ticks"\n'
        'test ! -e "$FLEET_DIR/native-called"; test ! -e "$INVENTORY_REFRESH_LOCK"\n'
    )
    result = subprocess.run(['bash', str(script), str(tmp_path), fault], capture_output=True, text=True,
                            timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stdout + result.stderr
    status, ticks = map(int, result.stdout.split())
    assert status == expected, result.stdout + result.stderr
    assert ticks == (2 if fault == 'caller-deadline' else 4 if fault in
                     ('same-generation', 'stale-new-expires', 'missing-generation') else
                     1 if fault in ('stale-new-recovers', 'identity-race', 'foreign-token-transition', 'publisher-birth-transition') else 0)


def test_campaign_inventory_clone_name_wait_passes_original_absolute_deadline(tmp_path):
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    start = source.index('machine_id_for_clone_name() {')
    function = source[start:source.index('\n}\n', start) + 3]
    script = tmp_path / 'caller.sh'
    script.write_text('set -euo pipefail\n' + function + '\n'
        'machines_snapshot_identity() { printf prior; }\n'
        'refresh_machines_snapshot_after() { test "$1" = prior; test "$2" = "$deadline"; touch "$1.ok"; return 1; }\n'
        'deadline="$SECONDS"; status=0; machine_id_for_clone_name target "$deadline" || status=$?\n'
        'test "$status" = 1; test -e prior.ok\n')
    result = subprocess.run(['bash', str(script)], cwd=tmp_path, capture_output=True, text=True,
                            timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize('case', ['materialized', 'absent', 'publisher-stalled', 'publisher-dead', 'capacity-guard-default'])
def test_campaign_inventory_borrowed_lookup_waits_one_sharded_publication_cycle(tmp_path, case):
    # run600c shard-16 r001-j0157/r003-j0557: the healthy borrowed parent published
    # every 61-70 s (sharded CLOUDBENCH_SNAPSHOT_POLL_SECONDS=60), but the clone-name
    # lookup allowed it only CLOUDBENCH_CLONE_LOOKUP_SECONDS=20 s, so the wait reported
    # "timed out waiting for a new healthy parent inventory generation". The real
    # lookup and borrowed wait run here; only the wait tick and sleep advance SECONDS.
    source = (ROOT / 'scripts/run-bench-fleet').read_text()
    start = source.index('machine_id_for_clone_name() {')
    function = source[start:source.index('\n}\n', start) + 3]
    publish_tick = 100 if case == 'capacity-guard-default' else 45
    script = tmp_path / 'lookup.sh'
    script.write_text(
        'set -euo pipefail\nFLEET_DIR="$1"; case_name="$2"; APP=fixture; FLEET_OWNER_HOST="$(hostname)"\n'
        'export CLOUDBENCH_SNAPSHOT_POLL_SECONDS=60 CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS=30\n'
        'unset CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS CLOUDBENCH_CLONE_LOOKUP_SECONDS\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n'
        f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-inventory.sh"))}\n'
        + function +
        'mkdir -p "$INVENTORY_INDEX/current/names"\n'
        'SNAPSHOT_LOOP_PID=$$; SNAPSHOT_LOOP_PID_START="$(inventory_pid_start_time $$)"\n'
        'SNAPSHOT_LOOP_TOKEN=fixture; INVENTORY_PUBLISHER_BORROWED=1\n'
        'INVENTORY_CAMPAIGN_PARENT_PID=$$; INVENTORY_CAMPAIGN_PARENT_START="$SNAPSHOT_LOOP_PID_START"\n'
        'FLY() { touch "$FLEET_DIR/native-called"; return 91; }\n'
        'health() { printf "publisher_token=fixture\\nvalid_until=%s\\ngeneration=%s\\n" "$((INVENTORY_CLOCK_EPOCH+600))" "$1" > "$INVENTORY_INDEX/current/health.tmp"; mv "$INVENTORY_INDEX/current/health.tmp" "$INVENTORY_INDEX/current/health"; }\n'
        'health before-clone; ticks=0\n'
        'advance() {\n'
        '  ticks=$((ticks+1)); SECONDS=$((SECONDS+1))\n'
        f'  if [ "$case_name" != publisher-stalled ] && [ "$ticks" = {publish_tick} ]; then\n'
        '    [ "$case_name" = absent ] || printf "0123456789abcd\\n" > "$INVENTORY_INDEX/current/names/cloudbench-target"\n'
        '    health after-clone\n'
        '  fi\n'
        '}\n'
        'inventory_refresh_wait_tick() { advance; }\n'
        'sleep() { advance; }\n'
        'if [ "$case_name" = publisher-dead ]; then (exit 0) & SNAPSHOT_LOOP_PID=$!; wait "$SNAPSHOT_LOOP_PID"; fi\n'
        'status=0; started=$SECONDS\n'
        'if [ "$case_name" = capacity-guard-default ]; then\n'
        '  refresh_machines_snapshot_after "$(machines_snapshot_identity)" 2> "$FLEET_DIR/err" || status=$?\n'
        'else\n'
        # The clone loop passes its original 20-second lookup deadline.
        '  deadline=$((SECONDS + ${CLOUDBENCH_CLONE_LOOKUP_SECONDS:-20}))\n'
        '  machine_id_for_clone_name cloudbench-target "$deadline" > "$FLEET_DIR/id" 2> "$FLEET_DIR/err" || status=$?\n'
        'fi\n'
        'printf "%s %s %s\\n" "$status" "$ticks" "$((SECONDS - started))"\n'
        'test ! -e "$FLEET_DIR/native-called"; test ! -e "$INVENTORY_REFRESH_LOCK"\n'
    )
    result = subprocess.run(['bash', str(script), str(tmp_path), case], capture_output=True, text=True,
                            timeout=FIXTURE_HOST_GUARD_SECONDS)
    assert result.returncode == 0, result.stdout + result.stderr
    status, ticks, elapsed = map(int, result.stdout.split())
    stderr = (tmp_path / 'err').read_text()
    if case == 'publisher-stalled':
        # A genuinely stalled feed still fails closed, after one bounded cycle:
        # poll 60 + jitter 2 + the existing 3 x 30 + 5 refresh budget.
        # SECONDS also carries the fixture's real host time; ticks alone may be fewer.
        assert status == 1 and ticks <= 157 and 157 <= elapsed <= 159, (status, ticks, elapsed, stderr)
        assert 'timed out waiting for a new healthy parent inventory generation' in stderr
        assert (tmp_path / 'id').read_text() == ''
        return
    if case == 'publisher-dead':
        # Ownership loss stays immediately fatal; the longer cycle covers only a
        # live, owned publisher between generations.
        assert status == 1 and ticks <= 1, (ticks, stderr)
        assert 'borrowed parent inventory is not owned and healthy' in stderr
        assert (tmp_path / 'id').read_text() == ''
        return
    assert ticks == publish_tick, stderr
    assert 'timed out waiting' not in stderr and 'after inventory refresh failure' not in stderr, stderr
    if case == 'materialized':
        assert status == 0 and (tmp_path / 'id').read_text() == '0123456789abcd', stderr
        assert stderr == ''
    elif case == 'absent':
        # One post-clone generation without the name hands off to the existing exact
        # registry resolver immediately; it neither waits out the cycle nor reports
        # an inventory failure.
        assert status == 1 and (tmp_path / 'id').read_text() == '', stderr
        assert 'absent from the first new parent inventory generation' in stderr
        assert '❌' not in stderr
    else:
        assert status == 0, stderr


def _scheduled_stop_guard():
    import runpy
    return runpy.run_path(str(ROOT / 'scripts/cloudbench-campaign-stop.py'))


def _scheduled_stop_summary(failed=0):
    jobs = []
    for index in range(600):
        attempts = [] if index >= failed else [{'attempt': 1, 'status': 'failed',
            'finished_at': '2026-10-15T00:00:00Z', 'infra_failure': True}]
        jobs.append({'job_id': f'r001-j{index+1:04}', 'task': f'task-{index}', 'attempts': attempts})
    return {'jobs': jobs}


@pytest.mark.parametrize('failed, expected', [(1, False), (29, False), (30, True)])
def test_campaign_scheduled_stop_uses_fixed_600_job_denominator(failed, expected):
    guard = _scheduled_stop_guard()
    result = guard['fold'](_scheduled_stop_summary(failed))
    assert result['trigger'] is expected


def test_campaign_scheduled_stop_deduplicates_failed_jobs_across_retries():
    guard = _scheduled_stop_guard()
    summary = _scheduled_stop_summary(29)
    for job in summary['jobs'][:29]:
        job['attempts'].append({**job['attempts'][0], 'attempt': 2})
    result = guard['fold'](summary)
    assert result['trigger'] is False
    assert result['infra_failed_jobs'] == 29
    assert result['scheduled_jobs'] == 600
    assert result['terminal'] == 58  # physical telemetry remains intact
    assert result['infra_true'] == 58


@pytest.mark.parametrize('status, flag, expected', [
    ('cancelled', True, 30), ('cancelled', None, 29), ('failed', None, 29),
    ('passed', True, 30), ('passed', False, 29), ('running', True, 29)])
def test_campaign_scheduled_stop_preserves_confirmed_terminal_infra(status, flag, expected):
    guard = _scheduled_stop_guard()
    summary = _scheduled_stop_summary(29)
    summary['jobs'][29]['attempts'] = [{'attempt': 1, 'status': status,
        'finished_at': '2026-10-15T00:00:00Z', 'infra_failure': flag}]
    result = guard['fold'](summary)
    assert result['trigger'] is (expected == 30)
    assert result['infra_failed_jobs'] == expected
    assert result['scheduled_jobs'] == 600


def test_campaign_scheduled_stop_logical_cancellation_keeps_physical_infra():
    guard = _scheduled_stop_guard()
    summary = _scheduled_stop_summary(30)
    for job in summary['jobs']:
        job['status'] = 'cancelled'
    assert guard['fold'](summary)['infra_failed_jobs'] == 30
    assert guard['fold'](summary)['trigger'] is True


def test_campaign_scheduled_stop_refuses_duplicate_physical_attempt_identity():
    guard = _scheduled_stop_guard()
    summary = _scheduled_stop_summary(29)
    summary['jobs'][0]['attempts'].append(dict(summary['jobs'][0]['attempts'][0]))
    with pytest.raises(ValueError, match='duplicate physical attempt'):
        guard['fold'](summary)


@pytest.mark.parametrize('change', ['missing', 'duplicate'])
def test_campaign_scheduled_stop_refuses_changed_scheduled_membership(change):
    guard = _scheduled_stop_guard()
    summary = _scheduled_stop_summary(30)
    if change == 'missing':
        summary['jobs'].pop()
    else:
        summary['jobs'][-1] = summary['jobs'][0]
    with pytest.raises(ValueError):
        guard['fold'](summary)


@pytest.mark.parametrize('scoped', [False, True])
@pytest.mark.parametrize('failed, expected_signals', [(1, 0), (29, 0), (30, 1)])
def test_campaign_scheduled_stop_actual_supervisor_sends_one_parent_term(tmp_path, monkeypatch, failed, expected_signals, scoped):
    """Run the actual supervisor loop repeatedly, including its durable stop latch."""
    import hashlib
    import runpy
    from unittest.mock import patch
    guard = _scheduled_stop_guard()
    main = guard['main']
    namespace = main.__globals__
    original_path = Path
    epoch = 123.0
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    suffix = hashlib.sha256((float(epoch).hex()+':'+boot).encode()).hexdigest()[:24]
    campaign_id = f'campaign-qualified600-{suffix}-{os.getpid()}'
    campaign = tmp_path / '.context/benchmarks/campaigns' / campaign_id
    manifest_dir = campaign / 'startup-cohorts/c001'
    destination = tmp_path / '.context/stress200-host'
    destination.mkdir(parents=True)
    legacy = destination
    old_evidence = legacy / 'first-infra-threshold-trigger.private.json'
    if scoped:
        old_evidence.write_bytes(b'prior epoch evidence must remain untouched\n')
        destination = legacy / 'watchers-new-original-epoch'
    summary = dict(_scheduled_stop_summary(failed), campaign_id=campaign_id,
                   e2e_started_at_epoch=epoch, total_jobs=600, concurrency=600)
    manifest = {'cohort_id': 'c001', 'e2e_deadline_monotonic': 9999.0,
                'jobs': {j['job_id']: None for j in summary['jobs']}}
    class Parent:
        pid = 12345
        done = False
        signals = []
        def poll(self): return 0 if self.done else None
        def send_signal(self, value): self.signals.append(value)
        def wait(self): return 0
    parent = Parent()
    def launch(*args, **kwargs):
        assert args[0] == ['bash', 'scripts/run-bench']
        if scoped:
            assert destination.stat().st_mode & 0o777 == 0o700
        manifest_dir.mkdir(parents=True)
        (campaign / 'summary.json').write_text(json.dumps(summary))
        (manifest_dir / 'manifest.json').write_text(json.dumps(manifest))
        return parent
    iterations = []
    def advance(_seconds):
        iterations.append(True)
        if len(iterations) == 3:
            parent.done = True
    def paths(*args):
        return tmp_path if args == ('/tmp/gate/repo',) else original_path(*args)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF', 'a'*40)
    with patch.dict(namespace, Path=paths, birth=lambda _pid: 'exact-birth', fence=lambda *args: None), \
         patch.object(namespace['subprocess'], 'Popen', side_effect=launch), \
         patch.object(namespace['signal'], 'signal'), \
         patch.object(namespace['time'], 'sleep', side_effect=advance), \
         patch.object(namespace['sys'], 'argv', ['supervisor', str(epoch), *(['--watcher-scope', 'watchers-new-original-epoch'] if scoped else []), 'bash', 'scripts/run-bench']):
        assert main() == 0
    assert parent.signals == [namespace['signal'].SIGTERM] * expected_signals
    assert (destination/'first-infra-threshold-trigger.private.json').exists() is bool(expected_signals)
    assert (destination/'infra-threshold-parent-term.safe.json').exists() is bool(expected_signals)
    assert len(iterations) == 3
    if scoped:
        assert old_evidence.read_bytes() == b'prior epoch evidence must remain untouched\n'
        assert not (legacy / 'threshold-original-parent.private.json').exists()


@pytest.mark.parametrize('prior', [
    'threshold-original-parent.private.json', 'first-authentic-infra-summary.private.json',
    'first-authentic-infra.private.json', 'first-infra-threshold-summary.private.json',
    'first-infra-threshold-trigger.private.json', 'infra-threshold-parent-term.safe.json',
    'dangling-trigger'])
def test_campaign_scheduled_stop_refuses_old_watcher_paths_before_parent(tmp_path, monkeypatch, prior):
    """Retained evidence from another epoch may never authorize a new launch or stop."""
    from unittest.mock import patch
    guard = _scheduled_stop_guard()
    main = guard['main']
    namespace = main.__globals__
    destination = tmp_path / '.context/stress200-host'
    destination.mkdir(parents=True)
    if prior == 'dangling-trigger':
        artifact = destination / 'first-infra-threshold-trigger.private.json'
        artifact.symlink_to(destination / 'missing-target')
    else:
        artifact = destination / prior
        artifact.write_bytes(b'original private evidence stays untouched\n')
    original_path = Path
    def paths(*args):
        return tmp_path if args == ('/tmp/gate/repo',) else original_path(*args)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF', 'a'*40)
    with patch.dict(namespace, Path=paths), \
         patch.object(namespace['subprocess'], 'Popen', side_effect=RuntimeError('parent launch must not occur')) as popen, \
         patch.object(namespace['sys'], 'argv', ['supervisor', '123.0', 'bash', 'scripts/run-bench']):
        with pytest.raises(ValueError, match='prior watcher evidence'):
            main()
    popen.assert_not_called()
    if prior == 'dangling-trigger':
        assert artifact.is_symlink()
    else:
        assert artifact.read_bytes() == b'original private evidence stays untouched\n'


@pytest.mark.parametrize('scope', ['', '.', '..', '../escape', '/tmp/escape', 'has space', 'ü', 'x' * 97])
def test_campaign_scheduled_stop_refuses_unsafe_watcher_scope_before_parent(tmp_path, monkeypatch, scope):
    from unittest.mock import patch
    namespace = _scheduled_stop_guard()['main'].__globals__
    legacy = tmp_path / '.context/stress200-host'; legacy.mkdir(parents=True)
    original = legacy / 'first-infra-threshold-trigger.private.json'; original.write_bytes(b'old original\n')
    def paths(*args): return tmp_path if args == ('/tmp/gate/repo',) else Path(*args)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF', 'a' * 40)
    with patch.dict(namespace, Path=paths), \
         patch.object(namespace['subprocess'], 'Popen') as popen, \
         patch.object(namespace['sys'], 'argv', ['supervisor', '123.0', '--watcher-scope', scope, 'bash', 'scripts/run-bench']):
        with pytest.raises(ValueError, match='invalid watcher scope'):
            namespace['main']()
    popen.assert_not_called()
    assert list(legacy.iterdir()) == [original]
    assert original.read_bytes() == b'old original\n'


@pytest.mark.parametrize('prior', ['directory', 'file', 'dangling', 'fifo'])
def test_campaign_scheduled_stop_preserves_existing_scoped_destination_before_parent(tmp_path, monkeypatch, prior):
    from unittest.mock import patch
    namespace = _scheduled_stop_guard()['main'].__globals__
    legacy = tmp_path / '.context/stress200-host'; legacy.mkdir(parents=True)
    selected = legacy / 'already-reserved'
    if prior == 'directory':
        selected.mkdir(); (selected / 'original').write_bytes(b'prior original\n')
    elif prior == 'file': selected.write_bytes(b'prior original\n')
    elif prior == 'dangling': selected.symlink_to(legacy / 'missing')
    else: os.mkfifo(selected)
    info = selected.lstat()
    def paths(*args): return tmp_path if args == ('/tmp/gate/repo',) else Path(*args)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF', 'a' * 40)
    with patch.dict(namespace, Path=paths), \
         patch.object(namespace['subprocess'], 'Popen') as popen, \
         patch.object(namespace['sys'], 'argv', ['supervisor', '123.0', '--watcher-scope', selected.name, 'bash', 'scripts/run-bench']):
        with pytest.raises(ValueError, match='prior watcher scope'):
            namespace['main']()
    popen.assert_not_called()
    assert selected.lstat() == info
    if prior == 'directory': assert (selected / 'original').read_bytes() == b'prior original\n'
    if prior == 'file': assert selected.read_bytes() == b'prior original\n'
    if prior == 'dangling': assert selected.is_symlink()


def test_campaign_scheduled_stop_refuses_linked_scope_parent_before_parent(tmp_path, monkeypatch):
    from unittest.mock import patch
    namespace = _scheduled_stop_guard()['main'].__globals__
    context = tmp_path / '.context'; context.mkdir()
    protected = tmp_path / 'protected'; protected.mkdir()
    (context / 'stress200-host').symlink_to(protected, target_is_directory=True)
    def paths(*args): return tmp_path if args == ('/tmp/gate/repo',) else Path(*args)
    monkeypatch.setenv('REVIEWED_OPERATOR_SOURCE_REF', 'a' * 40)
    with patch.dict(namespace, Path=paths), \
         patch.object(namespace['subprocess'], 'Popen') as popen, \
         patch.object(namespace['sys'], 'argv', ['supervisor', '123.0', '--watcher-scope', 'new-run', 'bash', 'scripts/run-bench']):
        with pytest.raises(ValueError, match='unsafe watcher scope parent'):
            namespace['main']()
    popen.assert_not_called()
    assert not list(protected.iterdir())
