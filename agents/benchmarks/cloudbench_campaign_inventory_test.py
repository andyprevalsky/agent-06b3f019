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
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("RUN_BENCH_CAMPAIGN_") and not key.startswith("BENCHMARK_HUB_")}
    env.update(FIXTURE_ROOT=str(tmp_path), FIXTURE_FAILURE=failure, CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY="0",
               FIXTURE_BARRIER=str(ROOT / 'scripts/cloudbench-campaign-barrier.py'))
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
        assert len([event for event in started if event['task'] == 'broken']) == 2
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


def run_consumers(tmp_path, *, shared=True, death=False, refresh=False, auth=False, production_only=False, post_canary=False, admission_wait=False, mutation=False):
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
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "kind=sys.argv[1]\n"
        "if os.environ.get('FIXTURE_POST_CANARY') == '1' and os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID') and os.environ.get('CLOUDBENCH_CAMPAIGN_INVENTORY_DIR'): sys.exit(1)\n"
        "if os.environ.get('FIXTURE_EXPECT_AUTH'): assert os.environ.get('FLY_API_TOKEN') == os.environ['FIXTURE_EXPECT_AUTH'], 'wrong selected credential'\n"
        "payload=Path(os.environ['FIXTURE_'+kind.upper()]).read_bytes()\n"
        "fd=os.open(os.environ['FIXTURE_CALLS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n"
        "os.write(fd,(json.dumps({'kind':kind,'decoded_bytes':len(payload)})+'\\n').encode());os.close(fd)\n"
        "sys.stdout.buffer.write(payload)\n"
    )
    fly.chmod(0o700)
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
        CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=str(int(shared)),
        CLOUDBENCH_CAMPAIGN_MUTATION_ADMISSION=str(int(mutation)),
        CLOUDBENCH_SNAPSHOT_POLL_SECONDS="60",
    )
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


def test_campaign_inventory_post_mutation_refresh_keeps_native_generation_and_ordinary_fleet_ownership(tmp_path):
    result, calls, _, _ = run_consumers(tmp_path, refresh=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert len([call for call in calls if call["kind"] == "machines"]) == 3, calls
    ordinary = tmp_path / "ordinary"
    ordinary.mkdir()
    result, calls, summary, _ = run_consumers(ordinary, shared=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "shared_inventory" not in summary
    assert len([call for call in calls if call["kind"] == "machines"]) == 4, calls


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
        'temporary.write_text(json.dumps({"pid":os.getpid(),"child_pid":child.pid})); temporary.replace(marker)\n'
        'while not Path(os.environ["FIXTURE_RELEASE"]).exists(): time.sleep(0.1)\n'
        "child.terminate(); child.wait()\n"
    )
    environment = dict(os.environ)
    for name in list(environment):
        if name.startswith(("RUN_BENCH_CAMPAIGN_", "CLOUDBENCH_CAMPAIGN_", "BENCHMARK_HUB_")):
            environment.pop(name)
    environment.update(
        FIXTURE_PHASE=phase,
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
            for owned_pid in owner.values():
                try:
                    os.kill(owned_pid, 0)
                except ProcessLookupError:
                    continue
                raise AssertionError(f"owned publication process {owned_pid} remains")
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
    (shared / 'inventory/current').mkdir(parents=True)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    stat = Path(f'/proc/{os.getpid()}/stat').read_text()
    birth = f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
    (shared / 'owner').write_text(f'app=fixture-app\npid={os.getpid()}\npid_start={birth}\ntoken=fixture\nparent_pid={os.getpid()}\nparent_start={birth}\n')
    (shared / 'inventory/current/health').write_text(f'publisher_token=fixture\nvalid_until={int(time.time()) + 120}\n')
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
    active = peak = 0
    for event in (tmp_path / 'events').read_text().splitlines():
        active += 1 if event.split()[0] == 'start' else -1
        peak = max(peak, active)
    assert peak == 1, f'independent fleet gates admitted {peak} overlapping native updates'
    assert active == 0



def stress_source_binding():
    import hashlib
    return {'ref': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
            'sha256': {name: hashlib.sha256((ROOT / 'scripts' / name).read_bytes()).hexdigest()
                       for name in ['cloudbench-campaign-mutation.py', 'cloudbench-script-snapshot.py', 'run-bench-campaign.py', 'cloudbench-port-lease.py', 'lib/cloudbench-env.sh']}}



def stress_mutation_feed(tmp_path):
    directory = tmp_path / 'inventory'
    (directory / 'inventory/current').mkdir(parents=True)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    stat = Path(f'/proc/{os.getpid()}/stat').read_text()
    birth = f"proc-start:{boot}:{stat[stat.rfind(')') + 2:].split()[19]}"
    (directory / 'owner').write_text(f'app=fixture-app\npid={os.getpid()}\npid_start={birth}\ntoken=fixture\nparent_pid={os.getpid()}\nparent_start={birth}\n')
    (directory / 'inventory/current/health').write_text(f'publisher_token=fixture\nvalid_until={int(time.time()) + 120}\n')
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
    subject.write_text('set -euo pipefail\n' + f'source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}\n' + 'FLEET_OWNER_PID_START="$(cloudbench_pid_start_time $$)"\nclone_timeout=6\nprivate_source_allows_provider_call() { return 0; }\n'
        'flyctl() { python3 -c \'import os,time;open(os.environ["FIXTURE_EVENTS"],"a").write(str(time.monotonic())+"\\n")\'; }\n'
        + definition + '\nFLY machine clone source\nFLY machine clone source\n')
    environment, _ = stress_mutation_feed(tmp_path)
    environment['FIXTURE_EVENTS'] = str(tmp_path / 'events')
    processes = [subprocess.Popen(['bash', str(subject)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    for process in processes:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert process.returncode == 0, stdout + stderr
    times = sorted(float(line) for line in (tmp_path / 'events').read_text().splitlines())
    assert len(times) == 4
    assert all(second - first >= 0.9 for first, second in zip(times, times[1:])), times



@pytest.mark.parametrize('fault', ['foreign-token', 'foreign-parent-birth', 'malformed-inventory', 'missing-health', 'expired-health'])
def test_campaign_inventory_stress_mutation_unknown_feed_never_grants(tmp_path, fault):
    environment, directory = stress_mutation_feed(tmp_path)
    if fault == 'foreign-token':
        (directory / 'inventory/current/health').write_text(f'publisher_token=foreign\nvalid_until={int(time.time()) + 120}\n')
    elif fault == 'foreign-parent-birth':
        owner = directory / 'owner'
        owner.write_text(owner.read_text().replace('parent_start=proc-start:', 'parent_start=foreign:'))
    elif fault == 'malformed-inventory':
        (directory / 'machines.json').write_text('{}')
    elif fault == 'missing-health':
        (directory / 'inventory/current/health').unlink()
    else:
        (directory / 'inventory/current/health').write_text('publisher_token=fixture\nvalid_until=1\n')
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
        blocked = subprocess.run(helper + ['acquire', *common, '--owner-pid', str(os.getpid()), '--slots', '1', '--wait-seconds', '1'],
            env=environment, text=True, capture_output=True, timeout=FIXTURE_HOST_GUARD_SECONDS)
        assert blocked.returncode != 0
        assert lease.exists(), 'caller death cannot prove its native child stopped'
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
        leases = list((tmp_path / 'capacity').rglob('lease-*.json'))
        assert len(leases) == 1 and old_token not in leases[0].name
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
        shutil.copytree(directory, foreign)
        (foreign / 'owner').write_text((foreign / 'owner').read_text().replace('token=fixture', 'token=foreign'))
        (foreign / 'inventory/current/health').write_text(f'publisher_token=foreign\nvalid_until={int(time.time()) + 120}\n')
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
    scope.update(cohort_path=str(cohort), cohort_id="c001", job=job, owner_pid=os.getpid(), path=tmp_path/"reserve", preferred=512, headroom=256, minimum=32, birth_snapshot=scope["capture_births"]())
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
        'FLY() { touch "$FLEET_DIR/native-read"; return 97; }\n' +
        '\n'.join(function(n) for n in ['pool_machine_state_from_json','pool_machine_shape_from_json','reconcile_pool','normalize_current_pool_shape','pool_write_shape_hints']) +
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
        f'FLEET_OWNERSHIP_ROOT={shlex.quote(str(root))}\nFLEET_REGISTRY_DIR=own\nFLEET_OWNER_HOST=fixture-host\nAPP=fixture-app\nFLEET_DIR={shlex.quote(str(tmp_path))}\nPOOL_IDS_FILE={shlex.quote(str(ids))}\n'+
        'registry_meta_value() { awk -F= -v k="$2" \'$1==k {print substr($0,length(k)+2);exit}\' "$1"; }\n'+
        'fleet_registry_cleanup_state() { printf reap; }\nregistry_owner_alive() { return '+('0' if case=='live' else '1')+'; }\n'+
        'release_cleanup_disk_reserve() { return 0; }\nacquire_registry_recovery_lock() { return 0; }\nrelease_registry_recovery_lock() { return 0; }\n'+
        'recover_registry_audit_only_fresh() { [ "$FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ] || exit 98; return 1; }\n'+
        function('reconcile_stale_fleet_registries')+'\n'+function('pool_machine_shape_from_json')+'\n'+function('normalize_current_pool_shape')+'\n'+
        'FLEET_PRIMARY_VM_SIZE=shared-cpu-2x\nFLEET_PRIMARY_VM_MEMORY=4096\n'+
        "POOL_INVENTORY_JSON='[{\"id\":\"abc123\",\"state\":\"stopped\",\"config\":{\"guest\":{\"cpu_kind\":\"shared\",\"cpus\":1,\"memory_mb\":1024}}}]'\n"+
        'resize_pool_machine() { [ "$FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ] || exit 98; return 1; }\n'+
        ('normalize_current_pool_shape; status=$?; [ "$status" = 1 ] && [ "$FLEET_POOL_RECONCILIATION_MAY_HAVE_MUTATED" = 1 ]\n' if case=='resize-refused' else
         'reconcile_stale_fleet_registries; status=$?; [ "$status" = '+('1' if case=='dead-recovery-refused' else '0')+' ] && [ "$FLEET_STALE_RECONCILIATION_MAY_HAVE_MUTATED" = '+('1' if case=='dead-recovery-refused' else '0')+' ]\n'))
    result = subprocess.run(['bash',str(script)],capture_output=True,text=True,timeout=10)
    assert result.returncode == 0, result.stdout+result.stderr
