import importlib.util
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "cloudbench-sync-deps.sh"
ARTIFACT_SCRIPT = ROOT / "scripts" / "cloudbench-current-run-artifact.py"
FETCH_SCRIPT = ROOT / "scripts" / "cloudbench-fetch-ref.sh"
SNAPSHOT_SCRIPT = ROOT / "scripts" / "cloudbench-select-snapshot.py"
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
    assert 'CHILD_MACHINE+=("$cid")' in fleet
    assert "isolated stacks reached the synchronized start barrier" in fleet
    assert "releasing synchronized start barrier" in fleet
    assert "reconciling authoritative pool machine" in fleet


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
