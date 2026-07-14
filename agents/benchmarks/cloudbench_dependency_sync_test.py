import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "cloudbench-sync-deps.sh"
ENV_HELPER_SCRIPT = ROOT / "scripts" / "lib" / "cloudbench-env.sh"
ARTIFACT_SCRIPT = ROOT / "scripts" / "cloudbench-current-run-artifact.py"
FETCH_SCRIPT = ROOT / "scripts" / "cloudbench-fetch-ref.sh"
SNAPSHOT_SCRIPT = ROOT / "scripts" / "cloudbench-select-snapshot.py"
MACHINE_READINESS_SCRIPT = ROOT / "scripts" / "cloudbench-machine-readiness.py"
AGGREGATE_SCRIPT = ROOT / "scripts" / "cloudbench-aggregate-runs.py"
DRIVER_SCRIPT = ROOT / "scripts" / "cloudbench-run.sh"
FLEET_SCRIPT = ROOT / "scripts" / "run-bench-fleet"
CLOUD_SCRIPT = ROOT / "scripts" / "run-bench-cloud"
PREDEPLOY_SCRIPT = ROOT / "scripts" / "run-predeploy-cloud"
DEPLOY_COMMAND = ROOT / ".claude" / "commands" / "deploy.md"


def _write_manifests(root: Path, *, lock: str = "same", requirements: str = "same") -> None:
    for relative in (
        "package.json",
        "back-end/package.json",
        "front-end/package.json",
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")
    (root / "package-lock.json").write_text(lock)
    (root / "back-end/package-lock.json").write_text(lock)
    helper = root / "scripts/lib/cloudbench-env.sh"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_text(ENV_HELPER_SCRIPT.read_text())
    req = root / "agents/requirements.txt"
    req.parent.mkdir(parents=True, exist_ok=True)
    req.write_text(requirements)


def test_refreshes_stale_volume_dependency_trees(tmp_path: Path) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor)
    _write_manifests(repo)
    (donor / "node_modules/current-package").mkdir(parents=True)
    (donor / "agents/venv/bin").mkdir(parents=True)
    (donor / "agents/venv/bin/python").write_text("current")
    (repo / "node_modules/stale-package").mkdir(parents=True)
    (repo / "agents/venv/bin").mkdir(parents=True)
    (repo / "agents/venv/bin/python").write_text("stale")

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (repo / "node_modules/current-package").is_dir()
    assert not (repo / "node_modules/stale-package").exists()
    assert (repo / "agents/venv/bin/python").read_text() == "current"
    assert (repo / "node_modules/.cloudbench-deps-fingerprint").is_file()
    assert (repo / "agents/venv/.cloudbench-deps-fingerprint").is_file()


def test_relocates_donor_virtualenv_text_prefixes_after_sync(tmp_path: Path) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor)
    _write_manifests(repo)
    (donor / "node_modules/current-package").mkdir(parents=True)
    donor_bin = donor / "agents/venv/bin"
    donor_bin.mkdir(parents=True)
    (donor_bin / "python").write_text("current")
    (donor_bin / "example-tool").write_text(
        f"#!{donor / 'agents/venv/bin/python'}\nprint('ok')\n"
    )
    (donor / "agents/venv/pyvenv.cfg").write_text(
        f"command = python -m venv {donor / 'agents/venv'}\n"
    )
    donor_cache = donor / "agents/venv/lib/python3.11/site-packages/demo/__pycache__"
    donor_cache.mkdir(parents=True)
    (donor_cache / "module.cpython-311.pyc").write_bytes(
        b"\0compiled:" + str(donor / "agents/venv").encode()
    )

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    repo_prefix = str(repo / "agents/venv")
    assert (repo / "agents/venv/bin/example-tool").read_text().splitlines()[0] == (
        f"#!{repo_prefix}/bin/python"
    )
    assert repo_prefix in (repo / "agents/venv/pyvenv.cfg").read_text()
    assert str(donor / "agents/venv") not in (
        repo / "agents/venv/pyvenv.cfg"
    ).read_text()
    assert not (
        repo
        / "agents/venv/lib/python3.11/site-packages/demo/__pycache__/module.cpython-311.pyc"
    ).exists()


def test_does_not_persist_python_fingerprint_when_relocation_fails(
    tmp_path: Path,
) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor)
    _write_manifests(repo)
    (donor / "node_modules/current-package").mkdir(parents=True)
    donor_venv = donor / "agents/venv"
    (donor_venv / "bin").mkdir(parents=True)
    (donor_venv / "bin/python").write_text("current")
    (donor_venv / "binary-extension.so").write_bytes(
        b"\0embedded:" + str(donor_venv).encode()
    )

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert not (repo / "agents/venv/.cloudbench-deps-fingerprint").exists()


def test_rejects_branch_whose_manifests_do_not_match_donor_image(tmp_path: Path) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor, lock="image-lock")
    _write_manifests(repo, lock="branch-lock")
    (donor / "node_modules").mkdir(parents=True)
    (donor / "agents/venv").mkdir(parents=True)

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "warm image/volume JavaScript dependencies do not match" in result.stderr


def test_accepts_fingerprinted_volume_when_image_donor_is_older(tmp_path: Path) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor, lock="current")
    _write_manifests(repo, lock="current")
    (donor / "node_modules/current-package").mkdir(parents=True)
    (donor / "agents/venv/bin").mkdir(parents=True)
    (donor / "agents/venv/bin/python").write_text("current")
    first = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr

    _write_manifests(donor, lock="older-image")
    (donor / "node_modules/current-package").rmdir()
    (donor / "node_modules/old-package").mkdir()
    second = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert second.returncode == 0, second.stderr
    assert (repo / "node_modules/current-package").is_dir()
    assert not (repo / "node_modules/old-package").exists()


def test_current_run_artifact_ignores_stale_snapshot_results(tmp_path: Path) -> None:
    runs = tmp_path / "runs"
    runs.mkdir()
    stale = runs / "stale.json"
    stale.write_text("{}")
    marker = tmp_path / "run-start"
    marker.touch()

    result = subprocess.run(
        ["python3", str(ARTIFACT_SCRIPT), str(runs), str(marker)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout == ""

    fresh = runs / "fresh.json"
    fresh.write_text("{}")
    result = subprocess.run(
        ["python3", str(ARTIFACT_SCRIPT), str(runs), str(marker)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == str(fresh)


def test_driver_clears_snapshot_reports_before_any_failing_setup_step() -> None:
    driver = DRIVER_SCRIPT.read_text()

    assert driver.index('rm -rf "$CONTEXT_DIR"') < driver.index(
        'bash "$SYNC_DEPS_SCRIPT"'
    )
    assert '[ -f "$card" ] && [ "$card" -nt "$RUN_OUTPUT_MARKER" ]' in driver
    assert driver.index("unset CLOUDBENCH_GITHUB_TOKEN_B64") < driver.index(
        'bash "$SYNC_DEPS_SCRIPT"'
    )


def test_fleet_waits_for_every_isolated_stack_before_releasing_benchmarks() -> None:
    driver = DRIVER_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert "synchronized start barrier ready" in driver
    assert "CLOUDBENCH_START_BARRIER" in cloud
    assert "export CLOUDBENCH_START_BARRIER_WAIT_SECONDS" in cloud
    assert (
        'START_BARRIER_WAIT_SECONDS="${CLOUDBENCH_START_BARRIER_WAIT_SECONDS:-$RUN_TIMEOUT}"'
        in fleet
    )
    assert "CHILD_RUN_TIMEOUT=$((RUN_TIMEOUT + START_BARRIER_WAIT_SECONDS))" in fleet
    assert "required_lock_ttl=$((CHILD_RUN_TIMEOUT + 3600))" in fleet
    assert fleet.index('CHILD_RUN_TIMEOUT="$RUN_TIMEOUT"') < fleet.index(
        "required_lock_ttl=$((CHILD_RUN_TIMEOUT + 3600))"
    )
    run_timeout = 7200
    barrier_timeout = 7200
    child_timeout = run_timeout + barrier_timeout
    required_lock_ttl = child_timeout + 3600
    assert required_lock_ttl > child_timeout
    assert (
        'CLOUDBENCH_START_BARRIER_WAIT_SECONDS="$START_BARRIER_WAIT_SECONDS"'
        in fleet
    )
    assert '--timeout "$CHILD_RUN_TIMEOUT"' in fleet
    assert "deadline=$(( $(date +%s) + START_BARRIER_WAIT_SECONDS ))" in fleet
    assert 'CHILD_MACHINE+=("$cid")' in fleet
    assert "isolated stacks reached the synchronized start barrier" in fleet
    assert "releasing synchronized start barrier" in fleet
    assert "returning claimed pool machine" in fleet


def test_predeploy_cloud_runner_selects_the_catalog_smoke_group() -> None:
    result = subprocess.run(
        ["bash", str(PREDEPLOY_SCRIPT), "--list"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "chat-mode",
        "spawn-sub-agents",
        "parallel-tool-calls",
        "message-person",
        "claude-code-agent",
        "browser-smoke",
        "browser-biometrics-webdecoy",
    ]


def test_deploy_smoke_gate_uses_the_visible_cloud_runner() -> None:
    deploy = DEPLOY_COMMAND.read_text()
    step = deploy.split("## Step 6: Smoke benchmarks + fix", 1)[1].split(
        "## Step 6b: Semantic tests + fix", 1
    )[0]

    assert "scripts/run-predeploy-cloud" in step
    assert "Benchmarks → Runs" in step
    assert "7/7" in step
    assert "run_benchmark.py --suite smoke" not in step
    assert "git diff --name-only HEAD" in deploy
    assert "git ls-files --others --exclude-standard" in deploy


def test_cloud_patch_includes_staged_and_unstaged_tracked_changes() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert 'git -C "$ROOT_DIR" diff HEAD --binary' in cloud
    assert 'git -C "$ROOT_DIR" diff HEAD --binary' in fleet


def test_fetch_ref_never_falls_back_to_stale_fetch_head(tmp_path: Path) -> None:
    origin = tmp_path / "origin.git"
    author = tmp_path / "author"
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "init", "--bare", str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "init", str(author)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(author), "config", "user.email", "bench@example.com"], check=True)
    subprocess.run(["git", "-C", str(author), "config", "user.name", "Bench"], check=True)
    (author / "value.txt").write_text("one")
    subprocess.run(["git", "-C", str(author), "add", "value.txt"], check=True)
    subprocess.run(["git", "-C", str(author), "commit", "-m", "one"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(author), "remote", "add", "origin", str(origin)], check=True)
    subprocess.run(["git", "-C", str(author), "push", "origin", "HEAD:main"], check=True, capture_output=True)
    subprocess.run(["git", "clone", "--branch", "main", str(origin), str(checkout)], check=True, capture_output=True)
    (author / "value.txt").write_text("two")
    subprocess.run(["git", "-C", str(author), "commit", "-am", "two"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(author), "push", "origin", "HEAD:main"], check=True, capture_output=True)
    target = subprocess.check_output(["git", "-C", str(author), "rev-parse", "HEAD"], text=True).strip()

    success = subprocess.run(
        ["bash", str(FETCH_SCRIPT), str(checkout), target],
        text=True,
        capture_output=True,
        check=False,
    )
    assert success.returncode == 0, success.stderr
    assert (checkout / "value.txt").read_text() == "two"

    before = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    failure = subprocess.run(
        ["bash", str(FETCH_SCRIPT), str(checkout), "0" * 40],
        text=True,
        capture_output=True,
        check=False,
    )
    after = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    assert failure.returncode == 1
    assert "could not fetch requested ref" in failure.stderr
    assert after == before


def test_fetch_ref_keeps_auth_header_out_of_git_argv() -> None:
    fetch = FETCH_SCRIPT.read_text()

    assert "GIT_CONFIG_GLOBAL" in fetch
    assert 'chmod 600 "$auth_config"' in fetch
    assert 'fetch_args=(-c "http.extraheader=$auth")' not in fetch


def test_snapshot_selector_prefers_new_completed_incremental_snapshot() -> None:
    spec = importlib.util.spec_from_file_location("cloudbench_select_snapshot", SNAPSHOT_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    snapshots = [
        {
            "id": "uploading",
            "created_at": "0001-01-01T00:00:00Z",
            "size": 0,
            "volume_size": 20_000,
            "status": "running",
        },
        {
            "id": "current-incremental",
            "created_at": "2026-07-12T05:08:01Z",
            "size": 2_500,
            "volume_size": 20_000,
            "status": "created",
        },
        {
            "id": "old-large",
            "created_at": "2026-07-08T20:23:14Z",
            "size": 15_800,
            "volume_size": 20_000,
            "status": "created",
        },
    ]

    assert module.select_snapshot(snapshots) == "current-incremental"


def test_snapshot_clone_is_not_startable_until_its_volume_is_mountable() -> None:
    machine_id = "machine-1"
    machines = [
        {
            "id": machine_id,
            "state": "created",
            "config": {
                "mounts": [
                    {"volume": "volume-1", "path": "/data"},
                    {"volume": "volume-2", "path": "/cache"},
                ]
            },
        }
    ]

    restoring = subprocess.run(
        ["python3", str(MACHINE_READINESS_SCRIPT), machine_id],
        input=json.dumps(
            {
                "machines": machines,
                "volumes": [
                    {"id": "volume-1", "state": "created"},
                    {"id": "volume-2", "state": "restoring"},
                ],
            }
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    mountable = subprocess.run(
        ["python3", str(MACHINE_READINESS_SCRIPT), machine_id],
        input=json.dumps(
            {
                "machines": machines,
                "volumes": [
                    {"id": "volume-1", "state": "created"},
                    {"id": "volume-2", "state": "created"},
                ],
            }
        ),
        text=True,
        capture_output=True,
        check=False,
    )

    assert restoring.returncode == 1
    assert restoring.stdout.strip() == "waiting:volume-2=restoring"
    assert mountable.returncode == 0
    assert mountable.stdout.strip() == "ready"


def test_start_gate_replays_created_machine_with_restoring_volume(
    tmp_path: Path,
) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("machine_storage_ready() {")
    function_end = cloud.index("\n}\n", function_start) + 3
    readiness_function = cloud[function_start:function_end]
    machine_id = "machine-1"
    machines_path = tmp_path / "machines.json"
    volumes_path = tmp_path / "volumes.json"
    start_log = tmp_path / "starts.log"
    machines_path.write_text(
        json.dumps(
            [
                {
                    "id": machine_id,
                    "state": "created",
                    "config": {
                        "mounts": [{"volume": "volume-1", "path": "/data"}]
                    },
                }
            ]
        )
    )
    volumes_path.write_text(json.dumps([{"id": "volume-1", "state": "restoring"}]))
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_fly = fake_bin / "flyctl"
    fake_fly.write_text(
        """#!/usr/bin/env bash
set -u
if [ "$1 $2" = "machines list" ]; then cat "$MACHINES_PATH"; exit 0; fi
if [ "$1 $2" = "volumes list" ]; then cat "$VOLUMES_PATH"; exit 0; fi
if [ "$1 $2" = "machine start" ]; then
  printf '%s\n' "$*" >> "$START_LOG"
  if grep -q restoring "$VOLUMES_PATH"; then
    echo "failed_precondition: unable to start machine from current state: 'created'" >&2
    exit 1
  fi
  exit 0
fi
exit 2
"""
    )
    fake_fly.chmod(0o755)
    env = {
        "PATH": f"{fake_bin}:{Path('/usr/bin')}:{Path('/bin')}",
        "MACHINES_PATH": str(machines_path),
        "VOLUMES_PATH": str(volumes_path),
        "START_LOG": str(start_log),
        "MACHINE_READINESS_SCRIPT": str(MACHINE_READINESS_SCRIPT),
    }

    legacy = subprocess.run(
        [str(fake_fly), "machine", "start", machine_id, "-a", "bench-app"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    start_log.unlink()
    gate = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLY() {{ flyctl "$@"; }}
{readiness_function}
if machine_storage_ready {machine_id}; then
  FLY machine start {machine_id} -a "$APP"
fi
""",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert legacy.returncode == 1
    assert "failed_precondition" in legacy.stderr
    assert gate.returncode == 0, gate.stderr
    assert not start_log.exists()

    volumes_path.write_text(json.dumps([{"id": "volume-1", "state": "created"}]))
    ready_gate = subprocess.run(
        gate.args,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert ready_gate.returncode == 0, ready_gate.stderr
    assert start_log.read_text().strip() == f"machine start {machine_id} -a bench-app"


def test_fresh_clone_start_paths_honor_storage_readiness_contract() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    startup = cloud.split("# ── 1. Start the warm machine", 1)[1].split(
        "# ── 2.", 1
    )[0]

    assert 'MACHINE_READINESS_SCRIPT="$ROOT_DIR/scripts/cloudbench-machine-readiness.py"' in cloud
    assert startup.count('machine_storage_ready "$mid"') == 2
    assert startup.count('request_machine_start "$mid"') == 2
    assert startup.index('if machine_storage_ready "$mid"') < startup.index(
        'request_machine_start "$mid"'
    )
    assert 'MACHINE_READINESS_SCRIPT="$ROOT_DIR/scripts/cloudbench-machine-readiness.py"' in fleet
    provision_start = fleet.index("provision_pool() {")
    provision_end = fleet.index("\n}\n\nCLAIMED_POOL_FILE", provision_start)
    provision = fleet[provision_start:provision_end]
    assert 'st="$(fleet_machine_state "$id")"' in provision
    assert 'machine_storage_ready "$id"' in provision
    assert provision.index("cloudbench_machine_lease_acquire_retry") < provision.index(
        'cloudbench_machine_start_with_lease "$APP" "$id" "$nonce"'
    )
    retire_start = fleet.index("retire_pool_machine() {")
    retire_end = fleet.index("\n}\n\nresume_pool_retirements()", retire_start)
    retire = fleet[retire_start:retire_end]
    assert retire.index("record_pool_retirement") < retire.index(
        "cloudbench_machine_lease_acquire_retry"
    )
    assert retire.index("cloudbench_machine_lease_acquire_retry") < retire.index(
        "cloudbench_machine_destroy_with_lease"
    )
    assert 'FLY volumes destroy "$volume_id"' in retire
    claim_start = fleet.index("claim_pool_machine() {")
    claim_end = fleet.index("\n}\n", claim_start)
    claim = fleet[claim_start:claim_end]
    assert claim.index('pool_machine_provenance_valid "$id"') < claim.index(
        'machine_storage_ready "$id"'
    )
    assert '1) continue ;;' in claim
    assert '*) return 2 ;;' in claim
    assert 'FLY machine start "$id"' not in claim
    assert (
        'if machine_storage_ready "$wid"; then\n'
        '            FLY machine start "$wid"' in fleet
    )


def test_fleet_machine_state_avoids_pipefail_status_sigpipe() -> None:
    fleet = FLEET_SCRIPT.read_text()
    inventory_start = fleet.index("fly_inventory_json() {")
    inventory_end = fleet.index("\n}\n", inventory_start) + 3
    state_start = fleet.index("fleet_machine_state() {")
    state_end = fleet.index("\n}\n", state_start) + 3
    state_function = fleet[inventory_start:inventory_end] + fleet[state_start:state_end]

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLY() {{
  if [ "$1 $2" = "machine status" ]; then
    python3 -c 'import os; os.write(1, b"State: stopped\\n" + b"x" * 1000000)'
    return
  fi
  printf '%s\\n' '[{{"id":"machine-1","state":"stopped"}}]'
}}
set +e
FLY machine status machine-1 -a bench-app 2>/dev/null | grep -qiE 'State.*(started|stopped)'
legacy_status=$?
set -e
{state_function}
printf 'legacy=%s\\n' "$legacy_status"
fleet_machine_state machine-1
""",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    lines = result.stdout.splitlines()
    assert lines[-1] == "stopped"
    assert int(lines[-2].split("=", 1)[1]) != 0


def test_fly_inventory_retries_transport_and_invalid_json_before_image_read(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    assert 'FLY machines list -a "$APP" --json' not in fleet
    assert 'FLY volumes list -a "$APP" --json' not in fleet
    assert 'warm_json="$(fly_inventory_json machines)"' in fleet
    assert 'volume_json="$(fly_inventory_json volumes)"' in fleet
    inventory_start = fleet.index("fly_inventory_json() {")
    inventory_end = fleet.index("\n}\n", inventory_start) + 3
    image_start = fleet.index("fleet_machine_image() {")
    image_end = fleet.index("\n}\n", image_start) + 3
    functions = fleet[inventory_start:inventory_end] + fleet[image_start:image_end]
    calls_file = tmp_path / "calls"

    def read_image(mode: str) -> subprocess.CompletedProcess[str]:
        calls_file.write_text("0\n")
        return subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
CLOUDBENCH_FLY_INVENTORY_ATTEMPTS=3
CLOUDBENCH_FLY_INVENTORY_RETRY_DELAY=0
FLY() {{
  count="$(cat "$CALLS_FILE")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$CALLS_FILE"
  if [ "$MODE" = transport ] && [ "$count" -eq 1 ]; then return 7; fi
  if [ "$MODE" = invalid ] && [ "$count" -eq 1 ]; then printf '{{invalid\n'; return 0; fi
  if [ "$MODE" = exhausted ]; then printf '{{invalid\n'; return 0; fi
  printf '[{{"id":"machine-1","config":{{"image":"registry.example/bench@sha256:abc"}}}}]\n'
}}
{functions}
fleet_machine_image machine-1
""",
            ],
            env={
                "PATH": f"/usr/bin:/bin",
                "CALLS_FILE": str(calls_file),
                "MODE": mode,
            },
            text=True,
            capture_output=True,
            check=False,
        )

    transport = read_image("transport")
    assert transport.returncode == 0, transport.stderr
    assert transport.stdout.strip() == "registry.example/bench@sha256:abc"
    assert calls_file.read_text().strip() == "2"

    invalid = read_image("invalid")
    assert invalid.returncode == 0, invalid.stderr
    assert invalid.stdout.strip() == "registry.example/bench@sha256:abc"
    assert calls_file.read_text().strip() == "2"

    exhausted = read_image("exhausted")
    assert exhausted.returncode == 2
    assert exhausted.stdout == ""
    assert calls_file.read_text().strip() == "3"


def test_pool_provenance_validates_snapshot_and_live_image(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    functions = fleet[image_start:validator_end]
    provenance = tmp_path / "pool.provenance.tsv"
    image = "registry.example/bench@sha256:current"
    provenance.write_text(f"abc123\twarm-1\tsnapshot-1\t{image}\tvol-1\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-1
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
LIVE_IMAGE="$EXPECTED_IMAGE"
FLY() {{
  printf '[{{"id":"abc123","config":{{"image":"%s"}}}}]\\n' "$LIVE_IMAGE"
}}
{functions}
pool_machine_provenance_valid abc123
printf 'valid\\n'
LIVE_IMAGE=registry.example/bench@sha256:stale
if pool_machine_provenance_valid abc123 >/dev/null 2>&1; then exit 31; fi
printf 'stale-image-rejected\\n'
LIVE_IMAGE="$EXPECTED_IMAGE"
SNAP_ID=snapshot-2
if pool_machine_provenance_valid abc123 >/dev/null 2>&1; then exit 32; fi
printf 'stale-snapshot-rejected\\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "valid",
        "stale-image-rejected",
        "stale-snapshot-rejected",
    ]


def test_normal_startup_migrates_legacy_volume_binding_before_validation(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    validate_start = fleet.index("validate_tracked_pool_provenance() {")
    validate_end = fleet.index("\n}\n", validate_start) + 3
    validate_function = fleet[validate_start:validate_end]
    volume_start = fleet.index("fleet_machine_volume_ids() {")
    upgrade_start = fleet.index("upgrade_pool_provenance_volume_bindings() {")
    volume_functions = fleet[volume_start:upgrade_start]
    upgrade_end = fleet.index("\n}\n\nrecord_pool_retirement()", upgrade_start) + 3
    upgrade_function = fleet[upgrade_start:upgrade_end]
    pool_file = tmp_path / "pool.ids"
    provenance_file = tmp_path / "pool.provenance.tsv"
    image = "registry.example/bench@sha256:current"
    pool_file.write_text("abc111\n")
    provenance_file.write_text(f"abc111\twarm-1\tsnapshot-1\t{image}\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-1
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
pool_machine_state() {{ printf 'stopped\n'; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    printf '[{{"id":"vol-1","attached_machine_id":"abc111"}}]\n'
  else
    printf '[{{"id":"abc111","config":{{"image":"%s"}}}}]\n' "$EXPECTED_IMAGE"
  fi
}}
{provenance_functions}
{validate_function}
{volume_functions}
{upgrade_function}
upgrade_pool_provenance_volume_bindings
validate_tracked_pool_provenance
cat "$POOL_PROVENANCE_FILE"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "PROVENANCE_FILE": str(provenance_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-1] == (
        f"abc111\twarm-1\tsnapshot-1\t{image}\tvol-1"
    )
    normal_startup = fleet[fleet.index("# --provision-pool:") : fleet.index("CODE_SUMMARY=\"\"")]
    assert normal_startup.index("upgrade_pool_provenance_volume_bindings || exit 1") < (
        normal_startup.index("validate_tracked_pool_provenance || exit 1")
    )


def test_fleet_run_directory_exists_before_provision_mode_dispatch() -> None:
    fleet = FLEET_SCRIPT.read_text()
    controller_acquire = fleet.index(
        'if ! cloudbench_controller_wait_acquire "$LOCK_DIR" "$APP"; then'
    )
    provision_dispatch = fleet.index("# --provision-pool:")
    run_dir_create = fleet.index('mkdir -p "$FLEET_DIR"', controller_acquire)

    assert controller_acquire < run_dir_create < provision_dispatch


def test_pool_provisioning_rotates_stale_snapshot_capacity_under_lease(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    validate_start = fleet.index("validate_tracked_pool_provenance() {")
    validate_end = fleet.index("\n}\n", validate_start) + 3
    validate_function = fleet[validate_start:validate_end]
    provision_start = fleet.index("provision_pool() {")
    provision_end = fleet.index("\n}\n\nCLAIMED_POOL_FILE", provision_start) + 3
    provision_function = fleet[provision_start:provision_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    pool_file = tmp_path / "pool.ids"
    provenance_file = tmp_path / "pool.provenance.tsv"
    fleet_dir = tmp_path / "run"
    machine_present_file = tmp_path / "machine-present"
    volume_present_file = tmp_path / "volume-present"
    operations_file = tmp_path / "operations"
    old_id = "abc111"
    new_id = "def222"
    image = "registry.example/bench@sha256:current"
    pool_file.write_text(f"{old_id}\n")
    provenance_file.write_text(f"{old_id}\twarm-1\tsnapshot-old\t{image}\n")
    machine_present_file.write_text("1\n")
    volume_present_file.write_text("1\n")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$FLEET_DIR_PATH/pool.retirement.tsv"
FLEET_DIR="$FLEET_DIR_PATH"
OWNED_CLONES_FILE="$FLEET_DIR/owned-clones.ids"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
REGION=ord
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
mkdir -p "$FLEET_DIR"
touch "$OWNED_CLONES_FILE"
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$VOLUME_PRESENT_FILE")" = 1 ]; then
      if [ "$(cat "$MACHINE_PRESENT_FILE")" = 1 ]; then
        printf '[{{"id":"vol-old","attached_machine_id":"{old_id}"}}]\n'
      else
        printf '[{{"id":"vol-old","attached_machine_id":null}}]\n'
      fi
    else
      printf '[{{"id":"vol-new","attached_machine_id":"{new_id}"}}]\n'
    fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf 'volume-destroy:%s\n' "$3" >> "$OPERATIONS_FILE"
    printf '0\n' > "$VOLUME_PRESENT_FILE"
    return
  fi
  printf '[{{"id":"{old_id}","config":{{"image":"%s"}}}},{{"id":"{new_id}","config":{{"image":"%s"}}}}]\n' \
    "$EXPECTED_IMAGE" "$EXPECTED_IMAGE"
}}
pool_machine_state() {{
  if [ "$1" = {old_id} ] && [ "$(cat "$MACHINE_PRESENT_FILE")" = 0 ]; then return 1; fi
  printf 'stopped\n'
}}
fleet_machine_state() {{ printf 'stopped\n'; }}
machine_storage_ready() {{ return 0; }}
cloudbench_machine_lease_acquire_retry() {{
  printf 'lease:%s\n' "$2" >> "$OPERATIONS_FILE"
  printf 'retirement-nonce\n'
}}
cloudbench_machine_destroy_with_lease() {{
  printf 'destroy:%s:%s\n' "$2" "$3" >> "$OPERATIONS_FILE"
  printf '0\n' > "$MACHINE_PRESENT_FILE"
}}
clone_machine_target() {{ printf '%s\n' '{new_id}' >> "$1"; printf '%s' '{new_id}'; }}
cloudbench_machine_start_with_lease() {{ return 0; }}
cloudbench_machine_stop_and_release_lease() {{ return 0; }}
sleep() {{ :; }}
{provenance_functions}
{validate_function}
{retirement_functions}
{provision_function}
if validate_tracked_pool_provenance >/dev/null 2>&1; then exit 61; fi
provision_pool 1
printf 'pool=%s\n' "$(paste -sd, "$POOL_IDS_FILE")"
printf 'retirement-rows=%s\n' "$(grep -c . "$POOL_RETIREMENT_FILE" || true)"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "PROVENANCE_FILE": str(provenance_file),
            "FLEET_DIR_PATH": str(fleet_dir),
            "MACHINE_PRESENT_FILE": str(machine_present_file),
            "VOLUME_PRESENT_FILE": str(volume_present_file),
            "OPERATIONS_FILE": str(operations_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"pool={new_id}" in result.stdout
    assert "retirement-rows=0" in result.stdout
    assert operations_file.read_text().splitlines() == [
        f"lease:{old_id}",
        f"destroy:{old_id}:retirement-nonce",
        "volume-destroy:vol-old",
    ]
    assert pool_file.read_text() == f"{new_id}\n"
    assert provenance_file.read_text() == (
        f"{new_id}\twarm-1\tsnapshot-current\t{image}\tvol-new\n"
    )


def test_pool_provisioning_retires_bound_volume_when_tracked_machine_disappears(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    provision_start = fleet.index("provision_pool() {")
    provision_end = fleet.index("\n}\n\nCLAIMED_POOL_FILE", provision_start) + 3
    provision_function = fleet[provision_start:provision_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    pool_file = tmp_path / "pool.ids"
    provenance_file = tmp_path / "pool.provenance.tsv"
    fleet_dir = tmp_path / "run"
    volume_present_file = tmp_path / "volume-present"
    operations_file = tmp_path / "operations"
    old_id = "abc111"
    new_id = "def222"
    image = "registry.example/bench@sha256:current"
    pool_file.write_text(f"{old_id}\n")
    provenance_file.write_text(
        f"{old_id}\twarm-1\tsnapshot-current\t{image}\tvol-old\n"
    )
    volume_present_file.write_text("1\n")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$FLEET_DIR_PATH/pool.retirement.tsv"
FLEET_DIR="$FLEET_DIR_PATH"
OWNED_CLONES_FILE="$FLEET_DIR/owned-clones.ids"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
REGION=ord
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
mkdir -p "$FLEET_DIR"
touch "$OWNED_CLONES_FILE"
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$VOLUME_PRESENT_FILE")" = 1 ]; then
      printf '[{{"id":"vol-old","attached_machine_id":null}},{{"id":"vol-new","attached_machine_id":"{new_id}","state":"created"}}]\n'
    else
      printf '[{{"id":"vol-new","attached_machine_id":"{new_id}","state":"created"}}]\n'
    fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf 'volume-destroy:%s\n' "$3" >> "$OPERATIONS_FILE"
    printf '0\n' > "$VOLUME_PRESENT_FILE"
    return
  fi
  printf '[{{"id":"{new_id}","state":"stopped","config":{{"image":"%s"}}}}]\n' "$EXPECTED_IMAGE"
}}
pool_machine_state() {{
  [ "$1" = {old_id} ] && return 1
  printf 'stopped\n'
}}
fleet_machine_state() {{ printf 'stopped\n'; }}
machine_storage_ready() {{ return 0; }}
cloudbench_machine_lease_acquire_retry() {{
  printf 'unexpected-lease:%s\n' "$2" >> "$OPERATIONS_FILE"
  return 1
}}
cloudbench_machine_destroy_with_lease() {{
  printf 'unexpected-machine-destroy:%s\n' "$2" >> "$OPERATIONS_FILE"
  return 1
}}
clone_machine_target() {{ printf '%s\n' '{new_id}' >> "$1"; printf '%s' '{new_id}'; }}
cloudbench_machine_start_with_lease() {{ return 0; }}
cloudbench_machine_stop_and_release_lease() {{ return 0; }}
sleep() {{ :; }}
{provenance_functions}
{retirement_functions}
{provision_function}
provision_pool 1
printf 'pool=%s\n' "$(paste -sd, "$POOL_IDS_FILE")"
printf 'retirement-rows=%s\n' "$(grep -c . "$POOL_RETIREMENT_FILE" || true)"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "PROVENANCE_FILE": str(provenance_file),
            "FLEET_DIR_PATH": str(fleet_dir),
            "VOLUME_PRESENT_FILE": str(volume_present_file),
            "OPERATIONS_FILE": str(operations_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"pool={new_id}" in result.stdout
    assert "retirement-rows=0" in result.stdout
    assert operations_file.read_text().splitlines() == ["volume-destroy:vol-old"]
    assert volume_present_file.read_text() == "0\n"
    assert pool_file.read_text() == f"{new_id}\n"
    assert provenance_file.read_text() == (
        f"{new_id}\twarm-1\tsnapshot-current\t{image}\tvol-new\n"
    )


def test_missing_pool_machine_cannot_resume_retirement_of_volume_attached_elsewhere(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    image = "registry.example/bench@sha256:current"
    provenance_file.write_text(
        f"abc111\twarm-1\tsnapshot-current\t{image}\tvol-owned\n"
    )
    retirement_file.write_text(
        f"abc111\tvol-owned\twarm-1\tsnapshot-current\t{image}\tvol-owned\n"
    )
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ return 1; }}
cloudbench_machine_lease_acquire_retry() {{ printf 'lease\n' >> "$OPERATIONS_FILE"; return 1; }}
cloudbench_machine_destroy_with_lease() {{ printf 'machine-destroy\n' >> "$OPERATIONS_FILE"; return 1; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    printf '[{{"id":"vol-owned","attached_machine_id":"other999"}}]\n'
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then printf 'volume-destroy\n' >> "$OPERATIONS_FILE"; return; fi
  return 2
}}
{provenance_functions}
{retirement_functions}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 111; fi
[ ! -s "$OPERATIONS_FILE" ] || exit 112
[ "$(grep -c . "$POOL_RETIREMENT_FILE")" -eq 1 ] || exit 113
printf 'attached-orphan-rejected\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["attached-orphan-rejected"]
    assert retirement_file.read_text() == (
        f"abc111\tvol-owned\twarm-1\tsnapshot-current\t{image}\tvol-owned\n"
    )


def test_orphan_volume_check_rejects_missing_attachment_schema() -> None:
    fleet = FLEET_SCRIPT.read_text()
    helper_start = fleet.index("fleet_orphan_volume_safe_for_missing_machine() {")
    helper_end = fleet.index("\n}\n\npool_retirement_target_stably_detached()", helper_start) + 3
    helper_function = fleet[helper_start:helper_end]

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLY() {{ printf '[{{"id":"vol-owned"}}]\n'; }}
{helper_function}
if fleet_orphan_volume_safe_for_missing_machine vol-owned; then exit 116; fi
printf 'missing-attachment-rejected\n'
""",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["missing-attachment-rejected"]


def test_partial_pool_retirement_journal_cannot_delete_a_volume_subset(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    volume_one_present_file = tmp_path / "volume-one-present"
    image = "registry.example/bench@sha256:current"
    provenance_file.write_text(
        f"abc111\twarm-1\tsnapshot-current\t{image}\tvol-one,vol-two\n"
    )
    retirement_file.write_text(
        f"abc111\tvol-one\twarm-1\tsnapshot-current\t{image}\tvol-one,vol-two\n"
    )
    operations_file.write_text("")
    volume_one_present_file.write_text("1\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ return 1; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$VOLUME_ONE_PRESENT_FILE")" = 1 ]; then
      printf '[{{"id":"vol-one","attached_machine_id":null}},{{"id":"vol-two","attached_machine_id":null}}]\n'
    else
      printf '[{{"id":"vol-two","attached_machine_id":null}}]\n'
    fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf 'volume-destroy:%s\n' "$3" >> "$OPERATIONS_FILE"
    printf '0\n' > "$VOLUME_ONE_PRESENT_FILE"
    return
  fi
  return 2
}}
{provenance_functions}
{retirement_functions}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 121; fi
[ ! -s "$OPERATIONS_FILE" ] || exit 122
printf 'partial-retirement-rejected\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "VOLUME_ONE_PRESENT_FILE": str(volume_one_present_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["partial-retirement-rejected"]


def test_pool_retirement_journal_failure_prevents_live_machine_destroy(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    old_image = "registry.example/bench@sha256:old"
    provenance_file.write_text(
        f"abc111\twarm-old\tsnapshot-old\t{old_image}\tvol-owned\n"
    )
    retirement_file.write_text("")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-current
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY=registry.example/bench@sha256:current
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ printf 'stopped\n'; }}
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    printf '[{{"id":"abc111","config":{{"image":"%s"}}}}]\n' "$OLD_IMAGE"
    return
  fi
  if [ "$1 $2" = "volumes list" ]; then
    printf '[{{"id":"vol-owned","attached_machine_id":"abc111"}}]\n'
    return
  fi
  return 2
}}
cloudbench_machine_lease_acquire_retry() {{ printf 'lease\n' >> "$OPERATIONS_FILE"; printf 'nonce\n'; }}
cloudbench_machine_destroy_with_lease() {{ printf 'machine-destroy\n' >> "$OPERATIONS_FILE"; return 1; }}
{provenance_functions}
{retirement_functions}
record_pool_retirement() {{ return 1; }}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 131; fi
[ ! -s "$OPERATIONS_FILE" ] || exit 132
printf 'journal-failure-rejected\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "OLD_IMAGE": old_image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["journal-failure-rejected"]


def test_pool_retirement_revalidates_detachment_before_volume_destroy_retry(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    attached_file = tmp_path / "attached"
    image = "registry.example/bench@sha256:current"
    provenance_file.write_text(
        f"abc111\twarm-1\tsnapshot-current\t{image}\tvol-owned\n"
    )
    retirement_file.write_text(
        f"abc111\tvol-owned\twarm-1\tsnapshot-current\t{image}\tvol-owned\n"
    )
    operations_file.write_text("")
    attached_file.write_text("0\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ return 1; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$ATTACHED_FILE")" = 1 ]; then
      printf '[{{"id":"vol-owned","attached_machine_id":"other999"}}]\n'
    else
      printf '[{{"id":"vol-owned","attached_machine_id":null}}]\n'
    fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf 'volume-destroy:%s\n' "$3" >> "$OPERATIONS_FILE"
    printf '1\n' > "$ATTACHED_FILE"
    return 1
  fi
  return 2
}}
sleep() {{ :; }}
{provenance_functions}
{retirement_functions}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 141; fi
[ "$(grep -c '^volume-destroy:' "$OPERATIONS_FILE")" -eq 1 ] || exit 142
[ "$(grep -c . "$POOL_RETIREMENT_FILE")" -eq 1 ] || exit 143
printf 'retry-attachment-rejected\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "ATTACHED_FILE": str(attached_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["retry-attachment-rejected"]


def test_multi_volume_pool_retirement_resumes_with_full_journal_after_partial_failure(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    volume_b_present_file = tmp_path / "volume-b-present"
    destroy_fails_file = tmp_path / "destroy-fails"
    image = "registry.example/bench@sha256:current"
    provenance_file.write_text(
        f"abc111\twarm-1\tsnapshot-current\t{image}\tvol-a,vol-b\n"
    )
    retirement_file.write_text(
        f"abc111\tvol-a\twarm-1\tsnapshot-current\t{image}\tvol-a,vol-b\n"
        f"abc111\tvol-b\twarm-1\tsnapshot-current\t{image}\tvol-a,vol-b\n"
    )
    operations_file.write_text("")
    volume_b_present_file.write_text("1\n")
    destroy_fails_file.write_text("1\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ return 1; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$VOLUME_B_PRESENT_FILE")" = 1 ]; then
      printf '[{{"id":"vol-b","attached_machine_id":null}}]\n'
    else
      printf '[]\n'
    fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf 'volume-destroy:%s\n' "$3" >> "$OPERATIONS_FILE"
    if [ "$(cat "$DESTROY_FAILS_FILE")" = 1 ]; then return 1; fi
    printf '0\n' > "$VOLUME_B_PRESENT_FILE"
    return
  fi
  return 2
}}
sleep() {{ :; }}
{provenance_functions}
{retirement_functions}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 151; fi
[ "$(grep -c . "$POOL_RETIREMENT_FILE")" -eq 2 ] || exit 152
printf '0\n' > "$DESTROY_FAILS_FILE"
resume_pool_retirements
[ "$(grep -c . "$POOL_RETIREMENT_FILE" || true)" -eq 0 ] || exit 153
printf 'partial-retirement-resumed\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "VOLUME_B_PRESENT_FILE": str(volume_b_present_file),
            "DESTROY_FAILS_FILE": str(destroy_fails_file),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-1] == "partial-retirement-resumed"
    assert operations_file.read_text().splitlines() == [
        "volume-destroy:vol-b",
        "volume-destroy:vol-b",
        "volume-destroy:vol-b",
        "volume-destroy:vol-b",
        "volume-destroy:vol-b",
        "volume-destroy:vol-b",
    ]


def test_pool_provisioning_rejects_stopped_capacity_with_unready_storage(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    provision_start = fleet.index("provision_pool() {")
    provision_end = fleet.index("\n}\n\nCLAIMED_POOL_FILE", provision_start) + 3
    provision_function = fleet[provision_start:provision_end]
    pool_file = tmp_path / "pool.ids"
    provenance_file = tmp_path / "pool.provenance.tsv"
    fleet_dir = tmp_path / "run"
    machine_id = "abc111"
    image = "registry.example/bench@sha256:current"
    pool_file.write_text(f"{machine_id}\n")
    provenance_file.write_text(
        f"{machine_id}\twarm-1\tsnapshot-current\t{image}\tvol-1\n"
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$FLEET_DIR_PATH/pool.retirement.tsv"
FLEET_DIR="$FLEET_DIR_PATH"
OWNED_CLONES_FILE="$FLEET_DIR/owned-clones.ids"
WARM_ID=warm-1
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY="$EXPECTED_IMAGE"
REGION=ord
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
mkdir -p "$FLEET_DIR"
touch "$OWNED_CLONES_FILE"
FLY() {{ printf '[{{"id":"{machine_id}","config":{{"image":"%s"}}}}]\n' "$EXPECTED_IMAGE"; }}
pool_machine_state() {{ printf 'stopped\n'; }}
fleet_machine_state() {{ printf 'stopped\n'; }}
machine_storage_ready() {{ return 1; }}
upgrade_pool_provenance_volume_bindings() {{ return 0; }}
resume_pool_retirements() {{ return 0; }}
sleep() {{ :; }}
{provenance_functions}
{provision_function}
if provision_pool 1 >/dev/null 2>&1; then exit 71; fi
printf 'unready-storage-rejected\n'
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "PROVENANCE_FILE": str(provenance_file),
            "FLEET_DIR_PATH": str(fleet_dir),
            "EXPECTED_IMAGE": image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["unready-storage-rejected"]


def test_pool_retirement_resumes_volume_cleanup_after_machine_disappears(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    retirement_file = tmp_path / "pool.retirement.tsv"
    provenance_file = tmp_path / "pool.provenance.tsv"
    volume_present_file = tmp_path / "volume-present"
    operations_file = tmp_path / "operations"
    image = "registry.example/bench@sha256:old"
    provenance_file.write_text(f"abc111\twarm-old\tsnapshot-old\t{image}\tvol-old\n")
    retirement_file.write_text(
        f"abc111\tvol-old\twarm-old\tsnapshot-old\t{image}\tvol-old\n"
    )
    volume_present_file.write_text("1\n")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
WARM_ID=warm-current
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY=registry.example/bench@sha256:current
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ return 1; }}
cloudbench_machine_lease_acquire_retry() {{ exit 81; }}
FLY() {{
  if [ "$1 $2" = "volumes list" ]; then
    if [ "$(cat "$VOLUME_PRESENT_FILE")" = 1 ]; then printf '[{{"id":"vol-old","attached_machine_id":null}}]\n'; else printf '[]\n'; fi
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then
    printf '%s\n' "$3" >> "$OPERATIONS_FILE"
    printf '0\n' > "$VOLUME_PRESENT_FILE"
    return
  fi
  return 2
}}
sleep() {{ :; }}
{provenance_functions}
{retirement_functions}
resume_pool_retirements
printf 'remaining=%s\n' "$(grep -c . "$POOL_RETIREMENT_FILE" || true)"
""",
        ],
        env={
            "RETIREMENT_FILE": str(retirement_file),
            "PROVENANCE_FILE": str(provenance_file),
            "VOLUME_PRESENT_FILE": str(volume_present_file),
            "OPERATIONS_FILE": str(operations_file),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "remaining=0" in result.stdout
    assert operations_file.read_text().splitlines() == ["vol-old"]


def test_pool_provisioning_never_retires_unverified_machine_ids(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    provision_start = fleet.index("provision_pool() {")
    provision_end = fleet.index("\n}\n\nCLAIMED_POOL_FILE", provision_start) + 3
    provision_function = fleet[provision_start:provision_end]
    image = "registry.example/bench@sha256:recorded"

    cases = {
        "missing": "",
        "duplicate": (
            f"abc111\twarm-old\tsnapshot-old\t{image}\tvol-1\n"
            f"abc111\twarm-old\tsnapshot-old\t{image}\tvol-1\n"
        ),
        "live-image-mismatch": f"abc111\twarm-old\tsnapshot-old\t{image}\tvol-1\n",
        "unreadable-live-image": f"abc111\twarm-old\tsnapshot-old\t{image}\tvol-1\n",
    }
    for case_name, provenance_text in cases.items():
        case_dir = tmp_path / case_name
        case_dir.mkdir()
        pool_file = case_dir / "pool.ids"
        provenance_file = case_dir / "pool.provenance.tsv"
        retirement_log = case_dir / "retired.ids"
        pool_file.write_text("abc111\n")
        provenance_file.write_text(provenance_text)
        live_payload = (
            "not-json"
            if case_name == "unreadable-live-image"
            else json.dumps(
                [
                    {
                        "id": "abc111",
                        "config": {
                            "image": (
                                "registry.example/bench@sha256:different"
                                if case_name == "live-image-mismatch"
                                else image
                            )
                        },
                    }
                ]
            )
        )

        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$CASE_DIR/pool.retirement.tsv"
FLEET_DIR="$CASE_DIR/run"
OWNED_CLONES_FILE="$FLEET_DIR/owned-clones.ids"
WARM_ID=warm-current
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY=registry.example/bench@sha256:current
REGION=ord
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
mkdir -p "$FLEET_DIR"
touch "$OWNED_CLONES_FILE"
FLY() {{ printf '%s\n' "$LIVE_PAYLOAD"; }}
pool_machine_state() {{ printf 'stopped\n'; }}
upgrade_pool_provenance_volume_bindings() {{ return 0; }}
resume_pool_retirements() {{ return 0; }}
retire_pool_machine() {{ printf '%s\n' "$1" >> "$RETIREMENT_LOG"; }}
{provenance_functions}
{provision_function}
if provision_pool 1 >/dev/null 2>&1; then exit 91; fi
[ ! -e "$RETIREMENT_LOG" ] || exit 92
printf 'rejected:%s\n' "$CASE_NAME"
""",
            ],
            env={
                "POOL_FILE": str(pool_file),
                "PROVENANCE_FILE": str(provenance_file),
                "CASE_DIR": str(case_dir),
                "RETIREMENT_LOG": str(retirement_log),
                "LIVE_PAYLOAD": live_payload,
                "CASE_NAME": case_name,
            },
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, f"{case_name}: {result.stderr}"
        assert result.stdout.splitlines() == [f"rejected:{case_name}"]


def test_corrupt_retirement_record_cannot_delete_machine_or_volume(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    image_start = fleet.index("fly_inventory_json() {")
    validator_end = fleet.index("\n}\n\nvalidate_tracked_pool_provenance()", image_start) + 3
    provenance_functions = fleet[image_start:validator_end]
    retirement_start = fleet.index("fleet_machine_volume_ids() {")
    retirement_end = fleet.index("\n}\n\nprovision_pool()", retirement_start) + 3
    retirement_functions = fleet[retirement_start:retirement_end]
    provenance_file = tmp_path / "pool.provenance.tsv"
    retirement_file = tmp_path / "pool.retirement.tsv"
    operations_file = tmp_path / "operations"
    old_image = "registry.example/bench@sha256:old"
    provenance_file.write_text(
        f"abc111\twarm-old\tsnapshot-old\t{old_image}\tvol-owned\n"
    )
    retirement_file.write_text(
        f"abc111\tvol-unrelated\twarm-old\tsnapshot-old\t{old_image}\tvol-owned\n"
    )
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_PROVENANCE_FILE="$PROVENANCE_FILE"
POOL_RETIREMENT_FILE="$RETIREMENT_FILE"
WARM_ID=warm-current
SNAP_ID=snapshot-current
WARM_IMAGE_IDENTITY=registry.example/bench@sha256:current
RUN_ID=test-run
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{ printf 'stopped\n'; }}
cloudbench_machine_lease_acquire_retry() {{ printf 'lease\n' >> "$OPERATIONS_FILE"; printf 'nonce\n'; }}
cloudbench_machine_destroy_with_lease() {{ printf 'machine-destroy\n' >> "$OPERATIONS_FILE"; }}
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    printf '[{{"id":"abc111","config":{{"image":"%s"}}}}]\n' "$OLD_IMAGE"
    return
  fi
  if [ "$1 $2" = "volumes list" ]; then
    printf '[{{"id":"vol-owned","attached_machine_id":"abc111"}},{{"id":"vol-unrelated"}}]\n'
    return
  fi
  if [ "$1 $2" = "volumes destroy" ]; then printf 'volume-destroy\n' >> "$OPERATIONS_FILE"; return; fi
  return 2
}}
{provenance_functions}
{retirement_functions}
if retire_pool_machine abc111 >/dev/null 2>&1; then exit 101; fi
[ ! -s "$OPERATIONS_FILE" ] || exit 102
printf 'corrupt-retirement-rejected\n'
""",
        ],
        env={
            "PROVENANCE_FILE": str(provenance_file),
            "RETIREMENT_FILE": str(retirement_file),
            "OPERATIONS_FILE": str(operations_file),
            "OLD_IMAGE": old_image,
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["corrupt-retirement-rejected"]


def test_fleet_children_cannot_replace_persistent_warm_state() -> None:
    cloud = CLOUD_SCRIPT.read_text()

    assert '[ -n "$FLEET_MACHINE_ID" ] && return 0' in cloud


def test_persistent_pool_logs_use_run_scoped_terminal_markers() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()

    assert 'DONE_MARKER="::CLOUDBENCH-DONE:: token=$RUN_LOG_TOKEN"' in cloud
    assert 'export CLOUDBENCH_RUN_TOKEN=' in cloud
    assert "RUNSTAMP-$RUN_LOG_TOKEN" in cloud
    assert 'LOG_RESET_ATTEMPTS="${CLOUDBENCH_LOG_RESET_ATTEMPTS:-20}"' in cloud
    assert 'for _ in $(seq 1 "$LOG_RESET_ATTEMPTS")' in cloud
    assert 'local attempts="${CLOUDBENCH_STAGE_ATTEMPTS:-20}"' in cloud
    assert 'stage_cloudbench_payload "$mid" "$STAGE_BUNDLE"' in cloud
    assert 'DONE_MARKER="::CLOUDBENCH-DONE::$MARKER_SUFFIX"' in driver
    assert 'MARKER_SUFFIX=" token=$CLOUDBENCH_RUN_TOKEN"' in driver


def test_cloudbench_payload_staging_uses_one_upload_per_attempt() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    stage_start = cloud.index("stage_cloudbench_payload() {")
    stage_end = cloud.index("\n}\n", stage_start) + 3
    stage_function = cloud[stage_start:stage_end]

    assert stage_function.count("FLY ssh sftp put") == 1
    assert '"$local_bundle" "$remote_bundle"' in stage_function
    assert "cloudbench-run.sh" not in stage_function
    assert "cloudbench-fetch-ref.sh" not in stage_function
    assert "cloudbench-sync-deps.sh" not in stage_function
    assert "cloudbench-current-run-artifact.py" not in stage_function
    assert "cloudbench-prepare-patch.sh" not in stage_function

    for payload_name in (
        "cloudbench-run.sh",
        "cloudbench-fetch-ref.sh",
        "cloudbench-sync-deps.sh",
        "cloudbench-current-run-artifact.py",
        "cloudbench-prepare-patch.sh",
    ):
        assert payload_name in cloud
    assert 'write_cloudbench_stage_bundle "$STAGE_BUNDLE"' in cloud


def test_cloudbench_payload_staging_retries_upload_without_refanning_helpers(
    tmp_path: Path,
) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    stage_start = cloud.index("stage_cloudbench_payload() {")
    stage_end = cloud.index("\n}\n", stage_start) + 3
    stage_function = cloud[stage_start:stage_end]
    calls_file = tmp_path / "upload-calls"
    upload_count_file = tmp_path / "upload-count"
    install_count_file = tmp_path / "install-count"
    stage_error_file = tmp_path / "stage-error"
    bundle_file = tmp_path / "payload.sh"
    bundle_file.write_text("payload\n")
    calls_file.write_text("")
    upload_count_file.write_text("0\n")
    install_count_file.write_text("0\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
{stage_function}
APP=bench-app
FLY() {{
  printf '%s\\n' "$*" >> "$CALLS_FILE"
  n=$(cat "$UPLOAD_COUNT_FILE")
  n=$((n + 1))
  printf '%s\\n' "$n" > "$UPLOAD_COUNT_FILE"
  if [ "$n" -lt 3 ]; then
    printf 'Error: failed to list active VMs: rate limited\\n' >&2
    return 1
  fi
}}
ssh_read() {{
  n=$(cat "$INSTALL_COUNT_FILE")
  n=$((n + 1))
  printf '%s\\n' "$n" > "$INSTALL_COUNT_FILE"
  [ "$n" -ge 3 ] && printf 'WROTE\\n'
}}
CLOUDBENCH_STAGE_ATTEMPTS=8
CLOUDBENCH_STAGE_REUPLOAD_AFTER=99
CLOUDBENCH_STAGE_RETRY_DELAY_SECONDS=0
stage_cloudbench_payload machine-1 "$BUNDLE_FILE" /tmp/payload.sh "$STAGE_ERROR_FILE"
""",
        ],
        env={
            "CALLS_FILE": str(calls_file),
            "UPLOAD_COUNT_FILE": str(upload_count_file),
            "INSTALL_COUNT_FILE": str(install_count_file),
            "STAGE_ERROR_FILE": str(stage_error_file),
            "BUNDLE_FILE": str(bundle_file),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = calls_file.read_text().splitlines()
    assert len(calls) == 3
    assert all("ssh sftp put" in call for call in calls)
    assert all("machine-1" in call for call in calls)
    assert install_count_file.read_text().strip() == "3"


def test_cloudbench_stage_bundle_is_valid_with_and_without_a_patch(
    tmp_path: Path,
) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    append_start = cloud.index("append_cloudbench_stage_file() {")
    append_end = cloud.index("\n}\n", append_start) + 3
    write_start = cloud.index("write_cloudbench_stage_bundle() {")
    write_end = cloud.index("\n}\n", write_start) + 3
    functions = cloud[append_start:append_end] + cloud[write_start:write_end]

    repo = tmp_path / "repo"
    scripts = repo / "scripts"
    scripts.mkdir(parents=True)
    payload_names = (
        "cloudbench-run.sh",
        "cloudbench-fetch-ref.sh",
        "cloudbench-sync-deps.sh",
        "cloudbench-current-run-artifact.py",
        "cloudbench-prepare-patch.sh",
    )
    for payload_name in payload_names:
        (scripts / payload_name).write_text(f"payload:{payload_name}\n")
    wrapper = tmp_path / "wrapper.sh"
    wrapper.write_text("exec bash /data/cloudbench-run.sh\n")
    patch = tmp_path / "change.patch"
    patch.write_bytes(b"binary-patch\x00content\n")

    for label, patch_path in (("clean", ""), ("patched", str(patch))):
        bundle = tmp_path / f"{label}.sh"
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -euo pipefail
{functions}
ROOT_DIR="$ROOT"
REMOTE_RUN_SCRIPT=scripts/cloudbench-run.sh
REMOTE_TMP_SCRIPT=/tmp/rb.sh
WRAPPER_LOCAL="$WRAPPER"
LOCAL_PATCH_FILE="$PATCH_FILE"
write_cloudbench_stage_bundle "$BUNDLE" /tmp/cloudbench-stage-test.sh
bash -n "$BUNDLE"
""",
            ],
            env={
                "ROOT": str(repo),
                "WRAPPER": str(wrapper),
                "PATCH_FILE": patch_path,
                "BUNDLE": str(bundle),
            },
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        generated = bundle.read_text()
        assert generated.count("base64 -d") == (7 if patch_path else 6)
        assert "install -m 0755" in generated
        assert "WROTE" in generated
        if patch_path:
            assert "install -m 0644" in generated
        else:
            assert "rm -f /tmp/cloudbench-local.patch" in generated


def test_exclusive_fleet_controller_recovers_started_pool_capacity(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    reconcile_start = fleet.index("reconcile_pool() {")
    reconcile_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_function = fleet[reconcile_start:reconcile_end]
    pool_file = tmp_path / "pool.ids"
    claims_dir = tmp_path / "claims"
    operations_file = tmp_path / "operations"
    pool_file.write_text("started-machine\nstopped-machine\n")
    claims_dir.mkdir()
    (claims_dir / "started-machine").write_text("stale-owner\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
{reconcile_function}
APP=bench-app
RUN_ID=test-run
POOL_IDS_FILE="$POOL_FILE"
POOL_CLAIMS_DIR="$CLAIMS_DIR"
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
pool_machine_state() {{
  [ "$1" = started-machine ] && printf 'started\\n' || printf 'stopped\\n'
}}
cloudbench_machine_lease_acquire_retry() {{
  printf 'lease %s\\n' "$2" >> "$OPERATIONS_FILE"
  printf 'recovery-nonce\\n'
}}
track_primary_lease() {{
  LEASED_PRIMARY_IDS+=("$1")
  LEASED_PRIMARY_NONCES+=("$2")
}}
cloudbench_machine_stop_and_release_lease() {{
  printf 'stop %s %s\\n' "$2" "$3" >> "$OPERATIONS_FILE"
}}
reconcile_pool
printf 'ids=%s\\n' "${{LEASED_PRIMARY_IDS[*]-}}"
printf 'nonces=%s\\n' "${{LEASED_PRIMARY_NONCES[*]-}}"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "CLAIMS_DIR": str(claims_dir),
            "OPERATIONS_FILE": str(operations_file),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert operations_file.read_text().splitlines() == [
        "lease started-machine",
        "stop started-machine recovery-nonce",
    ]
    assert not (claims_dir / "started-machine").exists()
    assert result.stdout.splitlines()[-2:] == [
        "ids=started-machine",
        "nonces=",
    ]


def test_pool_recovery_runs_only_after_global_lock_and_provenance_validation() -> None:
    fleet = FLEET_SCRIPT.read_text()
    controller_line = fleet.index('cloudbench_controller_wait_acquire "$LOCK_DIR" "$APP"')
    provenance_line = fleet.index("validate_tracked_pool_provenance || exit 1")
    reconcile_line = fleet.index("reconcile_pool || exit 1")
    launch_line = fleet.index("# ── Clone one machine per bench")

    assert controller_line < provenance_line < reconcile_line < launch_line
    assert "cloudbench_machine_lease_acquire_retry" in fleet[
        fleet.index("reconcile_pool() {") : fleet.index("claim_pool_machine() {")
    ]
    assert "cloudbench_machine_stop_and_release_lease" in fleet[
        fleet.index("reconcile_pool() {") : fleet.index("claim_pool_machine() {")
    ]


def test_environment_activation_retries_only_transient_fly_failures(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("machine_state_for_activation() {")
    activation_start = cloud.index("activate_machine_environment() {", function_start)
    function_end = cloud.index("\n}\n", activation_start) + 3
    activation_function = cloud[function_start:function_end]

    def activate(responses: list[tuple[int, str]]) -> tuple[subprocess.CompletedProcess[str], list[str]]:
        responses_file = tmp_path / "responses"
        calls_file = tmp_path / "calls"
        responses_file.write_text("\n".join(f"{status}|{message}" for status, message in responses) + "\n")
        calls_file.write_text("")
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
assert_app_environment_lock_ownership() {{ return 0; }}
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    printf '[{{"id":"machine-1","state":"stopped"}}]\n'
    return 0
  fi
  printf '%s\\n' "$*" >> "$CALLS_FILE"
  response="$(head -1 "$RESPONSES_FILE")"
  tail -n +2 "$RESPONSES_FILE" > "$RESPONSES_FILE.tmp"
  mv "$RESPONSES_FILE.tmp" "$RESPONSES_FILE"
  printf '%s\\n' "${{response#*|}}"
  return "${{response%%|*}}"
}}
{activation_function}
activate_machine_environment machine-1
""",
            ],
            env={
                "CALLS_FILE": str(calls_file),
                "RESPONSES_FILE": str(responses_file),
                "CLOUDBENCH_UPDATE_ATTEMPTS": "3",
                "CLOUDBENCH_UPDATE_RETRY_DELAY": "0",
            },
            text=True,
            capture_output=True,
            check=False,
        )
        return result, calls_file.read_text().splitlines()

    recovered, recovered_calls = activate(
        [
            (1, "request returned non-2xx status: 408"),
            (0, "Machine machine-1 updated successfully!"),
        ]
    )
    rejected, rejected_calls = activate([(1, "request returned non-2xx status: 401")])
    embedded_status, embedded_status_calls = activate(
        [(1, "machine abc503def returned nontransient validation error")]
    )
    exhausted, exhausted_calls = activate(
        [
            (1, "request returned non-2xx status: 503"),
            (1, "context deadline exceeded"),
            (1, "unexpected EOF"),
        ]
    )

    assert recovered.returncode == 0, recovered.stderr
    assert len(recovered_calls) == 2
    assert "transient Fly update failure" in recovered.stderr
    assert rejected.returncode == 1
    assert len(rejected_calls) == 1
    assert "transient Fly update failure" not in rejected.stderr
    assert embedded_status.returncode == 1
    assert len(embedded_status_calls) == 1
    assert "transient Fly update failure" not in embedded_status.stderr
    assert exhausted.returncode == 1
    assert len(exhausted_calls) == 3


def test_pool_activation_rechecks_state_and_never_updates_concurrent_runs(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("machine_state_for_activation() {")
    activation_start = cloud.index("activate_machine_environment() {", function_start)
    function_end = cloud.index("\n}\n", activation_start) + 3
    activation_functions = cloud[function_start:function_end]

    def activate(
        states: list[str],
        update_status: int = 1,
        role: str = "pool",
        guard_updates: int = 99,
    ) -> tuple[subprocess.CompletedProcess[str], int]:
        states_file = tmp_path / "states"
        updates_file = tmp_path / "updates"
        states_file.write_text("\n".join(states) + "\n")
        updates_file.write_text("")
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
assert_app_environment_lock_ownership() {{
  updates="$(wc -l < "$UPDATES_FILE" | tr -d ' ')"
  [ "${{updates:-0}}" -lt "$GUARD_UPDATES" ]
}}
FLY() {{
  if [ "$1 $2" = "machine update" ]; then
    printf 'update\\n' >> "$UPDATES_FILE"
    echo 'request returned non-2xx status: 408'
    return "$UPDATE_STATUS"
  fi
  if [ "$1 $2" = "machines list" ]; then
    state="$(head -1 "$STATES_FILE")"
    tail -n +2 "$STATES_FILE" > "$STATES_FILE.tmp"
    mv "$STATES_FILE.tmp" "$STATES_FILE"
    if [ "$state" = "absent" ]; then
      printf '[]\\n'
    elif [ "$state" = "malformed-item" ]; then
      printf '[null]\\n'
    elif [ "$state" = "malformed-object" ]; then
      printf '{{}}\\n'
    elif [ "$state" = "malformed-null" ]; then
      printf 'null\\n'
    else
      printf '[{{"id":"machine-1","state":"%s"}}]\\n' "$state"
    fi
    return 0
  fi
  return 2
}}
{activation_functions}
activate_machine_environment machine-1 "$ROLE"
""",
            ],
            env={
                "STATES_FILE": str(states_file),
                "UPDATES_FILE": str(updates_file),
                "UPDATE_STATUS": str(update_status),
                "ROLE": role,
                "GUARD_UPDATES": str(guard_updates),
                "CLOUDBENCH_UPDATE_RETRY_DELAY": "0",
            },
            text=True,
            capture_output=True,
            check=False,
        )
        return result, len(updates_file.read_text().splitlines())

    already_started, already_started_updates = activate(["started"])
    became_started, became_started_updates = activate(["stopped", "started"])
    disappeared, disappeared_updates = activate(["absent"])
    stopped_failure, stopped_failure_updates = activate(["stopped"] * 6, update_status=1)
    malformed_item, malformed_item_updates = activate(["malformed-item"])
    malformed_object, malformed_object_updates = activate(["malformed-object"])
    malformed_null, malformed_null_updates = activate(["malformed-null"])
    unsafe_state, unsafe_state_updates = activate(["created"])
    active_warm, active_warm_updates = activate(["started"], role="warm")
    lost_owner, lost_owner_updates = activate(
        ["stopped"] * 4, update_status=1, guard_updates=1
    )

    assert already_started.returncode == 0, already_started.stderr
    assert already_started_updates == 0
    assert "skipping concurrently active machine" in already_started.stderr
    assert became_started.returncode == 0, became_started.stderr
    assert became_started_updates == 1
    assert "skipping concurrent owner" in became_started.stderr
    assert disappeared.returncode == 0, disappeared.stderr
    assert disappeared_updates == 0
    assert stopped_failure.returncode == 1
    assert stopped_failure_updates == 3
    assert malformed_item.returncode == 1
    assert malformed_item_updates == 0
    assert malformed_object.returncode == 1
    assert malformed_object_updates == 0
    assert malformed_null.returncode == 1
    assert malformed_null_updates == 0
    assert unsafe_state.returncode == 1
    assert unsafe_state_updates == 0
    assert "unsafe activation state" in unsafe_state.stderr
    assert active_warm.returncode == 1
    assert active_warm_updates == 0
    assert "must be stopped" in active_warm.stderr
    assert lost_owner.returncode == 1
    assert lost_owner_updates == 1


def test_environment_activation_targets_only_warm_and_workspace_pool(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("environment_activation_targets() {")
    function_end = cloud.index("\n}\n", function_start) + 3
    targets_function = cloud[function_start:function_end]
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("abc123\n")

    def targets(machines: object) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
MACHINE_NAME=cloudbench-warm
POOL_IDS_FILE="$POOL_FILE"
FLY() {{ printf '%s\\n' "$MACHINES_JSON"; }}
{targets_function}
environment_activation_targets
""",
            ],
            env={"MACHINES_JSON": json.dumps(machines), "POOL_FILE": str(pool_file)},
            text=True,
            capture_output=True,
            check=False,
        )

    selected = targets(
        [
            {"id": "warm-1", "name": "cloudbench-warm", "state": "stopped"},
            {"id": "abc123", "name": "pooled", "state": "stopped"},
            {"id": "other-1", "name": "blue-dream-4251", "state": "started"},
        ]
    )
    missing_warm = targets([{"id": "other-1", "name": "blue-dream-4251", "state": "started"}])
    duplicate_warm = targets(
        [
            {"id": "warm-1", "name": "cloudbench-warm"},
            {"id": "warm-2", "name": "cloudbench-warm"},
        ]
    )
    malformed = targets([None])

    assert selected.returncode == 0, selected.stderr
    assert selected.stdout.splitlines() == ["warm\twarm-1", "pool\tabc123"]
    assert "other-1" not in selected.stdout
    assert missing_warm.returncode != 0
    assert "expected exactly one warm source" in missing_warm.stderr
    assert duplicate_warm.returncode != 0
    assert malformed.returncode != 0


def test_environment_refresh_serializes_shared_app_before_safe_pool_recovery() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert 'APP_ENV_LOCK_FILE="$GIT_COMMON_DIR/cloudbench-app-env.lock"' in cloud
    assert 'shlock -p "$$" -f "$APP_ENV_LOCK_FILE"' in cloud
    wrapper_start = cloud.index("inject_secrets() {")
    wrapper_end = cloud.index("\n}\n", wrapper_start)
    wrapper = cloud[wrapper_start:wrapper_end]
    assert "assert_app_environment_lock_ownership" in wrapper
    assert wrapper.index("acquire_app_environment_lock") < wrapper.index(
        "( _inject_secrets_locked )"
    )
    assert wrapper.index("( _inject_secrets_locked )") < wrapper.index(
        "release_app_environment_lock"
    )
    locked_start = cloud.index("_inject_secrets_locked() {")
    locked_end = cloud.index("\n}\n", locked_start)
    assert 'FLY secrets set --stage -a "$APP"' in cloud[locked_start:locked_end]

    refresh_call = 'bash scripts/run-bench-cloud --refresh-secrets'
    assert fleet.index(refresh_call) < fleet.index(
        "validate_tracked_pool_provenance || exit 1"
    )
    assert fleet.index("validate_tracked_pool_provenance || exit 1") < fleet.index(
        "reconcile_pool || exit 1"
    )
    assert fleet.index("reconcile_pool || exit 1") < fleet.index(
        'cid="$(claim_pool_machine)"'
    )
    allocation_start = fleet.index("# ── Clone one machine per bench")
    all_requested_launched = '[ "${#CHILD_PIDS[@]}" -eq "${#BENCHES[@]}" ]'
    allocation_end = fleet.index('echo "⏳ ${#CHILD_PIDS[@]} isolated', allocation_start)
    allocation = fleet[allocation_start:allocation_end]
    assert "continue" not in allocation
    assert all_requested_launched in fleet
    assert "release_app_environment_lock" in allocation
    assert "CLOUDBENCH_APP_ENV_LOCK_OWNER_PID" in fleet
    assert 'clone_machine_target "$out/worker-clones.ids" "$primary_id"' in fleet

    stop_cleanup_start = cloud.index("stop_on_exit() {")
    stop_cleanup_end = cloud.index("\n}", stop_cleanup_start)
    stop_cleanup = cloud[stop_cleanup_start:stop_cleanup_end]
    assert stop_cleanup.index('stop_machine "$mid"') < stop_cleanup.index(
        "release_app_environment_lock"
    )
    assert "CLOUDBENCH_HOLD_APP_ENV_LOCK=1" in cloud
    assert cloud.count("assert_app_environment_lock_ownership || exit 1") >= 3

    cleanup_start = fleet.index("cleanup_impl() {")
    cleanup_end = fleet.index("\n}\ncleanup() {", cleanup_start)
    cleanup = fleet[cleanup_start:cleanup_end]
    assert cleanup.index("trap - EXIT") < cleanup.index("terminate_and_wait")
    assert cleanup.index("trap '' HUP INT TERM") < cleanup.index(
        "terminate_and_wait"
    )
    assert 'terminate_and_wait "${AUTOSCALER_PIDS[@]:-}"' in cleanup
    assert 'terminate_and_wait "${CHILD_PIDS[@]:-}"' in cleanup
    assert cleanup.index("terminate_and_wait") < cleanup.index(
        "release_app_environment_lock"
    )
    assert 'CLOUDBENCH_CHILD_TERM_SECONDS:-30' in fleet
    assert 'kill -KILL "$p"' in fleet
    assert "trap 'exit 129' HUP" in fleet
    assert "trap 'exit 129' HUP" in cloud


def test_pool_reconcile_recovers_orphan_after_controller_handoff(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    inventory_start = fleet.index("fly_inventory_json() {")
    inventory_end = fleet.index("\n}\n", inventory_start) + 3
    state_start = fleet.index("fleet_machine_state() {")
    state_end = fleet.index("\n}\n", state_start) + 3
    pool_state_start = fleet.index("pool_machine_state() {")
    reconcile_start = fleet.index("reconcile_pool() {", pool_state_start)
    function_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_functions = (
        fleet[inventory_start:inventory_end]
        + fleet[state_start:state_end]
        + fleet[pool_state_start:function_end]
    )

    pool_file = tmp_path / "pool.ids"
    states_file = tmp_path / "states"
    operations_file = tmp_path / "operations"
    pool_file.write_text("abc123\n")
    states_file.write_text("started\n")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
RUN_ID=test-run
POOL_IDS_FILE="$POOL_FILE"
POOL_CLAIMS_DIR="$CLAIMS_DIR"
LEASED_PRIMARY_IDS=()
LEASED_PRIMARY_NONCES=()
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    state="$(head -1 "$STATES_FILE")"
    tail -n +2 "$STATES_FILE" > "$STATES_FILE.tmp"
    mv "$STATES_FILE.tmp" "$STATES_FILE"
    printf 'list %s\\n' "$state" >> "$OPERATIONS_FILE"
    printf '[{{"id":"abc123","state":"%s"}}]\\n' "$state"
    return 0
  fi
  return 2
}}
{reconcile_functions}
cloudbench_machine_lease_acquire_retry() {{
  printf 'lease %s\\n' "$2" >> "$OPERATIONS_FILE"
  printf 'recovery-nonce\\n'
}}
track_primary_lease() {{
  LEASED_PRIMARY_IDS+=("$1")
  LEASED_PRIMARY_NONCES+=("$2")
}}
cloudbench_machine_stop_and_release_lease() {{
  printf 'stop %s %s\\n' "$2" "$3" >> "$OPERATIONS_FILE"
}}
reconcile_pool || exit $?
printf 'refresh\\n' >> "$OPERATIONS_FILE"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "CLAIMS_DIR": str(tmp_path / "claims"),
            "STATES_FILE": str(states_file),
            "OPERATIONS_FILE": str(operations_file),
            "CLOUDBENCH_POOL_STOP_DELAY": "0",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert operations_file.read_text().splitlines() == [
        "list started",
        "lease abc123",
        "stop abc123 recovery-nonce",
        "refresh",
    ]
    assert states_file.read_text() == ""

    assert "created|replacing|started|starting|stopping" in fleet


def test_pool_claims_survive_command_substitution_and_stay_distinct(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("claim_pool_machine() {")
    function_end = fleet.index("\n}\n", function_start) + 3
    claim_function = fleet[function_start:function_end]
    pool_file = tmp_path / "pool.ids"
    claims_file = tmp_path / "run" / "claimed-pool.ids"
    global_claims = tmp_path / "global-claims"
    starts_file = tmp_path / "starts"
    pool_file.write_text("abc123\nbad999\ndef456\nfed789\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
CLAIMED_POOL_FILE="$CLAIMS_FILE"
POOL_CLAIMS_DIR="$GLOBAL_CLAIMS"
mkdir -p "$POOL_CLAIMS_DIR"
printf '%s\\n' "$$" > "$POOL_CLAIMS_DIR/abc123"
machine_storage_ready() {{ return 0; }}
pool_machine_provenance_valid() {{ [ "$1" != bad999 ]; }}
pool_machine_state() {{ [ "$1" = bad999 ] && return 1; printf 'stopped\\n'; }}
FLY() {{
  if [ "$1 $2" = "machine start" ]; then printf '%s\\n' "$3" >> "$STARTS_FILE"; return 0; fi
  return 2
}}
{claim_function}
first="$(claim_pool_machine)"
second="$(claim_pool_machine)"
printf '%s\\n%s\\n' "$first" "$second"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "CLAIMS_FILE": str(claims_file),
            "GLOBAL_CLAIMS": str(global_claims),
            "STARTS_FILE": str(starts_file),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["def456", "fed789"]
    assert claims_file.read_text().splitlines() == ["def456", "fed789"]
    assert not starts_file.exists()


def test_pool_reconcile_fails_closed_on_falsy_non_list_machine_json(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    inventory_start = fleet.index("fly_inventory_json() {")
    inventory_end = fleet.index("\n}\n", inventory_start) + 3
    state_start = fleet.index("fleet_machine_state() {")
    state_end = fleet.index("\n}\n", state_start) + 3
    pool_state_start = fleet.index("pool_machine_state() {")
    reconcile_start = fleet.index("reconcile_pool() {", pool_state_start)
    function_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_functions = (
        fleet[inventory_start:inventory_end]
        + fleet[state_start:state_end]
        + fleet[pool_state_start:function_end]
    )
    pool_file = tmp_path / "pool.ids"
    stops_file = tmp_path / "stops"
    pool_file.write_text("abc123\n")

    for payload in ("{}", "null", "0", '""'):
        stops_file.write_text("")
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    printf '%s\\n' "$MACHINES_JSON"
    return 0
  fi
  if [ "$1 $2" = "machine stop" ]; then
    printf 'stop\\n' >> "$STOPS_FILE"
    return 0
  fi
  return 2
}}
{reconcile_functions}
reconcile_pool
""",
            ],
            env={
                "POOL_FILE": str(pool_file),
                "STOPS_FILE": str(stops_file),
                "MACHINES_JSON": payload,
            },
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode != 0, payload
        assert stops_file.read_text() == "", payload


def test_fleet_clone_identity_requires_a_distinct_authoritative_target(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("fly_inventory_json() {")
    clone_start = fleet.index("clone_machine_target() {", function_start)
    function_end = fleet.index("\n}\n", clone_start) + 3
    clone_function = fleet[function_start:function_end]
    source_id = "6834251fe05798"
    target_id = "d895d2efe7d418"

    allocation = 0

    def allocate(output: str, status: int, returned_id: str) -> tuple[subprocess.CompletedProcess[str], Path]:
        nonlocal allocation
        allocation += 1
        ledger = tmp_path / f"owned-{allocation}.ids"
        target_name_file = tmp_path / f"target-name-{allocation}"
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
WARM_ID={source_id}
SNAP_ID=snapshot-1
REGION=ord
FLY() {{
  if [ "$1 $2" = "machine clone" ]; then
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then printf '%s' "$2" > "$TARGET_NAME_FILE"; break; fi
      shift
    done
    printf '%s\\n' "$CLONE_OUTPUT"
    return "$CLONE_STATUS"
  fi
  if [ "$1 $2" = "machines list" ]; then
    target_name="$(cat "$TARGET_NAME_FILE")"
    if [ -n "$RETURNED_ID" ]; then
      printf '[{{"id":"unrelated0001","name":"someone-else"}},{{"id":"%s","name":"%s"}}]\\n' "$RETURNED_ID" "$target_name"
    else
      printf '[]\\n'
    fi
    return 0
  fi
  return 2
}}
{clone_function}
clone_machine_target "$LEDGER"
""",
            ],
            env={
                "CLONE_OUTPUT": output,
                "CLONE_STATUS": str(status),
                "LEDGER": str(ledger),
                "RETURNED_ID": returned_id,
                "TARGET_NAME_FILE": str(target_name_file),
                "CLOUDBENCH_CLONE_LOOKUP_SECONDS": "0",
            },
            text=True,
            capture_output=True,
            check=False,
        )
        return result, ledger

    source_only_failure, source_only_ledger = allocate(
        "\n".join(
            [
                f"Cloning Machine {source_id} into region ord",
                "Creating new volume from snapshot: snapshot-1",
                "Error: volume provisioning failed",
            ]
        ),
        1,
        "",
    )
    aliased_success, aliased_ledger = allocate(
        f"Cloning Machine {source_id} into region ord",
        0,
        source_id,
    )
    created_target, target_ledger = allocate(
        "\n".join(
            [
                f"Cloning Machine {source_id} into region ord",
                "Provisioning a new Machine with image registry.example/image...",
                "human output format intentionally has no target id",
            ]
        ),
        0,
        target_id,
    )
    failed_after_create, failed_target_ledger = allocate(
        f"Cloning Machine {source_id} into region ord\nError: monitor failed",
        1,
        target_id,
    )

    assert source_only_failure.returncode == 1
    assert source_only_failure.stdout == ""
    assert "volume provisioning failed" in source_only_failure.stderr
    assert not source_only_ledger.exists()
    assert len(source_only_ledger.with_suffix(".names").read_text().splitlines()) == 1
    assert aliased_success.returncode == 1
    assert aliased_success.stdout == ""
    assert not aliased_ledger.exists()
    assert len(aliased_ledger.with_suffix(".names").read_text().splitlines()) == 1
    assert created_target.returncode == 0, created_target.stderr
    assert created_target.stdout == target_id
    assert target_ledger.read_text().splitlines() == [target_id]
    assert target_ledger.with_suffix(".names").read_text() == ""
    assert failed_after_create.returncode == 1
    assert failed_after_create.stdout == ""
    assert failed_target_ledger.read_text().splitlines() == [target_id]
    assert failed_target_ledger.with_suffix(".names").read_text() == ""
    assert "--detach" in clone_function
    assert "--name" in clone_function
    assert fleet.count("FLY machine clone") == 1
    assert "\\b[0-9a-f]{14}\\b" not in fleet


def test_pool_promotes_only_successful_owned_clone_ids() -> None:
    fleet = FLEET_SCRIPT.read_text()
    pool_start = fleet.index("provision_pool() {")
    pool_end = fleet.index("\n}\n", pool_start) + 3
    pool_function = fleet[pool_start:pool_end]

    clone_call = 'id="$(clone_machine_target "$OWNED_CLONES_FILE")"'
    promotion = 'printf \'%s\\n\' "$id" >> "$POOL_IDS_FILE"'
    release = 'grep -Fxv "$id" "$OWNED_CLONES_FILE"'
    assert clone_call in pool_function
    assert pool_function.index(clone_call) < pool_function.index(promotion)
    assert pool_function.index(promotion) < pool_function.index(release)
    assert 'clone_machine_target "$POOL_IDS_FILE"' not in pool_function


def test_unresolved_clone_name_fails_loudly_without_polling_past_deadline() -> None:
    fleet = FLEET_SCRIPT.read_text()
    inventory_start = fleet.index("fly_inventory_json() {")
    inventory_end = fleet.index("\n}\n", inventory_start) + 3
    resolver_start = fleet.index("machine_id_for_clone_name() {")
    resolver_end = fleet.index("\n}\n", resolver_start) + 3
    resolver_function = fleet[inventory_start:inventory_end] + fleet[resolver_start:resolver_end]

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLY() {{ printf '[]\\n'; }}
{resolver_function}
machine_id_for_clone_name cloudbench-late "$SECONDS"
""",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert "unresolved clone name 'cloudbench-late'" in result.stderr
    assert "flyctl machines list -a bench-app --json" in result.stderr


def test_fleet_cleanup_refuses_to_destroy_the_warm_source(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("reap_machine() {")
    function_end = fleet.index("\n}\n", function_start) + 3
    reap_function = fleet[function_start:function_end]
    source_id = "6834251fe05798"
    fly_log = tmp_path / "fly.log"

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
WARM_ID={source_id}
FLY() {{ printf '%s\\n' "$*" >> "$FLY_LOG"; }}
{reap_function}
reap_machine "$WARM_ID"
""",
        ],
        env={"FLY_LOG": str(fly_log)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "refusing to destroy warm source machine" in result.stderr
    assert not fly_log.exists()


def test_fleet_aggregate_contains_every_isolated_task(tmp_path: Path) -> None:
    fleet = tmp_path / "run-1"
    batch = fleet / "_batch"
    batch.mkdir(parents=True)
    benches = [{"name": "one"}, {"name": "two"}]
    (batch / "benches.json").write_text(json.dumps(benches))
    for name, passed in (("one", True), ("two", False)):
        task_dir = fleet / name
        task_dir.mkdir()
        (task_dir / "cloudbench-run.json").write_text(
            json.dumps(
                {
                    "tasks": [
                        {
                            "name": name,
                            "passed": passed,
                            "duration_seconds": 10 if name == "one" else 20,
                            "cost_cents": 1,
                        }
                    ]
                }
            )
        )
    output = batch / "run.json"

    result = subprocess.run(
        ["python3", str(AGGREGATE_SCRIPT), str(fleet), str(output)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    aggregated = json.loads(output.read_text())
    assert [task["name"] for task in aggregated["tasks"]] == ["one", "two"]
    assert aggregated["summary"]["total"] == 2
    assert aggregated["summary"]["passed"] == 1
    assert aggregated["summary"]["failed"] == 1
    assert aggregated["summary"]["total_duration_seconds"] == 30
