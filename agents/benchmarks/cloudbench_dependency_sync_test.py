import importlib.util
import json
import os
import signal
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "cloudbench-sync-deps.sh"
PRISMA_SYNC_SCRIPT = ROOT / "scripts" / "cloudbench-sync-prisma-client.sh"
ENV_HELPER_SCRIPT = ROOT / "scripts" / "lib" / "cloudbench-env.sh"
ARTIFACT_SCRIPT = ROOT / "scripts" / "cloudbench-current-run-artifact.py"
FETCH_SCRIPT = ROOT / "scripts" / "cloudbench-fetch-ref.sh"
SNAPSHOT_SCRIPT = ROOT / "scripts" / "cloudbench-select-snapshot.py"
MACHINE_READINESS_SCRIPT = ROOT / "scripts" / "cloudbench-machine-readiness.py"
STATUS_SERVER_SCRIPT = ROOT / "scripts" / "cloudbench-status-server.py"
AGGREGATE_SCRIPT = ROOT / "scripts" / "cloudbench-aggregate-runs.py"
DRIVER_SCRIPT = ROOT / "scripts" / "cloudbench-run.sh"
FLEET_SCRIPT = ROOT / "scripts" / "run-bench-fleet"
CLOUD_SCRIPT = ROOT / "scripts" / "run-bench-cloud"
PREDEPLOY_SCRIPT = ROOT / "scripts" / "run-predeploy-cloud"
PREDEPLOY_LOCAL_SCRIPT = ROOT / "scripts" / "run-predeploy-local"
RUN_BENCH_SCRIPT = ROOT / "scripts" / "run-bench"
STACK_SCRIPT = ROOT / "scripts" / "run.sh"
LOCAL_RUNNER = ROOT / "agents" / "benchmarks" / "local.py"
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


def _write_prisma_fixture(root: Path) -> tuple[Path, Path, dict[str, str]]:
    repo = root / "repo"
    schema = repo / "back-end/prisma/schema.prisma"
    schema.parent.mkdir(parents=True)
    schema.write_text("model Alpha { id String @id }\n")
    (repo / "node_modules/.prisma").mkdir(parents=True)

    bin_dir = root / "bin"
    bin_dir.mkdir()
    gosu = bin_dir / "gosu"
    gosu.write_text("#!/usr/bin/env bash\nset -eu\nshift\nexec \"$@\"\n")
    gosu.chmod(0o755)
    npx = bin_dir / "npx"
    npx.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "printf '%s\\n' \"$*\" >> \"$PRISMA_GENERATE_LOG\"\n"
        "[ \"${PRISMA_GENERATE_FAIL:-0}\" != 1 ]\n"
    )
    npx.chmod(0o755)

    generate_log = root / "prisma-generate.log"
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["PRISMA_GENERATE_LOG"] = str(generate_log)
    return repo, generate_log, env


def _run_prisma_sync(repo: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(PRISMA_SYNC_SCRIPT), str(repo), "rose"],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def test_prisma_client_regenerates_only_when_schema_fingerprint_changes(
    tmp_path: Path,
) -> None:
    repo, generate_log, env = _write_prisma_fixture(tmp_path)
    marker = repo / "node_modules/.prisma/.rose-schema-fingerprint"

    first = _run_prisma_sync(repo, env)
    assert first.returncode == 0, first.stderr
    assert generate_log.read_text().splitlines() == [
        f"--no-install prisma generate --schema {repo / 'back-end/prisma/schema.prisma'}"
    ]
    first_fingerprint = marker.read_text()

    unchanged = _run_prisma_sync(repo, env)
    assert unchanged.returncode == 0, unchanged.stderr
    assert len(generate_log.read_text().splitlines()) == 1
    assert marker.read_text() == first_fingerprint

    (repo / "back-end/prisma/schema.prisma").write_text(
        "model Alpha { id String @id gateKey String? }\n"
    )
    changed = _run_prisma_sync(repo, env)
    assert changed.returncode == 0, changed.stderr
    assert len(generate_log.read_text().splitlines()) == 2
    assert marker.read_text() != first_fingerprint


def test_prisma_client_generation_failure_is_fatal_and_keeps_old_fingerprint(
    tmp_path: Path,
) -> None:
    repo, generate_log, env = _write_prisma_fixture(tmp_path)
    marker = repo / "node_modules/.prisma/.rose-schema-fingerprint"
    baseline = _run_prisma_sync(repo, env)
    assert baseline.returncode == 0, baseline.stderr
    baseline_fingerprint = marker.read_text()

    (repo / "back-end/prisma/schema.prisma").write_text(
        "model Alpha { id String @id newField Boolean @default(false) }\n"
    )
    env["PRISMA_GENERATE_FAIL"] = "1"
    failed = _run_prisma_sync(repo, env)

    assert failed.returncode != 0
    assert "Prisma client generation failed" in failed.stderr
    assert len(generate_log.read_text().splitlines()) == 2
    assert marker.read_text() == baseline_fingerprint


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


def test_central_refresh_installs_changed_manifest_dependencies(tmp_path: Path) -> None:
    """The explicit central refresh may rebuild the warm volume from manifests.

    Ordinary per-box sync remains fail-closed when the immutable image donor is
    stale; the fleet's one-time refresh path opts into installation so a synced
    main dependency change does not permanently strand every stopped pool box.
    """
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    install_log = tmp_path / "install.log"
    _write_manifests(donor, lock="image-lock")
    _write_manifests(repo, lock="branch-lock")
    (donor / "node_modules/image-package").mkdir(parents=True)
    (donor / "agents/venv/bin").mkdir(parents=True)
    (donor / "agents/venv/bin/python").write_text("current")
    bin_dir.mkdir()
    npm = bin_dir / "npm"
    npm.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "printf 'npm cwd=%s args=%s\\n' \"$PWD\" \"$*\" >> \"$INSTALL_LOG\"\n"
        "mkdir -p node_modules\n"
        "touch node_modules/installed-from-manifests\n"
    )
    npm.chmod(0o755)
    npx = bin_dir / "npx"
    npx.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "printf 'npx cwd=%s args=%s\\n' \"$PWD\" \"$*\" >> \"$INSTALL_LOG\"\n"
    )
    npx.chmod(0o755)

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "INSTALL_LOG": str(install_log),
            "CLOUDBENCH_REBUILD_DEPS": "1",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert (repo / "node_modules/installed-from-manifests").is_file()
    assert not (repo / "node_modules/image-package").exists()
    assert (repo / "node_modules/.cloudbench-deps-fingerprint").read_text().strip()
    calls = install_log.read_text()
    assert "npm cwd=" in calls and "args=install --no-audit --no-fund" in calls
    assert "npx cwd=" in calls and "args=prisma generate" in calls


def _write_fake_python_with_venv(path: Path, *, fail_pip: bool) -> None:
    pip_script = (
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        "printf 'pip cwd=%s args=%s\\n' \"$PWD\" \"$*\" >> \"$INSTALL_LOG\"\n"
        + ("exit 9\n" if fail_pip else "touch \"$(dirname \"$0\")/../installed-from-manifests\"\n")
    )
    real_python = sys.executable
    path.write_text(
        f"#!{real_python}\n"
        "import os, pathlib, sys\n"
        f"real_python = {real_python!r}\n"
        "if sys.argv[1:3] == ['-m', 'venv']:\n"
        "    target = pathlib.Path(sys.argv[3])\n"
        "    (target / 'bin').mkdir(parents=True)\n"
        f"    pip = target / 'bin/pip'; pip.write_text({pip_script!r}); pip.chmod(0o755)\n"
        "    raise SystemExit(0)\n"
        "os.execv(real_python, [real_python, *sys.argv[1:]])\n"
    )
    path.chmod(0o755)


def _python_rebuild_fixture(tmp_path: Path, *, fail_pip: bool) -> tuple[Path, Path, dict[str, str]]:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    bin_dir = tmp_path / "bin"
    install_log = tmp_path / "install.log"
    _write_manifests(donor, lock="same", requirements="image-requirement")
    _write_manifests(repo, lock="same", requirements="branch-requirement")
    (donor / "node_modules/current-package").mkdir(parents=True)
    (donor / "agents/venv/bin").mkdir(parents=True)
    (donor / "agents/venv/bin/python").write_text("image-python")
    old_venv = repo / "agents/venv"
    old_venv.mkdir(parents=True)
    (old_venv / "old-only").write_text("preserve-until-commit")
    (old_venv / ".cloudbench-deps-fingerprint").write_text("old-fingerprint\n")
    bin_dir.mkdir()
    _write_fake_python_with_venv(bin_dir / "python3", fail_pip=fail_pip)
    return donor, repo, {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "INSTALL_LOG": str(install_log),
        "CLOUDBENCH_REBUILD_DEPS": "1",
    }


def test_central_refresh_replaces_python_venv_from_changed_requirements(tmp_path: Path) -> None:
    donor, repo, env = _python_rebuild_fixture(tmp_path, fail_pip=False)

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not (repo / "agents/venv/old-only").exists()
    assert (repo / "agents/venv/installed-from-manifests").is_file()
    assert (repo / "agents/venv/.cloudbench-deps-fingerprint").read_text().strip()
    assert "install -r agents/requirements.txt" in Path(env["INSTALL_LOG"]).read_text()


def test_central_refresh_does_not_publish_failed_python_rebuild(tmp_path: Path) -> None:
    donor, repo, env = _python_rebuild_fixture(tmp_path, fail_pip=True)

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert (repo / "agents/venv/old-only").is_file()
    assert (repo / "agents/venv/.cloudbench-deps-fingerprint").read_text() == "old-fingerprint\n"
    assert not list((repo / "agents").glob(".venv-cloudbench-new.*"))


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
    assert "deadline=$(( barrier_start + START_BARRIER_WAIT_SECONDS ))" in fleet
    assert 'CHILD_MACHINE+=("$cid")' in fleet
    # The barrier now tolerates infra failures (see
    # test_start_barrier_tolerates_infra_failures): it releases the ready set and
    # only the LIVE stacks gate the release, rather than aborting on any one exit.
    assert "isolated stacks reached the barrier" in fleet
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


def test_deploy_smoke_gate_uses_the_local_isolated_runner(monkeypatch) -> None:
    # The policy, shell entrypoints, and Python owner form one executable chain.
    # Assert every hop so documentation can delegate without duplicating a
    # transitive implementation string, while a shared-stack regression cannot
    # hide behind otherwise-correct source routing.
    deploy = DEPLOY_COMMAND.read_text()
    step = deploy.split("## Step 6: Smoke benchmarks + fix", 1)[1].split(
        "## Step 6b: Semantic tests + fix", 1
    )[0]

    assert "bash scripts/run-predeploy-local" in step
    assert "LOCAL isolated benchmark stack" in step
    assert "Use the cloud fleet only as an explicit opt-in" in step
    assert "7/7" in step
    assert "run_benchmark.py --suite smoke" not in step

    predeploy_local = PREDEPLOY_LOCAL_SCRIPT.read_text()
    assert 'exec bash "$ROOT_DIR/scripts/run-bench" --local' in predeploy_local
    run_bench = RUN_BENCH_SCRIPT.read_text()
    local_branch = run_bench.split('if [[ "${1:-}" == "--local" ]]', 1)[1].split(
        'if [[ "${1:-}" == "--single-box" ]]', 1
    )[0]
    assert 'exec "$PY" -u benchmarks/local.py "$@"' in local_branch

    from benchmarks import local as local_runner

    monkeypatch.setattr(local_runner, "allocate_port_range", lambda _preferred: 62000)
    args = local_runner.parse_args(
        ["single-creator-arm", "--run-id", "predeploy-contract", "--base-port", "62000"]
    )
    stack = local_runner.build_service_stack(args)
    assert stack.isolated is True
    assert stack.workspace_name is not None
    assert stack.base_port == 62000
    assert '["bash", "scripts/run.sh", "--benchmark"]' in LOCAL_RUNNER.read_text()

    assert "git diff --name-only HEAD" in deploy
    assert "git ls-files --others --exclude-standard" in deploy


def test_cloud_patch_includes_tracked_and_untracked_changes() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert 'scripts/create-worktree-patch.sh" "$ROOT_DIR"' in cloud
    assert 'scripts/create-worktree-patch.sh" "$ROOT_DIR"' in fleet


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
    assert 'CLOUDBENCH_STORAGE_READY="$([ "$src" = "pool" ] && printf 1 || printf 0)"' in fleet
    storage = _extract_fleet_function(cloud, "machine_storage_ready() {")
    assert 'CLOUDBENCH_STORAGE_READY:-0' in storage
    pool_slot = _extract_fleet_function(fleet, "provision_pool_slot() {")
    assert 'if machine_storage_ready "$id"; then' in pool_slot
    assert pool_slot.index('if machine_storage_ready "$id"; then') < pool_slot.index(
        'FLY machine start "$id"'
    )


def test_pool_boot_update_is_bounded_and_skips_redundant_inventory_polling() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    branch = cloud[cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then'):]
    assert 'CLOUDBENCH_BOOT_UPDATE_TIMEOUT' in branch
    assert '_with_timeout "${CLOUDBENCH_BOOT_UPDATE_TIMEOUT:-90}"' in branch
    assert "final Fly update error" in branch
    pool_fast_path = branch[branch.index('if [ "${CLOUDBENCH_STORAGE_READY:-0}" = "1" ]; then'):]
    pool_fast_path = pool_fast_path[: pool_fast_path.index("else")]
    assert "machine_state" not in pool_fast_path
    assert "machine_storage_ready" not in pool_fast_path
    assert "request_machine_start" not in pool_fast_path
    assert 'CLOUDBENCH_BOOT_START_TIMEOUT' in pool_fast_path
    assert 'flyctl machine start "$mid"' in pool_fast_path
    claim_start = fleet.index("claim_pool_machine() {")
    claim_end = fleet.index("\n}\n", claim_start)
    claim = fleet[claim_start:claim_end]
    assert "machine_storage_ready" not in claim
    assert "FLY machine status" not in claim
    assert "FLY machine start" not in claim
    assert 'write_pool_claim "$claim_path"' in claim
    assert (
        'if machine_storage_ready "$wid"; then\n'
        '            FLY machine start "$wid"' in fleet
    )


def test_snapshot_and_pool_dependency_proofs_are_exact() -> None:
    fleet = FLEET_SCRIPT.read_text()

    assert '[ "$_rest" = "$SNAP_ID" ]' in fleet
    assert 'RECORDED_SNAP_ID="$(awk' in fleet
    assert 'SNAP_ID="$RECORDED_SNAP_ID"' in fleet
    assert "using recorded proven snapshot" in fleet
    assert "an interrupted refresh" in fleet
    assert 'POOL_META_FILE="$POOL_IDS_FILE.deps"' in fleet
    assert 'printf \'%s %s %s\\n\' "$CURRENT_NODE_FP" "$CURRENT_PY_FP" "$SNAP_ID"' in fleet
    assert 'pooled machines were built from unproven/stale dependency trees' in fleet


def test_autoscaler_metrics_poll_over_data_plane_without_ssh() -> None:
    fleet = FLEET_SCRIPT.read_text()
    desired = _extract_fleet_function(fleet, "_box_desired() {")
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")

    assert "FLY ssh" not in desired
    assert "curl --noproxy '*'" in desired
    assert "flyctl proxy" in autoscaler
    assert '"${cid}.vm.${APP}.internal"' in autoscaler
    assert "seq 10 18" in autoscaler
    assert '"http://127.0.0.1:$metrics_port/metrics"' in autoscaler
    assert "start_metrics_proxy 30" in autoscaler
    assert "autoscaler metrics via data plane" in autoscaler


def test_data_plane_proxies_retry_machine_dns_and_restart_if_lost() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    starter = _extract_fleet_function(cloud, "start_data_plane_proxy() {")
    ensure = _extract_fleet_function(cloud, "ensure_status_proxy() {")

    assert "CLOUDBENCH_DATA_PROXY_READY_TIMEOUT" in starter
    assert 'flyctl proxy "$local_port:$remote_port" "$host"' in starter
    assert 'kill -0 "$pid"' in starter
    assert '"http://127.0.0.1:$local_port/driver-health"' in starter
    assert "resolves the remote host lazily" in starter
    assert "CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS" in starter
    assert "post-probe survival window" in starter
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))"' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 1))"' in cloud
    assert "start_leased_data_plane_proxy" in ensure
    assert "ensure_status_proxy >/dev/null 2>&1 || true" in cloud


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
    verify_call = 'bash "$RUN_BENCH_CLOUD_BIN" --verify-secrets'
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
    # fleet traps name the signal before exiting (still exit 129/130/143)
    assert "controller received HUP" in fleet and "exit 129' HUP" in fleet
    assert "trap 'exit 129' HUP" in cloud


def test_pool_reconcile_leaves_concurrent_owner_untouched(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    function_start = fleet.index("pool_machine_state_from_json() {")
    reconcile_start = fleet.index("reconcile_pool() {", function_start)
    function_end = fleet.index("\n}\n", reconcile_start) + 3
    reconcile_functions = fleet[function_start:function_end]

    git_common = tmp_path / "git-common"
    pool_file = git_common / "cloudbench-pools" / "workspace.ids"
    claims_dir = git_common / "cloudbench-pool-claims"
    states_file = tmp_path / "states"
    operations_file = tmp_path / "operations"
    pool_file.parent.mkdir(parents=True)
    pool_file.write_text("abc123\n")
    states_file.write_text("started\n")
    operations_file.write_text("")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
GIT_COMMON_DIR="$GIT_COMMON"
POOL_IDS_FILE="$POOL_FILE"
POOL_CLAIMS_DIR="$CLAIMS_DIR"
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
            "GIT_COMMON": str(git_common),
            "CLAIMS_DIR": str(claims_dir),
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
    write_start = fleet.index("write_pool_claim() {")
    write_end = fleet.index("\n}\n", write_start) + 3
    write_function = fleet[write_start:write_end]
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
FLEET_OWNER_HOST=test-host
FLEET_OWNER_PID_START='Mon Jan  1 00:00:00 2001'
machine_storage_ready() {{ return 0; }}
FLY() {{
  if [ "$1 $2" = "machine status" ]; then printf 'State stopped\\n'; return 0; fi
  if [ "$1 $2" = "machine start" ]; then printf '%s\\n' "$3" >> "$STARTS_FILE"; return 0; fi
  return 2
}}
{write_function}
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
    function_start = fleet.index("pool_machine_state_from_json() {")
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
fleet_machines_json() {{ FLY machines list -a "$APP" --json; }}
fleet_registry_record_name() {{ return 0; }}
fleet_registry_record_id() {{ return 0; }}
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
                # Isolate identity resolution to a single attempt; retry
                # behavior is covered by test_clone_retries_transient_*.
                "CLOUDBENCH_CLONE_MAX_ATTEMPTS": "1",
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
    # Exactly one clone-from-source call site, and it is bounded by the
    # hung-clone watchdog (fly_with_timeout) rather than an unbounded FLY call.
    assert fleet.count('machine clone "$source_id"') == 1
    assert "fly_with_timeout" in clone_function
    assert "\\b[0-9a-f]{14}\\b" not in fleet


def test_clone_releases_only_definitive_preallocation_failures() -> None:
    """A rate-limited/CPU-rejected clone creates no Machine. After the bounded
    name lookup confirms absence, its attempt record must be released so a
    later successful retry does not leave a phantom stale registry. Ambiguous
    launch errors retain ownership fail-closed."""
    fleet = FLEET_SCRIPT.read_text()
    classifier = _extract_fleet_function(fleet, "clone_failure_definitively_unallocated() {")
    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    script = f"""{classifier}
for message in \
  'Error: failed to create volume: resource_exhausted: rate limit exceeded' \
  'Error: failed to create volume: machine capacity hold failed' \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_x'\"; do
  clone_failure_definitively_unallocated "$message" || exit 1
done
clone_failure_definitively_unallocated 'Error: failed to launch VM: volume not found' && exit 2
exit 0
"""
    result = subprocess.run(["bash", "-c", script], check=False)
    assert result.returncode == 0
    assert 'fleet_registry_release_name "$target_name"' in cloner
    assert cloner.index('clone_failure_definitively_unallocated "$clone_out"') < cloner.index(
        'fleet_registry_release_name "$target_name"'
    )


def test_pool_promotes_only_successful_owned_clone_ids() -> None:
    fleet = FLEET_SCRIPT.read_text()
    pool_function = _extract_fleet_function(fleet, "provision_pool_slot() {")

    clone_call = 'id="$(clone_machine_target "$slot_ledger")"'
    promotion = 'if ! pool_ledger_record_id "$id"; then'
    registry_release = 'fleet_registry_release_id "$id"'
    assert clone_call in pool_function
    assert pool_function.index(clone_call) < pool_function.index(promotion)
    assert pool_function.index(promotion) < pool_function.index(registry_release)
    assert 'clone_machine_target "$POOL_IDS_FILE"' not in pool_function


def test_pool_provision_fans_out_slots_concurrently() -> None:
    """A 30-machine warm pool must take roughly one clone's wall clock, not
    thirty. Each concurrent slot owns a separate ephemeral ledger; only the
    stopped-id promotion is serialized by the durable pool ledger lock."""
    fleet = FLEET_SCRIPT.read_text()
    pool = _extract_fleet_function(fleet, "provision_pool() {")
    slot = _extract_fleet_function(fleet, "provision_pool_slot() {")

    assert 'provision_pool_slot "$i" "$n" &' in pool
    assert 'pool_pids+=("$pid")' in pool
    assert 'for pid in "${pool_pids[@]}"; do' in pool
    assert pool.index('wait "$pid"') < pool.index("PROVISION_PIDS=()")
    assert "CLOUDBENCH_CLONE_LAUNCH_STAGGER_SECONDS" in pool
    assert 'pool-provision-$i.ids' in slot
    assert 'pool_ledger_record_id "$id"' in slot
    assert "snapshot_machine_state" in slot
    assert "FLY machine status" not in slot
    assert "pool_machine_state" not in slot
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    assert '"${PROVISION_PIDS[@]:-}"' in cleanup

    pool_branch = fleet[fleet.index('if [ -n "$PROVISION_POOL" ]; then'):]
    assert pool_branch.index("machines_snapshot_loop & SNAPSHOT_LOOP_PID=$!") < pool_branch.index(
        'provision_pool "$PROVISION_POOL"'
    )


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
                            "llm_usage_by_provider": {
                                "codex_token": {
                                    "calls": 1,
                                    "input_tokens": 10,
                                    "output_tokens": 2,
                                    "cost_usd": 0,
                                    "models": {
                                        "gpt-5.6-sol": {
                                            "calls": 1,
                                            "input_tokens": 10,
                                            "output_tokens": 2,
                                            "cost_usd": 0,
                                        }
                                    },
                                }
                            },
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
    usage = json.loads((batch / "llm-usage.json").read_text())
    assert usage["run_id"] == "run-1"
    assert usage["providers"]["codex_token"]["calls"] == 2
    assert usage["providers"]["codex_token"]["models"]["gpt-5.6-sol"]["input_tokens"] == 20


def _extract_fleet_function(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start) + 3
    return source[start:end]


def test_clone_retries_transient_volume_not_found(tmp_path: Path) -> None:
    """A single Fly clone-from-snapshot volume race must not abort the batch:
    clone_machine_target retries with a fresh name and returns the id once the
    transient failure clears. Guards the 28-wide synchronized-start barrier
    against one flaky clone tearing down every isolated stack."""
    fleet = FLEET_SCRIPT.read_text()
    timeout_fn = _extract_fleet_function(fleet, "fly_with_timeout() {")
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    ledger = tmp_path / "owned-clones.ids"
    attempt_file = tmp_path / "attempts"
    machines_file = tmp_path / "machines"
    machines_file.write_text("")

    script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=warm-1
SNAP_ID=vs_test
export ATTEMPT_FILE="$ATTEMPT_FILE" MACHINES_FILE="$MACHINES_FILE"
FLY() {{
  if [ "$1 $2" = "machine clone" ]; then
    local name=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; shift 2; continue; fi
      shift
    done
    local n; n=$(( $(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATTEMPT_FILE"
    if [ "$n" -lt 2 ]; then echo "Error: failed to launch VM: volume not found" >&2; return 1; fi
    printf '{{"id":"clone-%s","name":"%s"}}\\n' "$n" "$name" >> "$MACHINES_FILE"
    return 0
  fi
  if [ "$1 $2" = "machines list" ]; then
    python3 -c 'import os; ls=[l.strip() for l in open(os.environ["MACHINES_FILE"]) if l.strip()]; print("["+",".join(ls)+"]")'
    return 0
  fi
  return 0
}}
CLOUDBENCH_CLONE_RETRY_SECONDS=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
CLOUDBENCH_CLONE_MAX_ATTEMPTS=3
{timeout_fn}
fleet_machines_json() {{ FLY machines list -a "$APP" --json; }}
fleet_registry_record_name() {{ return 0; }}
fleet_registry_record_id() {{ return 0; }}
{resolver}
{cloner}
clone_machine_target "$LEDGER"
"""

    result = subprocess.run(
        ["bash", "-c", script],
        env={
            "ATTEMPT_FILE": str(attempt_file),
            "MACHINES_FILE": str(machines_file),
            "LEDGER": str(ledger),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    # Second attempt is the one that succeeds → clone-2.
    assert result.stdout.strip() == "clone-2", result.stdout
    assert attempt_file.read_text().strip() == "2", "expected exactly one retry"
    assert "retrying" in result.stderr
    # The resolved id is recorded once in the ownership ledger.
    assert ledger.read_text().split() == ["clone-2"]


def test_clone_gives_up_after_max_attempts(tmp_path: Path) -> None:
    """Persistent (non-transient) clone failure still fails closed after the
    bounded retry budget — retries must not loop forever."""
    fleet = FLEET_SCRIPT.read_text()
    timeout_fn = _extract_fleet_function(fleet, "fly_with_timeout() {")
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    ledger = tmp_path / "owned-clones.ids"
    attempt_file = tmp_path / "attempts"

    script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=warm-1
SNAP_ID=vs_test
export ATTEMPT_FILE="$ATTEMPT_FILE"
FLY() {{
  if [ "$1 $2" = "machine clone" ]; then
    local n; n=$(( $(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATTEMPT_FILE"
    echo "Error: failed to launch VM: volume not found" >&2; return 1
  fi
  if [ "$1 $2" = "machines list" ]; then echo "[]"; return 0; fi
  return 0
}}
CLOUDBENCH_CLONE_RETRY_SECONDS=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
CLOUDBENCH_CLONE_MAX_ATTEMPTS=3
{timeout_fn}
fleet_machines_json() {{ FLY machines list -a "$APP" --json; }}
fleet_registry_record_name() {{ return 0; }}
fleet_registry_record_id() {{ return 0; }}
{resolver}
{cloner}
clone_machine_target "$LEDGER"
"""

    result = subprocess.run(
        ["bash", "-c", script],
        env={"ATTEMPT_FILE": str(attempt_file), "LEDGER": str(ledger)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1, result.stdout
    assert attempt_file.read_text().strip() == "3", "should stop at the attempt budget"
    assert "after 3 attempt(s)" in result.stderr


def test_clone_times_out_and_retries_a_hung_clone(tmp_path: Path) -> None:
    """A hung `flyctl machine clone` (stalled Fly API) must not freeze the
    sequential provisioning loop: fly_with_timeout reaps it and the retry loop
    proceeds with a fresh clone. This is the iteration-3 failure (controller
    blocked 25min on one clone → barrier never released → 0/28)."""
    fleet = FLEET_SCRIPT.read_text()
    timeout_fn = _extract_fleet_function(fleet, "fly_with_timeout() {")
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    ledger = tmp_path / "owned-clones.ids"
    attempt_file = tmp_path / "attempts"
    machines_file = tmp_path / "machines"
    machines_file.write_text("")

    script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=warm-1
SNAP_ID=vs_test
export ATTEMPT_FILE="$ATTEMPT_FILE" MACHINES_FILE="$MACHINES_FILE"
FLY() {{
  if [ "$1 $2" = "machine clone" ]; then
    local name=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--name" ]; then name="$2"; shift 2; continue; fi
      shift
    done
    local n; n=$(( $(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATTEMPT_FILE"
    if [ "$n" -lt 2 ]; then sleep 30; return 0; fi
    printf '{{"id":"clone-%s","name":"%s"}}\\n' "$n" "$name" >> "$MACHINES_FILE"
    return 0
  fi
  if [ "$1 $2" = "machines list" ]; then
    python3 -c 'import os; ls=[l.strip() for l in open(os.environ["MACHINES_FILE"]) if l.strip()]; print("["+",".join(ls)+"]")'
    return 0
  fi
  return 0
}}
CLOUDBENCH_CLONE_TIMEOUT_SECONDS=1
CLOUDBENCH_CLONE_RETRY_SECONDS=0
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
CLOUDBENCH_CLONE_MAX_ATTEMPTS=3
{timeout_fn}
fleet_machines_json() {{ FLY machines list -a "$APP" --json; }}
fleet_registry_record_name() {{ return 0; }}
fleet_registry_record_id() {{ return 0; }}
{resolver}
{cloner}
clone_machine_target "$LEDGER"
"""

    result = subprocess.run(
        ["bash", "-c", script],
        env={
            "ATTEMPT_FILE": str(attempt_file),
            "MACHINES_FILE": str(machines_file),
            "LEDGER": str(ledger),
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "clone-2", result.stdout
    assert attempt_file.read_text().strip() == "2", "hung clone should be reaped then retried once"
    assert "retrying" in result.stderr


def test_fleet_provisions_clones_concurrently() -> None:
    """All per-bench clones must fan out concurrently, not serialize. Sequential
    cloning stretched provisioning to 30-50min — the window every clone hang /
    volume race / cross-workspace contention event aborted the batch in. Phase 1
    backgrounds each claim-or-clone in its own subshell writing its own per-bench
    ledger; a barrier waits for all before Phase 2 launches any child."""
    fleet = FLEET_SCRIPT.read_text()
    assert "concurrently (claim-or-clone)" in fleet
    prov = fleet.index("# ── Phase 1:")
    wait_all = fleet.index('for pp in "${PROVISION_PIDS[@]}"; do wait')
    phase2 = fleet.index("# ── Phase 2:")
    # ordering: fan-out → barrier → launch
    assert prov < wait_all < phase2, "phases out of order"
    assert fleet.index("PROVISION_PIDS=()", wait_all) < phase2
    phase1 = fleet[prov:wait_all]
    # each provision is a backgrounded subshell using its OWN per-bench ledger
    assert 'clone_machine_target "$out/primary.ids"' in phase1
    assert ") &" in phase1
    assert 'PROVISION_PIDS+=("$!")' in phase1
    # provisioning is decoupled from the run: Phase 1 never launches a child, so
    # one slow clone cannot block the others (or the whole batch).
    assert "CHILD_PIDS+=" not in phase1
    assert "run-bench-cloud" not in phase1
    # No leak if killed mid-provision: each concurrent clone records into the
    # durable fleet-ownership registry (inside clone_machine_target), which the
    # cleanup reaps via reap_registry_clones — authoritative even across
    # workspace deletion, and it calls reap_machine (which also reaps volumes).
    assert "fleet_registry_record_name" in fleet
    assert "reap_registry_clones" in fleet


def test_reap_machine_destroys_the_clones_forked_volume(tmp_path: Path) -> None:
    """`flyctl machine destroy` never destroys the clone's forked volume — it
    leaks and bills forever (observed: 42 x 20GB in one day). reap_machine must
    resolve the volume BEFORE the machine disappears and destroy it after,
    while never touching the warm source's volume."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in ("machine_volume_id() {", "reap_volume() {", "reap_machine() {")
    )
    calls = tmp_path / "calls"

    script = f"""set -uo pipefail
APP=bench-app
WARM_ID=warm-1
WARM_VOLUME_ID=vol_warm
export CALLS_FILE="$CALLS_FILE"
FLY() {{
  echo "$*" >> "$CALLS_FILE"
  case "$1 $2" in
    "machines list")
      # clone-1 exists (with its volume) until it has been destroyed once
      if grep -q "machine destroy" "$CALLS_FILE"; then echo "[]"; else
        printf '[{{"id":"clone-1","config":{{"mounts":[{{"volume":"vol_clone"}}]}}}}]\\n'
      fi ;;
    "machine destroy") return 0 ;;
    "volumes destroy") return 0 ;;
    "volumes list") echo "[]" ;;
  esac
  return 0
}}
{helpers}
reap_machine clone-1
echo "reap_machine_exit=$?"
reap_volume vol_warm && echo "warm_guard=missing" || echo "warm_guard=held"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"CALLS_FILE": str(calls)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    log = calls.read_text()
    assert "machine destroy --force clone-1" in log
    assert "volumes destroy vol_clone" in log, "forked volume must be reaped with its machine"
    # the volume was resolved BEFORE the destroy (list precedes destroy)
    assert log.index("machines list") < log.index("machine destroy")
    assert "reap_machine_exit=0" in result.stdout
    # warm volume is never destroyable through the reap path
    assert "warm_guard=held" in result.stdout
    assert "volumes destroy vol_warm" not in log


def test_orphan_volume_sweep_reaps_only_aged_unattached_clone_volumes(tmp_path: Path) -> None:
    """The fleet-start sweep self-heals volumes leaked by killed runs. It must
    destroy ONLY unattached cloudbench_data volumes older than the grace period
    — never attached ones, other apps' volume names, fresh in-flight forks
    (concurrent controller create->attach window), or the warm source volume."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in ("reap_volume() {", "sweep_orphaned_volumes() {")
    )
    calls = tmp_path / "calls"

    script = f"""set -uo pipefail
APP=bench-app
VOLUME_NAME=cloudbench_data
WARM_VOLUME_ID=vol_warm
CLOUDBENCH_VOLUME_ORPHAN_GRACE_SECONDS=3600
export CALLS_FILE="$CALLS_FILE"
FLY() {{
  echo "$*" >> "$CALLS_FILE"
  case "$1 $2" in
    "volumes list")
      python3 - <<'PYJSON'
import json
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps([
  {{"id": "vol_old_orphan", "name": "cloudbench_data", "attached_machine_id": None,
    "created_at": iso(now - timedelta(hours=2))}},
  {{"id": "vol_fresh_fork", "name": "cloudbench_data", "attached_machine_id": None,
    "created_at": iso(now - timedelta(minutes=5))}},
  {{"id": "vol_attached", "name": "cloudbench_data", "attached_machine_id": "m1",
    "created_at": iso(now - timedelta(hours=9))}},
  {{"id": "vol_other_app", "name": "captest", "attached_machine_id": None,
    "created_at": iso(now - timedelta(hours=9))}},
  {{"id": "vol_warm", "name": "cloudbench_data", "attached_machine_id": None,
    "created_at": iso(now - timedelta(hours=9))}},
]))
PYJSON
      ;;
    "volumes destroy") return 0 ;;
  esac
  return 0
}}
{helpers}
sweep_orphaned_volumes
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"CALLS_FILE": str(calls)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    log = calls.read_text()
    assert "volumes destroy vol_old_orphan" in log
    for protected in ("vol_fresh_fork", "vol_attached", "vol_other_app", "vol_warm"):
        assert f"volumes destroy {protected}" not in log, f"{protected} must survive the sweep"
    # the sweep runs at fleet start, wired in (not just defined)
    assert "\nsweep_orphaned_volumes\n" in fleet


def test_detach_reexec_survives_launcher_session_death(tmp_path: Path) -> None:
    """cloudbench_detach_reexec must re-exec the command in its OWN session
    (fork -> setsid -> exec): a fleet controller otherwise dies with the
    launching terminal/agent session's process group (observed: a 28-machine
    fleet torn down mid-run by launcher exit). Verified functionally: the
    detached child reports a different session id than the launcher and keeps
    running after the launcher is gone."""
    env_lib = ENV_HELPER_SCRIPT.read_text()
    start = env_lib.index("cloudbench_detach_reexec() {")
    end = env_lib.index("\nPY\n}", start) + len("\nPY\n}")
    helper = env_lib[start:end]
    log = tmp_path / "detached.log"
    sid_file = tmp_path / "sids"

    launcher = f"""set -uo pipefail
{helper}
sid() {{ python3 -c 'import os; print(os.getsid(0))'; }}
echo "launcher_sid=$(sid)" >> "$SID_FILE"
cloudbench_detach_reexec "$LOG" bash -c \
  'echo "child_sid=$(python3 -c "import os; print(os.getsid(0))")" >> "$SID_FILE"; sleep 2; echo survived >> "$SID_FILE"'
"""
    result = subprocess.run(
        ["bash", "-c", launcher],
        env={"LOG": str(log), "SID_FILE": str(sid_file), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    # launcher has fully exited; the detached child must still complete
    deadline = time.time() + 10
    while time.time() < deadline and "survived" not in sid_file.read_text():
        time.sleep(0.2)
    content = sid_file.read_text()
    assert "survived" in content, f"detached child died with the launcher: {content!r}"
    sids = dict(line.split("=") for line in content.splitlines() if "=" in line)
    assert sids["launcher_sid"] != sids["child_sid"], "child must run in its OWN session"
    # the fleet wires --detach before any lock/machine acquisition
    fleet = FLEET_SCRIPT.read_text()
    assert "--detach)" in fleet
    assert fleet.index("cloudbench_detach_reexec") < fleet.index("cloudbench_controller_lock_acquire"), (
        "detach must happen before the controller lock so the surviving process owns it"
    )


def test_read_pollers_share_one_machines_snapshot(tmp_path: Path) -> None:
    """28 autoscalers + clone resolvers each running their own `flyctl machines
    list` was ~28x redundant API load per interval — the source of
    resource_exhausted throttling at fleet width. Read-only pollers must consume
    the controller-owned snapshot (fleet_machines_json/fleet_volumes_json);
    mutation-verification paths (reap, pool claims) must stay live for
    post-write freshness."""
    fleet = FLEET_SCRIPT.read_text()

    # the snapshot loop exists, starts before Phase 1, and is reaped in cleanup
    assert "machines_snapshot_loop() {" in fleet
    assert "machines_snapshot_loop & SNAPSHOT_LOOP_PID=$!" in fleet
    assert 'kill "$SNAPSHOT_LOOP_PID"' in fleet
    assert fleet.index("machines_snapshot_loop & SNAPSHOT_LOOP_PID") < fleet.index(
        "# ── Phase 1:"
    )
    # backoff on API failure lives in the loop (single caller = single backoff)
    loop = _extract_fleet_function(fleet, "machines_snapshot_loop() {")
    assert "backoff" in loop

    # read-only pollers consume the shared snapshot. The exceptional post-clone
    # resolver requests a coalesced fresh snapshot before reading it, so 30
    # fallback resolvers do not each hammer the Machines API or read stale data.
    for fn_sig in ("machine_id_for_clone_name() {", "_machine_priv_ip() {", "machine_storage_ready() {"):
        body = _extract_fleet_function(fleet, fn_sig)
        assert "FLY machines list" not in body, f"{fn_sig} must read the shared snapshot"
        assert "fleet_machines_json" in body
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    assert "refresh_machines_snapshot_after" in resolver
    refresh = _extract_fleet_function(fleet, "refresh_machines_snapshot_after() {")
    assert "FLY machines list" in refresh
    assert "machines-refresh.lock" in refresh
    ready = _extract_fleet_function(fleet, "machine_storage_ready() {")
    assert "FLY volumes list" not in ready and "fleet_volumes_json" in ready
    # the autoscaler liveness check reads the snapshot, not machine status
    assert 'while fleet_machines_json | grep -q "\\"$cid\\""' in fleet

    # mutation-verification paths stay LIVE (a 5s-stale snapshot would make
    # reap retry against ghosts and claims race)
    for fn_sig in ("reap_machine() {", "pool_machine_state() {"):
        body = _extract_fleet_function(fleet, fn_sig)
        assert "FLY machines list" in body, f"{fn_sig} must verify against live state"

    # fleet_machines_json: functional — serves fresh snapshot, falls back live
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in ("_fresh_snapshot_or() {", "fleet_machines_json() {")
    )
    snap = tmp_path / "machines.json"
    snap.write_text('[{"id":"from-snapshot"}]\n')
    script = f"""set -uo pipefail
APP=bench-app
SNAPSHOT_POLL=5
MACHINES_SNAPSHOT="$SNAP"
FLY() {{ echo '[{{"id":"from-live"}}]'; }}
{helpers}
fleet_machines_json
touch -t 202001010000 "$SNAP"   # stale → must fall back to live
fleet_machines_json
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"SNAP": str(snap), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert lines[0] == '[{"id":"from-snapshot"}]', lines
    assert lines[1] == '[{"id":"from-live"}]', lines


def _preflight_harness(tmp_path: Path, *, state_line: str | None, dirty: bool,
                       autorefresh: str, snap_epoch: int, refresh_status: int = 0,
                       refreshed_snapshot: str = "snap-transaction") -> tuple:
    """Run warm_deps_preflight with stubbed FLY/git/refresh; returns (result, calls)."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in (
            "snapshot_created_epoch() {",
            "snapshot_is_complete_exact() {",
            "warm_deps_preflight() {",
        )
    )
    root = tmp_path / "root"
    (root / "scripts").mkdir(parents=True)
    fake_cloud = root / "scripts" / "run-bench-cloud"
    fake_cloud.write_text(
        '#!/usr/bin/env bash\n'
        'echo "refresh-deps $*" >> "$CALLS_FILE"\n'
        f'printf "NODEFP PYFP 2000 {refreshed_snapshot}\\n" > "$COMMON/cloudbench-warm-deps.fp"\n'
        f'exit {refresh_status}\n'
    )
    fake_cloud.chmod(0o755)
    (root / "scripts" / "cloudbench-select-snapshot.py").write_text('print("snap-new")\n')
    common = tmp_path / "common"
    common.mkdir()
    if state_line is not None:
        (common / "cloudbench-warm-deps.fp").write_text(state_line + "\n")
    calls = tmp_path / "calls"
    calls.write_text("")

    script = f"""set -uo pipefail
APP=bench-app
VOL_ID=vol_warm
SNAP_ID=snap-current
BENCH_REF=abc123
BENCHES=(a b c)
ROOT_DIR="$ROOT"
RUN_BENCH_CLOUD_BIN="$ROOT/scripts/run-bench-cloud"
GIT_COMMON_DIR="$COMMON"
CLOUDBENCH_WARM_DEPS_AUTOREFRESH={autorefresh}
export CALLS_FILE="$CALLS_FILE"
FLY() {{
  echo '[{{"id":"snap-current","created_at":"{__import__("datetime").datetime.fromtimestamp(snap_epoch, __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}","status":"created","size":9}},{{"id":"{refreshed_snapshot}","created_at":"2026-07-17T00:00:00Z","status":"created","size":9}},{{"id":"snap-unrelated-newer","created_at":"2026-07-17T00:01:00Z","status":"created","size":9}}]'
}}
cloudbench_node_dependency_fingerprint() {{ echo NODEFP; }}
cloudbench_manifest_fingerprint() {{ echo PYFP; }}
CLOUDBENCH_PYTHON_MANIFESTS=(agents/requirements.txt)
git() {{ [ "{int(dirty)}" = "1" ] && return 1 || return 0; }}
{helpers}
warm_deps_preflight || exit $?
echo "SNAP_AFTER=$SNAP_ID"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"ROOT": str(root), "COMMON": str(common), "CALLS_FILE": str(calls),
             "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    return result, calls


def test_warm_deps_preflight_fast_path_and_central_heal(tmp_path: Path) -> None:
    """Stale warm-snapshot dep trees made EVERY clone pay a multi-minute rsync
    (the fleet's dominant bring-up cost). The preflight must (a) prove
    freshness from the shared state file and skip healing, (b) heal centrally
    ONCE via --refresh-deps when the state is absent/stale, and (c) never heal
    when manifests are dirty vs HEAD (uncommitted deps can't be healed
    centrally). It must never block the run on failure."""
    # (a) matching state + fresh snapshot → fast path, no refresh
    result, calls = _preflight_harness(
        tmp_path / "a", state_line="NODEFP PYFP 1000 snap-current", dirty=False,
        autorefresh="1", snap_epoch=2000)
    assert result.returncode == 0, result.stderr
    assert "fast bring-up" in result.stdout
    assert calls.read_text() == ""
    assert "SNAP_AFTER=snap-current" in result.stdout

    # (b) no state → central heal once, then adopt only the exact snapshot
    # the refresh transaction published (never a newer unrelated snapshot).
    result, calls = _preflight_harness(
        tmp_path / "b", state_line=None, dirty=False, autorefresh="1", snap_epoch=2000)
    assert result.returncode == 0, result.stderr
    assert "refresh-deps --refresh-deps --ref abc123" in calls.read_text()
    assert "SNAP_AFTER=snap-transaction" in result.stdout

    # (c) dirty manifests cannot be fetched/rebuilt centrally and must fail
    # before provisioning; the old advertised per-box fallback hits the same
    # immutable donor mismatch and cannot work.
    result, calls = _preflight_harness(
        tmp_path / "c", state_line=None, dirty=True, autorefresh="1", snap_epoch=2000)
    assert result.returncode != 0
    assert "DIRTY" in result.stdout + result.stderr
    assert calls.read_text() == ""

    # (d) a failed central transaction aborts immediately instead of launching
    # clones that are already known to fail the copy-only dependency gate.
    result, calls = _preflight_harness(
        tmp_path / "d", state_line=None, dirty=False, autorefresh="1",
        snap_epoch=2000, refresh_status=1)
    assert result.returncode != 0
    assert "refresh-deps --refresh-deps --ref abc123" in calls.read_text()
    assert "refusing to provision" in result.stdout + result.stderr

    # (e) disabling required maintenance also fails before provisioning and
    # prints the explicit manual repair command.
    result, calls = _preflight_harness(
        tmp_path / "e", state_line=None, dirty=False, autorefresh="0", snap_epoch=2000)
    assert result.returncode != 0
    assert "--refresh-deps" in result.stdout + result.stderr
    assert calls.read_text() == ""


def test_refresh_deps_is_a_validated_maintenance_transaction() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    refresh = cloud[
        cloud.index('if [ "$MODE" = "refresh-deps" ]; then'):
        cloud.index('# MODE: --refresh-wmh')
    ]
    snapshot_helper = _extract_fleet_function(cloud, "create_volume_snapshot_exact() {")

    assert "CLOUDBENCH_REBUILD_DEPS=1" in refresh
    assert "CLOUDBENCH_REBUILD_DEPS=1" not in driver
    assert "EXPECTED_REF=" in refresh
    assert "REMOTE_REF=" in refresh
    assert "REMOTE_NODE_FP=" in refresh
    assert "REMOTE_PY_FP=" in refresh
    assert "remote dependency state did not match" in refresh
    assert 'create_volume_snapshot_exact "$VOL_ID" || exit 1' in refresh
    assert 'volumes snapshots create "$vol" -a "$APP" --json' in snapshot_helper
    assert 'CREATED_SNAPSHOT_ID=' in snapshot_helper
    assert 'BEFORE_IDS="$before_ids"' in snapshot_helper
    assert "authoritative pre-snapshot inventory" in snapshot_helper
    assert "multiple new snapshots appeared" in snapshot_helper
    assert "snap-unrelated" not in snapshot_helper
    assert "central dep refresh failed; refusing to provision" in fleet
    assert "clones will pay the per-box rsync" not in fleet
    assert "warm_deps_preflight || exit 1" in fleet


def test_refresh_deps_requires_confirmed_stop_before_snapshot(tmp_path: Path) -> None:
    """A failed/slow stop must prevent both snapshot creation and publication."""
    cloud = CLOUD_SCRIPT.read_text()
    strict_stop = _extract_fleet_function(cloud, "stop_machine_strict() {")
    calls = tmp_path / "calls"
    calls.write_text("")
    script = f"""set -uo pipefail
APP=bench-app
CLOUDBENCH_MAINTENANCE_STOP_ATTEMPTS=2
FLY() {{ echo "$*" >> "$CALLS"; [ "$1 $2" != "machine stop" ]; }}
machine_state() {{ echo started; }}
sleep() {{ :; }}
{strict_stop}
if stop_machine_strict warm-1; then
  FLY volumes snapshots create vol-1 -a "$APP" --json
  echo PUBLISHED
fi
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"CALLS": str(calls), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "machine stop warm-1" in calls.read_text()
    assert "snapshots create" not in calls.read_text()
    assert "PUBLISHED" not in result.stdout

    # A stop request that succeeds but never reaches provider state=stopped is
    # equally unsafe and must have the same fail-before-snapshot outcome.
    calls.write_text("")
    slow_script = script.replace(
        'FLY() { echo "$*" >> "$CALLS"; [ "$1 $2" != "machine stop" ]; }',
        'FLY() { echo "$*" >> "$CALLS"; return 0; }',
    )
    slow = subprocess.run(
        ["bash", "-c", slow_script],
        env={"CALLS": str(calls), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert slow.returncode == 0, slow.stderr
    assert "snapshots create" not in calls.read_text()
    assert "PUBLISHED" not in slow.stdout


def test_refresh_deps_tracks_exact_created_snapshot(tmp_path: Path) -> None:
    """Fly's empty create response is bound by a strict before/after ID diff."""
    cloud = CLOUD_SCRIPT.read_text()
    create_snapshot = _extract_fleet_function(cloud, "create_volume_snapshot_exact() {")
    calls = tmp_path / "calls"
    calls.write_text("")
    created = tmp_path / "created"
    script = f"""set -uo pipefail
APP=bench-app
CLOUDBENCH_SNAPSHOT_READY_ATTEMPTS=2
FLY() {{
  echo "$*" >> "$CALLS"
  if [ "$1 $2 $3" = "volumes snapshots create" ]; then
    touch "$CREATED"
    return 0
  elif [ -f "$CREATED" ]; then
    echo '[{{"id":"snap-unrelated-older","status":"created","size":99}},{{"id":"snap-owned","status":"created","size":10}}]'
  else
    echo '[{{"id":"snap-unrelated-older","status":"created","size":99}}]'
  fi
}}
sleep() {{ :; }}
{create_snapshot}
create_volume_snapshot_exact vol-1 || exit $?
echo "EXACT=$CREATED_SNAPSHOT_ID"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"CALLS": str(calls), "CREATED": str(created), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "EXACT=snap-owned" in result.stdout
    assert "snap-unrelated-older" not in result.stdout

    created.unlink()
    ambiguous_script = script.replace(
        '{"id":"snap-owned","status":"created","size":10}]',
        '{"id":"snap-owned","status":"created","size":10},'
        '{"id":"snap-racing","status":"running","size":0}]',
    )
    ambiguous = subprocess.run(
        ["bash", "-c", ambiguous_script],
        env={"CALLS": str(calls), "CREATED": str(created), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert ambiguous.returncode != 0
    assert "multiple new snapshots appeared" in ambiguous.stderr
    assert "EXACT=" not in ambiguous.stdout


def test_refresh_deps_rejects_invalid_ref_before_fly(tmp_path: Path) -> None:
    """An unresolved ref is input failure and must cause zero Fly API calls."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "fly-calls"
    calls.write_text("")
    fake_fly = bin_dir / "flyctl"
    fake_fly.write_text(
        '#!/usr/bin/env bash\n'
        'printf "%s\\n" "$*" >> "$FLY_CALLS"\n'
        'echo "[]"\n'
    )
    fake_fly.chmod(0o755)

    result = subprocess.run(
        ["bash", str(CLOUD_SCRIPT), "--refresh-deps", "--ref", "definitely-not-a-commit"],
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FLY_BENCH_API_TOKEN": "test-token",
            "FLY_CALLS": str(calls),
        },
        text=True, capture_output=True, check=False, timeout=20,
    )

    assert result.returncode != 0
    assert calls.read_text() == ""
    assert "invalid benchmark ref" in result.stdout + result.stderr


def test_isolated_backend_startup_retries_one_hung_process(tmp_path: Path) -> None:
    """A live-but-never-listening first backend cannot abort the whole fleet slot."""
    stack = STACK_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(stack, signature)
        for signature in (
            "terminate_backend_group() {",
            "restart_backend_service() {",
            "wait_for_isolated_backend_ready() {",
        )
    )
    launcher = tmp_path / "backend_tree.py"
    launcher.write_text(
        "import os, pathlib, signal, subprocess, sys, time\n"
        "os.setsid()\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'])\n"
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid))\n"
        "time.sleep(30)\n"
    )
    launches = tmp_path / "launches"
    launches.write_text("0\n")
    child_dir = tmp_path / "children"
    child_dir.mkdir()
    script = f"""set -uo pipefail
BACKEND_PORT=3001
BACKEND_LOG_FILE=/dev/null
FAIL_DIR="$CHILD_DIR/fail"
mkdir -p "$FAIL_DIR"
CLOUDBENCH_BACKEND_START_READY_ATTEMPTS=2
BACKEND_INDEX=0
PIDS=("")
launch_backend_service() {{
  count=$(cat "$LAUNCHES"); count=$((count + 1)); echo "$count" > "$LAUNCHES"
  python3 "$LAUNCHER" "$CHILD_DIR/child-$count" &
  BACKEND_PID=$!
  BACKEND_PGID=$BACKEND_PID
  PIDS[$BACKEND_INDEX]="$BACKEND_PID"
  echo "$BACKEND_PID" > "$CHILD_DIR/root-$count"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CHILD_DIR/child-$count" ] && break; sleep 0.1; done
}}
curl() {{ [ "$(cat "$LAUNCHES")" -ge 2 ]; }}
{helpers}
launch_backend_service
wait_for_isolated_backend_ready
rc=$?
old_child=$(cat "$CHILD_DIR/child-1")
if kill -0 "$old_child" 2>/dev/null; then echo OLD_SURVIVED; rc=1; else echo OLD_GONE; fi
new_root=$(cat "$CHILD_DIR/root-2")
[ "${{PIDS[0]}}" = "$new_root" ] || {{ echo SLOT_STALE; rc=1; }}
terminate_backend_group || rc=1
kill -0 "$new_root" 2>/dev/null && {{ echo NEW_SURVIVED; rc=1; }}
exit "$rc"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={
            "LAUNCHER": str(launcher),
            "LAUNCHES": str(launches),
            "CHILD_DIR": str(child_dir),
            "PATH": os.environ["PATH"],
        },
        text=True, capture_output=True, check=False, timeout=25,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert launches.read_text().strip() == "2"
    assert "backend startup attempt 1/2 did not become healthy" in result.stdout + result.stderr
    assert "backend became healthy after restart" in result.stdout
    assert "OLD_GONE" in result.stdout
    assert "OLD_SURVIVED" not in result.stdout
    assert "SLOT_STALE" not in result.stdout
    assert "NEW_SURVIVED" not in result.stdout


def test_refresh_deps_mode_contract() -> None:
    """--refresh-deps must sync the ref, run the marker-gated dep sync, STOP the
        machine before snapshotting (quiesced snapshot), wait boundedly for the
        exact created snapshot, and record the shared freshness state file."""
    cloud = CLOUD_SCRIPT.read_text()
    start = cloud.index('if [ "$MODE" = "refresh-deps" ]; then')
    end = cloud.index('# MODE: --refresh-wmh', start)
    mode = cloud[start:end]
    snapshot_helper = _extract_fleet_function(cloud, "create_volume_snapshot_exact() {")
    assert "cloudbench-sync-deps.sh' /app" in mode
    assert "::DEPS-REFRESH-DONE::" in mode
    # stop precedes the snapshot cut
    assert mode.index('stop_machine_strict "$mid"') < mode.index('create_volume_snapshot_exact "$VOL_ID"')
    # bounded wait for a COMPLETE fresh snapshot
    assert 'CLOUDBENCH_SNAPSHOT_READY_ATTEMPTS:-90' in snapshot_helper
    # shared freshness state recorded for fleet preflights
    assert 'cloudbench-warm-deps.fp' in mode
    assert "cloudbench_node_dependency_fingerprint" in mode
    assert "cloudbench_manifest_fingerprint" in mode
    # flag is wired
    assert '--refresh-deps)   MODE="refresh-deps"' in cloud
    # the fleet preflight exists and runs before cloning begins
    fleet = FLEET_SCRIPT.read_text()
    assert fleet.index("warm_deps_preflight || exit 1\n") < fleet.index("# ── Phase 1:")


def test_controller_execs_from_a_script_snapshot(tmp_path: Path) -> None:
    """bash reads scripts lazily from disk: editing run-bench-fleet or
    run-bench-cloud while a controller is mid-run shifts bytes under the
    interpreter and kills a healthy fleet with a parse error (observed: 28
    provisioned boxes torn down by "syntax error near unexpected token 'fi'"
    after an in-flight edit). The controller must re-exec from an immutable
    per-invocation snapshot before any long-running work, and every child
    run-bench-cloud invocation must use the snapshot copy."""
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()

    # snapshot-exec happens before arg parsing / locks / machines
    snap_at = fleet.index('exec bash "$CLOUDBENCH_SCRIPT_SNAPSHOT/run-bench-fleet"')
    assert snap_at < fleet.index('while [ $# -gt 0 ]; do')
    assert snap_at < fleet.index("cloudbench_controller_lock_acquire")
    # the snapshot carries all three co-versioned interpreter files
    for f in ("run-bench-fleet", "run-bench-cloud", "cloudbench-env.sh"):
        assert f in fleet[fleet.index("cloudbench-scripts.XXXXXX"):snap_at], f"{f} missing from snapshot copy set"
    # every child/preflight/verify call goes through the snapshot binary —
    # no direct executable reference to the live checkout remains
    assert 'RUN_BENCH_CLOUD_BIN="$CLOUDBENCH_SCRIPT_SNAPSHOT/run-bench-cloud"' in fleet
    for line in fleet.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "echo " in stripped:
            continue
        if "bash scripts/run-bench-cloud" in stripped or 'bash "$ROOT_DIR/scripts/run-bench-cloud"' in stripped:
            raise AssertionError(f"live-checkout invocation must use RUN_BENCH_CLOUD_BIN: {line}")
    # both interpreters honor the fleet-root override so snapshot copies keep
    # resolving repo paths correctly
    assert 'ROOT_DIR="${CLOUDBENCH_FLEET_ROOT:-' in fleet
    assert 'ROOT_DIR="${CLOUDBENCH_FLEET_ROOT:-' in cloud
    assert 'source "${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts/lib}/cloudbench-env.sh"' in fleet
    assert 'source "${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts/lib}/cloudbench-env.sh"' in cloud
    # the run's cleanup reaps the snapshot dir
    assert 'rm -rf "$CLOUDBENCH_SCRIPT_SNAPSHOT"' in fleet

    # functional: the re-exec chain is sound end-to-end (--help flows through
    # the snapshot exec and still exits 0 with usage text)
    result = subprocess.run(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={**os.environ, "CLOUDBENCH_SCRIPT_SNAPSHOT": "", "TMPDIR": str(tmp_path)},
        text=True, capture_output=True, check=False, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "run-bench-fleet" in result.stdout
    # and the snapshot dir was actually created under our TMPDIR
    assert any(d.name.startswith("cloudbench-scripts.") for d in tmp_path.iterdir())


def test_bring_up_report_attributes_time_to_named_steps(tmp_path: Path) -> None:
    """Every bring-up second must be attributable to a named step: the driver
    stamps `STEP <name>` boundaries and cloudbench-bring-up-report.py turns a
    fleet run dir into per-step durations + p50/max + slowest-step callout."""
    driver = DRIVER_SCRIPT.read_text()
    # timestamped log + step marker helpers exist and phases are stamped
    assert 'log() { echo "[cloudbench $(date -u +%H:%M:%S)] $*"; }' in driver
    assert 'step() { log "STEP $*"; }' in driver
    for name in ("git_sync", "dep_sync", "postgres", "stack_launch", "services_wait", "benchmark"):
        assert f"\nstep {name}\n" in driver, f"driver missing STEP stamp: {name}"

    run = tmp_path / "run"
    (run / "bench-a").mkdir(parents=True)
    (run / "bench-a" / "fleet-child.log").write_text(
        "   | [cloudbench 10:00:00] STEP git_sync\n"
        "   | [cloudbench 10:00:20] STEP dep_sync\n"
        "   | [cloudbench 10:03:20] STEP postgres\n"
        "   | [cloudbench 10:03:30] STEP stack_launch\n"
        "   | [cloudbench 10:04:30] STEP services_wait\n"
        "   | [cloudbench 10:05:00] STEP benchmark\n"
    )
    (run / "bench-b").mkdir(parents=True)
    (run / "bench-b" / "fleet-child.log").write_text(
        "   | [cloudbench 10:00:00] STEP git_sync\n"
        "   | [cloudbench 10:00:10] STEP dep_sync\n"
        "   | [cloudbench 10:00:15] STEP postgres\n"
        "   | [cloudbench 10:00:25] STEP stack_launch\n"
        "   | [cloudbench 10:01:25] STEP services_wait\n"
        "   | [cloudbench 10:02:00] STEP benchmark\n"
    )
    result = subprocess.run(
        ["python3", str(ROOT / "scripts" / "cloudbench-bring-up-report.py"), str(run)],
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "bench-a" in out and "bench-b" in out
    # bench-a's dep_sync is 180s and must surface as the slowest step
    assert "slowest step: dep_sync on bench-a (180s)" in out
    assert "p50" in out and "max" in out


def test_run_is_visible_in_hub_from_fire_time(tmp_path: Path) -> None:
    """A fired run must appear in the central hub IMMEDIATELY with an explicit
    starting phase — a run waiting on a snapshot/heal/provisioning was invisible
    until Phase 2 wrote its first real report card. The startup card is written
    and the hub started right after the controller lock, before any
    preflight/heal/machine work, and the phase updates at each stage."""
    fleet = FLEET_SCRIPT.read_text()
    lock_at = fleet.index('if ! cloudbench_controller_lock_acquire_wait')
    card_at = fleet.index('write_startup_card "controller starting"')
    hub_at = fleet.index("start_central_hub\n")
    verify_at = fleet.index('Verifying the shared benchmark app environment')
    fanout_at = fleet.index("# ── Phase 1:")
    assert lock_at < card_at < verify_at, "startup card must precede preflight"
    assert lock_at < hub_at < verify_at, "hub must serve before preflight"
    assert card_at < fanout_at and hub_at < fanout_at
    # phase updates at each controller stage
    for phase in ("verifying environment", "healing warm snapshot", "provisioning"):
        assert f'write_startup_card "{phase}' in fleet, f"missing phase update: {phase}"
    # early + late hub starts must stay the SAME server invocation (no drift)
    assert fleet.count('agents/benchmarks/agent_link_server.py') == 2

    # functional: the card is a valid hub-readable starting card
    helper_start = fleet.index("write_startup_card() {")
    helper = fleet[helper_start:fleet.index("\nPY\n}", helper_start) + len("\nPY\n}")]
    result = subprocess.run(
        ["bash", "-c", f'''set -uo pipefail
FLEET_DIR="$FD"
RUN_ID=test-run
BENCHES=(alpha beta)
{helper}
write_startup_card "healing warm snapshot (dep trees)"
'''],
        env={"FD": str(tmp_path), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    card = json.loads((tmp_path / "_batch" / "report-card.json").read_text())
    assert card["status"] == "starting"
    assert "healing warm snapshot" in card["phase"]
    assert card["summary"]["total"] == 2
    assert [t["name"] for t in card["tasks"]] == ["alpha", "beta"]
    assert all(t["status"] == "starting" for t in card["tasks"])


def test_controller_names_the_signal_that_killed_it() -> None:
    """Silent teardowns (children mass-TERM'd, no error, no barrier release)
    repeatedly masqueraded as infra failures when the controller was signalled
    externally. Each fatal signal trap must announce itself before exiting."""
    fleet = FLEET_SCRIPT.read_text()
    for sig in ("HUP", "INT", "TERM"):
        assert f"controller received {sig}" in fleet, f"unannounced {sig} trap"


def test_stale_name_only_registry_survives_provider_visibility_gap(tmp_path: Path) -> None:
    """A successful Fly clone can become list-visible after the controller's
    lookup deadline. The name-only record is the sole durable ownership proof
    during that gap, so stale recovery must retain it and fail closed rather
    than orphaning a late machine while provisioning a replacement fleet."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in (
            "registry_meta_value() {",
            "registry_resolve_name() {",
            "registry_machine_details() {",
            "reap_registry_clones() {",
        )
    )
    root = tmp_path / "cloudbench-fleet-ownership"
    reg = root / "deadtoken"
    (reg / "clones").mkdir(parents=True)
    # a clone recorded by name only (no id) whose machine is absent on Fly
    (reg / "clones" / "cloudbench-gone").write_text("name=cloudbench-gone\n")

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT="$ROOT"
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
FLY() {{
  if [ "$1 $2" = "machines list" ]; then echo "[]"; fi   # clone is absent
}}
{helpers}
reap_registry_clones "$REG" stale
echo "reap_exit=$?"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"ROOT": str(root), "REG": str(reg), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert "retaining ownership and refusing to provision" in result.stderr
    assert "reap_exit=1" in result.stdout, f"{result.stdout}\n{result.stderr}"
    assert (reg / "clones" / "cloudbench-gone").exists(), "uncertain clone ownership must survive"


def test_fleet_dedupes_duplicate_bench_names() -> None:
    """RCA (2026-07-15): the daily catalog gained duplicate task names via a
    merge. run-bench-fleet keys each bench's isolated machine on
    $FLEET_DIR/$bench, so a duplicate name shared an out-dir/machine and tripped
    'isolation violation: machine … allocated twice', aborting all 31 benches at
    t+312s. The fleet must dedupe bench args (first-seen order) and run once."""
    fleet = FLEET_SCRIPT.read_text()
    # the dedupe runs before the isolation-checked launch loop
    assert "duplicate bench" in fleet
    dedupe_at = fleet.index("_deduped_benches=()")
    launch_at = fleet.index("# ── Phase 1:")
    assert dedupe_at < launch_at, "dedupe must precede provisioning"

    # functional: a b a c b -> a b c (order preserved, dupes dropped)
    block_start = fleet.index('if [ "${#BENCHES[@]}" -ge 1 ]; then', dedupe_at - 400)
    block_end = fleet.index("\nfi\n", block_start) + 3
    dedupe_block = fleet[block_start:block_end]
    script = f"""set -uo pipefail
BENCHES=(alpha beta alpha gamma beta alpha)
{dedupe_block}
printf '%s ' "${{BENCHES[@]}}"
echo
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "alpha beta gamma", result.stdout
    assert result.stderr.count("duplicate bench") == 3


def test_cloud_git_sync_uses_safe_directory_everywhere() -> None:
    """RCA (2026-07-15): --refresh-deps and --refresh-wmh ran `git -C
    '$REMOTE_REPO'` as ROOT on the rose-owned /data/repo checkout, so git's
    dubious-ownership guard fired ('detected dubious ownership in repository at
    /data/repo') and every fetch/checkout/reset failed — the central heal could
    not run, leaving the warm snapshot stale and each fleet box paying a slow
    dep-rsync + Prisma regen that aborted the batch. Every root-run git on the
    volume checkout must set -c safe.directory (verified on the warm box: bare
    git -> dubious ownership; with safe.directory -> resolves HEAD)."""
    cloud = CLOUD_SCRIPT.read_text()
    # No bare `git -C '$REMOTE_REPO'` may remain (root-run heal/wmh sync paths).
    bare = "git -C '$REMOTE_REPO'"
    assert bare not in cloud, f"root-run git on the volume checkout must use -c safe.directory: {bare}"
    # And the safe.directory form must be present where those syncs happen.
    assert "git -c safe.directory='$REMOTE_REPO' -C '$REMOTE_REPO'" in cloud


def test_start_barrier_tolerates_infra_failures() -> None:
    """RCA (2026-07-15): at fleet width some isolated stacks sporadically fail
    on-box startup (resource/timing races under N concurrent full stacks). The
    all-or-nothing barrier returned failure the instant ANY child exited before
    signalling ready, aborting the whole batch — a 30/31-healthy run reported
    ZERO results, twice. The barrier must EXCLUDE a stack that dies before ready
    (infra failure, not a benchmark verdict), keep the live set, release for the
    survivors, and fail only if EVERY stack dies."""
    fleet = FLEET_SCRIPT.read_text()
    fn = _extract_fleet_function(fleet, "release_start_barrier() {")
    # A single dead child no longer aborts: the old `return 1` on child exit is gone.
    assert "isolated runner exited before synchronized start barrier" not in fn
    # It excludes the dead stack and keeps going.
    assert "excluding it (infra)" in fn
    # It only fails when the whole live set is gone.
    assert 'live" -eq 0 ]' in fn and "every isolated stack failed" in fn
    # Release only targets the ready machines. A release failure must stop the
    # invalid run immediately; silently proceeding strands that task at the
    # barrier and guarantees a missing verdict.
    assert 'is_ready[$j]}" = "1" ] || continue' in fn
    assert "could not release synchronized start barrier" in fn
    # Timeout releases the ready set instead of aborting.
    assert "releasing the ready set anyway" in fn


def test_start_barrier_release_uses_authenticated_data_plane(tmp_path: Path) -> None:
    """RCA (2026-07-16): boot launch removed the N-wide SSH launch burst and
    status polling moved to the WireGuard data plane, but synchronized release
    still fired one `flyctl ssh console ... touch` per ready box. In a live
    30-wide run, one release RPC failed and released boxes subsequently stopped
    without DONE markers. Release must use the already-established status proxy,
    authenticate the request, and fail the controller if any ready box cannot be
    released instead of silently waiting for that box's barrier timeout.
    """
    import urllib.error
    import urllib.request

    fleet = FLEET_SCRIPT.read_text()
    fn = _extract_fleet_function(fleet, "release_start_barrier() {")
    assert "FLY ssh console" not in fn
    assert "CLOUDBENCH_BARRIER_TOKEN" in fleet
    assert "http://127.0.0.1:" in fn and "/release" in fn
    assert "could not release synchronized start barrier" in fn

    assert STATUS_SERVER_SCRIPT.exists(), "data-plane release server is missing"
    barrier = "run-123"
    token = "release-secret"
    (tmp_path / "bench.log").write_text("ready\n")
    ready_file = tmp_path / "server.port"
    env = os.environ.copy()
    env["CLOUDBENCH_BARRIER_TOKEN"] = token
    server = subprocess.Popen(
        [
            "python3",
            str(STATUS_SERVER_SCRIPT),
            "--directory",
            str(tmp_path),
            "--port",
            "0",
            "--barrier",
            barrier,
            "--bind",
            "127.0.0.1",
            "--ready-file",
            str(ready_file),
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.time() + 5
        while not ready_file.is_file():
            if server.poll() is not None:
                raise AssertionError("status server exited before binding")
            if time.time() >= deadline:
                raise AssertionError("status server did not publish its port")
            time.sleep(0.02)
        port = int(ready_file.read_text().strip())
        base = f"http://127.0.0.1:{port}"
        local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            try:
                with local_opener.open(f"{base}/bench.log", timeout=0.5) as response:
                    assert response.read() == b"ready\n"
                break
            except (OSError, urllib.error.URLError):
                if time.time() >= deadline:
                    raise
                time.sleep(0.05)

        release = tmp_path / f"cloudbench-start-{barrier}.release"
        denied = urllib.request.Request(
            f"{base}/release",
            data=b"",
            method="POST",
            headers={"Authorization": "Bearer wrong"},
        )
        try:
            local_opener.open(denied, timeout=1)
            raise AssertionError("wrong barrier token unexpectedly succeeded")
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
        assert not release.exists()

        allowed = urllib.request.Request(
            f"{base}/release",
            data=b"",
            method="POST",
            headers={"Authorization": f"Bearer {token}"},
        )
        with local_opener.open(allowed, timeout=1) as response:
            assert response.status == 204
        assert release.exists()

        pid_file = tmp_path / "cloudbench-driver.pid"
        pid_file.write_text(f"{os.getpid()}\n")
        with local_opener.open(f"{base}/driver-health", timeout=1) as response:
            assert response.status == 204
        health_probe = _extract_fleet_function(
            CLOUD_SCRIPT.read_text(), "probe_driver_health() {"
        )

        def probe(probe_port: int) -> int:
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    f'{health_probe}\nLOCAL_STATUS_PORT="$1"\nprobe_driver_health',
                    "probe",
                    str(probe_port),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            return result.returncode

        assert probe(port) == 0
        pid_file.write_text("99999999\n")
        try:
            local_opener.open(f"{base}/driver-health", timeout=1)
            raise AssertionError("dead driver unexpectedly reported healthy")
        except urllib.error.HTTPError as exc:
            assert exc.code == 410
        assert probe(port) == 10
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            unused_port = sock.getsockname()[1]
        assert probe(unused_port) == 20
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_status_server_defaults_to_fly_6pn_ipv6(tmp_path: Path) -> None:
    import urllib.request

    if not socket.has_ipv6:
        return
    (tmp_path / "bench.log").write_text("ipv6-ready\n")
    ready_file = tmp_path / "server.port"
    server = subprocess.Popen(
        [
            "python3",
            str(STATUS_SERVER_SCRIPT),
            "--directory",
            str(tmp_path),
            "--port",
            "0",
            "--ready-file",
            str(ready_file),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.time() + 5
        while not ready_file.is_file():
            if server.poll() is not None:
                raise AssertionError(server.stderr.read())
            if time.time() >= deadline:
                raise AssertionError("IPv6 status server did not publish its port")
            time.sleep(0.02)
        port = int(ready_file.read_text().strip())
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://[::1]:{port}/bench.log", timeout=2) as response:
            assert response.read() == b"ipv6-ready\n"
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_data_plane_barrier_release_at_full_fleet_width(tmp_path: Path) -> None:
    """All 30 ready boxes release concurrently over their existing data-plane
    proxies; one unavailable endpoint makes the run fail immediately and visibly.
    """
    import socket
    import urllib.error
    import urllib.request

    barrier = "fleet-30"
    token = "fleet-release-token"
    servers: list[subprocess.Popen[str]] = []
    roots: list[Path] = []
    ports: list[int] = []
    env = os.environ.copy()
    env["CLOUDBENCH_BARRIER_TOKEN"] = token
    try:
        for index in range(30):
            root = tmp_path / str(index)
            root.mkdir()
            (root / "bench.log").write_text(
                f"synchronized start barrier ready: {barrier}\n"
            )
            ready_file = root / "server.port"
            server = subprocess.Popen(
                [
                    "python3",
                    str(STATUS_SERVER_SCRIPT),
                    "--directory",
                    str(root),
                    "--port",
                    "0",
                    "--barrier",
                    barrier,
                    "--bind",
                    "127.0.0.1",
                    "--ready-file",
                    str(ready_file),
                ],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            servers.append(server)
            roots.append(root)
            ready_deadline = time.time() + 5
            while not ready_file.is_file():
                if server.poll() is not None:
                    raise AssertionError(f"status server {index} exited before binding")
                if time.time() >= ready_deadline:
                    raise AssertionError(f"status server {index} did not publish its port")
                time.sleep(0.02)
            ports.append(int(ready_file.read_text().strip()))

        deadline = time.time() + 5
        local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while True:
            try:
                with local_opener.open(
                    f"http://127.0.0.1:{ports[-1]}/bench.log", timeout=0.2
                ):
                    break
            except (OSError, urllib.error.URLError):
                if time.time() >= deadline:
                    raise
                time.sleep(0.05)

        for root, port in zip(roots, ports, strict=True):
            (root / "fleet-child.log").write_text(
                f"status proxy: 127.0.0.1:{port} -> fly:8011\n"
                f"synchronized start barrier ready: {barrier}\n"
            )
            (root / "status-proxy.port").write_text(f"{port}\n")

        release_fn = _extract_fleet_function(
            FLEET_SCRIPT.read_text(), "release_start_barrier() {"
        )
        quoted_roots = " ".join(shlex.quote(str(root)) for root in roots)
        script = f"""set +e
SYNCHRONIZED_START=1
RUN_ID={barrier}
START_BARRIER_WAIT_SECONDS=2
CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS=2
CLOUDBENCH_BARRIER_TOKEN={token}
CLOUDBENCH_BARRIER_RELEASE_ATTEMPTS=2
CHILD_PIDS=({' '.join([str(os.getpid())] * 30)})
CHILD_OUT=({quoted_roots})
CHILD_BENCH=({' '.join(f'task-{i}' for i in range(30))})
CHILD_MACHINE=({' '.join(f'machine-{i}' for i in range(30))})
{release_fn}
release_start_barrier
"""
        success = subprocess.run(
            ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=8
        )
        assert success.returncode == 0, success.stderr
        assert all(
            (root / f"cloudbench-start-{barrier}.release").exists() for root in roots
        )

        for root in roots:
            (root / f"cloudbench-start-{barrier}.release").unlink()
        servers[-1].terminate()
        servers[-1].wait(timeout=5)
        failed = subprocess.run(
            ["bash", "-c", script.replace("ATTEMPTS=2", "ATTEMPTS=1")],
            text=True,
            capture_output=True,
            check=False,
            timeout=8,
        )
        assert failed.returncode == 1
        assert "could not release synchronized start barrier" in failed.stderr
    finally:
        for server in servers:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=5)


def test_clone_burst_is_rate_limit_resilient() -> None:
    """RCA (2026-07-15): a 30-wide daily fleet fired all clones in the SAME
    instant, saturating Fly's Machines API — `resource_exhausted: rate limit
    exceeded` on clone/create-volume. The fixed-8s/3-attempt retry landed every
    retry back inside the same saturation window, so 3 clones exhausted their
    attempts and dropped from the batch (silent coverage loss, an infra failure).
    Fix: stagger the launch burst + exponential backoff with jitter + more
    attempts, so a rate-limited clone outlasts the burst instead of giving up."""
    fleet = FLEET_SCRIPT.read_text()
    # More attempts (was 3).
    assert (
        'max_attempts="${CLOUDBENCH_CLONE_MAX_ATTEMPTS:-'
        '${CLOUDBENCH_CLONE_ATTEMPTS:-5}}"' in fleet
    )
    # Launch burst is staggered, not simultaneous.
    assert 'CLOUDBENCH_CLONE_LAUNCH_STAGGER_SECONDS' in fleet
    # Exponential backoff (bit-shift by attempt) with a cap and jitter.
    clone_fn = _extract_fleet_function(fleet, "clone_machine_target() {")
    assert "1 << (attempt - 1)" in clone_fn
    assert "CLOUDBENCH_CLONE_RETRY_MAX_SECONDS" in clone_fn
    assert "RANDOM % 5" in clone_fn
    # The old fixed-delay retry (`sleep "$retry_delay"` unconditionally) is gone.
    assert 'sleep "$retry_delay"\n' not in clone_fn


def test_launcher_detects_dead_onbox_driver() -> None:
    """RCA (2026-07-15): at fleet width the detached on-box driver sometimes dies
    at launch (an early kill/crash before its first STEP — Fly API rate-limited).
    It then never writes the DONE marker, so the launcher's poll loop — which only
    watched for DONE or the 3600s hard timeout — spun the FULL run timeout while
    the fleet's synchronized-start barrier waited on that box, stalling the whole
    batch for up to an hour on ONE flaky launch. The launcher must probe driver
    liveness after a stall and stop promptly when it's gone with no DONE marker,
    so the controller excludes the box fast; launches are staggered to reduce the
    burst that triggers the death; and the health-wait FATAL must capture the exit
    code + stack-log tail so a bring-up death is diagnosable."""
    cloud = CLOUD_SCRIPT.read_text()
    # Poll loop probes driver liveness over the data plane on stall and breaks on death.
    assert "DRIVER_STALL_SECONDS" in cloud
    assert "/driver-health" in cloud
    assert "confirmed dead after" in cloud
    assert "probe_machine_liveness()" in cloud
    assert "explicitly no longer running" in cloud
    # Stall exclusion uses the data-plane liveness contract, never an ssh pgrep.
    assert "driver-health" in STATUS_SERVER_SCRIPT.read_text()
    # Driver launch is retried until confirmed running (a single rate-limited
    # fire-and-forget launch left boxes dead at RUNSTAMP), and the liveness
    # probe presumes death on repeated non-ALIVE results (DEAD OR unreachable),
    # since the rate-limiting that kills the driver also fails a strict probe.
    assert "CLOUDBENCH_DRIVER_LAUNCH_ATTEMPTS" in cloud
    assert "driver not confirmed running (attempt" in cloud
    # Boot launches are minimally staggered (30 submissions in ~7.5s), while
    # the legacy multi-SSH path retains its conservative throttle.
    fleet = FLEET_SCRIPT.read_text()
    assert "CLOUDBENCH_LAUNCH_STAGGER_SECONDS" in fleet
    assert 'CLOUDBENCH_LAUNCH_STAGGER_SECONDS:-0.25}' in fleet
    assert 'CLOUDBENCH_LAUNCH_STAGGER_SECONDS:-3.5}' in fleet
    # Stack-health FATAL captures the actual death cause (exit code + tail + OOM).
    run = (CLOUD_SCRIPT.parent / "cloudbench-run.sh").read_text()
    assert "stack process exited (rc=$stack_rc)" in run
    assert "last 40 lines of stack log" in run


def test_status_polled_over_data_plane_proxy_not_ssh() -> None:
    """RCA (2026-07-15): the fleet's SSH-pull design (each of 30 boxes ssh_read-
    polling /data/bench.log every few seconds) saturates Fly's Machines-API rate
    limit — confirmed by manual 'flyctl machines list' being throttled ~1/3 of
    calls during a live 30-box run, which froze the batch. Fix: serve bench.log
    from a tiny on-box HTTP server and poll it over a `flyctl proxy` (WireGuard
    DATA plane — zero Machines-API cost). Never fall back to SSH inside the hard-
    timeout loop: a stopped box left flyctl SSH hung for 2h22m beyond its 7200s
    ceiling, and 30 simultaneous fallbacks recreate the control-plane burst."""
    cloud = CLOUD_SCRIPT.read_text()
    # On-box status server over /data, and a data-plane proxy to it.
    assert "REMOTE_STATUS_PORT" in cloud
    assert "http.server ${REMOTE_STATUS_PORT} --directory /data" in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))" LOCAL_STATUS_PORT' in cloud
    assert 'publish_status_proxy_port "$port"' in cloud
    # The poll reads only over the bounded data-plane proxy.
    assert "read_bench_log()" in cloud
    assert 'curl -fsS --max-time 6 "http://127.0.0.1:$LOCAL_STATUS_PORT/bench.log"' in cloud
    assert 'if remote_log="$(read_bench_log' in cloud
    read_log = _extract_fleet_function(cloud, "read_bench_log() {")
    assert "ssh_read" not in read_log
    # Proxy cleanup is PID-owned; no cross-run pattern kill is allowed.
    assert 'cloudbench_terminate_and_wait 5 "${PROXY_PID:-}" "${STATUS_PROXY_PID:-}"' in cloud
    assert 'flyctl proxy "$local_port:$remote_port"' in cloud
    assert 'FLY proxy "$local_port:$remote_port"' not in cloud
    assert 'pkill -f "flyctl proxy $LOCAL_STATUS_PORT' not in cloud

    # Backgrounding the FLY() shell function records a wrapper-subshell PID and
    # can orphan its flyctl child. Autoscaler metrics tunnels must also record
    # and reap the executable PID directly.
    fleet = FLEET_SCRIPT.read_text()
    assert 'flyctl proxy "$metrics_port:$BOX_HEALTH_PORT"' in fleet
    assert 'FLY proxy "$metrics_port:$BOX_HEALTH_PORT"' not in fleet
    assert 'cloudbench_terminate_and_wait 5 "${metrics_proxy_pid:-}"' in fleet


def test_boot_launch_collects_terminal_artifacts_without_post_done_ssh() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    collection = cloud[
        cloud.index("# Preserve the complete remote driver") : cloud.index(
            "RUN_IDENTITY_OK=", cloud.index("# Preserve the complete remote driver")
        )
    ]

    assert 'if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" != "1" ]; then' in collection
    assert 'if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then' in collection
    assert 'CARD_JSON="$(awk' in collection
    assert 'RUN_JSON="$(awk' in collection
    assert "Never re-enter Machines-API SSH after DONE" in collection


def test_boot_launch_dashboard_card_mirror_uses_data_plane() -> None:
    """The live dashboard must not create one Machines-API SSH session per
    second per box; at daily width that exhausted Fly and left an SSH child
    alive after the real verdict and DONE marker."""
    cloud = CLOUD_SCRIPT.read_text()
    mirror = cloud[
        cloud.index("expected_total=\"${#BENCH_TASKS[@]}\"") : cloud.index(
            "DASHBOARD_MIRROR_PID=$!"
        )
    ]

    assert 'if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then' in mirror
    assert "/repo/.context/cloudbench/report-card.json" in mirror
    assert "curl -fsS --max-time 6" in mirror
    assert "30 control-plane sessions/second" in mirror


def test_boot_supervisor_keeps_data_plane_alive_after_done() -> None:
    """A Fly Machine must not stop between the on-box DONE write and the
    controller's next data-plane poll, or a real verdict becomes NORESULT."""
    boot = (CLOUD_SCRIPT.parent / "cloudbench-boot.sh").read_text()

    assert 'bash "$REPO/scripts/cloudbench-run.sh" >> "$LOG" 2>&1' in boot
    assert 'exec bash "$REPO/scripts/cloudbench-run.sh"' not in boot
    assert "holding for controller collection" in boot
    assert boot.rstrip().endswith("exec sleep infinity")


def test_claimed_pool_teardown_is_parallel_with_shared_inventory() -> None:
    """Thirty serial stop-and-list loops add N teardown latency and API load."""
    fleet = FLEET_SCRIPT.read_text()
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    claimed = cleanup[
        cleanup.index("pending_pool_ids=") : cleanup.index(
            'if [ "$FLEET_REGISTRY_PUBLISHED"'
        )
    ]

    assert 'machine stop "$id"' in claimed
    assert "CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT" in claimed
    assert 'stop_pids+=("$!")' in claimed
    assert 'FLY machines list -a "$APP" --json' in claimed
    assert 'pool_machine_state "$id"' not in claimed
    assert "CLOUDBENCH_POOL_STOP_REQUEST_ATTEMPTS" in claimed
    assert "shared inventory" in claimed


def test_cloud_timeout_kills_a_command_that_ignores_sigalrm() -> None:
    """RCA (2026-07-16): the perl-alarm wrapper exec'd flyctl and relied on
    SIGALRM surviving exec. A stopped-machine SSH ignored that contract and ran
    for 2h22m, preventing the outer 7200s loop deadline from being checked.
    The wrapper must own, terminate, and wait for the child process itself."""
    cloud = CLOUD_SCRIPT.read_text()
    timeout_fn = _extract_fleet_function(cloud, "_with_timeout() {")
    script = f"""{timeout_fn}
_with_timeout 1 python3 -c 'import signal,time; signal.signal(signal.SIGALRM, signal.SIG_IGN); time.sleep(30)'
"""
    started = time.monotonic()
    proc = subprocess.Popen(
        ["bash", "-c", script],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=4)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise AssertionError("timeout wrapper left its signal-ignoring child hung")
    assert proc.returncode != 0, (stdout, stderr)
    assert time.monotonic() - started < 4


def test_staleness_pauses_during_barrier_wait_and_per_box_timeout() -> None:
    """RCA (2026-07-15): the data-plane staleness exclusion wrongly killed boxes
    that had reached 'barrier ready' and were legitimately BLOCKED on the release
    file (no bench.log output while waiting) — when the barrier took a while to
    release, every ready box was excluded → 0/30 NORESULT. Fix: pause the staleness
    timer while the log shows 'barrier ready' but not yet 'barrier released'. And
    a per-box barrier ceiling so one holdout (hung relay / driver dead before the
    poll loop) can't drag the whole barrier to the global timeout."""
    cloud = CLOUD_SCRIPT.read_text()
    assert "synchronized start barrier ready" in cloud
    assert "! grep -aq 'synchronized start barrier released'" in cloud
    fleet = FLEET_SCRIPT.read_text()
    assert "CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS" in fleet
    assert "did not reach the start barrier within" in fleet


def test_quiet_benchmark_emits_driver_heartbeats() -> None:
    """RCA (2026-07-16): the 210-second no-log watchdog was described as a
    bring-up detector but remained active after barrier release. Multiple real
    benchmarks ran quietly for 210 seconds, were killed as alleged bring-up
    failures, and became missing verdicts. The driver must heartbeat while the
    benchmark subprocess is alive so true driver death still becomes stale while
    quiet, healthy benchmark execution does not.
    """
    driver = DRIVER_SCRIPT.read_text()
    heartbeat = _extract_fleet_function(driver, "run_with_heartbeat() {")
    assert "CLOUDBENCH_HEARTBEAT_SECONDS" in heartbeat
    assert 'log "$label heartbeat' in heartbeat
    assert 'run_with_heartbeat "benchmark"' in driver

    script = f"""set +e
log() {{ echo "$*"; }}
{heartbeat}
CLOUDBENCH_HEARTBEAT_SECONDS=1 run_with_heartbeat benchmark bash -c 'sleep 2; exit 7'
rc=$?
echo rc=$rc
exit 0
"""
    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=6
    )
    assert "benchmark heartbeat" in result.stdout
    assert "rc=7" in result.stdout


def test_cloud_runner_avoids_live_run_port_collisions() -> None:
    """RCA (2026-07-16): concurrent runs in one workspace reused the same fixed
    per-task ports. Live evidence showed status proxies exiting with `bind:
    address already in use`, which blinded liveness/release and caused infra
    exclusions. Every locally bound per-task endpoint must resolve a free port,
    and the fleet must discover the selected status port from the child rather
    than reconstructing the preferred value.
    """
    cloud = CLOUD_SCRIPT.read_text()
    assert 'claim_local_port "$LOCAL_DASH_PORT" LOCAL_DASH_PORT' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))" LOCAL_STATUS_PORT' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 1))" LIVE_BACKEND_PORT' in cloud
    assert "return 98" in _extract_fleet_function(cloud, "start_data_plane_proxy() {")
    assert "release_local_port_lease" in _extract_fleet_function(
        cloud, "start_leased_data_plane_proxy() {"
    )
    assert "release_local_port_leases" in _extract_fleet_function(cloud, "stop_on_exit() {")
    assert 'pkill -f "flyctl proxy $LOCAL_STATUS_PORT' not in cloud
    assert 'pkill -f "flyctl proxy $LIVE_BACKEND_PORT' not in cloud
    fleet = FLEET_SCRIPT.read_text()
    barrier = _extract_fleet_function(fleet, "release_start_barrier() {")
    assert "status-proxy.port" in barrier
    assert 'status_port="$(cat "$release_port_file"' in barrier
    assert "sed -nE 's/.*status proxy:" not in barrier
    assert "CHILD_PORT[j] + 3" not in barrier

    bindable = _extract_fleet_function(cloud, "local_port_is_bindable() {")
    claim = _extract_fleet_function(cloud, "claim_local_port() {")
    release = _extract_fleet_function(cloud, "release_local_port_leases() {")
    lease_root = ROOT / ".context" / f"port-lease-test-{os.getpid()}"
    lease_root.mkdir(parents=True, exist_ok=True)
    script = f"""set -eu
PORT_LEASE_ROOT="$1"
PORT_LEASE_NONCE="$$-$RANDOM"
PORT_LEASES=()
{bindable}
{claim}
{release}
trap release_local_port_leases EXIT
claim_local_port "$2" CLAIMED_PORT
echo "$CLAIMED_PORT"
sleep 1
"""
    first = subprocess.Popen(
        ["bash", "-c", script, "lease", str(lease_root), "42000"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    second = subprocess.Popen(
        ["bash", "-c", script, "lease", str(lease_root), "42000"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    first_out, first_err = first.communicate(timeout=5)
    second_out, second_err = second.communicate(timeout=5)
    assert first.returncode == 0, first_err
    assert second.returncode == 0, second_err
    assert first_out.strip() != second_out.strip()
    assert not any(lease_root.iterdir())
    lease_root.rmdir()


def test_fleet_barrier_reads_the_authoritative_rotated_status_port(tmp_path: Path) -> None:
    """A recovered status tunnel may rotate after its first published log line.

    Barrier release must read the atomic port handoff, not stale console output.
    """
    fleet = FLEET_SCRIPT.read_text()
    release = _extract_fleet_function(fleet, "release_start_barrier() {")
    child_out = tmp_path / "child"
    child_out.mkdir()
    (child_out / "fleet-child.log").write_text(
        "status proxy: 127.0.0.1:60944 -> fly:8011\n"
        "synchronized start barrier ready: rotation-test\n"
    )
    (child_out / "status-proxy.port").write_text("61945\n")
    observed_url = tmp_path / "release-url"
    script = f"""set -e
SYNCHRONIZED_START=1
RUN_ID=rotation-test
START_BARRIER_WAIT_SECONDS=5
CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS=5
CLOUDBENCH_BARRIER_RELEASE_ATTEMPTS=1
CLOUDBENCH_BARRIER_TOKEN=test-token
CHILD_PIDS=("$$")
CHILD_OUT=({shlex.quote(str(child_out))})
CHILD_MACHINE=(machine-1)
CHILD_BENCH=(bench-1)
curl() {{
  for arg in "$@"; do
    case "$arg" in http://*) printf '%s\n' "$arg" > {shlex.quote(str(observed_url))} ;; esac
  done
  printf 204
}}
sleep() {{ :; }}
{release}
release_start_barrier
"""
    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=5
    )
    assert result.returncode == 0, result.stderr
    assert observed_url.read_text().strip() == "http://127.0.0.1:61945/release"
