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
    assert startup.count('if machine_storage_ready "$mid"') == 2
    assert startup.count('request_machine_start "$mid"') == 2
    assert startup.index('if machine_storage_ready "$mid"') < startup.index(
        'request_machine_start "$mid"'
    )
    assert 'MACHINE_READINESS_SCRIPT="$ROOT_DIR/scripts/cloudbench-machine-readiness.py"' in fleet
    assert (
        'if machine_storage_ready "$id"; then\n'
        '                FLY machine start "$id"' in fleet
    )
    claim_start = fleet.index("claim_pool_machine() {")
    claim_end = fleet.index("\n}\n", claim_start)
    claim = fleet[claim_start:claim_end]
    assert claim.index('machine_storage_ready "$id" || continue') < claim.index(
        'FLY machine start "$id"'
    )
    assert (
        'if machine_storage_ready "$wid"; then\n'
        '            FLY machine start "$wid"' in fleet
    )


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
    assert 'STAGE_ATTEMPTS="${CLOUDBENCH_STAGE_ATTEMPTS:-20}"' in cloud
    assert 'for _ in $(seq 1 "$STAGE_ATTEMPTS")' in cloud
    assert 'DONE_MARKER="::CLOUDBENCH-DONE::$MARKER_SUFFIX"' in driver
    assert 'MARKER_SUFFIX=" token=$CLOUDBENCH_RUN_TOKEN"' in driver


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


def test_image_activation_accepts_fly_cli_false_negative_after_update(
    tmp_path: Path,
) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("machine_state_for_activation() {")
    activation_start = cloud.index("activate_machine_environment() {", function_start)
    function_end = cloud.index("\n}\n", activation_start) + 3
    activation_functions = cloud[function_start:function_end]
    calls_file = tmp_path / "calls"
    list_calls_file = tmp_path / "list-calls"
    list_calls_file.write_text("0")
    image_ref = "registry.fly.io/bench:current"

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench
assert_app_environment_lock_ownership() {{ return 0; }}
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    list_call=$(( $(cat "$LIST_CALLS_FILE") + 1 ))
    printf '%s' "$list_call" > "$LIST_CALLS_FILE"
    case "$list_call" in
      1) state=stopped; image=previous ;;
      2) state=replacing; image=current ;;
      *) state=stopped; image=current ;;
    esac
    printf '[{{"id":"machine-1","state":"%s","config":{{"image":"registry.fly.io/bench:%s@sha256:abc"}}}}]\n' "$state" "$image"
    return 0
  fi
  printf '%s\n' "$*" >> "$CALLS_FILE"
  echo "machine failed to reach desired start state, and restart policy was set to no restart"
  return 1
}}
{activation_functions}
activate_machine_environment machine-1 warm {image_ref}
""",
        ],
        env={
            "CALLS_FILE": str(calls_file),
            "LIST_CALLS_FILE": str(list_calls_file),
            "CLOUDBENCH_IMAGE_SETTLE_RETRY_DELAY": "0",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert len(calls_file.read_text().splitlines()) == 1
    assert int(list_calls_file.read_text()) >= 4
    assert "provider confirms desired image" in result.stdout


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


def test_setup_refreshes_existing_warm_and_pool_machine_images(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("activate_owned_machine_images() {")
    function_end = cloud.index("\n}\n", function_start) + 3
    refresh_function = cloud[function_start:function_end]
    calls_file = tmp_path / "calls"

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
environment_activation_targets() {{
  printf 'warm\\twarm-1\\npool\\tpool-1\\n'
}}
activate_machine_environment() {{
  printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "$CALLS_FILE"
}}
{refresh_function}
activate_owned_machine_images registry.fly.io/bench:new
""",
        ],
        env={"CALLS_FILE": str(calls_file)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert calls_file.read_text().splitlines() == [
        "warm-1|warm|registry.fly.io/bench:new",
        "pool-1|pool|registry.fly.io/bench:new",
    ]
    setup_start = cloud.index('if [ "$MODE" = "setup" ]; then')
    setup_end = cloud.index("# MODE: --refresh-wmh", setup_start)
    setup = cloud[setup_start:setup_end]
    assert setup.index('activate_owned_machine_images "$IMAGE_REF"') < setup.index(
        'start_machine "$mid"'
    )


def test_warm_resolver_ignores_live_cached_pool_machine(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    function_start = cloud.index("resolve_machine_id() {")
    function_end = cloud.index("\n}\n", function_start) + 3
    resolver = cloud[function_start:function_end]
    state_file = tmp_path / "cloudbench-machine.json"
    state_file.write_text(json.dumps({"machine_id": "pool-1"}))

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
FLEET_MACHINE_ID=
STATE_FILE="$STATE_FILE_PATH"
MACHINE_NAME=cloudbench-warm
_machines_json() {{
  printf '[{{"id":"pool-1","name":"pool-machine"}},{{"id":"warm-1","name":"cloudbench-warm"}}]\n'
}}
{resolver}
resolve_machine_id
""",
        ],
        env={"STATE_FILE_PATH": str(state_file)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "warm-1"


def test_setup_fetch_trusts_only_the_rose_owned_warm_checkout() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    setup_start = cloud.index('if [ "$MODE" = "setup" ]; then')
    setup_end = cloud.index("# MODE: --refresh-wmh", setup_start)
    setup = cloud[setup_start:setup_end]

    assert (
        setup.count(
            "git -c safe.directory='$REMOTE_REPO' -C '$REMOTE_REPO'"
        )
        >= 2
    )
    assert "git config --global --add safe.directory" not in setup
    assert r'\"\$GITHUB_TOKEN\"' in setup
    assert 'CLONE_CMD_B64=' in setup
    assert "base64 -d | bash" in setup
    assert '-C "bash -lc \\"printf' in setup
    assert 'if ! clone_output="$(FLY ssh console' in setup
    assert "GH_TOKEN=%q" not in setup


def test_environment_mutation_is_maintenance_only_and_run_path_read_only() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    # Maintenance ops (--setup / --refresh-wmh / --refresh-secrets) remain the
    # ONLY paths that mutate the shared app environment, and they still
    # serialize behind the cross-worktree app-environment lock.
    assert 'APP_ENV_LOCK_FILE="$GIT_COMMON_DIR/cloudbench-app-env.lock"' in cloud
    assert 'shlock -p "$$" -f "$APP_ENV_LOCK_FILE"' in cloud
    wrapper_start = cloud.index("inject_secrets() {")
    wrapper_end = cloud.index("\n}\n", wrapper_start)
    wrapper = cloud[wrapper_start:wrapper_end]
    assert wrapper.index("acquire_app_environment_lock") < wrapper.index(
        "( _inject_secrets_locked )"
    )
    assert wrapper.index("( _inject_secrets_locked )") < wrapper.index(
        "release_app_environment_lock"
    )
    locked_start = cloud.index("_inject_secrets_locked() {")
    locked_end = cloud.index("\n}\n", locked_start)
    assert 'FLY secrets set --stage -a "$APP"' in cloud[locked_start:locked_end]
    assert "CLOUDBENCH_HOLD_APP_ENV_LOCK=1" in cloud
    assert cloud.count("assert_app_environment_lock_ownership || exit 1") >= 2

    # The RUN path is concurrent-workstream safe: it reconciles its own pool,
    # then READ-ONLY verifies the shared environment. It never refreshes it,
    # never inherits another process's lock ownership, and never references
    # the app-environment lock at all.
    verify_call = "bash scripts/run-bench-cloud --verify-secrets"
    assert fleet.index("reconcile_pool || exit 1") < fleet.index(verify_call)
    assert fleet.index(verify_call) < fleet.index('cid="$(claim_pool_machine)"')
    assert "run-bench-cloud --refresh-secrets;" not in fleet
    assert "APP_ENV_LOCK" not in fleet
    assert "acquire_app_environment_lock" not in fleet
    assert "CLOUDBENCH_APP_ENV_LOCK_OWNER_PID" not in cloud
    assert 'clone_machine_target "$out/worker-clones.ids" "$primary_id"' in fleet
    verify_start = cloud.index("verify_app_environment() {")
    verify_end = cloud.index("\n}\n", verify_start)
    verify = cloud[verify_start:verify_end]
    assert 'FLY secrets list -a "$APP" --json' in verify
    assert "secrets set" not in verify

    stop_cleanup_start = cloud.index("stop_on_exit() {")
    stop_cleanup_end = cloud.index("\n}", stop_cleanup_start)
    stop_cleanup = cloud[stop_cleanup_start:stop_cleanup_end]
    assert 'stop_machine "$mid"' in stop_cleanup
    assert "release_app_environment_lock" not in stop_cleanup

    cleanup_start = fleet.index("cleanup() {")
    cleanup_end = fleet.index("\n}", cleanup_start)
    cleanup = fleet[cleanup_start:cleanup_end]
    assert cleanup.index("trap - EXIT") < cleanup.index("terminate_and_wait")
    assert cleanup.index("trap '' HUP INT TERM") < cleanup.index(
        "terminate_and_wait"
    )
    assert (
        'cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" '
        '"${AUTOSCALER_PIDS[@]:-}"'
    ) in cleanup
    assert (
        'cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" '
        '"${CHILD_PIDS[@]:-}"'
    ) in cleanup
    assert 'CLOUDBENCH_CHILD_TERM_SECONDS:-30' in fleet
    helper = ENV_HELPER_SCRIPT.read_text()
    assert "cloudbench_terminate_and_wait() {" in helper
    assert 'kill -KILL "$pid"' in helper
    assert "trap 'exit 129' HUP" in fleet
    assert "trap 'exit 129' HUP" in cloud


def test_pool_reconcile_leaves_concurrent_owner_untouched(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("pool_machine_state() {")
    reconcile_start = fleet.index("reconcile_pool() {", function_start)
    function_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_functions = fleet[function_start:function_end]

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
POOL_IDS_FILE="$POOL_FILE"
UNAVAILABLE_POOL_IDS=()
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    state="$(head -1 "$STATES_FILE")"
    tail -n +2 "$STATES_FILE" > "$STATES_FILE.tmp"
    mv "$STATES_FILE.tmp" "$STATES_FILE"
    printf 'list %s\\n' "$state" >> "$OPERATIONS_FILE"
    printf '[{{"id":"abc123","state":"%s"}}]\\n' "$state"
    return 0
  fi
  if [ "$1 $2" = "machine stop" ]; then
    printf 'stop\\n' >> "$OPERATIONS_FILE"
    return 0
  fi
  return 2
}}
{reconcile_functions}
reconcile_pool || exit $?
printf 'unavailable=%s\\n' "${{UNAVAILABLE_POOL_IDS[*]}}"
printf 'refresh\\n' >> "$OPERATIONS_FILE"
""",
        ],
        env={
            "POOL_FILE": str(pool_file),
            "STATES_FILE": str(states_file),
            "OPERATIONS_FILE": str(operations_file),
            "CLOUDBENCH_POOL_STOP_DELAY": "0",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "unavailable=abc123" in result.stdout
    assert operations_file.read_text().splitlines() == [
        "list started",
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
    pool_file.write_text("abc123\ndef456\nfed789\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
CLAIMED_POOL_FILE="$CLAIMS_FILE"
POOL_CLAIMS_DIR="$GLOBAL_CLAIMS"
UNAVAILABLE_POOL_IDS=(abc123)
machine_storage_ready() {{ return 0; }}
FLY() {{
  if [ "$1 $2" = "machine status" ]; then printf 'State stopped\\n'; return 0; fi
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
    assert starts_file.read_text().splitlines() == ["def456", "fed789"]


def test_pool_reconcile_fails_closed_on_falsy_non_list_machine_json(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("pool_machine_state() {")
    reconcile_start = fleet.index("reconcile_pool() {", function_start)
    function_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_functions = fleet[function_start:function_end]
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
    function_start = fleet.index("machine_id_for_clone_name() {")
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
    function_start = fleet.index("machine_id_for_clone_name() {")
    function_end = fleet.index("\n}\n", function_start) + 3
    resolver_function = fleet[function_start:function_end]

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
