"""Copy campaigns reuse the real inventory producer without borrowing ownership."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("CLOUDBENCH_INVENTORY_ROOT_UNDER_TEST", Path(__file__).resolve().parents[2]))


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


def run_consumers(tmp_path, *, shared=True, death=False, refresh=False, auth=False, production_only=False):
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
        "if os.environ.get('FIXTURE_EXPECT_AUTH'): assert os.environ.get('FLY_API_TOKEN') == os.environ['FIXTURE_EXPECT_AUTH'], 'wrong selected credential'\n"
        "payload=Path(os.environ['FIXTURE_'+kind.upper()]).read_bytes()\n"
        "fd=os.open(os.environ['FIXTURE_CALLS'],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)\n"
        "os.write(fd,(json.dumps({'kind':kind,'decoded_bytes':len(payload),'job':os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID')})+'\\n').encode());os.close(fd)\n"
        "sys.stdout.buffer.write(payload)\n"
    )
    fly.chmod(0o700)
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
        "trap finish EXIT\ntrap 'exit 143' TERM\nstart_machines_snapshot_loop\n"
        'if [ -z "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ]; then\n'
        # The ordinary control asserts two reads per owner. Observe its first
        # loop read before immediate fixture exit can stop that owner.
        ' while [ "$(python3 -c \'import json,os;print(sum(json.loads(s)["kind"]=="machines" and json.loads(s)["job"]==os.environ["RUN_BENCH_CAMPAIGN_JOB_ID"] for s in open(os.environ["FIXTURE_CALLS"])))\')" -lt 2 ]; do sleep 0.1; done\n'
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
        CLOUDBENCH_CAMPAIGN_SHARED_INVENTORY=str(int(shared)),
        CLOUDBENCH_SNAPSHOT_POLL_SECONDS="60",
    )
    if auth:
        env["FLY_BENCH_API_TOKEN"] = "offline-bench-token-selected-123456789"
        env["FLY_API_TOKEN"] = "offline-injected-token-unselected"
        env["FIXTURE_EXPECT_AUTH"] = env["FLY_BENCH_API_TOKEN"]
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/run-bench-campaign.py"),
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
        timeout=40,
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
