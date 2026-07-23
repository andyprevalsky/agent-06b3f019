import base64
import importlib.util
import inspect
import hashlib
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "cloudbench-sync-deps.sh"
PRISMA_SYNC_SCRIPT = ROOT / "scripts" / "cloudbench-sync-prisma-client.sh"
ENV_HELPER_SCRIPT = ROOT / "scripts" / "lib" / "cloudbench-env.sh"
SEED_BUDGET_SCRIPT = ROOT / "scripts" / "lib" / "cloudbench-seed-budget.sh"
APP_ENV_LOCK_SCRIPT = ROOT / "scripts" / "lib" / "cloudbench-app-env-lock.sh"
ARTIFACT_SCRIPT = ROOT / "scripts" / "cloudbench-current-run-artifact.py"
FETCH_SCRIPT = ROOT / "scripts" / "cloudbench-fetch-ref.sh"
SNAPSHOT_SCRIPT = ROOT / "scripts" / "cloudbench-select-snapshot.py"
MACHINE_READINESS_SCRIPT = ROOT / "scripts" / "cloudbench-machine-readiness.py"
STATUS_SERVER_SCRIPT = ROOT / "scripts" / "cloudbench-status-server.py"
BOOT_SCRIPT = ROOT / "scripts" / "cloudbench-boot.sh"
WORKTREE_PATCH_SCRIPT = ROOT / "scripts" / "create-worktree-patch.sh"
AGGREGATE_SCRIPT = ROOT / "scripts" / "cloudbench-aggregate-runs.py"
DRIVER_SCRIPT = ROOT / "scripts" / "cloudbench-run.sh"
WORKER_SCRIPT = ROOT / "scripts" / "cloudbench-worker.sh"
FLEET_SCRIPT = ROOT / "scripts" / "run-bench-fleet"
CLOUD_SCRIPT = ROOT / "scripts" / "run-bench-cloud"
CLOUDBENCH_RESULT_SCRIPT = ROOT / "scripts" / "cloudbench_result.py"
AGENT_LINK_SERVER = ROOT / "agents" / "benchmarks" / "agent_link_server.py"
PORT_LEASE_SCRIPT = ROOT / "scripts" / "cloudbench-port-lease.py"
PREDEPLOY_SCRIPT = ROOT / "scripts" / "run-predeploy-cloud"
PREDEPLOY_LOCAL_SCRIPT = ROOT / "scripts" / "run-predeploy-local"
PREDEPLOY_METRICS_SCRIPT = ROOT / "agents" / "benchmarks" / "predeploy_metrics.py"
LOGGED_COMMAND_SCRIPT = ROOT / "scripts" / "run_logged_command.py"
RUN_BENCH_SCRIPT = ROOT / "scripts" / "run-bench"
WORKTREE_PATCH_SCRIPT = ROOT / "scripts" / "create-worktree-patch.sh"
STACK_SCRIPT = ROOT / "scripts" / "run.sh"
SEED_CACHE_LIB = ROOT / "scripts" / "lib" / "seed-cache.sh"
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
    gosu.write_text('#!/usr/bin/env bash\nset -eu\nshift\nexec "$@"\n')
    gosu.chmod(0o755)
    npx = bin_dir / "npx"
    npx.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        'printf \'%s\\n\' "$*" >> "$PRISMA_GENERATE_LOG"\n'
        '[ "${PRISMA_GENERATE_FAIL:-0}" != 1 ]\n'
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

    (repo / "back-end/prisma/schema.prisma").write_text("model Alpha { id String @id gateKey String? }\n")
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


def test_boot_launch_propagates_parent_hub_identity_to_remote_benchmark() -> None:
    """Fleet children must never register duplicate one-task Hub runs.

    The parent controller is already fail-closed on its visible aggregate row.
    Dropping this identity at the Fly Machine boundary makes every child perform
    its own required Hub upload concurrently, so transient upload saturation
    turns otherwise valid tasks into NORESULT before benchmark execution.
    """
    cloud_script = CLOUD_SCRIPT.read_text()
    env_args = cloud_script.split("_envargs=(", 1)[1].split("    )", 1)[0]

    assert '--env "BENCHMARK_HUB_PARENT_RUN_ID=${BENCHMARK_HUB_PARENT_RUN_ID:-}"' in env_args


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


def test_refreshes_fingerprinted_venv_when_runtime_files_are_unreadable(
    tmp_path: Path,
) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor)
    _write_manifests(repo)
    (donor / "node_modules/current-package").mkdir(parents=True)
    donor_python = donor / "agents/venv/bin/python"
    donor_python.parent.mkdir(parents=True)
    donor_python.write_text("#!/usr/bin/env bash\nexit 0\n")
    donor_python.chmod(0o755)

    first = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr

    cached_python = repo / "agents/venv/bin/python"
    cached_python.write_text("#!/usr/bin/env bash\necho 'OSError: [Errno 5] Input/output error' >&2\nexit 5\n")
    cached_python.chmod(0o755)
    marker_before = (repo / "agents/venv/.cloudbench-deps-fingerprint").read_text()

    repaired = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert repaired.returncode == 0, repaired.stderr
    assert cached_python.read_text() == donor_python.read_text()
    assert (repo / "agents/venv/.cloudbench-deps-fingerprint").read_text() == marker_before


def test_relocates_donor_virtualenv_text_prefixes_after_sync(tmp_path: Path) -> None:
    donor = tmp_path / "donor"
    repo = tmp_path / "repo"
    _write_manifests(donor)
    _write_manifests(repo)
    (donor / "node_modules/current-package").mkdir(parents=True)
    donor_bin = donor / "agents/venv/bin"
    donor_bin.mkdir(parents=True)
    (donor_bin / "python").write_text("current")
    (donor_bin / "example-tool").write_text(f"#!{donor / 'agents/venv/bin/python'}\nprint('ok')\n")
    (donor / "agents/venv/pyvenv.cfg").write_text(f"command = python -m venv {donor / 'agents/venv'}\n")
    donor_cache = donor / "agents/venv/lib/python3.11/site-packages/demo/__pycache__"
    donor_cache.mkdir(parents=True)
    (donor_cache / "module.cpython-311.pyc").write_bytes(b"\0compiled:" + str(donor / "agents/venv").encode())

    result = subprocess.run(
        ["bash", str(SCRIPT), str(donor), str(repo)],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    repo_prefix = str(repo / "agents/venv")
    assert (repo / "agents/venv/bin/example-tool").read_text().splitlines()[0] == (f"#!{repo_prefix}/bin/python")
    assert repo_prefix in (repo / "agents/venv/pyvenv.cfg").read_text()
    assert str(donor / "agents/venv") not in (repo / "agents/venv/pyvenv.cfg").read_text()
    assert not (repo / "agents/venv/lib/python3.11/site-packages/demo/__pycache__/module.cpython-311.pyc").exists()


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
    (donor_venv / "binary-extension.so").write_bytes(b"\0embedded:" + str(donor_venv).encode())

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
        'printf \'npm cwd=%s args=%s\\n\' "$PWD" "$*" >> "$INSTALL_LOG"\n'
        "mkdir -p node_modules\n"
        "touch node_modules/installed-from-manifests\n"
    )
    npm.chmod(0o755)
    npx = bin_dir / "npx"
    npx.write_text('#!/usr/bin/env bash\nset -eu\nprintf \'npx cwd=%s args=%s\\n\' "$PWD" "$*" >> "$INSTALL_LOG"\n')
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
    pip_script = '#!/usr/bin/env bash\nset -eu\nprintf \'pip cwd=%s args=%s\\n\' "$PWD" "$*" >> "$INSTALL_LOG"\n' + (
        "exit 9\n" if fail_pip else 'touch "$(dirname "$0")/../installed-from-manifests"\n'
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
    return (
        donor,
        repo,
        {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "INSTALL_LOG": str(install_log),
            "CLOUDBENCH_REBUILD_DEPS": "1",
        },
    )


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
    donor_python = donor / "agents/venv/bin/python"
    donor_python.write_text("#!/usr/bin/env bash\nexit 0\n")
    donor_python.chmod(0o755)
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

    assert driver.index('rm -rf "$CONTEXT_DIR"') < driver.index('bash "$SYNC_DEPS_SCRIPT"')
    assert '[ -f "$card" ] && [ "$card" -nt "$RUN_OUTPUT_MARKER" ]' in driver
    assert driver.index("unset CLOUDBENCH_GITHUB_TOKEN_B64") < driver.index('bash "$SYNC_DEPS_SCRIPT"')


def test_cold_fleet_guest_gets_a_first_run_stack_budget(tmp_path: Path) -> None:
    """RCA (2026-07-17): a replacement fleet guest legitimately spent more
    than the warm guest's fixed 900-second health deadline performing its first
    production seed. It completed the seed at the deadline, then the driver
    killed the stack before services could start, yielding a REAL NORESULT.

    A guest must retain the bounded cold-start ceiling even when preflight sees
    a matching dump: run.sh can still reject/remove it or fall back after a
    failed restore. Healthy warm restores return early, so the larger ceiling
    adds no latency. Explicit operator overrides remain authoritative.
    """
    driver = DRIVER_SCRIPT.read_text()
    budget_lib = SEED_BUDGET_SCRIPT.read_text()
    helper = _extract_fleet_function(
        budget_lib, "cloudbench_seed_dump_restorable() {"
    ) + _extract_fleet_function(budget_lib, "stack_wait_budget_seconds() {")
    seed_dump = tmp_path / "victoria-seed.dump"
    repo = tmp_path / "repo"
    schema = repo / "back-end" / "prisma" / "schema.prisma"
    schema.parent.mkdir(parents=True)
    schema.write_text("model User { id String @id }\n")

    def budget(*, cold: bool, env: dict[str, str] | None = None) -> int:
        if not cold:
            seed_dump.write_bytes(b"valid seed")
            seed_dump.with_suffix(".dump.schemahash").write_text(
                hashlib.sha1(schema.read_bytes()).hexdigest()
            )
        elif seed_dump.exists():
            seed_dump.unlink()
            seed_dump.with_suffix(".dump.schemahash").unlink(missing_ok=True)
        result = subprocess.run(
            [
                "bash",
                "-c",
                f'{helper}\nSTACK_SEED_DUMP="$1"\nREPO_DIR="$2"\nstack_wait_budget_seconds',
                "budget",
                str(seed_dump),
                str(repo),
            ],
            env={**os.environ, **(env or {})},
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return int(result.stdout.strip())

    assert budget(cold=True) >= 1800
    assert budget(cold=False) >= 1800
    assert budget(
        cold=True,
        env={
            "CLOUDBENCH_STACK_WAIT_SECONDS": "120",
            "CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS": "321",
        },
    ) == 321


def test_fleet_barrier_budget_covers_cold_guest_bootstrap() -> None:
    """RCA (2026-07-17): after the on-box cold-start budget was raised to
    2160s (the 1800s measured cold path plus 20% headroom), the parent
    controller still used its independent 720s per-box
    barrier ceiling. Live run 20260717-204617-18785 excluded the healthy cold
    replacement at exactly 720s while it was still syncing browser data.

    The parent budget must derive from the same cold-stack contract, include
    bounded pre-stack time (boot, checkout, dependency sync), and propagate an
    override all the way into the remote driver. The global barrier may never
    be shorter than the per-box budget.
    """
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    helper = _extract_fleet_function(fleet, "per_box_barrier_wait_seconds() {")
    result = subprocess.run(
        ["bash", "-c", f"{helper}\nper_box_barrier_wait_seconds"],
        env=os.environ.copy(),
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert int(result.stdout.strip()) >= 2400

    overridden = subprocess.run(
        ["bash", "-c", f"{helper}\nper_box_barrier_wait_seconds"],
        env={**os.environ, "CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS": "777"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert overridden.returncode == 0, overridden.stderr
    assert overridden.stdout.strip() == "777"

    assert (
        'CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS="$FIRST_RUN_STACK_WAIT_SECONDS"'
        in fleet
    )
    cold_default_pattern = re.compile(
        r"CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS:-([0-9]+)"
    )
    fleet_defaults = cold_default_pattern.findall(fleet)
    cloud_defaults = cold_default_pattern.findall(cloud)
    driver = DRIVER_SCRIPT.read_text()
    budget_defaults = cold_default_pattern.findall(SEED_BUDGET_SCRIPT.read_text())
    assert len(fleet_defaults) == 2
    assert len(cloud_defaults) == 2
    assert len(budget_defaults) == 1
    assert 'source "$SEED_BUDGET_LIB"' in driver
    assert 'STACK_WAIT_SECONDS="$(stack_wait_budget_seconds)"' in driver
    cold_defaults = fleet_defaults + cloud_defaults + budget_defaults
    assert len(set(cold_defaults)) == 1
    assert int(cold_defaults[0]) >= 1800
    assert (
        '"$START_BARRIER_WAIT_SECONDS" -lt "$PER_BOX_BARRIER_WAIT_SECONDS"'
        in fleet
    )
    assert 'per_box="$PER_BOX_BARRIER_WAIT_SECONDS"' in fleet


def test_boot_update_capacity_pressure_waits_without_spending_regular_retries(
    tmp_path: Path,
) -> None:
    """RCA (2026-07-21): epoch 14 admitted with replacement headroom, but an
    already-running controller on older code provisioned after that cooperative
    snapshot and filled the provider Machine ceiling. Four config updates then
    spent the same ten retries used for ordinary mutation failures and exited
    before the foreign fleet returned capacity.

    Provider capacity pressure needs its own bounded wait budget. It must not
    consume the smaller retry budget that still fails genuine update errors
    quickly.
    """
    cloud = CLOUD_SCRIPT.read_text()
    helper = _extract_fleet_function(
        cloud, "boot_update_with_capacity_recovery() {"
    )
    counter = tmp_path / "attempts"
    update_log = tmp_path / "update.log"
    shell = f"""
_with_timeout() {{ shift; "$@"; }}
fake_update() {{
    count=$(cat "$COUNTER" 2>/dev/null || echo 0)
    count=$((count + 1))
    printf '%s\n' "$count" > "$COUNTER"
    if [ "${{FAILURE_KIND}}" = capacity ] && [ "$count" -le 12 ]; then
        echo "Your organization has reached its machine limit" >&2
        return 1
    fi
    if [ "${{FAILURE_KIND}}" = ordinary ]; then
        echo "invalid machine update" >&2
        return 1
    fi
    echo updated
}}
{helper}
boot_update_with_capacity_recovery "$1" fake_update
"""
    base_env = {
        **os.environ,
        "COUNTER": str(counter),
        "CLOUDBENCH_BOOT_UPDATE_ATTEMPTS": "2",
        "CLOUDBENCH_BOOT_UPDATE_CAPACITY_WAIT_SECONDS": "60",
        "CLOUDBENCH_BOOT_UPDATE_CAPACITY_RETRY_SECONDS": "0",
        "CLOUDBENCH_BOOT_UPDATE_RETRY_SECONDS": "0",
    }
    recovered = subprocess.run(
        ["bash", "-c", shell, "capacity-recovery", str(update_log)],
        env={**base_env, "FAILURE_KIND": "capacity"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert recovered.returncode == 0, recovered.stderr
    assert counter.read_text().strip() == "13"

    counter.unlink()
    ordinary = subprocess.run(
        ["bash", "-c", shell, "ordinary-failure", str(update_log)],
        env={**base_env, "FAILURE_KIND": "ordinary"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert ordinary.returncode != 0
    assert counter.read_text().strip() == "2"

    fleet = FLEET_SCRIPT.read_text()
    assert 'CLOUDBENCH_BOOT_UPDATE_CAPACITY_WAIT_SECONDS="$BOOT_UPDATE_CAPACITY_WAIT_SECONDS"' in fleet
    assert 'CLOUDBENCH_BOOT_CONFIG_BARRIER_WAIT_SECONDS="$BOOT_CONFIG_BARRIER_WAIT_SECONDS"' in fleet


def test_boot_config_barrier_detects_failed_child_before_recovery_deadline(
    tmp_path: Path,
) -> None:
    """The longer capacity-recovery ceiling must not delay a deterministic
    ordinary child failure. A child that exited without its exact ready marker
    makes the global boot barrier impossible and must fail it immediately."""
    fleet = FLEET_SCRIPT.read_text()
    helper = _extract_fleet_function(fleet, "boot_config_failed_child() {")
    barrier = tmp_path / "barrier"
    (barrier / "ready").mkdir(parents=True)
    child = tmp_path / "child"
    child.mkdir()
    (child / "benchmark-child.finished").write_text("1\n")
    script = f"""
BOOT_CONFIG_BARRIER="$1"
CHILD_OUT=("$2")
CHILD_MACHINE=(machine-1)
CHILD_BENCH=(bench-1)
{helper}
boot_config_failed_child
"""
    failed = subprocess.run(
        ["bash", "-c", script, "failed-child", str(barrier), str(child)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert failed.returncode == 0
    assert failed.stdout.strip() == "bench-1"

    (barrier / "ready" / "machine-1").touch()
    ready = subprocess.run(
        ["bash", "-c", script, "ready-child", str(barrier), str(child)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert ready.returncode != 0
    assert ready.stdout == ""


def test_freshly_seeded_database_gets_cold_backend_health_budget() -> None:
    """RCA (2026-07-17): live run 20260717-211552-12528 completed a
    first-time 10k-message/22k-cookie production seed, then interrupted an
    alive backend after the warm 60-second health window. Its retry was also
    interrupted at 60 seconds, producing an infrastructure NORESULT without an
    application error. A cold seed gets a bounded longer health window; restored
    warm databases retain the fast budget, and operator overrides still win.
    """
    stack = STACK_SCRIPT.read_text()
    # run.sh sources scripts/lib/seed-cache.sh, so isolated_backend_ready_attempts
    # delegates the actual number to backend_ready_budget() living in that lib.
    # Reproduce the same composition here (budget helper + attempts wrapper) plus
    # the DB_RESTORED=false default run.sh sets before calling it.
    budget = _extract_fleet_function(
        SEED_CACHE_LIB.read_text(), "backend_ready_budget() {"
    )
    helper = (
        budget + "\n" + _extract_fleet_function(stack, "isolated_backend_ready_attempts() {")
    )

    def attempts(*, cold: bool, override: str | None = None) -> int:
        env = os.environ.copy()
        if override is not None:
            env["CLOUDBENCH_BACKEND_START_READY_ATTEMPTS"] = override
        else:
            env.pop("CLOUDBENCH_BACKEND_START_READY_ATTEMPTS", None)
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"{helper}\nFIRST_RUN_SEEDED=$1\nDB_RESTORED=false\nisolated_backend_ready_attempts",
                "attempts",
                "true" if cold else "false",
            ],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return int(result.stdout.strip())

    assert attempts(cold=True) >= 180
    assert attempts(cold=False) == 60
    assert attempts(cold=True, override="17") == 17
    assert "FIRST_RUN_SEEDED=true" in stack
    assert 'attempts="$(isolated_backend_ready_attempts)"' in stack


def test_fleet_waits_for_every_isolated_stack_before_releasing_benchmarks() -> None:
    driver = DRIVER_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert "synchronized start barrier ready" in driver
    assert "CLOUDBENCH_START_BARRIER" in cloud
    assert "export CLOUDBENCH_START_BARRIER_WAIT_SECONDS" in cloud
    assert 'START_BARRIER_WAIT_SECONDS="${CLOUDBENCH_START_BARRIER_WAIT_SECONDS:-$RUN_TIMEOUT}"' in fleet
    assert "CHILD_RUN_TIMEOUT=$((RUN_TIMEOUT + START_BARRIER_WAIT_SECONDS))" in fleet
    assert 'CLOUDBENCH_START_BARRIER_WAIT_SECONDS="$START_BARRIER_WAIT_SECONDS"' in fleet
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
        "claude-code-agent",
        "browser-smoke",
        "browser-biometrics-webdecoy",
    ]


def test_predeploy_local_runner_selects_the_catalog_smoke_group() -> None:
    result = subprocess.run(
        ["bash", str(PREDEPLOY_LOCAL_SCRIPT), "--list"],
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
        "claude-code-agent",
        "browser-smoke",
        "browser-biometrics-webdecoy",
    ]


def test_cloudbench_result_allows_only_approved_claude_credential_skip(tmp_path: Path) -> None:
    reason = "Claude Code credentials unavailable: no synced Claude token and no available pool token"

    def write_run(path: Path, task_name: str, failure_reason: str) -> None:
        path.write_text(
            json.dumps(
                {
                    "timestamp": "2026-07-22T00:00:00+00:00",
                    "summary": {
                        "total": 1,
                        "passed": 0,
                        "failed": 0,
                        "skipped": 1,
                        "pass_rate": 0.0,
                    },
                    "tasks": [
                        {
                            "name": task_name,
                            "passed": False,
                            "status": "SKIPPED",
                            "failure_reason": failure_reason,
                        }
                    ],
                }
            )
        )

    approved = tmp_path / "approved.json"
    write_run(approved, "cache-coverage", reason)
    accepted = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(approved),
            "--expected-task",
            "cache-coverage",
            "--require-pass",
            "--allow-claude-code-credential-skip",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert accepted.returncode == 0, accepted.stderr

    strict = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(approved),
            "--expected-task",
            "cache-coverage",
            "--require-pass",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert strict.returncode != 0
    assert "task results are not all passing" in strict.stderr

    wrong_task = tmp_path / "wrong-task.json"
    write_run(wrong_task, "chat-mode", reason)
    rejected_wrong_task = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(wrong_task),
            "--expected-task",
            "chat-mode",
            "--require-pass",
            "--allow-claude-code-credential-skip",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected_wrong_task.returncode != 0
    assert "task results are not all passing" in rejected_wrong_task.stderr

    wrong_reason = tmp_path / "wrong-reason.json"
    write_run(wrong_reason, "cache-coverage", "some other skip")
    rejected_wrong_reason = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(wrong_reason),
            "--expected-task",
            "cache-coverage",
            "--require-pass",
            "--allow-claude-code-credential-skip",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected_wrong_reason.returncode != 0
    assert "task results are not all passing" in rejected_wrong_reason.stderr


def test_cloudbench_wrappers_accept_approved_claude_credential_skip() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    cloud_validation = cloud.split('"$ROOT_DIR/scripts/cloudbench_result.py" "$RUN_OUT"', 1)[1].split(
        "then", 1
    )[0]
    assert "--require-pass --allow-claude-code-credential-skip" in cloud_validation
    assert '"--allow-claude-code-credential-skip"' in fleet


def test_deploy_smoke_gate_uses_the_local_isolated_runner(monkeypatch) -> None:
    # The policy, shell entrypoints, and Python owner form one executable chain.
    # Assert every hop so documentation can delegate without duplicating a
    # transitive implementation string, while a shared-stack regression cannot
    # hide behind otherwise-correct source routing.
    deploy = DEPLOY_COMMAND.read_text()
    step = deploy.split("## Step 6: Smoke benchmarks + fix", 1)[1].split("## Step 6b: Semantic tests + fix", 1)[0]

    assert "scripts/run-predeploy-local" in step
    assert "scripts/run-predeploy-cloud" in step
    assert "Benchmarks → Runs" in step
    assert "ALL non-skipped Pre-Deploy smoke benchmarks must pass" in step
    assert "deploy-approved smoke skip is a Claude Code benchmark" in step
    assert "skippable by future deploys without additional human approval" in step
    assert "every non-skipped task" in step
    assert "every requested task passes" in step
    assert ".context/predeploy-runs/<run-id>/runner.log" in step
    assert "run_benchmark.py --suite smoke" not in step
    assert "scripts/run-deploy-stage --start" in deploy
    assert "scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-local" in step
    assert "scripts/run-deploy-stage --finish" in deploy
    assert "bash scripts/run-predeploy-local" in step
    assert "LOCAL isolated benchmark stack" in step
    assert "Use the cloud fleet only as an explicit opt-in" in step
    assert "run_benchmark.py --suite smoke" not in step

    predeploy_local = PREDEPLOY_LOCAL_SCRIPT.read_text()
    assert 'bash "$ROOT_DIR/scripts/run-bench" --local' in predeploy_local
    assert "BENCHMARK_SKIP_WMH_BUILD=1" in predeploy_local
    run_bench = RUN_BENCH_SCRIPT.read_text()
    local_branch = run_bench.split('if [[ "${1:-}" == "--local" ]]', 1)[1].split(
        'if [[ "${1:-}" == "--single-box" ]]', 1
    )[0]
    assert 'exec "$PY" -u benchmarks/local.py "$@"' in local_branch

    from benchmarks import local as local_runner

    assert local_runner.SERVICE_START_TIMEOUT_SECONDS == 600
    assert inspect.signature(local_runner.wait_for_services).parameters["timeout_seconds"].default == 600
    monkeypatch.setattr(local_runner, "allocate_port_range", lambda _preferred: 62000)
    args = local_runner.parse_args(["single-creator-arm", "--run-id", "predeploy-contract", "--base-port", "62000"])
    stack = local_runner.build_service_stack(args)
    assert stack.isolated is True
    assert stack.workspace_name is not None
    assert stack.base_port == 62000
    assert '["bash", "scripts/run.sh", "--benchmark"]' in LOCAL_RUNNER.read_text()
    assert "git diff --name-only HEAD" in deploy
    assert "git ls-files --others --exclude-standard" in deploy


def test_deploy_always_gates_changed_cloudbench_controllers() -> None:
    deploy = DEPLOY_COMMAND.read_text()
    assert "CHANGED_CLOUDBENCH=" in deploy
    gate = deploy.split("## Step 4cb: Cloud benchmark controller regressions", 1)[1].split(
        "## Step 4c: Credential health check", 1
    )[0]
    assert "bash scripts/tests/cloudbench-env.test.sh" in gate
    assert "cloudbench_dependency_sync_test.py" in gate
    assert "fleet_barrier_reads_the_authoritative_rotated_status_port" in gate
    assert "data_plane_barrier_release_at_full_fleet_width" in gate
    assert "boot_launch_delivers_the_exact_worktree_patch_to_every_guest" in gate
    assert "boot_launch_runs_the_current_driver_before_applying_the_patch" in gate
    assert "cloud_patch_includes_tracked_and_untracked_changes" in gate
    assert "cloud_patch_detection_and_payload_include_staged_only_changes" in gate
    assert "worktree_patch_ignores_append_only_history_ledgers" in gate
    assert "patch_delivery_clears_stale_base64_configuration" in gate
    assert "shared_patch_digest_is_pinned_and_verified" in gate
    assert "declared_patch_payload_cannot_be_missing_or_empty" in gate
    assert "empty_local_patch_cleanup_is_nounset_safe" in gate
    assert "autoscaled_worker_failure_publishes_durable_failure_marker" in gate
    assert "must never pause for human approval" in gate
    assert "Operational gate maintenance is pre-authorized" in deploy


def test_cloud_patch_includes_tracked_and_untracked_changes() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    assert 'scripts/create-worktree-patch.sh" "$ROOT_DIR"' in cloud
    assert 'scripts/create-worktree-patch.sh" "$ROOT_DIR" "$BENCH_REF"' in fleet
    assert '[ "$REQUESTED_BENCH_REF" != "$BENCH_REF" ] || cloudbench_worktree_has_changes "$ROOT_DIR"' in fleet
    assert "cloudbench_fetchable_ref" in fleet
    assert cloud.count('LOCAL_PATCH_FILE=""') == 1
    assert cloud.count('STAGED_LOCAL_FILES=()') == 1
    assert fleet.index("worker_ledger_lock_acquire() {") < fleet.index("clone_machine_target() {")
    assert fleet.index("clone_machine_target() {") < fleet.index('if [ -n "$PROVISION_POOL" ]')


def test_worktree_patch_includes_unpushed_commits_from_fetchable_base(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    checkout = tmp_path / "checkout"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "bench@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Bench"], check=True)
    (repo / "tracked.txt").write_text("base\n")
    subprocess.run(["git", "-C", str(repo), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "base"], check=True, capture_output=True)
    base = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    (repo / "tracked.txt").write_text("unpushed commit\n")
    subprocess.run(["git", "-C", str(repo), "commit", "-am", "local"], check=True, capture_output=True)
    (repo / "tracked.txt").write_text("working tree\n")
    (repo / "untracked.txt").write_text("also shipped\n")

    patch = subprocess.run(
        ["bash", str(WORKTREE_PATCH_SCRIPT), str(repo), base],
        check=True,
        capture_output=True,
    ).stdout
    subprocess.run(["git", "clone", str(repo), str(checkout)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(checkout), "checkout", base], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(checkout), "apply", "--binary", "-"], input=patch, check=True)
    assert (checkout / "tracked.txt").read_text() == "working tree\n"
    assert (checkout / "untracked.txt").read_text() == "also shipped\n"


def test_boot_launch_wires_ipv6_status_server_and_driver_health() -> None:
    boot = BOOT_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    assert "cloudbench-status-server.py" in boot
    assert "cloudbench-driver.pid" in boot
    assert "cloudbench-driver.state" in boot
    assert 'python3 -m http.server "$STATUS_PORT"' not in boot
    assert '--file-local "/cloudbench-status-server.py=' in cloud
    assert '--file-local "/cloudbench-seed-budget.sh=$ROOT_DIR/scripts/lib/cloudbench-seed-budget.sh"' in cloud
    assert '--env "CLOUDBENCH_SEED_BUDGET_LIB=/cloudbench-seed-budget.sh"' in cloud


def test_legacy_launch_wrapper_publishes_complete_driver_lifecycle() -> None:
    """The legacy SSH path shares /driver-health with boot-launch. A reused
    machine must clear a stale terminal state before serving health, then move
    through running and exited atomically around the staged driver."""
    cloud = CLOUD_SCRIPT.read_text()
    wrapper = cloud.split('WRAPPER_LOCAL="$(mktemp)"', 1)[1].split(
        '} > "$WRAPPER_LOCAL"', 1
    )[0]
    status_launch = cloud.split("# Start a tiny status HTTP server", 1)[1].split(
        "launch_attempts=", 1
    )[0]

    assert "cloudbench-driver.state.tmp" in status_launch
    assert "printf 'booting" in status_launch
    assert status_launch.index("printf 'booting") < status_launch.index(
        "cloudbench-status-server.py"
    )
    assert "publish_driver_state" in wrapper
    assert "cloudbench-driver.pid.tmp" in wrapper
    assert wrapper.index("cloudbench-driver.pid.tmp") < wrapper.index(
        "publish_driver_state running"
    )
    assert "exec bash /data/cloudbench-run.sh" not in wrapper
    assert wrapper.index("bash /data/cloudbench-run.sh") < wrapper.index(
        "publish_driver_state exited"
    )


def test_boot_launch_stages_and_exports_complete_local_patch() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    assert '--file-local "/cloudbench-local.patch=$LOCAL_PATCH_FILE"' in cloud
    assert '--env "LOCAL_PATCH_FILE=/cloudbench-local.patch"' in cloud
    assert cloud.index('LOCAL_PATCH_FILE=""') < cloud.index(
        'if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]'
    )


def test_cloud_patch_detection_and_payload_include_staged_only_changes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "bench@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Bench"], check=True)
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n")
    subprocess.run(["git", "-C", str(repo), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "baseline"], check=True, capture_output=True)
    tracked.write_text("staged-only\n")
    subprocess.run(["git", "-C", str(repo), "add", "tracked.txt"], check=True)
    assert subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; cloudbench_worktree_has_changes "$2"',
            "staged-check",
            str(ENV_HELPER_SCRIPT),
            str(repo),
        ],
        check=False,
    ).returncode == 0
    patch = subprocess.run(
        ["bash", str(WORKTREE_PATCH_SCRIPT), str(repo)],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    assert "+staged-only" in patch
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    assert 'cloudbench_worktree_has_changes "$ROOT_DIR"' in cloud
    assert fleet.count('cloudbench_worktree_has_changes "$ROOT_DIR"') >= 2


def test_patch_delivery_clears_stale_base64_configuration() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    boot_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    legacy_start = cloud.index("# ── 1. Start the warm machine", boot_start)
    boot = cloud[boot_start:legacy_start]
    legacy = cloud[legacy_start:]

    assert "LOCAL_PATCH_B64" not in driver
    assert '--env "LOCAL_PATCH_B64="' in boot
    assert 'echo "unset LOCAL_PATCH_B64"' in legacy


def test_shared_patch_digest_is_pinned_and_verified(tmp_path: Path) -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    block_start = cloud.index("STAGED_LOCAL_FILES=()")
    block_end = cloud.index("# ── Launch the driver", block_start)
    patch_block = cloud[block_start:block_end]
    payload = tmp_path / "shared.patch"
    payload.write_text("original\n")
    marker = tmp_path / "accepted"
    script = f"""
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
ROOT_DIR={shlex.quote(str(ROOT))}
CLOUDBENCH_LOCAL_PATCH_SOURCE={shlex.quote(str(payload))}
CLOUDBENCH_LOCAL_PATCH_SHA256=definitely-not-the-payload-digest
{patch_block}
touch {shlex.quote(str(marker))}
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "checksum mismatch" in result.stderr
    assert not marker.exists()

    # At any fleet width, all children inherit the one fleet-pinned expected
    # digest; no child promotes its independently observed hash to authority.
    assert fleet.count('CLOUDBENCH_LOCAL_PATCH_SHA256="$FLEET_PATCH_SHA256"') == 1
    assert 'LOCAL_PATCH_SHA256="$CLOUDBENCH_LOCAL_PATCH_SHA256"' in patch_block
    assert 'if [ -n "$LOCAL_PATCH_FILE" ] && [ -z "$LOCAL_PATCH_SHA256" ]; then' in patch_block


def test_declared_patch_payload_cannot_be_missing_or_empty(tmp_path: Path) -> None:
    driver = DRIVER_SCRIPT.read_text()
    worker = WORKER_SCRIPT.read_text()
    driver_start = driver.index('if [ -n "${LOCAL_PATCH_FILE:-}" ]; then')
    driver_end = driver.index("\nfi\n\n# Replace the bootstrap", driver_start) + len("\nfi\n")
    worker_start = worker.index('if [ -n "${LOCAL_PATCH_FILE:-}" ]; then')
    worker_end = worker.index("\nfi\n\n# Every autoscaled", worker_start) + len("\nfi\n")

    for guest, block in (
        ("primary", driver[driver_start:driver_end]),
        ("worker", worker[worker_start:worker_end]),
    ):
        for payload_kind in ("missing", "empty"):
            payload = tmp_path / f"{guest}-{payload_kind}.patch"
            if payload_kind == "empty":
                payload.touch()
            reached = tmp_path / f"{guest}-{payload_kind}.reached"
            script = f"""
LOCAL_PATCH_FILE={shlex.quote(str(payload))}
LOCAL_PATCH_SHA256=unused
log() {{ printf '%s\\n' "$*" >&2; }}
finish() {{ exit "$1"; }}
{block}
touch {shlex.quote(str(reached))}
"""
            result = subprocess.run(
                ["bash", "-c", script],
                text=True,
                capture_output=True,
                check=False,
            )
            assert result.returncode != 0, (guest, payload_kind, result.stdout, result.stderr)
            assert not reached.exists()
            assert "missing or empty" in result.stderr


def test_worktree_patch_ignores_append_only_history_ledgers(tmp_path: Path) -> None:
    """A dirty append-only telemetry ledger must not poison cloud patch apply.

    RCA (2026-07-22): a /descend run committed local timing rows, then shipped
    the complete unpushed workspace delta to persistent cloud guests. Guests can
    carry their own independent append-only history rows, so treating these
    union-merge ledgers like ordinary context-sensitive source files made
    `git apply` reject the entire runtime patch before benchmarks started.
    """
    base = tmp_path / "base"
    source = tmp_path / "source"
    guest = tmp_path / "guest"
    patch = tmp_path / "workspace.patch"

    base.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=base, check=True)
    subprocess.run(["git", "config", "user.email", "bench@example.com"], cwd=base, check=True)
    subprocess.run(["git", "config", "user.name", "Bench"], cwd=base, check=True)
    history = base / "agents/benchmarks/history/descend_steps.jsonl"
    history.parent.mkdir(parents=True)
    history.write_text('{"record_type":"factory_event_schema","schema_version":1,"workflow":"descend"}\n')
    app = base / "scripts/runtime-surface.sh"
    app.parent.mkdir()
    app.write_text("old runtime\n")
    subprocess.run(["git", "add", "."], cwd=base, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=base, check=True)

    subprocess.run(["git", "clone", "-q", str(base), str(source)], check=True)
    subprocess.run(["git", "clone", "-q", str(base), str(guest)], check=True)

    (source / "scripts/runtime-surface.sh").write_text("new runtime\n")
    with (source / "agents/benchmarks/history/descend_steps.jsonl").open("a") as handle:
        handle.write('{"record_type":"factory_event","run_id":"local-descend"}\n')

    with (guest / "agents/benchmarks/history/descend_steps.jsonl").open("a") as handle:
        handle.write('{"record_type":"factory_event","run_id":"guest-prior-run"}\n')

    with patch.open("w") as handle:
        subprocess.run(
            ["bash", str(WORKTREE_PATCH_SCRIPT), str(source), "HEAD"],
            text=True,
            stdout=handle,
            check=True,
        )

    applied = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", str(patch)],
        cwd=guest,
        text=True,
        capture_output=True,
        check=False,
    )

    assert applied.returncode == 0, applied.stderr
    assert (guest / "scripts/runtime-surface.sh").read_text() == "new runtime\n"
    assert "local-descend" not in (guest / "agents/benchmarks/history/descend_steps.jsonl").read_text()
    assert "guest-prior-run" in (guest / "agents/benchmarks/history/descend_steps.jsonl").read_text()

    only_history = tmp_path / "only-history"
    subprocess.run(["git", "clone", "-q", str(base), str(only_history)], check=True)
    with (only_history / "agents/benchmarks/history/descend_steps.jsonl").open("a") as handle:
        handle.write('{"record_type":"factory_event","run_id":"local-descend"}\n')
    assert subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; cloudbench_worktree_has_changes "$2"',
            "history-only-check",
            str(ENV_HELPER_SCRIPT),
            str(only_history),
        ],
        check=False,
    ).returncode == 1


def test_empty_local_patch_cleanup_is_nounset_safe() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    cleanup = _extract_fleet_function(cloud, "cleanup_staged_local_files() {")
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"set -u\nSTAGED_LOCAL_FILES=()\n{cleanup}\ncleanup_staged_local_files",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_cloud_patch_can_be_disabled_for_a_pinned_committed_ref() -> None:
    """A controller validating a committed ref must be able to ignore unrelated
    concurrent workspace edits without stashing, reverting, or shipping them."""
    cloud = CLOUD_SCRIPT.read_text()
    patch_block = cloud.split('LOCAL_PATCH_FILE=""', 1)[1].split("# Proxy the box BACKEND", 1)[0]
    assert "CLOUDBENCH_SKIP_LOCAL_PATCH:-0" in patch_block
    assert '!= "1"' in patch_block
    assert 'scripts/create-worktree-patch.sh" "$ROOT_DIR"' in patch_block
    fleet = FLEET_SCRIPT.read_text()
    fleet_patch_block = fleet.split('FLEET_PATCH_FILE=""', 1)[1].split("_machine_priv_ip()", 1)[0]
    assert "CLOUDBENCH_SKIP_LOCAL_PATCH:-0" in fleet_patch_block
    assert '!= "1"' in fleet_patch_block
    provenance = _extract_fleet_function(fleet, "print_code_provenance() {")
    assert "CLOUDBENCH_SKIP_LOCAL_PATCH:-0" in provenance
    assert "local changes intentionally excluded" in provenance


def test_boot_launch_delivers_the_exact_worktree_patch_to_every_guest() -> None:
    """The no-SSH launch path must not silently run the base checkout."""
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    worker = WORKER_SCRIPT.read_text()

    boot_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    patch_start = cloud.index('LOCAL_PATCH_FILE=""')
    legacy_start = cloud.index("# ── 1. Start the warm machine", boot_start)
    boot = cloud[boot_start:legacy_start]

    assert patch_start < boot_start, "boot-launch decides delivery before creating the patch"
    assert 'LOCAL_PATCH_FILE=/cloudbench-local.patch' in boot
    assert 'LOCAL_PATCH_SHA256=$LOCAL_PATCH_SHA256' in boot
    assert '--file-local "/cloudbench-local.patch=$LOCAL_PATCH_FILE"' in boot
    assert 'CLOUDBENCH_LOCAL_PATCH_SOURCE="$FLEET_PATCH_FILE"' in fleet

    for guest in (driver, worker):
        assert 'LOCAL_PATCH_SHA256' in guest
        assert 'sha256sum "$LOCAL_PATCH_FILE"' in guest
        assert "patch payload checksum mismatch" in guest

    worker_stage = fleet[fleet.index("provision_worker() {") : fleet.index("bench_autoscaler() {")]
    assert 'LOCAL_PATCH_SHA256=$FLEET_PATCH_SHA256' in worker_stage
    assert 'sftp put' in worker_stage
    patch_upload = worker_stage.split('if [ -n "$FLEET_PATCH_FILE" ]', 1)[1].split(
        'if run_worker_stage_cmd "launch worker wrapper"', 1
    )[0]
    assert '|| true' not in patch_upload
    assert "continue" in patch_upload


def test_boot_launch_runs_the_current_driver_before_applying_the_patch() -> None:
    """Updating the executing repo script can shift bytes under Bash itself."""
    cloud = CLOUD_SCRIPT.read_text()
    boot = (ROOT / "scripts" / "cloudbench-boot.sh").read_text()

    boot_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    legacy_start = cloud.index("# ── 1. Start the warm machine", boot_start)
    launch = cloud[boot_start:legacy_start]
    assert '--env CLOUDBENCH_RUN_SCRIPT=/cloudbench-run.sh' in launch
    assert '--file-local "/cloudbench-run.sh=$ROOT_DIR/scripts/cloudbench-run.sh"' in launch
    assert 'DRIVER="${CLOUDBENCH_RUN_SCRIPT:-/cloudbench-run.sh}"' in boot
    assert 'bash "$DRIVER" >> "$LOG" 2>&1' in boot


def test_autoscaled_worker_failure_publishes_durable_failure_marker(tmp_path: Path) -> None:
    """Upload failure or a guest that never publishes post-patch readiness
    must publish a durable failure before it can be counted as ready capacity."""
    fleet = FLEET_SCRIPT.read_text()
    pool_count = _extract_fleet_function(fleet, "_pool_ids() {")
    cleanup = _worker_cleanup_bundle(fleet)
    provision = _extract_fleet_function(fleet, "provision_worker() {")
    root = tmp_path / "root"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts/cloudbench-worker.sh").write_text("#!/usr/bin/env bash\n")
    patch_file = tmp_path / "workspace.patch"
    patch_file.write_text("patch\n")

    for mode in ("storage-not-ready", "upload-failure", "readiness-failure"):
        out = tmp_path / mode
        reaped = tmp_path / f"{mode}.reaped"
        calls = tmp_path / f"{mode}.calls"
        script = f"""set -euo pipefail
ROOT_DIR={shlex.quote(str(root))}
APP=test-app
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
BOX_BACKEND_PORT=3001
BOX_WMH_PORT=3007
FLEET_WORKER_VM_SIZE=shared-cpu-1x
FLEET_WORKER_VM_MEMORY=1024
WORKER_STAGE_ATTEMPTS=3
WORKER_READY_TIMEOUT=1
FLEET_WORKER_HEALTH_PORT=3103
FLEET_PATCH_FILE={shlex.quote(str(patch_file))}
FLEET_PATCH_SHA256=expected
FLEET_OWNER_TOKEN=test-owner
WORKER_STAGE_ATTEMPTS=3
WORKER_READY_TIMEOUT=1
CLOUDBENCH_WORKER_STAGE_ATTEMPTS=3
CLOUDBENCH_WORKER_STAGE_RETRY_SECONDS=0
MODE={shlex.quote(mode)}
OUT={shlex.quote(str(out))}
REAPED={shlex.quote(str(reaped))}
CALLS={shlex.quote(str(calls))}
: > "$CALLS"
reserve_worker_machine_slot() {{ return 0; }}
capacity_release_reservation() {{ return 0; }}
controller_github_token_b64() {{ printf '%s' token-b64; }}
clone_machine_target() {{
  mkdir -p "$(dirname "$1")"
  printf '%s\n' abc123 >> "$1"
  printf '%s' abc123
}}
machine_storage_ready() {{ [ "$MODE" != storage-not-ready ]; }}
machine_storage_failed() {{ return 1; }}
fly_with_timeout() {{
  shift
  printf '%s\n' "$*" >> "$CALLS"
  case "$*" in
    *"ssh sftp put"*"cloudbench-local.patch"*)
      [ "$MODE" != upload-failure ] ;;
    *) return 0 ;;
  esac
}}
worker_operational() {{ [ "$MODE" != readiness-failure ]; }}
reap_machine() {{ printf '%s\n' "$1" > "$REAPED"; }}
fleet_registry_release_id() {{ :; }}
sleep() {{ :; }}
{pool_count}
{cleanup}
{provision}
provision_worker bench workspace primary fd00::1 0 "$OUT"
wait || true
test -s "$OUT/worker-abc123.stage.log"
test "$(_pool_ids "$OUT")" = 0
test -s "$REAPED"
test ! -e "$OUT/worker-abc123.pending"
test ! -e "$OUT/worker-abc123.ready"
"""
        result = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        assert result.returncode == 0, (mode, result.stdout, result.stderr)
        fly_calls = calls.read_text().splitlines()
        stage_log = (out / "worker-abc123.stage.log").read_text()
        if mode == "storage-not-ready":
            assert fly_calls == []
            assert "storage not ready" in stage_log
            continue
        neutralize = next(i for i, call in enumerate(fly_calls) if "machine update abc123" in call)
        first_start = next(i for i, call in enumerate(fly_calls) if "machine start abc123" in call)
        clear_stage = next(
            i for i, call in enumerate(fly_calls) if "rm -f /data/cloudbench-worker.sh" in call
        )
        first_upload = next(
            i
            for i, call in enumerate(fly_calls)
            if "ssh sftp put" in call and "cloudbench-worker.sh" in call
        )
        assert neutralize < first_start
        assert first_start < clear_stage < first_upload
        assert "--env CLOUDBENCH_BOOT=0 --command sleep infinity" in fly_calls[neutralize]
        assert "--skip-start" in fly_calls[neutralize]
        assert "neutralize cloned boot command" in stage_log
        assert "start neutralized worker" in stage_log
        assert "clear stale worker stage files" in stage_log
        launch_calls = [call for call in fly_calls if "setsid bash /tmp/rbw.sh" in call]
        assert len(launch_calls) <= 1
        if mode == "readiness-failure":
            assert len(launch_calls) == 1
            assert "/tmp/rbw.sh" in launch_calls[0]
            assert "did not reach queue readiness" in stage_log
        else:
            assert launch_calls == []
            assert "upload local patch failed" in stage_log

        assert 'ready_deadline=$((SECONDS + worker_ready_timeout))' in provision
        assert 'if worker_operational "$wid"; then' in provision

    worker = WORKER_SCRIPT.read_text()
    assert worker.index("patch payload checksum mismatch") < worker.index(
        'printf \'%s\\n\' "$$" > "$WORKER_READY_FILE"'
    )


def test_worker_preflight_failure_records_cleanup_failure_and_keeps_retry_handle(tmp_path: Path) -> None:
    """A token/config failure must not hide an unreaped worker.

    The original provisioning error stays visible, while the worker id remains
    tracked so controller teardown can retry deletion.
    """
    fleet = FLEET_SCRIPT.read_text()
    cleanup = _worker_cleanup_bundle(fleet)
    provision = _extract_fleet_function(fleet, "provision_worker() {")
    output = tmp_path / "bench"
    output.mkdir()
    reaped = tmp_path / "reaped"
    script = f"""set +e
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
FLEET_WORKER_VM_SIZE=shared-cpu-1x
FLEET_WORKER_VM_MEMORY=1024
reserve_worker_machine_slot() {{ return 0; }}
capacity_release_reservation() {{ return 0; }}
clone_machine_target() {{
  printf '%s\\n' deadbeef000001 >> "$1"
  printf '%s' deadbeef000001
}}
controller_github_token_b64() {{ return 1; }}
reap_machine() {{ printf '%s\\n' "$1" > {shlex.quote(str(reaped))}; return 1; }}
fleet_registry_release_id() {{ return 0; }}
{cleanup}
{provision}
provision_worker task workspace primary-id fdaa::1 0 {shlex.quote(str(output))}
exit $?
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )

    assert result.returncode != 0
    assert reaped.read_text().strip() == "deadbeef000001"
    assert (output / "worker-clones.ids").read_text().splitlines() == ["deadbeef000001"]
    failure = (output / "autoscaler.failed").read_text()
    assert "No current controller GitHub token" in failure
    assert "cleanup failed and remains tracked for controller teardown" in failure
    assert "cleanup failed and remains tracked" in result.stderr


def test_worker_cleanup_serializes_ledger_and_preserves_cancellation(tmp_path: Path) -> None:
    """Two cleanup owners must reap once and keep a late cancellation durable."""
    cleanup = _worker_cleanup_bundle(FLEET_SCRIPT.read_text())
    output = tmp_path / "bench"
    output.mkdir()
    worker_id = "deadbeef000002"
    (output / "worker-clones.ids").write_text(f"{worker_id}\n")
    (output / "worker-ready.ids").write_text(f"{worker_id}\n")
    (output / f"worker-{worker_id}.pending").touch()
    (output / f"worker-{worker_id}.ready").touch()
    (output / f"worker-{worker_id}.cancelled").touch()
    reaps = tmp_path / "reaps"
    releases = tmp_path / "releases"
    script = f"""set -e
OUT={shlex.quote(str(output))}
WID={worker_id}
REAPS={shlex.quote(str(reaps))}
RELEASES={shlex.quote(str(releases))}
reap_machine() {{ printf '%s\n' "$1" >> "$REAPS"; sleep 0.1; }}
fleet_registry_release_id() {{ printf '%s\n' "$1" >> "$RELEASES"; }}
{cleanup}
cleanup_failed_worker "$OUT" "$WID" &
first=$!
cleanup_failed_worker "$OUT" "$WID" &
second=$!
wait "$first"
wait "$second"
test ! -s "$OUT/worker-clones.ids"
test ! -s "$OUT/worker-ready.ids"
test ! -e "$OUT/worker-$WID.pending"
test ! -e "$OUT/worker-$WID.ready"
test -e "$OUT/worker-$WID.cancelled"
test ! -e "$OUT/worker-clones.ids.lock"
test "$(wc -l < "$REAPS" | tr -d ' ')" = 1
test "$(wc -l < "$RELEASES" | tr -d ' ')" = 1
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )

    assert result.returncode == 0, result.stderr + result.stdout

    unreadable = tmp_path / "unreadable"
    unreadable.mkdir()
    (unreadable / "worker-clones.ids").write_text(f"{worker_id}\n")
    read_error_script = f"""set +e
OUT={shlex.quote(str(unreadable))}
WID={worker_id}
grep() {{ return 2; }}
reap_machine() {{ return 99; }}
fleet_registry_release_id() {{ return 99; }}
{cleanup}
cleanup_failed_worker "$OUT" "$WID"
rc=$?
test "$rc" -ne 0
test "$(cat "$OUT/worker-clones.ids")" = "$WID"
test ! -e "$OUT/worker-clones.ids.lock"
"""
    read_error = subprocess.run(
        ["bash", "-c", read_error_script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert read_error.returncode == 0, read_error.stderr + read_error.stdout


def test_worker_ledger_lock_recovers_dead_owner_and_rejects_foreign_release(
    tmp_path: Path,
) -> None:
    """A killed controller cannot wedge teardown, and only its successor may unlock."""
    locks = _worker_ledger_lock_bundle(FLEET_SCRIPT.read_text())
    output = tmp_path / "bench"
    output.mkdir()
    lock = output / "worker-clones.ids.lock"
    lock.mkdir()
    (lock / "owner").write_text("999999 stale-token 1\n")

    script = f"""set -e
OUT={shlex.quote(str(output))}
WORKER_LEDGER_LOCK_ATTEMPTS=5
WORKER_LEDGER_LOCK_RETRY_SECONDS=0
WORKER_LEDGER_LOCK_STALE_SECONDS=1
{locks}
worker_ledger_lock_acquire "$OUT"
test -s "$OUT/worker-clones.ids.lock/owner"
worker_ledger_lock_release "$OUT"
test ! -e "$OUT/worker-clones.ids.lock"

worker_ledger_lock_acquire "$OUT"
if ( WORKER_LEDGER_LOCK_TOKEN=forged; worker_ledger_lock_release "$OUT" ); then
  echo 'foreign owner released lock' >&2
  exit 2
fi
test -d "$OUT/worker-clones.ids.lock"
worker_ledger_lock_release "$OUT"
test ! -e "$OUT/worker-clones.ids.lock"

WORKER_LEDGER_LOCK_ATTEMPTS=1:2
if worker_ledger_lock_acquire "$OUT"; then exit 3; fi
test ! -e "$OUT/worker-clones.ids.lock"
WORKER_LEDGER_LOCK_ATTEMPTS=5
WORKER_LEDGER_LOCK_STALE_SECONDS=1:2
if worker_ledger_lock_acquire "$OUT"; then exit 4; fi
test ! -e "$OUT/worker-clones.ids.lock"
"""
    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_worker_cleanup_reaps_different_workers_without_holding_global_ledger_lock(
    tmp_path: Path,
) -> None:
    """Slow provider deletes for separate workers must overlap without losing either ledger edit."""
    cleanup = _worker_cleanup_bundle(FLEET_SCRIPT.read_text())
    output = tmp_path / "bench"
    output.mkdir()
    workers = ("deadbeef000010", "deadbeef000011")
    (output / "worker-clones.ids").write_text("\n".join(workers) + "\n")
    (output / "worker-ready.ids").write_text("\n".join(workers) + "\n")
    gate = tmp_path / "gate"
    gate.mkdir()
    reaped = tmp_path / "reaped"

    script = f"""set -e
OUT={shlex.quote(str(output))}
GATE={shlex.quote(str(gate))}
REAPED={shlex.quote(str(reaped))}
WORKER_LEDGER_LOCK_RETRY_SECONDS=0.01
WORKER_CLEANUP_CLAIM_RETRY_SECONDS=0.01
reap_machine() {{
  : > "$GATE/$1"
  deadline=$((SECONDS + 3))
  while [ "$(find "$GATE" -type f | wc -l | tr -d ' ')" -lt 2 ]; do
    [ "$SECONDS" -lt "$deadline" ] || return 90
    sleep 0.02
  done
  printf '%s\n' "$1" >> "$REAPED"
}}
fleet_registry_release_id() {{ return 0; }}
{cleanup}
cleanup_failed_worker "$OUT" {workers[0]} &
first=$!
cleanup_failed_worker "$OUT" {workers[1]} &
second=$!
wait "$first"
wait "$second"
test ! -s "$OUT/worker-clones.ids"
test ! -s "$OUT/worker-ready.ids"
test "$(sort -u "$REAPED" | wc -l | tr -d ' ')" = 2
test ! -e "$OUT/worker-clones.ids.lock"
test ! -e "$OUT/worker-{workers[0]}.cleanup-claim"
test ! -e "$OUT/worker-{workers[1]}.cleanup-claim"
"""
    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_ready_reconciliation_uses_worker_ledger_lock_and_never_duplicates_id(
    tmp_path: Path,
) -> None:
    """Concurrent readiness publishers serialize with cleanup's ownership ledger."""
    fleet = FLEET_SCRIPT.read_text()
    bundle = "\n".join(
        (
            _extract_fleet_function(fleet, "worker_is_tracked() {"),
            _worker_ledger_lock_bundle(fleet),
            _extract_fleet_function(fleet, "reconcile_worker_ready_outcomes() {"),
        )
    )
    output = tmp_path / "bench"
    output.mkdir()
    worker_id = "deadbeef000012"
    (output / "worker-clones.ids").write_text(f"{worker_id}\n")
    (output / "worker-ready.ids").write_text("")
    (output / f"worker-{worker_id}.ready").touch()

    script = f"""set -e
OUT={shlex.quote(str(output))}
WORKER_LEDGER_LOCK_RETRY_SECONDS=0.01
{bundle}
reconcile_worker_ready_outcomes "$OUT" &
first=$!
reconcile_worker_ready_outcomes "$OUT" &
second=$!
wait "$first"
wait "$second"
test "$(grep -Fxc {worker_id} "$OUT/worker-ready.ids")" = 1
test ! -e "$OUT/worker-clones.ids.lock"
"""
    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )
    assert result.returncode == 0, result.stderr + result.stdout

    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    lock = cloner.index('worker_ledger_lock_acquire "$(dirname "$ledger")"')
    append = cloner.index("printf '%s\\n' \"$target_id\" >> \"$ledger\"", lock)
    unlock = cloner.index('worker_ledger_lock_release "$(dirname "$ledger")"', append)
    assert lock < append < unlock


def test_worker_numeric_settings_are_validated_independently(tmp_path: Path) -> None:
    """Colon-bearing values must never reach numeric tests or seq."""
    fleet = FLEET_SCRIPT.read_text()
    cleanup = _worker_cleanup_bundle(fleet)
    provision = _extract_fleet_function(fleet, "provision_worker() {")

    for index, (stage_attempts, ready_timeout) in enumerate((("1:2", "3"), ("2", "3:4"))):
        output = tmp_path / f"invalid-{index}"
        output.mkdir()
        reaped = tmp_path / f"invalid-{index}.reaped"
        script = f"""set +e
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
FLEET_WORKER_VM_SIZE=shared-cpu-1x
FLEET_WORKER_VM_MEMORY=1024
WORKER_STAGE_ATTEMPTS={shlex.quote(stage_attempts)}
WORKER_READY_TIMEOUT={shlex.quote(ready_timeout)}
reserve_worker_machine_slot() {{ return 0; }}
capacity_release_reservation() {{ return 0; }}
clone_machine_target() {{ printf '%s\n' deadbeef000003 >> "$1"; printf '%s' deadbeef000003; }}
controller_github_token_b64() {{ printf token; }}
reap_machine() {{ printf '%s\n' "$1" > {shlex.quote(str(reaped))}; }}
fleet_registry_release_id() {{ return 0; }}
{cleanup}
{provision}
provision_worker task workspace primary-id fdaa::1 0 {shlex.quote(str(output))}
rc=$?
test "$rc" -ne 0
test ! -s {shlex.quote(str(output / "worker-clones.ids"))}
grep -q 'invalid worker stage/readiness timeout configuration' {shlex.quote(str(output / "autoscaler.failed"))}
exit 0
"""
        result = subprocess.run(
            ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
        )
        assert result.returncode == 0, result.stderr + result.stdout
        assert reaped.read_text().strip() == "deadbeef000003"


def test_fetch_ref_never_falls_back_to_stale_fetch_head(tmp_path: Path) -> None:
    fetch_env = dict(os.environ, CLOUDBENCH_GIT_MIN_FREE_KB="1")
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
        env=fetch_env,
    )
    assert success.returncode == 0, success.stderr
    assert (checkout / "value.txt").read_text() == "two"

    before = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    failure = subprocess.run(
        ["bash", str(FETCH_SCRIPT), str(checkout), "0" * 40],
        text=True,
        capture_output=True,
        check=False,
        env=fetch_env,
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
    timeout_function = _extract_fleet_function(cloud, "_with_timeout() {")
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
                    "config": {"mounts": [{"volume": "volume-1", "path": "/data"}]},
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
{timeout_function}
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


def test_machine_readiness_publishes_keyed_inventory_index(tmp_path: Path) -> None:
    machines = tmp_path / "machines.json"
    volumes = tmp_path / "volumes.json"
    real_root = tmp_path / "real-root"
    real_root.mkdir()
    alias_root = tmp_path / "alias-root"
    alias_root.symlink_to(real_root, target_is_directory=True)
    index = alias_root / "inventory"
    machines.write_text(
        json.dumps(
            [
                {
                    "id": "machine-1",
                    "name": "cloudbench-one",
                    "state": "created",
                    "private_ip": "fdaa::1",
                    "config": {"mounts": [{"volume": "volume-1"}]},
                },
                {
                    "id": "machine-2",
                    "name": "cloudbench-two",
                    "state": "stopped",
                    "private_ip": "fdaa::2",
                    "config": {"mounts": []},
                },
            ]
        )
    )
    volumes.write_text(json.dumps([{"id": "volume-1", "state": "failed"}]))

    first = subprocess.run(
        [
            sys.executable,
            str(MACHINE_READINESS_SCRIPT),
            "--publish-index",
            str(machines),
            str(volumes),
            str(index),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr
    first_generation = (index / "current").resolve()
    assert f"generation={first_generation.name}" in (index / "current/health").read_text()
    assert (index / "current/machines/machine-1").read_text().splitlines() == [
        "state=created",
        "private_ip=fdaa::1",
        "storage_ready=0",
        "storage_failed=1",
    ]
    assert (index / "current/machines/machine-2").read_text().splitlines() == [
        "state=stopped",
        "private_ip=fdaa::2",
        "storage_ready=1",
        "storage_failed=0",
    ]
    assert (index / "current/names/cloudbench-one").read_text().strip() == "machine-1"

    volumes.write_text(json.dumps([{"id": "volume-1", "state": "created"}]))
    second = subprocess.run(first.args, text=True, capture_output=True, check=False)
    assert second.returncode == 0, second.stderr
    assert (index / "current").resolve() != first_generation
    assert (index / "current").exists()
    assert (index / "current/machines/machine-1").read_text().splitlines()[-1] == (
        "storage_failed=0"
    )
    assert "storage_ready=1" in (
        index / "current/machines/machine-1"
    ).read_text().splitlines()
    current_before_replay = (index / "current").resolve()
    partial = index / ".generation-dead-publisher"
    (partial / "machines").mkdir(parents=True)
    (partial / "machines/partial").write_text("state=created\n")
    # A killed publisher may have written this early marker without ever
    # swapping current. Future mtime makes the old mtime-based predecessor GC
    # choose the orphan deterministically and discard the real old current.
    (partial / "published_at").write_text(f"{int(time.time())}\n")
    future = time.time() + 3600
    os.utime(partial, (future, future))
    replay = subprocess.run(first.args, text=True, capture_output=True, check=False)
    assert replay.returncode == 0, replay.stderr
    assert not partial.exists()
    assert current_before_replay.exists()
    for _ in range(2):
        replay = subprocess.run(first.args, text=True, capture_output=True, check=False)
        assert replay.returncode == 0, replay.stderr
    assert len(list(index.glob(".generation-*"))) <= 2


def test_machine_inventory_publication_cleans_temp_link_on_replace_failure(
    tmp_path: Path,
) -> None:
    machines = tmp_path / "machines.json"
    volumes = tmp_path / "volumes.json"
    index = tmp_path / "inventory"
    machines.write_text(
        json.dumps(
            [
                {
                    "id": "machine-1",
                    "name": "cloudbench-one",
                    "state": "created",
                    "private_ip": "fdaa::1",
                    "config": {"mounts": []},
                }
            ]
        )
    )
    volumes.write_text(json.dumps([]))

    spec = importlib.util.spec_from_file_location(
        "cloudbench_machine_readiness_publication_failure",
        MACHINE_READINESS_SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    readiness_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(readiness_module)

    original_replace = readiness_module.os.replace

    def fail_replace(src: object, dst: object) -> None:
        raise OSError(f"forced replace failure: {src} -> {dst}")

    readiness_module.os.replace = fail_replace
    try:
        try:
            readiness_module.publish_index(machines, volumes, index)
            raise AssertionError("publish_index should fail when os.replace fails")
        except OSError:
            pass
    finally:
        readiness_module.os.replace = original_replace

    assert not list(index.glob(".current-*"))
    assert not list(index.glob(".generation-*"))


def test_machine_inventory_publication_keeps_committed_generation_on_prune_failure(
    tmp_path: Path,
) -> None:
    machines = tmp_path / "machines.json"
    volumes = tmp_path / "volumes.json"
    index = tmp_path / "inventory"
    machines.write_text(
        json.dumps(
            [
                {
                    "id": "machine-1",
                    "name": "cloudbench-one",
                    "state": "created",
                    "private_ip": "fdaa::1",
                    "config": {"mounts": []},
                }
            ]
        )
    )
    volumes.write_text(json.dumps([]))

    spec = importlib.util.spec_from_file_location(
        "cloudbench_machine_readiness_prune_failure",
        MACHINE_READINESS_SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    readiness_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(readiness_module)

    original_replace = readiness_module.os.replace
    original_glob = readiness_module.Path.glob
    swap_committed = False

    def tracked_replace(src: object, dst: object) -> None:
        nonlocal swap_committed
        original_replace(src, dst)
        swap_committed = True

    def fail_prune_glob(path: Path, pattern: str):
        if swap_committed and pattern == ".generation-*":
            raise OSError("forced prune failure after committed current swap")
        return original_glob(path, pattern)

    readiness_module.os.replace = tracked_replace
    readiness_module.Path.glob = fail_prune_glob
    try:
        try:
            readiness_module.publish_index(machines, volumes, index)
            raise AssertionError("publish_index should fail when post-swap pruning fails")
        except OSError as exc:
            assert "forced prune failure" in str(exc)
    finally:
        readiness_module.os.replace = original_replace
        readiness_module.Path.glob = original_glob

    assert not list(index.glob(".current-*"))
    assert (index / "current").is_symlink()
    current_generation = (index / "current").resolve()
    assert current_generation.exists()
    assert f"generation={current_generation.name}" in (index / "current/health").read_text()


def test_machine_inventory_index_publication_is_linear(tmp_path: Path) -> None:
    """Publishing N keyed records must not rescan all N machines/volumes for
    each record. Instrument list iteration so this proves algorithmic work
    directly instead of relying on a timing threshold that varies in CI."""

    spec = importlib.util.spec_from_file_location(
        "cloudbench_machine_readiness_complexity", MACHINE_READINESS_SCRIPT
    )
    assert spec is not None and spec.loader is not None
    readiness_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(readiness_module)

    class CountingList(list):
        def __init__(self, values: list[dict[str, object]]) -> None:
            super().__init__(values)
            self.yields = 0

        def __iter__(self):  # type: ignore[no-untyped-def]
            for item in super().__iter__():
                self.yields += 1
                yield item

    width = 64
    machines = CountingList(
        [
            {
                "id": f"machine-{index}",
                "name": f"cloudbench-{index}",
                "state": "created",
                "private_ip": f"fdaa::{index}",
                "config": {"mounts": [{"volume": f"volume-{index}"}]},
            }
            for index in range(width)
        ]
    )
    volumes = CountingList(
        [{"id": f"volume-{index}", "state": "created"} for index in range(width)]
    )

    def fake_load(_path: Path, label: str):  # type: ignore[no-untyped-def]
        return machines if label == "machine" else volumes

    readiness_module._load_inventory_file = fake_load
    readiness_module.publish_index(
        tmp_path / "unused-machines.json",
        tmp_path / "unused-volumes.json",
        tmp_path / "inventory",
    )

    assert machines.yields <= width * 2, machines.yields
    assert volumes.yields <= width * 2, volumes.yields
    published_at = (tmp_path / "inventory/current/published_at").read_text().strip()
    assert published_at.isdigit()


def test_storage_readiness_inventory_reads_are_bounded(tmp_path: Path) -> None:
    """One wedged read-only Fly inventory call must yield to the retry loop."""
    cloud = CLOUD_SCRIPT.read_text()
    readiness = _extract_fleet_function(cloud, "machine_storage_ready() {")
    timeout_fn = _extract_fleet_function(cloud, "_with_timeout() {")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_fly = fake_bin / "flyctl"
    fake_fly.write_text(
        """#!/usr/bin/env bash
set -u
if [ "$1 $2" = "machines list" ]; then
  printf '%s\n' '[{"id":"machine-1","state":"created","config":{"mounts":[]}}]'
  exit 0
fi
if [ "$1 $2" = "volumes list" ]; then
  exec sleep 30
fi
exit 2
"""
    )
    fake_fly.chmod(0o755)
    env = {
        "PATH": f"{fake_bin}:{Path('/usr/bin')}:{Path('/bin')}",
        "MACHINE_READINESS_SCRIPT": str(MACHINE_READINESS_SCRIPT),
        "CLOUDBENCH_STORAGE_QUERY_TIMEOUT": "0.2",
    }

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLY() {{ flyctl "$@"; }}
{timeout_fn}
{readiness}
machine_storage_ready machine-1
""",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=2,
    )

    assert result.returncode == 1, result.stderr


def test_fresh_clone_start_paths_honor_storage_readiness_contract() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    startup = cloud.split("# ── 1. Start the warm machine", 1)[1].split("# ── 2.", 1)[0]

    assert 'MACHINE_READINESS_SCRIPT="$ROOT_DIR/scripts/cloudbench-machine-readiness.py"' in cloud
    assert startup.count('if machine_storage_ready "$mid"') == 2
    assert startup.count('request_machine_start "$mid"') == 2
    assert startup.index('if machine_storage_ready "$mid"') < startup.index('request_machine_start "$mid"')
    assert 'MACHINE_READINESS_SCRIPT="$ROOT_DIR/scripts/cloudbench-machine-readiness.py"' in fleet
    assert 'CLOUDBENCH_STORAGE_READY="$([ "$src" = "pool" ] && printf 1 || printf 0)"' in fleet
    storage = _extract_fleet_function(cloud, "machine_storage_ready() {")
    assert "CLOUDBENCH_STORAGE_READY:-0" in storage
    pool_slot = _extract_fleet_function(fleet, "provision_pool_slot() {")
    assert 'if machine_storage_ready "$id"; then' in pool_slot
    assert pool_slot.index('if machine_storage_ready "$id"; then') < pool_slot.index('FLY machine start "$id"')


def test_boot_update_always_submits_a_bounded_post_config_start() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    branch = cloud[cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then') :]
    update_retry = _extract_fleet_function(
        cloud, "boot_update_with_capacity_recovery() {"
    )
    assert "CLOUDBENCH_BOOT_UPDATE_TIMEOUT" in update_retry
    assert '_with_timeout "$timeout_seconds" "$@"' in update_retry
    assert 'boot_update_with_capacity_recovery "$_update_log"' in branch
    assert "final Fly update error" in branch
    post_config_start = branch[branch.index("# The update above is explicitly `--skip-start`"):]
    post_config_start = post_config_start[: post_config_start.index("\nelse\n# ── 1.")]
    assert "machine_state" not in post_config_start
    assert "machine_storage_ready" not in post_config_start
    assert "request_machine_start" not in post_config_start
    assert 'CLOUDBENCH_BOOT_START_ATTEMPTS' in post_config_start
    assert 'CLOUDBENCH_BOOT_START_TIMEOUT' in post_config_start
    assert 'flyctl machine start "$mid"' in post_config_start
    assert 'mv "$POST_CONFIG_START_MARKER.tmp.$$" "$POST_CONFIG_START_MARKER"' in post_config_start
    assert "post-config start accepted" in post_config_start
    claim_start = fleet.index("claim_pool_machine() {")
    claim_end = fleet.index("\n}\n", claim_start)
    claim = fleet[claim_start:claim_end]
    assert "machine_storage_ready" not in claim
    assert "FLY machine status" not in claim
    assert "FLY machine start" not in claim
    assert 'write_pool_claim "$claim_path"' in claim
    worker_provision = _extract_fleet_function(fleet, "provision_worker() {")
    storage_ready = worker_provision.index('if ! machine_storage_ready "$wid"; then')
    assert 'machine_storage_failed "$wid"' in worker_provision[storage_ready:]
    neutralize = worker_provision.index('machine update "$wid"', storage_ready)
    first_start = worker_provision.index('machine start "$wid"', neutralize)
    assert storage_ready < neutralize < first_start
    assert "--env CLOUDBENCH_BOOT=0" in worker_provision[neutralize:first_start]
    assert "--skip-start" in worker_provision[neutralize:first_start]


def test_boot_launch_delivers_the_advertised_local_workspace_patch() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    branch_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    setup = cloud[:branch_start]
    branch = cloud[branch_start:]

    assert 'LOCAL_PATCH_FILE="$(mktemp)"' in setup
    assert '--env "LOCAL_PATCH_FILE=/cloudbench-local.patch"' in branch
    assert '--file-local "/cloudbench-local.patch=$LOCAL_PATCH_FILE"' in branch
    assert '--env "LOCAL_PATCH_FILE="' in branch


def test_boot_launch_executes_the_current_injected_driver() -> None:
    """Driver edits must take effect before that driver applies the workspace patch."""
    cloud = CLOUD_SCRIPT.read_text()
    boot = (CLOUD_SCRIPT.parent / "cloudbench-boot.sh").read_text()
    branch_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    branch = cloud[branch_start:]

    assert '--file-local "/cloudbench-run.sh=$ROOT_DIR/scripts/cloudbench-run.sh"' in branch
    assert 'DRIVER="${CLOUDBENCH_RUN_SCRIPT:-/cloudbench-run.sh}"' in boot
    assert 'bash "$DRIVER" >> "$LOG" 2>&1' in boot
    assert 'bash "$REPO/scripts/cloudbench-run.sh" >> "$LOG" 2>&1' not in boot


def test_snapshot_and_pool_dependency_proofs_are_exact() -> None:
    fleet = FLEET_SCRIPT.read_text()

    assert '[ "$_rest" = "$SNAP_ID" ]' in fleet
    assert 'RECORDED_SNAP_ID="$(awk' in fleet
    assert 'SNAP_ID="$RECORDED_SNAP_ID"' in fleet
    assert "using recorded proven snapshot" in fleet
    assert "an interrupted refresh" in fleet
    assert 'POOL_META_FILE="$POOL_IDS_FILE.deps"' in fleet
    assert 'printf \'%s %s %s\\n\' "$CURRENT_NODE_FP" "$CURRENT_PY_FP" "$SNAP_ID"' in fleet
    assert "pooled machines were built from unproven/stale dependency trees" in fleet


def test_autoscaler_metrics_poll_over_data_plane_without_ssh() -> None:
    fleet = FLEET_SCRIPT.read_text()
    desired = _extract_fleet_function(fleet, "_box_desired() {")
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")
    provision_worker = _extract_fleet_function(fleet, "provision_worker() {")

    assert "FLY ssh" not in desired
    assert "curl --noproxy '*'" in desired
    assert "flyctl proxy" in autoscaler
    assert 'pip="$(_machine_priv_ip "$cid")"' in autoscaler
    assert 'while [ ! -f "$out/post-config-start.accepted" ]' in autoscaler
    assert 'flyctl proxy "$metrics_port:$BOX_HEALTH_PORT" "$pip"' in autoscaler
    assert autoscaler.index('post-config-start.accepted') < autoscaler.index(
        'flyctl proxy "$metrics_port:$BOX_HEALTH_PORT" "$pip"'
    )
    assert '"${cid}.vm.${APP}.internal"' not in autoscaler
    assert "claim_autoscaler_metrics_port" in autoscaler
    assert "seq 10 18" not in autoscaler
    assert '"http://127.0.0.1:$metrics_port/metrics"' in autoscaler
    assert "start_metrics_proxy 30" in autoscaler
    assert "autoscaler metrics via data plane" in autoscaler
    assert "jobs -pr" in autoscaler
    assert "cloudbench_terminate_and_wait" in autoscaler
    assert "fly_with_timeout" in provision_worker


def test_autoscaler_metrics_port_avoids_persistent_archive_listener(
    tmp_path: Path,
) -> None:
    """Persistent archived run viewers may occupy the old dash+10..18 pool.

    Metrics tunnels must use a host-wide atomic lease around an actually
    bindable port instead of retrying the same deterministic occupied range.
    """
    fleet = FLEET_SCRIPT.read_text()
    claim = _extract_fleet_function(
        fleet, "claim_autoscaler_metrics_port() {"
    )
    release = _extract_fleet_function(
        fleet, "release_autoscaler_metrics_port() {"
    )

    occupied_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    for occupied_port in range(43000, 44000):
        try:
            occupied_socket.bind(("127.0.0.1", occupied_port))
            occupied_socket.listen(1)
            break
        except OSError:
            continue
    else:
        occupied_socket.close()
        raise AssertionError("could not reserve a test archive-listener port")

    lease_root = tmp_path / "leases"
    script = f"""set -eu
AUTOSCALER_PORT_LEASE_ROOT="$1"
CLOUDBENCH_AUTOSCALER_PORT_START="$2"
AUTOSCALER_PORT_LEASE_HELPER="$3"
{claim}
{release}
owner_pid="$$"
claim_autoscaler_metrics_port claimed "$owner_pid" test-token
printf '%s\n' "$claimed"
release_autoscaler_metrics_port "$claimed" "$owner_pid" test-token
"""
    try:
        result = subprocess.run(
            [
                "bash", "-c", script, "port-test", str(lease_root),
                str(occupied_port), str(PORT_LEASE_SCRIPT),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    finally:
        occupied_socket.close()

    assert result.returncode == 0, result.stderr
    assert int(result.stdout.strip()) != occupied_port
    assert not any(path.name.isdigit() for path in lease_root.iterdir())


def test_host_port_allocator_continues_past_first_hundred_listeners(
    tmp_path: Path,
) -> None:
    """Durable archive viewers can fill a preferred 100-port dashboard window."""
    listeners: list[socket.socket] = []
    preferred = 0
    for candidate in range(42000, 56000, 200):
        attempt: list[socket.socket] = []
        try:
            for port in range(candidate, candidate + 100):
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.bind(("127.0.0.1", port))
                listener.listen(1)
                attempt.append(listener)
        except OSError:
            for listener in attempt:
                listener.close()
            continue
        listeners = attempt
        preferred = candidate
        break
    assert preferred, "could not reserve a contiguous 100-port repro window"

    root = tmp_path / "leases"
    command = [
        sys.executable,
        str(PORT_LEASE_SCRIPT),
        "claim",
        "--root",
        str(root),
        "--owner-pid",
        str(os.getpid()),
        "--token",
        "past-hundred",
        "--start",
        str(preferred),
    ]
    try:
        result = subprocess.run(
            command, text=True, capture_output=True, check=False, timeout=10
        )
    finally:
        for listener in listeners:
            listener.close()

    assert result.returncode == 0, result.stderr
    claimed_port = int(result.stdout.strip())
    assert claimed_port == preferred + 100
    subprocess.run(
        [
            sys.executable,
            str(PORT_LEASE_SCRIPT),
            "release",
            "--root",
            str(root),
            "--owner-pid",
            str(os.getpid()),
            "--token",
            "past-hundred",
            "--port",
            str(claimed_port),
        ],
        check=True,
    )


def test_autoscaler_port_allocator_serializes_and_recovers_interruption(
    tmp_path: Path,
) -> None:
    """Claims serialize across callers and never expose partial ownership.

    This also models PID reuse with a mismatched process-start identity and
    SIGKILL between durable temp creation and atomic lease publication.
    """
    root = tmp_path / "leases"
    owner_pid = os.getpid()

    def command(action: str, token: str, *extra: str) -> list[str]:
        return [
            sys.executable,
            str(PORT_LEASE_SCRIPT),
            action,
            "--root",
            str(root),
            "--owner-pid",
            str(owner_pid),
            "--token",
            token,
            *extra,
        ]

    first = subprocess.Popen(
        command("claim", "parallel-a", "--start", "44000"),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    second = subprocess.Popen(
        command("claim", "parallel-b", "--start", "44000"),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    first_out, first_err = first.communicate(timeout=5)
    second_out, second_err = second.communicate(timeout=5)
    assert first.returncode == 0, first_err
    assert second.returncode == 0, second_err
    first_port = int(first_out.strip())
    second_port = int(second_out.strip())
    assert first_port != second_port
    for port in (first_port, second_port):
        record = json.loads((root / str(port)).read_text())
        assert record["pid"] == owner_pid
        assert record["process_start"]

    for token, port in (("parallel-a", first_port), ("parallel-b", second_port)):
        released = subprocess.run(
            command("release", token, "--port", str(port)),
            text=True,
            capture_output=True,
            check=False,
        )
        assert released.returncode == 0, released.stderr

    stale = subprocess.run(
        command("claim", "stale-identity", "--start", str(first_port)),
        text=True,
        capture_output=True,
        check=False,
    )
    assert stale.returncode == 0, stale.stderr
    stale_port = int(stale.stdout.strip())
    stale_path = root / str(stale_port)
    stale_record = json.loads(stale_path.read_text())
    stale_record["process_start"] = "same-pid-different-process-start"
    stale_path.write_text(json.dumps(stale_record) + "\n")
    replacement_a = subprocess.Popen(
        command("claim", "replacement-a", "--start", str(stale_port)),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    replacement_b = subprocess.Popen(
        command("claim", "replacement-b", "--start", str(stale_port)),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    replacement_a_out, replacement_a_err = replacement_a.communicate(timeout=5)
    replacement_b_out, replacement_b_err = replacement_b.communicate(timeout=5)
    assert replacement_a.returncode == 0, replacement_a_err
    assert replacement_b.returncode == 0, replacement_b_err
    replacement_ports = {
        int(replacement_a_out.strip()),
        int(replacement_b_out.strip()),
    }
    assert len(replacement_ports) == 2
    assert stale_port in replacement_ports
    for token, port in zip(
        ("replacement-a", "replacement-b"),
        (int(replacement_a_out.strip()), int(replacement_b_out.strip())),
    ):
        subprocess.run(
            command("release", token, "--port", str(port)), check=True
        )

    paused_env = {
        **os.environ,
        "CLOUDBENCH_PORT_LEASE_TEST_PAUSE_BEFORE_PUBLISH": "10",
    }
    interrupted = subprocess.Popen(
        command("claim", "interrupted", "--start", "45000"),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=paused_env,
    )
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not list(root.glob(".claim-*.tmp")):
        time.sleep(0.02)
    assert list(root.glob(".claim-*.tmp")), "allocator never reached pre-publish pause"
    interrupted.kill()
    interrupted.communicate(timeout=5)

    recovered = subprocess.run(
        command("claim", "recovered", "--start", "45000"),
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert recovered.returncode == 0, recovered.stderr
    recovered_port = int(recovered.stdout.strip())
    assert not list(root.glob(".claim-*.tmp"))
    released_owner = subprocess.run(
        command("release-owner", "recovered"),
        text=True,
        capture_output=True,
        check=False,
    )
    assert released_owner.returncode == 0, released_owner.stderr
    assert not (root / str(recovered_port)).exists()

    run_ports: list[int] = []
    for token in ("run-token-a", "run-token-b", "other-token"):
        claimed = subprocess.run(
            command("claim", token, "--start", "46000"),
            text=True,
            capture_output=True,
            check=False,
        )
        assert claimed.returncode == 0, claimed.stderr
        run_ports.append(int(claimed.stdout.strip()))
    released_prefix = subprocess.run(
        command("release-prefix", "run-token"),
        text=True,
        capture_output=True,
        check=False,
    )
    assert released_prefix.returncode == 0, released_prefix.stderr
    assert not (root / str(run_ports[0])).exists()
    assert not (root / str(run_ports[1])).exists()
    assert (root / str(run_ports[2])).exists()
    subprocess.run(
        command("release", "other-token", "--port", str(run_ports[2])),
        check=True,
    )


def test_autoscaler_retries_metrics_transport_until_first_capacity_observation() -> None:
    """A Fly data-plane proxy can die while the primary is still restoring its
    stack and before /metrics exists. Pre-readiness transport loss must retry
    under the stack/child lifecycle; once desired capacity has been observed,
    the identical loss remains a bounded mandatory-autoscaler failure."""
    autoscaler = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "bench_autoscaler() {"
    )
    recovery = autoscaler.split(
        'if ! fleet_job_running "$metrics_proxy_pid"; then', 1
    )[1].split('local desired want cur', 1)[0]

    assert 'until start_metrics_proxy 30; do' in autoscaler
    assert 'if [ -e "$out/autoscaler.ready" ]; then' in recovery
    assert "metrics proxy unavailable before first desired count; retrying" in recovery
    pre_ready = recovery.split("else", 1)[1]
    assert "continue" in pre_ready
    assert "metrics proxy died and did not recover" in recovery


def test_autoscaler_worker_clone_failure_sets_the_fatal_marker(tmp_path: Path) -> None:
    """A desired scale-up that cannot allocate its worker is mandatory infra.

    The benchmark may finish before the autoscaler's next poll, so returning a
    nonzero helper status is insufficient: the durable failure marker is the
    controller's authoritative final gate.
    """
    provision_worker = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "provision_worker() {"
    )
    output = tmp_path / "bench"
    output.mkdir()
    script = f"""set +e
reserve_worker_machine_slot() {{ return 0; }}
clone_machine_target() {{ return 1; }}
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
FLEET_WORKER_VM_SIZE=shared-cpu-2x
FLEET_WORKER_VM_MEMORY=4096
{provision_worker}
provision_worker task workspace primary-id fdaa::1 0 {shlex.quote(str(output))}
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False
    )

    assert result.returncode != 0
    failure = output / "autoscaler.failed"
    assert failure.is_file(), result.stderr
    assert "could not allocate worker clone" in failure.read_text()


def test_worker_health_turns_ready_only_after_temporal_worker_runs() -> None:
    worker = (ROOT / "agents" / "worker.py").read_text()
    health = (ROOT / "agents" / "health_server.py").read_text()

    worker_task = worker.index("worker_task = asyncio.create_task(worker.run())")
    healthy = worker.index("set_worker_status(True)")
    legacy_ready_log = worker.index("Worker started, waiting for tasks...")
    ready_log = worker.index("Worker ready, polling Temporal task queue")

    assert worker_task < healthy < legacy_ready_log < ready_log
    assert '"healthy": False' in health

    transition = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import health_server as h; c=h.app.test_client(); "
                "assert c.get('/health').status_code == 503; "
                "h.set_worker_status(True); "
                "assert c.get('/health').status_code == 200; "
                "h.set_worker_status(False); "
                "assert c.get('/health').status_code == 503"
            ),
        ],
        cwd=ROOT / "agents",
        text=True,
        capture_output=True,
        check=False,
    )
    assert transition.returncode == 0, transition.stderr


def test_autoscaled_worker_uses_authenticated_fetch_ref_helper(tmp_path: Path) -> None:
    """Worker clones start from a warm snapshot, not the patched primary volume.

    They must use the same authenticated exact-ref helper as primaries before
    joining the benchmark queue; raw git fetch can fail on private refs and
    leave the controller waiting for a health endpoint that will never appear.
    """
    worker = WORKER_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    token_helper = _extract_fleet_function(fleet, "controller_github_token_b64() {")
    provision = _extract_fleet_function(fleet, "provision_worker() {")

    assert 'FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-/data/cloudbench-fetch-ref.sh}"' in worker
    assert 'CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF"' in worker
    assert 'git -C "$REPO_DIR" fetch origin "$REF"' not in worker
    assert worker.index('unset CLOUDBENCH_GITHUB_TOKEN_B64') < worker.index(
        "bash ./scripts/run_local_worker.sh"
    )
    assert "rm -f /tmp/rbw.env" in worker

    assert 'controller_github_token_b64' in provision
    assert 'export CLOUDBENCH_GITHUB_TOKEN_B64=' not in provision
    assert 'export CLOUDBENCH_FETCH_REF_SCRIPT=/data/cloudbench-fetch-ref.sh' in provision
    assert 'scripts/cloudbench-fetch-ref.sh" /data/cloudbench-fetch-ref.sh' in provision
    assert '-m 0600 "$worker_env" /tmp/rbw.env' in provision
    assert 'rm -f /tmp/rbw.env' in provision

    output = tmp_path / "bench"
    output.mkdir()
    calls = tmp_path / "calls.log"
    captured_wrapper = tmp_path / "rbw.sh"
    captured_env = tmp_path / "rbw.env"
    captured_env_mode = tmp_path / "rbw.env.mode"
    encoded_token = base64.b64encode(b"secret-token").decode()
    script = f"""set +e
ROOT_DIR={shlex.quote(str(ROOT))}
APP=bench-app
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
FLEET_WORKER_VM_SIZE=performance-1x
FLEET_WORKER_VM_MEMORY=2048
WORKER_STAGE_ATTEMPTS=1
WORKER_READY_TIMEOUT=5
FLEET_WORKER_HEALTH_PORT=3103
BOX_BACKEND_PORT=3001
BOX_WMH_PORT=3007
FLEET_PATCH_FILE=""
CONTROLLER_GITHUB_TOKEN_B64_CACHE={shlex.quote(encoded_token)}
CALLS={shlex.quote(str(calls))}
CAPTURED_WRAPPER={shlex.quote(str(captured_wrapper))}
CAPTURED_ENV={shlex.quote(str(captured_env))}
CAPTURED_ENV_MODE={shlex.quote(str(captured_env_mode))}
reserve_worker_machine_slot() {{ return 0; }}
capacity_release_reservation() {{ return 0; }}
clone_machine_target() {{ printf 'feedface000001'; }}
machine_storage_ready() {{ return 0; }}
worker_operational() {{ return 0; }}
fly_with_timeout() {{
  _timeout="$1"; shift
  printf '%s\\n' "$*" >> "$CALLS"
  if [ "$1 $2 $3" = "ssh sftp put" ]; then
    argc=$#
    eval "src=\\${{$((argc - 1))}}"
    eval "dest=\\${{$argc}}"
    mode=""
    prev=""
    for arg in "$@"; do
      [ "$prev" = "-m" ] && mode="$arg"
      prev="$arg"
    done
    if [ "$dest" = "/tmp/rbw.sh" ]; then cp "$src" "$CAPTURED_WRAPPER"; fi
    if [ "$dest" = "/tmp/rbw.env" ]; then
      cp "$src" "$CAPTURED_ENV"
      printf '%s\\n' "$mode" > "$CAPTURED_ENV_MODE"
    fi
  fi
  return 0
}}
sleep() {{ :; }}
{token_helper}
{provision}
provision_worker task workspace primary-id fdaa::1 0 {shlex.quote(str(output))}
deadline=$((SECONDS + 5))
while [ ! -e {shlex.quote(str(output / "worker-feedface000001.ready"))} ] && [ "$SECONDS" -lt "$deadline" ]; do
  sleep 0.05
done
[ -e {shlex.quote(str(output / "worker-feedface000001.ready"))} ] || exit 90
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert captured_env_mode.read_text().strip() == "0600"
    wrapper_text = captured_wrapper.read_text()
    env_text = captured_env.read_text()
    assert "secret-token" not in wrapper_text
    assert encoded_token not in wrapper_text
    assert f"CLOUDBENCH_GITHUB_TOKEN_B64={encoded_token}" in env_text
    assert ". /tmp/rbw.env" in wrapper_text
    assert "rm -f /tmp/rbw.env" in wrapper_text
    assert "/data/cloudbench-fetch-ref.sh" in calls.read_text()


def test_autoscaler_persists_desired_capacity_before_reporting_ready() -> None:
    fleet = FLEET_SCRIPT.read_text()
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")

    desired_write = autoscaler.index('mv "$out/desired-worker-count.tmp"')
    startup_ready = autoscaler.index(': > "$out/autoscaler.ready"')
    clone = autoscaler.index('provision_worker "$bench"')

    assert desired_write < startup_ready < clone
    assert 'ready_workers" -lt "$desired_workers"' in fleet


def test_autoscaler_stops_cleanly_when_its_benchmark_child_finishes(
    tmp_path: Path,
) -> None:
    """A remote driver tears down /metrics immediately after its benchmark.
    That expected lifecycle must stop the autoscaler before its unreadable-
    metrics threshold can rewrite a completed benchmark as infrastructure."""
    fleet = FLEET_SCRIPT.read_text()
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")
    supervisor = _extract_fleet_function(
        fleet, "run_fleet_child_supervised() {"
    )
    launch = fleet.split("# ── Phase 2: launch each provisioned bench", 1)[1].split(
        "CHILD_PIDS+=(", 1
    )[0]
    final_acceptance = fleet.split("AUTOSCALER_FAILURE=0", 1)[1].split(
        "# Normal completion has already reaped every child", 1
    )[0]

    assert 'run_fleet_child_supervised "$out/benchmark-child.finished"' in launch
    assert 'marker_tmp="$finished_marker.tmp.$$"' in supervisor
    assert 'mv "$marker_tmp" "$finished_marker"' in supervisor
    assert "benchmark-child.finished" in autoscaler
    assert autoscaler.index("benchmark-child.finished") < autoscaler.index(
        'desired="$(_box_desired "$metrics_url")"'
    )
    unreadable = autoscaler.split('if [ -z "$desired" ]; then', 1)[1].split(
        'scrape_failures=0', 1
    )[0]
    assert unreadable.index("benchmark-child.finished") < unreadable.index(
        "metrics returned no valid desired_machine_count"
    )
    assert "autoscaler.completed-after-child.tmp" in autoscaler
    assert 'mv "$completed_tmp" "$out/autoscaler.completed-after-child"' in autoscaler
    assert "primary disappeared from provider inventory before child completion" in autoscaler
    assert "mandatory_autoscaler_process_acceptable" in final_acceptance

    # Inverse regression: an autoscaler that dies first must not be forgiven
    # merely because the child later publishes its independent finish marker.
    acceptance = _extract_fleet_function(
        fleet, "mandatory_autoscaler_process_acceptable() {"
    )
    (tmp_path / "benchmark-child.finished").write_text("0\n")
    dead_before_child = subprocess.run(
        [
            "bash",
            "-c",
            (
                f"{acceptance}\n"
                "fleet_job_running() { return 1; }\n"
                'mandatory_autoscaler_process_acceptable "$1" 999'
            ),
            "acceptance",
            str(tmp_path),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert dead_before_child.returncode != 0
    (tmp_path / "autoscaler.completed-after-child").write_text("0\n")
    causal_completion = subprocess.run(
        dead_before_child.args,
        text=True,
        capture_output=True,
        check=False,
    )
    assert causal_completion.returncode == 0, causal_completion.stderr


def test_fleet_child_supervisor_forwards_termination_and_awaits_cleanup(
    tmp_path: Path,
) -> None:
    """Fleet cleanup must not orphan run-bench-cloud under PID 1.

    The tracked background PID is a Bash function/subshell, not the runner it
    starts.  A controller TERM therefore has to be forwarded explicitly and
    the runner must be reaped before the durable child-finished marker appears.
    """
    supervisor = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "run_fleet_child_supervised() {"
    )
    terminator = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "terminate_fleet_runner_group() {"
    )
    assert "os.setsid()" in supervisor
    launch = supervisor.index("python3 -c")
    assigned = supervisor.index("runner_pid=$!")
    replay = supervisor.index('if [ -n "$forwarded_signal_name" ]; then')
    assert launch < assigned < replay
    assert "terminate_fleet_runner_group" in supervisor[replay:]
    marker = tmp_path / "benchmark-child.finished"
    ready = tmp_path / "child.ready"
    cleaned = tmp_path / "child.cleaned"
    child_pid = tmp_path / "child.pid"
    child = (
        f"trap 'printf cleaned > {shlex.quote(str(cleaned))}; exit 143' TERM; "
        f"printf '%s\\n' \"$$\" > {shlex.quote(str(child_pid))}; "
        f": > {shlex.quote(str(ready))}; "
        "while :; do sleep 1; done"
    )
    script = f"""set +e
{terminator}
{supervisor}
run_fleet_child_supervised {shlex.quote(str(marker))} bash -c {shlex.quote(child)} &
supervisor_pid=$!
deadline=$((SECONDS + 5))
while [ ! -e {shlex.quote(str(ready))} ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
[ -e {shlex.quote(str(ready))} ] || exit 90
kill -TERM "$supervisor_pid" || exit 91
wait "$supervisor_pid"
supervisor_rc=$?
[ "$supervisor_rc" -eq 143 ] || exit 92
[ -e {shlex.quote(str(cleaned))} ] || exit 93
[ -e {shlex.quote(str(marker))} ] || exit 94
[ "$(cat {shlex.quote(str(marker))})" = 143 ] || exit 95
runner_pid="$(cat {shlex.quote(str(child_pid))})"
! kill -0 "$runner_pid" 2>/dev/null || exit 96
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


def test_fleet_child_supervisor_bounds_escalation_and_reaps_process_group(
    tmp_path: Path,
) -> None:
    """A wedged runner cleanup must not survive the fleet's supervisor.

    The supervisor gets less time than the controller's own CHILD_PIDS ceiling
    and escalates against the runner's whole process group, including descendants.
    """
    terminator = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "terminate_fleet_runner_group() {"
    )
    supervisor = _extract_fleet_function(
        FLEET_SCRIPT.read_text(), "run_fleet_child_supervised() {"
    )
    marker = tmp_path / "benchmark-child.finished"
    ready = tmp_path / "child.ready"
    child_pid = tmp_path / "child.pid"
    grandchild_pid = tmp_path / "grandchild.pid"
    child = (
        "trap '' HUP INT TERM; "
        "bash -c \"trap '' HUP INT TERM; while :; do sleep 1; done\" & grandchild=$!; "
        f"printf '%s\\n' \"$$\" > {shlex.quote(str(child_pid))}; "
        f"printf '%s\\n' \"$grandchild\" > {shlex.quote(str(grandchild_pid))}; "
        f": > {shlex.quote(str(ready))}; "
        "while :; do sleep 1; done"
    )
    script = f"""set +e
{terminator}
{supervisor}
CLOUDBENCH_RUNNER_TERM_SECONDS=1 run_fleet_child_supervised {shlex.quote(str(marker))} bash -c {shlex.quote(child)} &
supervisor_pid=$!
deadline=$((SECONDS + 5))
while [ ! -e {shlex.quote(str(ready))} ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
[ -e {shlex.quote(str(ready))} ] || exit 90
runner_pid="$(cat {shlex.quote(str(child_pid))})"
runner_pgid="$(ps -o pgid= -p "$runner_pid" | tr -d ' ')"
[ "$runner_pgid" = "$runner_pid" ] || exit 91
kill -TERM "$supervisor_pid" || exit 92
wait "$supervisor_pid"
supervisor_rc=$?
[ "$supervisor_rc" -eq 143 ] || exit 93
[ "$(cat {shlex.quote(str(marker))})" = 143 ] || exit 94
grandchild="$(cat {shlex.quote(str(grandchild_pid))})"
deadline=$((SECONDS + 5))
while {{ kill -0 "$runner_pid" 2>/dev/null || kill -0 "$grandchild" 2>/dev/null; }} \
      && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.05; done
! kill -0 "$runner_pid" 2>/dev/null || exit 95
! kill -0 "$grandchild" 2>/dev/null || exit 96
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


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
    assert "export CLOUDBENCH_RUN_TOKEN=" in cloud
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
    embedded_status, embedded_status_calls = activate([(1, "machine abc503def returned nontransient validation error")])
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
    lost_owner, lost_owner_updates = activate(["stopped"] * 4, update_status=1, guard_updates=1)

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
    assert setup.index('activate_owned_machine_images "$IMAGE_REF"') < setup.index('start_machine "$mid"')


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

    assert setup.count("git -c safe.directory='$REMOTE_REPO' -C '$REMOTE_REPO'") >= 2
    assert "git config --global --add safe.directory" not in setup
    assert r"\"\$GITHUB_TOKEN\"" in setup
    assert "CLONE_CMD_B64=" in setup
    assert "base64 -d | bash" in setup
    assert '-C "bash -lc \\"printf' in setup
    assert 'if ! clone_output="$(FLY ssh console' in setup
    assert "GH_TOKEN=%q" not in setup


def test_environment_mutation_is_maintenance_only_and_run_path_read_only() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    lock_lib = APP_ENV_LOCK_SCRIPT.read_text()

    # Maintenance ops (--setup / --refresh-wmh / --refresh-secrets) remain the
    # ONLY paths that mutate the shared app environment, and they still
    # serialize behind the cross-worktree app-environment lock.
    assert 'APP_ENV_LOCK_FILE="$GIT_COMMON_DIR/cloudbench-app-env.lock"' in cloud
    assert 'source "${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts/lib}/cloudbench-app-env-lock.sh"' in cloud
    assert 'shlock -p "$$" -f "$APP_ENV_LOCK_FILE"' in lock_lib
    wrapper_start = cloud.index("inject_secrets() {")
    wrapper_end = cloud.index("\n}\n", wrapper_start)
    wrapper = cloud[wrapper_start:wrapper_end]
    assert wrapper.index("acquire_app_environment_lock") < wrapper.index("( _inject_secrets_locked )")
    assert wrapper.index("( _inject_secrets_locked )") < wrapper.index("release_app_environment_lock")
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
    assert cleanup.index("trap '' HUP INT TERM") < cleanup.index("terminate_and_wait")
    assert ('cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" "${AUTOSCALER_PIDS[@]:-}"') in cleanup
    assert ('cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" "${CHILD_PIDS[@]:-}"') in cleanup
    assert "CLOUDBENCH_CHILD_TERM_SECONDS:-30" in fleet
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
    clone_function = _worker_ledger_lock_bundle(fleet) + "\n" + fleet[function_start:function_end]
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
machine_storage_ready() {{ return 0; }}
machine_storage_failed() {{ return 1; }}
{_clone_index_adapter_fixture()}
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
    recovered_after_create, recovered_target_ledger = allocate(
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
    assert recovered_after_create.returncode == 0, recovered_after_create.stderr
    assert recovered_after_create.stdout == target_id
    assert recovered_target_ledger.read_text().splitlines() == [target_id]
    assert recovered_target_ledger.with_suffix(".names").read_text() == ""
    assert "--detach" in clone_function
    assert "--name" in clone_function
    # Exactly one clone-from-source call site, and it is bounded by the
    # hung-clone watchdog (fly_with_timeout) rather than an unbounded FLY call.
    assert fleet.count('machine clone "$source_id"') == 1
    assert "fly_with_timeout" in clone_function
    assert "\\b[0-9a-f]{14}\\b" not in fleet


def test_clone_retries_provider_accepted_failed_snapshot_volume(
    tmp_path: Path,
) -> None:
    """Fly can return a successful Machine clone while its asynchronously
    restored snapshot volume has already entered terminal ``failed``.  Such a
    target must be reaped and retried during provisioning; publishing it to the
    boot barrier turns one bad volume into an all-benchmark timeout."""

    fleet = FLEET_SCRIPT.read_text()
    watchdog = _extract_fleet_function(fleet, "fly_with_timeout() {")
    cloner = _clone_machine_bundle(fleet)
    ledger = tmp_path / "owned.ids"
    clone_count = tmp_path / "clone-count"
    reaped = tmp_path / "reaped.ids"
    clone_count.write_text("0\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
WARM_ID=6834251fe05798
SNAP_ID=snapshot-1
REGION=ord
FLY() {{
  if [ "$1 $2" = "machine clone" ]; then
    n="$(cat "$CLONE_COUNT")"
    n=$((n + 1))
    printf '%s\n' "$n" > "$CLONE_COUNT"
    if [ "$n" = 1 ]; then id=deadbeef000001; else id=feedface000002; fi
    printf 'Machine %s has been created...\n' "$id"
    return 0
  fi
  return 2
}}
fleet_registry_record_name() {{ return 0; }}
fleet_registry_record_id() {{ return 0; }}
fleet_registry_release_id() {{ return 0; }}
machine_storage_ready() {{ [ "$1" = feedface000002 ]; }}
machine_storage_failed() {{ [ "$1" = deadbeef000001 ]; }}
reap_machine() {{ printf '%s\n' "$1" >> "$REAPED"; }}
{watchdog}
{cloner}
clone_machine_target "$LEDGER"
""",
        ],
        env={
            "CLONE_COUNT": str(clone_count),
            "REAPED": str(reaped),
            "LEDGER": str(ledger),
            "CLOUDBENCH_CLONE_MAX_ATTEMPTS": "2",
            "CLOUDBENCH_CLONE_RETRY_SECONDS": "0",
            "CLOUDBENCH_CLONE_RETRY_MAX_SECONDS": "0",
            "CLOUDBENCH_CLONE_STORAGE_READY_SECONDS": "1",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == "feedface000002"
    assert clone_count.read_text().strip() == "2"
    assert reaped.read_text().splitlines() == ["deadbeef000001"]
    assert ledger.read_text().splitlines() == ["feedface000002"]


def test_clone_releases_only_definitive_preallocation_failures() -> None:
    """A rate-limited/CPU-rejected clone creates no Machine. After the bounded
    name lookup confirms absence, its attempt record must be released so a
    later successful retry does not leave a phantom stale registry. Ambiguous
    launch errors retain ownership fail-closed."""
    fleet = FLEET_SCRIPT.read_text()
    classifier = _extract_fleet_function(fleet, "clone_failure_definitively_unallocated() {")
    cloner = _clone_machine_bundle(fleet)
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
    assert "pool-provision-$i.ids" in slot
    assert 'pool_ledger_record_id "$id"' in slot
    assert "snapshot_machine_state" in slot
    assert "FLY machine status" not in slot
    assert "pool_machine_state" not in slot
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    assert '"${PROVISION_PIDS[@]:-}"' in cleanup

    pool_branch = fleet[fleet.index('if [ -n "$PROVISION_POOL" ]; then'):]
    assert pool_branch.index("start_machines_snapshot_loop") < pool_branch.index(
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
{_clone_index_adapter_fixture()}
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


def _fleet_primary_shape_helpers(source: str) -> str:
    return "".join(
        _extract_fleet_function(source, signature)
        for signature in (
            "bench_needs_bundled_frontend_primary() {",
            "primary_vm_size_for_bench() {",
            "primary_vm_memory_for_bench() {",
            "shared_cpu_units_for_vm_size() {",
        )
    )


def _worker_ledger_lock_bundle(source: str) -> str:
    return "\n".join(
        _extract_fleet_function(source, signature)
        for signature in (
            "worker_ledger_lock_acquire() {",
            "worker_ledger_lock_release() {",
        )
    )


def _clone_machine_bundle(source: str) -> str:
    return "\n".join(
        (
            _worker_ledger_lock_bundle(source),
            _extract_fleet_function(source, "clone_machine_target() {"),
        )
    )


def _worker_cleanup_bundle(source: str) -> str:
    return "\n".join(
        _extract_fleet_function(source, signature)
        for signature in (
            "worker_is_tracked() {",
            "worker_ledger_lock_acquire() {",
            "worker_ledger_lock_release() {",
            "cleanup_failed_worker() {",
        )
    )


def _clone_index_adapter_fixture() -> str:
    """Model the controller's keyed inventory boundary in isolated clone tests.

    The publisher/index contract is exercised separately. Clone retry tests use
    an in-memory FLY stub, so this adapter converts that stub's provider-shaped
    response into the one-name lookup exposed by the production keyed index.
    """
    return r'''
machines_snapshot_identity() { printf 'test-generation'; }
refresh_machines_snapshot_after() { return 0; }
inventory_machine_id_for_name() {
  FLY machines list -a "$APP" --json | python3 -c '
import json, sys
name = sys.argv[1]
machines = json.load(sys.stdin)
if not isinstance(machines, list) or any(not isinstance(machine, dict) for machine in machines):
    raise SystemExit(2)
matches = [machine.get("id") for machine in machines
           if machine.get("name") == name and machine.get("id")]
if len(matches) == 1:
    print(matches[0])
elif not matches:
    raise SystemExit(1)
else:
    raise SystemExit(2)
' "$1"
}
'''


def test_runner_ownership_probe_executes_through_remote_shell() -> None:
    """RCA (2026-07-17): flyctl v0.4.70 executes ``ssh -C`` arguments
    directly. A probe beginning with an environment assignment was interpreted
    as an executable name, so stale idle pool claims became permanently
    unreadable and every successor fleet failed before provisioning.

    Model flyctl's direct-exec boundary: only an explicit remote shell may
    interpret the assignment, pipeline, command substitution, and printf.
    """
    probe = _extract_fleet_function(FLEET_SCRIPT.read_text(), "registry_runner_count() {")
    script = f"""set -u
APP=test-app
FLY() {{
  local remote=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-C" ]; then shift; remote="${{1:-}}"; break; fi
    shift
  done
  case "$remote" in
    'bash -c '*|'bash -lc '*) printf 'CLOUDBENCH_RUNNER_COUNT=0\\n' ;;
    *) printf 'exec: ownership assignment is not an executable\\n' >&2; return 1 ;;
  esac
}}
{probe}
test "$(registry_runner_count machine-1)" = 0
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=5)
    assert result.returncode == 0, result.stderr


def test_fleet_canonicalizes_short_ref_before_remote_handoff(tmp_path: Path) -> None:
    """RCA (2026-07-17): ``--ref 0ec3f5d65`` resolved in the controller
    checkout but was handed to fresh Fly clones verbatim. Git servers do not
    advertise abbreviated object IDs, so every clone failed ``git fetch``
    before its status server or synchronized-ready marker could start.
    """
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "Test"], check=True)
    (tmp_path / "tracked").write_text("content\n")
    subprocess.run(["git", "-C", str(tmp_path), "add", "tracked"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-qm", "fixture"], check=True)
    full_ref = subprocess.check_output(["git", "-C", str(tmp_path), "rev-parse", "HEAD"], text=True).strip()
    short_ref = full_ref[:9]
    fleet = FLEET_SCRIPT.read_text()
    canonicalize = (
        _extract_fleet_function(fleet, "canonicalize_bench_ref() {") if "canonicalize_bench_ref() {" in fleet else ""
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"{canonicalize}\ncanonicalize_bench_ref {shlex.quote(short_ref)}",
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == full_ref


def test_clone_retries_transient_volume_not_found(tmp_path: Path) -> None:
    """A single Fly clone-from-snapshot volume race must not abort the batch:
    clone_machine_target retries with a fresh name and returns the id once the
    transient failure clears. Guards the 28-wide synchronized-start barrier
    against one flaky clone tearing down every isolated stack."""
    fleet = FLEET_SCRIPT.read_text()
    timeout_fn = _extract_fleet_function(fleet, "fly_with_timeout() {")
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    cloner = _clone_machine_bundle(fleet)
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
machine_storage_ready() {{ return 0; }}
machine_storage_failed() {{ return 1; }}
{_clone_index_adapter_fixture()}
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
    cloner = _clone_machine_bundle(fleet)
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
machine_storage_ready() {{ return 0; }}
machine_storage_failed() {{ return 1; }}
{_clone_index_adapter_fixture()}
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
    cloner = _clone_machine_bundle(fleet)
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
machine_storage_ready() {{ return 0; }}
machine_storage_failed() {{ return 1; }}
{_clone_index_adapter_fixture()}
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


def test_bundled_frontend_primary_provisioning_bypasses_default_pool() -> None:
    """A 4GB stopped pool Machine must not be assigned to a bundled Vite build."""
    fleet = FLEET_SCRIPT.read_text()
    assert (
        'FLEET_BUNDLED_FRONTEND_VM_SIZE="${CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE:-shared-cpu-4x}"'
        in fleet
    )
    assert (
        'FLEET_BUNDLED_FRONTEND_VM_MEMORY="${CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_MEMORY:-8192}"'
        in fleet
    )
    classifier = _extract_fleet_function(fleet, "bench_needs_bundled_frontend_primary() {")
    for task in (
        "agent-payment-test-shop",
        "agent-payment-idempotent-abandonment",
        "agent-payment-abandonment",
        "agent-payment-setup-resume",
        "gate-subscription-card-mint",
        "gate-kyc-card-mint",
    ):
        assert task in classifier

    prov = fleet.index("# ── Phase 1:")
    wait_all = fleet.index('for pp in "${PROVISION_PIDS[@]}"; do wait')
    phase1 = fleet[prov:wait_all]
    assert 'bench_needs_bundled_frontend_primary "$bench"' in phase1
    assert 'pcid="$(claim_pool_machine)"' in phase1
    assert 'clone_machine_target "$out/primary.ids" "$WARM_ID" "$bench_vm_size" "$bench_vm_memory"' in phase1
    assert phase1.index('bench_needs_bundled_frontend_primary "$bench"') < phase1.index(
        'pcid="$(claim_pool_machine)"'
    )


def test_reap_machine_destroys_the_clones_forked_volume(tmp_path: Path) -> None:
    """`flyctl machine destroy` never destroys the clone's forked volume — it
    leaks and bills forever (observed: 42 x 20GB in one day). reap_machine must
    resolve the volume BEFORE the machine disappears and destroy it after,
    while never touching the warm source's volume."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig) for sig in ("machine_volume_id() {", "reap_volume() {", "reap_machine() {")
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
    helpers = "".join(_extract_fleet_function(fleet, sig) for sig in ("reap_volume() {", "sweep_orphaned_volumes() {"))
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
    resource_exhausted throttling at fleet width. Shared-mode readers must never
    fall back to one provider call per consumer when that snapshot ages during
    rate limiting, and hot per-machine reads must use the keyed index instead of
    reparsing an app-wide array in every child."""
    fleet = FLEET_SCRIPT.read_text()

    # The snapshot loop exists, initializes before Phase 1, and is reaped in cleanup.
    assert "machines_snapshot_loop() {" in fleet
    assert "start_machines_snapshot_loop" in fleet
    assert 'kill "$SNAPSHOT_LOOP_PID"' in fleet
    assert fleet.index("start_machines_snapshot_loop") < fleet.index(
        "# ── Phase 1:"
    )
    # Backoff on API failure lives in the one loop; the last good index remains readable.
    loop = _extract_fleet_function(fleet, "machines_snapshot_loop() {")
    assert "backoff" in loop
    assert "refresh_inventory_snapshot" in loop

    # Hot read-only pollers consume O(1) keyed records. No consumer reparses the
    # complete Machines/Volumes arrays, which would become O(N^2) at fleet width.
    for fn_sig in (
        "machine_id_for_clone_name() {",
        "_machine_priv_ip() {",
        "machine_storage_ready() {",
        "snapshot_machine_state() {",
    ):
        body = _extract_fleet_function(fleet, fn_sig)
        assert "FLY machines list" not in body, f"{fn_sig} must use the keyed index"
        assert "fleet_machines_json" not in body, f"{fn_sig} must not parse app-wide JSON"
        assert "inventory_machine" in body
    resolver = _extract_fleet_function(fleet, "machine_id_for_clone_name() {")
    assert "refresh_machines_snapshot_after" in resolver
    refresh = _extract_fleet_function(fleet, "refresh_machines_snapshot_after() {")
    assert "inventory_refresh_lock_acquire" in refresh
    assert "inventory_refresh_lock_release" in refresh
    assert "_refresh_inventory_snapshot_unlocked" in refresh
    # Autoscaler liveness is an O(1) record-existence check, and a missing/stale
    # keyed record now fails closed instead of silently ending the autoscaler.
    assert 'if ! inventory_machine_exists "$cid"; then' in fleet
    assert "primary disappeared from provider inventory before child completion" in fleet

    # mutation-verification paths stay LIVE (a 5s-stale snapshot would make
    # reap retry against ghosts and claims race)
    for fn_sig in ("reap_machine() {", "pool_machine_state() {"):
        body = _extract_fleet_function(fleet, fn_sig)
        assert "FLY machines list" in body, f"{fn_sig} must verify against live state"

    # Shared mode serves the last good snapshot even after it ages. It must never
    # execute the live fallback under the provider failure it is meant to absorb.
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in (
            "inventory_index_healthy() {",
            "_fresh_snapshot_or() {",
            "fleet_machines_json() {",
        )
    )
    snap = tmp_path / "machines.json"
    snap.write_text('[{"id":"from-snapshot"}]\n')
    script = f"""set -uo pipefail
APP=bench-app
SNAPSHOT_POLL=5
MACHINES_SNAPSHOT="$SNAP"
INVENTORY_INDEX="$ROOT/inventory"
INVENTORY_MAX_STALE_SECONDS=120
INVENTORY_CLOCK_EPOCH="$(date +%s)"
INVENTORY_CLOCK_SECONDS="$SECONDS"
SNAPSHOT_LOOP_PID=$$
SNAPSHOT_LOOP_TOKEN=test-token
mkdir -p "$INVENTORY_INDEX/current"
printf 'publisher_token=test-token\nvalid_until=%s\n' "$((INVENTORY_CLOCK_EPOCH + 120))" > "$INVENTORY_INDEX/current/health"
FLY() {{ echo called >> "$CALLS"; echo '[{{"id":"from-live"}}]'; }}
{helpers}
fleet_machines_json
touch -t 202001010000 "$SNAP"
fleet_machines_json
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"SNAP": str(snap), "CALLS": str(tmp_path / "calls"),
             "ROOT": str(tmp_path), "PATH": os.environ["PATH"]},
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    lines = result.stdout.strip().splitlines()
    assert lines[0] == '[{"id":"from-snapshot"}]', lines
    assert lines[1] == '[{"id":"from-snapshot"}]', lines
    assert not (tmp_path / "calls").exists(), "shared readers reached the provider"

    # A failed exceptional refresh releases its ownership lock so the next
    # bounded attempt can recover; no permanent mkdir-lock wedge is allowed.
    identity = _extract_fleet_function(fleet, "machines_snapshot_identity() {")
    registry_value = _extract_fleet_function(fleet, "registry_meta_value() {")
    registry_alive = _extract_fleet_function(fleet, "registry_owner_alive() {")
    lock_acquire = _extract_fleet_function(fleet, "inventory_refresh_lock_acquire() {")
    lock_release = _extract_fleet_function(fleet, "inventory_refresh_lock_release() {")
    lock_script = f"""set -uo pipefail
FLEET_DIR="$ROOT"
INVENTORY_INDEX="$ROOT/inventory"
INVENTORY_REFRESH_LOCK="$FLEET_DIR/machines-refresh.lock"
MACHINES_SNAPSHOT="$ROOT/machines.json"
FLEET_OWNER_HOST=test-host
SNAPSHOT_REFRESH_TIMEOUT=1
CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=3
MACHINE_READINESS_SCRIPT="$READINESS"
mkdir -p "$FLEET_DIR"
printf '[]\n' > "$MACHINES_SNAPSHOT"
{identity}
{registry_value}
{registry_alive}
{lock_acquire}
{lock_release}
_refresh_inventory_snapshot_unlocked() {{ return 1; }}
{refresh}
prior="$(machines_snapshot_identity)"
if refresh_machines_snapshot_after "$prior"; then exit 9; fi
test ! -e "$FLEET_DIR/machines-refresh.lock"
"""
    lock_result = subprocess.run(
        ["bash", "-c", lock_script],
        env={
            "ROOT": str(tmp_path / "lock-root"),
            "READINESS": str(MACHINE_READINESS_SCRIPT),
            "PATH": os.environ["PATH"],
        },
        text=True, capture_output=True, check=False,
    )
    assert lock_result.returncode == 0, lock_result.stderr


def test_inventory_publishers_share_one_recoverable_atomic_lock(tmp_path: Path) -> None:
    """Periodic and post-clone refreshes must serialize behind the same lock.
    The lock is published atomically with complete owner metadata so SIGKILL
    cannot expose a metadata-less directory that outlives the waiter budget."""
    fleet = FLEET_SCRIPT.read_text()
    required = (
        "inventory_refresh_lock_acquire() {",
        "inventory_refresh_lock_release() {",
        "_refresh_inventory_snapshot_unlocked() {",
    )
    for signature in required:
        assert signature in fleet

    periodic = _extract_fleet_function(fleet, "refresh_inventory_snapshot() {")
    exceptional = _extract_fleet_function(fleet, "refresh_machines_snapshot_after() {")
    acquire = _extract_fleet_function(fleet, "inventory_refresh_lock_acquire() {")
    assert periodic.index("inventory_refresh_lock_acquire") < periodic.index(
        "_refresh_inventory_snapshot_unlocked"
    )
    assert exceptional.index("inventory_refresh_lock_acquire") < exceptional.index(
        "_refresh_inventory_snapshot_unlocked"
    )
    assert 'ln "$candidate" "$lock"' in acquire
    assert 'mkdir "$lock"' not in acquire

    helpers = "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "registry_owner_alive() {",
            "inventory_refresh_lock_acquire() {",
            "inventory_refresh_lock_release() {",
        )
    )
    script = f"""set -uo pipefail
FLEET_DIR="$ROOT"
INVENTORY_REFRESH_LOCK="$FLEET_DIR/machines-refresh.lock"
FLEET_OWNER_HOST=test-host
SNAPSHOT_REFRESH_TIMEOUT=1
CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=3
CLOUDBENCH_REFRESH_LOCK_MALFORMED_GRACE_SECONDS=0
MACHINE_READINESS_SCRIPT="$READINESS"
mkdir -p "$FLEET_DIR"
{helpers}
lock="$FLEET_DIR/machines-refresh.lock"
printf 'malformed=1\n' > "$lock"
inventory_refresh_lock_acquire
test "$(registry_meta_value "$lock" pid)" = "$$"
inventory_refresh_lock_release
printf 'host=test-host\npid=99999999\npid_start=dead\n' > "$lock"
inventory_refresh_lock_acquire
test "$(registry_meta_value "$lock" pid)" = "$$"
inventory_refresh_lock_release
test ! -e "$lock"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={
            "ROOT": str(tmp_path / "lock"),
            "READINESS": str(MACHINE_READINESS_SCRIPT),
            "PATH": os.environ["PATH"],
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_exceptional_inventory_refresh_coalesces_waiters(tmp_path: Path) -> None:
    """A clone-name waiter must leave as soon as another publisher advances the
    generation. It must not acquire the released lock and serialize a redundant
    provider refresh, nor spawn sleep/process probes in its contention tick."""
    fleet = FLEET_SCRIPT.read_text()
    assert "inventory_refresh_wait_tick() {" in fleet
    wait_tick = _extract_fleet_function(fleet, "inventory_refresh_wait_tick() {")
    assert "sleep" not in wait_tick
    assert "ps " not in wait_tick
    assert "sed " not in wait_tick
    acquire = _extract_fleet_function(fleet, "inventory_refresh_lock_acquire() {")
    assert "machines_snapshot_identity" in acquire
    refresh = _extract_fleet_function(fleet, "refresh_machines_snapshot_after() {")
    assert '"$prior"' in refresh
    assert '"2"' in refresh

    helpers = "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "machines_snapshot_identity() {",
            "inventory_refresh_wait_tick() {",
            "inventory_refresh_lock_acquire() {",
            "inventory_refresh_lock_release() {",
            "refresh_machines_snapshot_after() {",
        )
    )
    root = tmp_path / "coalesced"
    root.mkdir()
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
FLEET_DIR="$ROOT"
INVENTORY_INDEX="$ROOT/inventory"
INVENTORY_REFRESH_LOCK="$ROOT/machines-refresh.lock"
INVENTORY_WAIT_FIFO="$ROOT/inventory.wait"
FLEET_OWNER_HOST=test-host
SNAPSHOT_REFRESH_TIMEOUT=1
CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=3
mkdir -p "$INVENTORY_INDEX/current"
mkfifo "$INVENTORY_WAIT_FIFO"
printf 'generation=.generation-one\n' > "$INVENTORY_INDEX/current/health"
printf 'host=test-host\npid=%s\npid_start=live\ntoken=owner-token\n' "$$" > "$INVENTORY_REFRESH_LOCK"
{helpers}
_refresh_inventory_snapshot_unlocked() {{ printf 'called\n' >> "$CALLS"; }}
( sleep 0.2; printf 'generation=.generation-two\n' > "$INVENTORY_INDEX/current/health" ) &
refresh_machines_snapshot_after .generation-one
test ! -e "$CALLS"
test -e "$INVENTORY_REFRESH_LOCK"
test -z "$(find "$ROOT" -name '*.candidate.*' -print -quit)"
""",
        ],
        env={
            "ROOT": str(root),
            "CALLS": str(tmp_path / "provider-calls"),
            "PATH": os.environ["PATH"],
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_dead_refresh_owner_cannot_orphan_a_late_publisher(
    tmp_path: Path,
) -> None:
    """A Python publisher outlives a SIGKILLed Bash parent unless it holds a
    child-visible filesystem fence. Recovery must wait for that old inode, not
    unlink it and let a newer publisher race an older late commit."""
    fleet = FLEET_SCRIPT.read_text()
    acquire = _extract_fleet_function(fleet, "inventory_refresh_lock_acquire() {")
    assert "--recover-lock" in acquire
    assert "--lock-held" not in acquire
    publisher = MACHINE_READINESS_SCRIPT.read_text()
    assert "fcntl.flock" in publisher
    assert "CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN" in publisher

    lock_root = tmp_path / "fenced-lock"
    lock_root.mkdir()
    lock = lock_root / "machines-refresh.lock"
    lock.write_text("host=test-host\npid=99999999\npid_start=dead\ntoken=old-token\n")
    ready = tmp_path / "holder-ready"
    holder_code = r'''
import fcntl, os, pathlib, sys, time
path = pathlib.Path(sys.argv[1])
ready = pathlib.Path(sys.argv[2])
with path.open("r+") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    inode = os.fstat(handle.fileno()).st_ino
    ready.write_text("ready")
    time.sleep(1.0)
    print("same" if path.stat().st_ino == inode else "replaced", flush=True)
'''
    holder = subprocess.Popen(
        [sys.executable, "-c", holder_code, str(lock), str(ready)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.time() + 5
    while time.time() < deadline and not ready.exists():
        time.sleep(0.02)
    assert ready.exists(), "fence holder did not initialize"

    helpers = "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "registry_owner_alive() {",
            "inventory_refresh_wait_tick() {",
            "inventory_refresh_lock_acquire() {",
            "inventory_refresh_lock_release() {",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
FLEET_DIR="$ROOT"
INVENTORY_REFRESH_LOCK="$FLEET_DIR/machines-refresh.lock"
INVENTORY_WAIT_FIFO="$FLEET_DIR/inventory.wait"
FLEET_OWNER_HOST=test-host
MACHINE_READINESS_SCRIPT="$READINESS"
SNAPSHOT_REFRESH_TIMEOUT=1
CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS=5
mkfifo "$INVENTORY_WAIT_FIFO"
{helpers}
inventory_refresh_lock_acquire
inventory_refresh_lock_release
""",
        ],
        env={
            "ROOT": str(lock_root),
            "READINESS": str(MACHINE_READINESS_SCRIPT),
            "PATH": os.environ["PATH"],
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    holder_out, holder_err = holder.communicate(timeout=5)
    assert result.returncode == 0, result.stderr
    assert holder.returncode == 0, holder_err
    assert holder_out.strip() == "same", holder_out

    # Exercise the exact probe→unlink race: an orphan has opened the old inode
    # but not locked it yet. Recovery must lock that inode, invalidate its token,
    # and unlink it before releasing; when the orphan later locks its open fd it
    # can no longer satisfy the publication fence.
    lock.write_text("host=test-host\npid=99999999\npid_start=dead\ntoken=old-token\n")
    opened = tmp_path / "orphan-opened"
    proceed = tmp_path / "orphan-proceed"
    late_holder_code = r'''
import fcntl, pathlib, sys, time
path = pathlib.Path(sys.argv[1])
opened = pathlib.Path(sys.argv[2])
proceed = pathlib.Path(sys.argv[3])
with path.open("r+") as handle:
    opened.write_text("opened")
    while not proceed.exists():
        time.sleep(0.01)
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    handle.seek(0)
    token = ""
    for line in handle:
        if line.startswith("token="):
            token = line.strip().split("=", 1)[1]
    print(token, flush=True)
'''
    late_holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            late_holder_code,
            str(lock),
            str(opened),
            str(proceed),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    deadline = time.time() + 5
    while time.time() < deadline and not opened.exists():
        time.sleep(0.02)
    assert opened.exists(), "late publisher did not open the old inode"
    recovered = subprocess.run(
        [sys.executable, str(MACHINE_READINESS_SCRIPT), "--recover-lock", str(lock)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert recovered.returncode == 0, recovered.stderr
    assert not lock.exists()
    proceed.write_text("continue")
    late_out, late_err = late_holder.communicate(timeout=5)
    assert late_holder.returncode == 0, late_err
    assert late_out.strip() != "old-token", late_out


def test_recover_lock_reports_io_errors_without_busy_status(tmp_path: Path) -> None:
    lock_dir = tmp_path / "lock-is-directory"
    lock_dir.mkdir()
    recovered = subprocess.run(
        [sys.executable, str(MACHINE_READINESS_SCRIPT), "--recover-lock", str(lock_dir)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert recovered.returncode == 3
    assert "inventory lock recovery failed:" in recovered.stderr


def test_keyed_inventory_rejects_stale_or_dead_publisher(tmp_path: Path) -> None:
    """A last-good positive record is safe only while its exact publisher is
    alive and the provider generation is recent. A killed or wedged publisher
    must fail closed without a child-scaled live API fallback."""
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    assert "inventory_index_healthy() {" in fleet
    assert "_inventory_index_healthy() {" in cloud

    # Hot keyed reads must not fork ps/sed/date for every machine poll. Lease
    # validation is shell builtins + record metadata only; process identity is
    # created once when the publisher starts.
    for body in (
        _extract_fleet_function(fleet, "inventory_index_healthy() {"),
        _extract_fleet_function(fleet, "inventory_machine_field() {"),
        _extract_fleet_function(cloud, "_inventory_index_healthy() {"),
        _extract_fleet_function(cloud, "_machine_record_field() {"),
    ):
        assert "ps " not in body
        assert "sed " not in body
        assert "date " not in body

    for signature in (
        "inventory_machine_field() {",
        "inventory_machine_exists() {",
        "inventory_machine_id_for_name() {",
    ):
        assert "inventory_index_healthy" in _extract_fleet_function(fleet, signature)
    assert "_inventory_index_healthy" in _extract_fleet_function(
        cloud, "_machine_record_field() {"
    )
    for assignment in (
        "CLOUDBENCH_INVENTORY_OWNER_PID=",
        "CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN=",
        "CLOUDBENCH_INVENTORY_HEALTH=",
    ):
        assert assignment in fleet

    health = _extract_fleet_function(fleet, "inventory_index_healthy() {")
    record_path = _extract_fleet_function(fleet, "inventory_machine_record_path() {")
    field = _extract_fleet_function(fleet, "inventory_machine_field() {")
    root = tmp_path / "inventory"
    record = root / "current/machines/machine-1"
    record.parent.mkdir(parents=True)
    record.write_text("state=started\nprivate_ip=fdaa::1\nstorage_ready=1\n")
    health_path = root / "current/health"
    health_path.write_text(
        f"publisher_token=test-token\nvalid_until={int(time.time()) + 60}\n"
    )

    script = f"""set -uo pipefail
INVENTORY_INDEX="$ROOT"
INVENTORY_CLOCK_EPOCH="$(date +%s)"
INVENTORY_CLOCK_SECONDS="$SECONDS"
SNAPSHOT_LOOP_PID=$$
SNAPSHOT_LOOP_TOKEN=test-token
{health}
{record_path}
{field}
test "$(inventory_machine_field machine-1 state)" = started
SNAPSHOT_LOOP_PID=99999999
if inventory_machine_field machine-1 state; then exit 8; fi
SNAPSHOT_LOOP_PID=$$
printf 'publisher_token=test-token\nvalid_until=%s\n' "$((INVENTORY_CLOCK_EPOCH - 60))" > "$INVENTORY_INDEX/current/health"
if inventory_machine_field machine-1 state; then exit 9; fi
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={"ROOT": str(root), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def _preflight_harness(
    tmp_path: Path,
    *,
    state_line: str | None,
    dirty: bool,
    autorefresh: str,
    snap_epoch: int,
    refresh_status: int = 0,
    refreshed_snapshot: str = "snap-transaction",
) -> tuple:
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
        "#!/usr/bin/env bash\n"
        'echo "refresh-deps $*" >> "$CALLS_FILE"\n'
        f'printf "NODEFP PYFP 2000 {refreshed_snapshot}\\n" > "$COMMON/cloudbench-warm-deps.fp"\n'
        f"exit {refresh_status}\n"
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
        env={"ROOT": str(root), "COMMON": str(common), "CALLS_FILE": str(calls), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
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
        tmp_path / "a", state_line="NODEFP PYFP 1000 snap-current", dirty=False, autorefresh="1", snap_epoch=2000
    )
    assert result.returncode == 0, result.stderr
    assert "fast bring-up" in result.stdout
    assert calls.read_text() == ""
    assert "SNAP_AFTER=snap-current" in result.stdout

    # (b) no state → central heal once, then adopt only the exact snapshot
    # the refresh transaction published (never a newer unrelated snapshot).
    result, calls = _preflight_harness(tmp_path / "b", state_line=None, dirty=False, autorefresh="1", snap_epoch=2000)
    assert result.returncode == 0, result.stderr
    assert "refresh-deps --refresh-deps --ref abc123" in calls.read_text()
    assert "SNAP_AFTER=snap-transaction" in result.stdout

    # (c) dirty manifests cannot be fetched/rebuilt centrally and must fail
    # before provisioning; the old advertised per-box fallback hits the same
    # immutable donor mismatch and cannot work.
    result, calls = _preflight_harness(tmp_path / "c", state_line=None, dirty=True, autorefresh="1", snap_epoch=2000)
    assert result.returncode != 0
    assert "DIRTY" in result.stdout + result.stderr
    assert calls.read_text() == ""

    # (d) a failed central transaction aborts immediately instead of launching
    # clones that are already known to fail the copy-only dependency gate.
    result, calls = _preflight_harness(
        tmp_path / "d", state_line=None, dirty=False, autorefresh="1", snap_epoch=2000, refresh_status=1
    )
    assert result.returncode != 0
    assert "refresh-deps --refresh-deps --ref abc123" in calls.read_text()
    assert "refusing to provision" in result.stdout + result.stderr

    # (e) disabling required maintenance also fails before provisioning and
    # prints the explicit manual repair command.
    result, calls = _preflight_harness(tmp_path / "e", state_line=None, dirty=False, autorefresh="0", snap_epoch=2000)
    assert result.returncode != 0
    assert "--refresh-deps" in result.stdout + result.stderr
    assert calls.read_text() == ""


def test_refresh_deps_is_a_validated_maintenance_transaction() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-deps" ]; then') : cloud.index("# MODE: --refresh-wmh")]
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
    assert "CREATED_SNAPSHOT_ID=" in snapshot_helper
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
        text=True,
        capture_output=True,
        check=False,
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
        text=True,
        capture_output=True,
        check=False,
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
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "EXACT=snap-owned" in result.stdout
    assert "snap-unrelated-older" not in result.stdout

    created.unlink()
    ambiguous_script = script.replace(
        '{"id":"snap-owned","status":"created","size":10}]',
        '{"id":"snap-owned","status":"created","size":10},{"id":"snap-racing","status":"running","size":0}]',
    )
    ambiguous = subprocess.run(
        ["bash", "-c", ambiguous_script],
        env={"CALLS": str(calls), "CREATED": str(created), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
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
    fake_fly.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FLY_CALLS"\necho "[]"\n')
    fake_fly.chmod(0o755)

    result = subprocess.run(
        ["bash", str(CLOUD_SCRIPT), "--refresh-deps", "--ref", "definitely-not-a-commit"],
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FLY_BENCH_API_TOKEN": "test-token",
            "FLY_CALLS": str(calls),
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )

    assert result.returncode != 0
    assert calls.read_text() == ""
    assert "invalid benchmark ref" in result.stdout + result.stderr


def test_isolated_backend_startup_retries_one_hung_process(tmp_path: Path) -> None:
    """A live-but-never-listening first backend cannot abort the whole fleet slot."""
    stack = STACK_SCRIPT.read_text()
    # isolated_backend_ready_attempts() delegates to backend_ready_budget(), which
    # run.sh sources from scripts/lib/seed-cache.sh — prepend it so the extracted
    # snippet is self-contained just like the sourced production stack.
    helpers = _extract_fleet_function(
        SEED_CACHE_LIB.read_text(), "backend_ready_budget() {"
    ) + "".join(
        _extract_fleet_function(stack, signature)
        for signature in (
            "launch_backend_service() {",
            "terminate_backend_group() {",
            "restart_backend_service() {",
            "isolated_backend_ready_attempts() {",
            "wait_for_isolated_backend_ready() {",
        )
    )
    launcher = tmp_path / "backend_tree.py"
    launcher.write_text(
        "import os, pathlib, signal, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'])\n"
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid))\n"
        "time.sleep(30)\n"
    )
    launches = tmp_path / "launches"
    launches.write_text("0\n")
    child_dir = tmp_path / "children"
    child_dir.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_npx = bin_dir / "npx"
    fake_npx.write_text(
        "#!/usr/bin/env bash\n"
        'count=$(cat "$LAUNCHES")\n'
        'count=$((count + 1))\n'
        '[ "$count" -lt 2 ] || sleep 3\n'
        'echo "$count" > "$LAUNCHES"\n'
        'exec python3 "$LAUNCHER" "$CHILD_DIR/child-$count"\n'
    )
    fake_npx.chmod(0o755)
    script = f"""set -eo pipefail
BACKEND_PORT=3001
BACKEND_LOG_FILE="$CHILD_DIR/backend.log"
FAIL_DIR="$CHILD_DIR/fail"
mkdir -p "$FAIL_DIR"
# Keep this below the production warm-start budget (60), but large enough to
# cover the deterministic delayed second launch in the fake npx wrapper.
CLOUDBENCH_BACKEND_START_READY_ATTEMPTS=10
BACKEND_INDEX=0
PIDS=("")
NAMES=()
BENCHMARK_MODE=true
BENCHMARK_ISOLATED_RUN=true
FIRST_RUN_SEEDED=false
DB_RESTORED=false
SCRIPT_DIR="$SCRIPT_DIR"
    # Force the first controller-owned PID through the retry path. For the
    # replacement, wait until its TERM-ignoring descendant exists; that proves
    # run-in-new-session has established the process group before the fake
    # health check succeeds and removes an async-launch race from this test.
    curl() {{
        [ -s "$CHILD_DIR/root-1" ] || return 1
        [ "$BACKEND_PID" != "$(cat "$CHILD_DIR/root-1")" ] || return 1
        for _ in $(seq 1 100); do
            [ -s "$CHILD_DIR/child-2" ] && return 0
            sleep 0.1
        done
        return 1
    }}
{helpers}
launch_backend_service
echo "$BACKEND_PID" > "$CHILD_DIR/root-1"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CHILD_DIR/child-1" ] && break; sleep 0.1; done
wait_for_isolated_backend_ready
rc=$?
old_child=$(cat "$CHILD_DIR/child-1")
if kill -0 "$old_child" 2>/dev/null; then echo OLD_SURVIVED; rc=1; else echo OLD_GONE; fi
new_root="$BACKEND_PID"
[ "${{PIDS[0]}}" = "$new_root" ] || {{ echo SLOT_STALE; rc=1; }}
terminate_backend_group || rc=1
kill -0 "$new_root" 2>/dev/null && {{ echo NEW_SURVIVED; rc=1; }}
exit "$rc"
"""
    harness_env = {
        "LAUNCHER": str(launcher),
        "LAUNCHES": str(launches),
        "CHILD_DIR": str(child_dir),
        "SCRIPT_DIR": str(ROOT / "scripts"),
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
    }
    # Preserve the exact smoke failure as a negative control: production does
    # not enable nounset, so an invented empty ROOT_DIR resolves to /scripts.
    broken_script = script.replace(
        'python3 "$SCRIPT_DIR/run-in-new-session.py"',
        'python3 "$ROOT_DIR/scripts/run-in-new-session.py"',
    ).replace("for _ in $(seq 1 100); do", "for _ in $(seq 1 1); do")
    broken = subprocess.run(
        ["bash", "-c", broken_script],
        cwd=ROOT,
        env=harness_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert broken.returncode != 0
    assert "can't open file '/scripts/run-in-new-session.py'" in broken.stderr

    result = subprocess.run(
        ["bash", "-c", script],
        cwd=ROOT,
        env=harness_env,
        # The harness launches and tears down two process groups, waiting through
        # TERM and KILL windows twice. Concurrent coverage/deploy loops can delay
        # scheduling, so leave headroom while still bounding a stuck cleanup.
        text=True,
        capture_output=True,
        check=False,
        timeout=60,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert launches.read_text().strip() == "2"
    assert "backend startup attempt 1/2 did not become healthy" in result.stdout + result.stderr
    assert "backend became healthy after restart" in result.stdout
    assert "OLD_GONE" in result.stdout
    assert "OLD_SURVIVED" not in result.stdout
    assert "SLOT_STALE" not in result.stdout
    assert "NEW_SURVIVED" not in result.stdout


def test_isolated_backend_session_launcher_is_macos_portable(tmp_path: Path) -> None:
    """The local smoke path must not require GNU setsid(1), absent on macOS."""
    stack = STACK_SCRIPT.read_text()
    session_launcher = ROOT / "scripts" / "run-in-new-session.py"
    assert 'python3 "$SCRIPT_DIR/run-in-new-session.py" bash -c' in stack
    assert "$ROOT_DIR/scripts/run-in-new-session.py" not in stack
    assert "setsid bash" not in stack

    ready = tmp_path / "ready"
    child = tmp_path / "child.py"
    child.write_text(
        "import os, pathlib, signal, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        f"pathlib.Path({str(ready)!r}).write_text(f'{{os.getpid()}} {{os.getsid(0)}} {{os.getpgrp()}}')\n"
        "time.sleep(30)\n"
    )
    # Deliberately provide no setsid executable. The helper must establish a
    # session whose id and process group are both the owned root process.
    process = subprocess.Popen(
        [sys.executable, str(session_launcher), sys.executable, str(child)],
        env={"PATH": str(tmp_path)},
    )
    try:
        deadline = time.time() + 5
        while time.time() < deadline and not ready.exists():
            time.sleep(0.05)
        assert ready.exists(), "session-owned child did not start"
        pid, sid, pgid = (int(value) for value in ready.read_text().split())
        assert pid == process.pid
        assert sid == process.pid
        assert pgid == process.pid
    finally:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def test_local_predeploy_skips_wmh_and_wmh_logs_survive_agent_chdir(tmp_path: Path) -> None:
    """Real-mode smoke must not build WMH; simulate logs still need a rooted path."""
    predeploy = PREDEPLOY_LOCAL_SCRIPT.read_text()
    stack = STACK_SCRIPT.read_text()

    fixture = tmp_path / "predeploy"
    (fixture / "scripts").mkdir(parents=True)
    (fixture / "agents" / "benchmarks").mkdir(parents=True)
    (fixture / "scripts" / "run-predeploy-local").write_text(predeploy)
    (fixture / "scripts" / "run_logged_command.py").write_text(LOGGED_COMMAND_SCRIPT.read_text())
    (fixture / "agents" / "benchmarks" / "predeploy_metrics.py").write_text(PREDEPLOY_METRICS_SCRIPT.read_text())
    (fixture / "agents" / "benchmarks" / "tasks.json").write_text(
        json.dumps([{"name": "smoke-fixture", "tags": ["smoke"]}])
    )
    capture = fixture / "capture"
    (fixture / "scripts" / "run-bench").write_text(
        '#!/usr/bin/env bash\nprintf "%s\\n" "${BENCHMARK_SKIP_WMH_BUILD:-unset}" "$*" > "$CAPTURE"\n'
    )
    (fixture / "scripts" / "run-bench").chmod(0o755)
    subprocess.run(["git", "init", "-q", str(fixture)], check=True)
    subprocess.run(["git", "-C", str(fixture), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(fixture), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(fixture), "add", "."], check=True)
    subprocess.run(["git", "-C", str(fixture), "commit", "-qm", "fixture"], check=True)
    result = subprocess.run(
        ["bash", str(fixture / "scripts" / "run-predeploy-local")],
        env={**os.environ, "CAPTURE": str(capture)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert capture.read_text().splitlines() == ["1", "--local smoke-fixture --max-concurrency 2"]

    wmh = _extract_fleet_function(stack, "start_world_model_harness() {")
    wmh_root = tmp_path / "wmh"
    activate = wmh_root / "agents" / "venv" / "bin" / "activate"
    activate.parent.mkdir(parents=True)
    activate.write_text("python() { printf 'build-cwd=%s\\n' \"$PWD\"; return 1; }\n")
    harness = f"""set -uo pipefail
cd "$WMH_ROOT"
should_serve_world_model() {{ return 0; }}
PIDS=()
NAMES=()
RUN_CONTEXT_DIR=.context/isolated
WMH_BUILD_DIR=.context/model
WMH_MODEL_NAME=fixture
WMH_PORT=39999
BENCHMARK_MODE=true
{wmh}
start_world_model_harness
"""
    result = subprocess.run(
        ["bash", "-c", harness],
        env={**os.environ, "WMH_ROOT": str(wmh_root)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    rooted_log = wmh_root / ".context" / "isolated" / "wmh-serve-log.txt"
    assert rooted_log.read_text().strip() == f"build-cwd={wmh_root / 'agents'}"
    assert not (wmh_root / "agents" / ".context").exists()


def test_isolated_stack_forwards_anthropic_exclusion_to_wmh_provider() -> None:
    """The stack env allow-list must preserve an explicit no-Anthropic run policy."""
    stack = DRIVER_SCRIPT.read_text()
    stack_env_start = stack.index("STACK_ENV=(")
    stack_env_end = stack.index("\n)", stack_env_start)
    stack_env = stack[stack_env_start:stack_env_end]

    assert '"ROSE_EXCLUDE_ANTHROPIC_FAMILY=${ROSE_EXCLUDE_ANTHROPIC_FAMILY:-}"' in stack_env


def test_wmh_health_wait_allows_cold_model_load_past_thirty_seconds(tmp_path: Path) -> None:
    """A live WMH process must not be discarded before its cold model finishes loading."""
    stack = STACK_SCRIPT.read_text()
    wmh = _extract_fleet_function(stack, "start_world_model_harness() {")

    wmh_root = tmp_path / "wmh"
    activate = wmh_root / "agents" / "venv" / "bin" / "activate"
    fake_bin = wmh_root / "fake-bin"
    model_root = wmh_root / ".context" / "model"
    (model_root / "models" / "fixture").mkdir(parents=True)
    (model_root / "build.manifest.json").write_text("{}")
    activate.parent.mkdir(parents=True)
    fake_bin.mkdir()
    activate.write_text(f'export PATH="{fake_bin}:$PATH"\n')
    fake_python = fake_bin / "python"
    fake_python.write_text("#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile :; do /bin/sleep 60; done\n")
    fake_python.chmod(0o755)

    harness = f"""set -uo pipefail
cd "$WMH_ROOT"
should_serve_world_model() {{ return 0; }}
PIDS=()
NAMES=()
RUN_CONTEXT_DIR=.context/isolated
WMH_BUILD_DIR=.context/model
WMH_MODEL_NAME=fixture
WMH_PORT=39999
BENCHMARK_MODE=true
BENCHMARK_SKIP_WMH_DELTA=1
curl_attempts=0
curl() {{
    curl_args="$*"
    curl_attempts=$((curl_attempts + 1))
    [ "$curl_attempts" -ge 31 ]
}}
sleep() {{ :; }}
{wmh}
start_world_model_harness
printf 'attempts=%s base=%s args=%s\n' "$curl_attempts" "${{WMH_BASE_URL:-}}" "$curl_args"
kill "$WMH_PID" 2>/dev/null || true
wait "$WMH_PID" 2>/dev/null || true
"""
    result = subprocess.run(
        ["bash", "-c", harness],
        env={**os.environ, "WMH_ROOT": str(wmh_root)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "attempts=31 base=http://localhost:39999" in result.stdout
    assert "--connect-timeout 1 --max-time 1" in result.stdout


def test_wmh_health_wait_caps_untrusted_timeout_without_expanding_seq(tmp_path: Path) -> None:
    """An extreme readiness timeout must fall back to the bounded default."""
    stack = STACK_SCRIPT.read_text()
    wmh = _extract_fleet_function(stack, "start_world_model_harness() {")

    wmh_root = tmp_path / "wmh"
    activate = wmh_root / "agents" / "venv" / "bin" / "activate"
    fake_bin = wmh_root / "fake-bin"
    model_root = wmh_root / ".context" / "model"
    (model_root / "models" / "fixture").mkdir(parents=True)
    (model_root / "build.manifest.json").write_text("{}")
    activate.parent.mkdir(parents=True)
    fake_bin.mkdir()
    activate.write_text(f'export PATH="{fake_bin}:$PATH"\n')
    fake_python = fake_bin / "python"
    fake_python.write_text("#!/usr/bin/env bash\ntrap 'exit 0' TERM INT\nwhile :; do /bin/sleep 60; done\n")
    fake_python.chmod(0o755)

    harness = f"""set -uo pipefail
cd "$WMH_ROOT"
should_serve_world_model() {{ return 0; }}
PIDS=()
NAMES=()
RUN_CONTEXT_DIR=.context/isolated
WMH_BUILD_DIR=.context/model
WMH_MODEL_NAME=fixture
WMH_PORT=39999
WMH_HEALTH_TIMEOUT_SECONDS=999999999999999999999999999999999999999999999999999999999999
BENCHMARK_MODE=true
BENCHMARK_SKIP_WMH_DELTA=1
curl_attempts=0
curl() {{ curl_attempts=$((curl_attempts + 1)); return 1; }}
sleep() {{ :; }}
{wmh}
start_world_model_harness
printf 'attempts=%s\n' "$curl_attempts"
kill "$WMH_PID" 2>/dev/null || true
wait "$WMH_PID" 2>/dev/null || true
"""
    result = subprocess.run(
        ["bash", "-c", harness],
        env={**os.environ, "WMH_ROOT": str(wmh_root)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (
        "Invalid WMH_HEALTH_TIMEOUT_SECONDS="
        "999999999999999999999999999999999999999999999999999999999999; using 180s"
        in result.stdout
    )
    assert "attempts=180" in result.stdout


def test_refresh_deps_mode_contract() -> None:
    """--refresh-deps must sync the ref, run the marker-gated dep sync, STOP the
    machine before snapshotting (quiesced snapshot), wait boundedly for the
    exact created snapshot, and record the shared freshness state file."""
    cloud = CLOUD_SCRIPT.read_text()
    start = cloud.index('if [ "$MODE" = "refresh-deps" ]; then')
    end = cloud.index("# MODE: --refresh-wmh", start)
    mode = cloud[start:end]
    snapshot_helper = _extract_fleet_function(cloud, "create_volume_snapshot_exact() {")
    assert "cloudbench-sync-deps.sh' /app" in mode
    assert "::DEPS-REFRESH-DONE::" in mode
    # stop precedes the snapshot cut
    assert mode.index('stop_machine_strict "$mid"') < mode.index('create_volume_snapshot_exact "$VOL_ID"')
    # bounded wait for a COMPLETE fresh snapshot
    assert "CLOUDBENCH_SNAPSHOT_READY_ATTEMPTS:-90" in snapshot_helper
    # shared freshness state recorded for fleet preflights
    assert "cloudbench-warm-deps.fp" in mode
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
    assert snap_at < fleet.index("while [ $# -gt 0 ]; do")
    assert snap_at < fleet.index("cloudbench_controller_lock_acquire")
    # the snapshot carries all three co-versioned interpreter files
    for f in (
        "run-bench-fleet",
        "run-bench-cloud",
        "cloudbench-port-lease.py",
        "cloudbench-env.sh",
    ):
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
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    assert cleanup.index('cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" "${AUTOSCALER_PIDS[@]:-}"') < cleanup.index(
        'rm -rf "$CLOUDBENCH_SCRIPT_SNAPSHOT"'
    )

    # functional: the re-exec chain is sound end-to-end (--help flows through
    # the snapshot exec and still exits 0 with usage text)
    result = subprocess.run(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={**os.environ, "CLOUDBENCH_SCRIPT_SNAPSHOT": "", "TMPDIR": str(tmp_path)},
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
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
        text=True,
        capture_output=True,
        check=False,
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
    lock_at = fleet.index("if ! cloudbench_controller_lock_acquire_wait")
    card_at = fleet.index('write_startup_card "controller starting"')
    hub_at = fleet.index("start_central_hub || exit 1\n")
    require_hub_at = fleet.index("require_central_hub_visibility || exit 1")
    verify_at = fleet.index("Verifying the shared benchmark app environment")
    fanout_at = fleet.index("# ── Phase 1:")
    assert lock_at < card_at < verify_at, "startup card must precede preflight"
    assert lock_at < hub_at < verify_at, "hub must serve before preflight"
    assert hub_at < require_hub_at < verify_at, "hub visibility must be proven before preflight"
    assert card_at < fanout_at and hub_at < fanout_at
    # phase updates at each controller stage
    for phase in ("verifying environment", "healing warm snapshot", "provisioning"):
        assert f'write_startup_card "{phase}' in fleet, f"missing phase update: {phase}"
    # Early and late phases share one identity-aware lifecycle implementation;
    # duplicating the launch path previously let the late copy kill foreign hubs.
    assert fleet.count("agents/benchmarks/agent_link_server.py") == 1
    assert fleet.count("start_central_hub || exit 1") == 2

    # functional: the card is a valid hub-readable starting card
    helper_start = fleet.index("write_startup_card() {")
    helper = fleet[helper_start : fleet.index("\nPY\n}", helper_start) + len("\nPY\n}")]
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
FLEET_DIR="$FD"
RUN_ID=test-run
BENCHES=(alpha beta)
{helper}
write_startup_card "healing warm snapshot (dep trees)"
""",
        ],
        env={"FD": str(tmp_path), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    card = json.loads((tmp_path / "_batch" / "report-card.json").read_text())
    assert card["status"] == "starting"
    assert "healing warm snapshot" in card["phase"]
    assert card["summary"]["total"] == 2
    assert [t["name"] for t in card["tasks"]] == ["alpha", "beta"]
    assert all(t["status"] == "starting" for t in card["tasks"])
    assert [t["name"] for t in card["per_task"]] == ["alpha", "beta"]
    assert all(t["status"] == "starting" for t in card["per_task"])

    visibility_start = fleet.index("require_central_hub_visibility() {")
    visibility_fn = fleet[visibility_start : fleet.index("\n}\n", visibility_start) + 3]
    visibility = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
RUN_ID=visible-run
DASH_BASE=8765
UNIFIED_DASH_PID=
{visibility_fn}
curl() {{ printf '<html>visible-run</html>'; }}
require_central_hub_visibility
curl() {{ return 1; }}
sleep() {{ :; }}
CLOUDBENCH_HUB_VISIBILITY_ATTEMPTS=1
if require_central_hub_visibility; then exit 99; fi
""",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert visibility.returncode == 0, visibility.stderr
    assert "central hub registration verified" in visibility.stdout
    assert "refusing to continue invisibly" in visibility.stderr


def test_foreign_central_hub_port_reuses_only_the_matching_runs_root(
    tmp_path: Path,
) -> None:
    """A stale/foreign workspace hub on the derived Conductor port must stay
    alive, while this fleet selects a hub that serves its own runs root."""
    base_port = None
    for candidate in range(42000, 62000):
        sockets = []
        try:
            for port in (candidate, candidate + 1):
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.bind(("127.0.0.1", port))
                sockets.append(sock)
            base_port = candidate
            break
        except OSError:
            pass
        finally:
            for sock in sockets:
                sock.close()
    assert base_port is not None, "could not reserve consecutive hub test ports"

    foreign_root = tmp_path / "foreign"
    foreign_root.mkdir()
    (foreign_root / "index.html").write_text("Benchmark runs foreign-workspace\n")
    runs_root = tmp_path / "runs"
    runs_root.mkdir()
    hub_context = tmp_path / "hub-context"
    hub_context.mkdir()

    foreign = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(base_port), "--bind", "127.0.0.1"],
        cwd=foreign_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    own_hub = subprocess.Popen(
        [
            sys.executable,
            str(AGENT_LINK_SERVER),
            "--root",
            str(runs_root),
            "--host",
            "127.0.0.1",
            "--port",
            str(base_port + 1),
            "--repo-root",
            str(ROOT),
            "--context-dir",
            str(hub_context),
            "--frontend-dir",
            str(ROOT / "front-end"),
            "--hub-runs-dir",
            str(runs_root),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            if foreign.poll() is None and own_hub.poll() is None:
                probe = subprocess.run(
                    ["curl", "--noproxy", "*", "-fsS", f"http://127.0.0.1:{base_port + 1}/hub-meta.json"],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                if probe.returncode == 0:
                    break
            time.sleep(0.05)

        selection = subprocess.run(
            [
                "bash",
                "-c",
                'source "$HELPER"; cloudbench_select_central_hub_port "$FOREIGN_PORT" "$RUNS_ROOT"',
            ],
            env={
                **os.environ,
                "HELPER": str(ENV_HELPER_SCRIPT),
                "FOREIGN_PORT": str(base_port),
                "RUNS_ROOT": str(runs_root),
            },
            text=True,
            capture_output=True,
            check=False,
        )
        assert selection.returncode == 0, selection.stderr
        assert selection.stdout.strip() == str(base_port + 1)
        assert foreign.poll() is None, "foreign workspace hub must not be killed"
        assert own_hub.poll() is None
        assert "cloudbench_select_central_hub_port" in FLEET_SCRIPT.read_text()
    finally:
        foreign.terminate()
        own_hub.terminate()
        foreign.wait(timeout=5)
        own_hub.wait(timeout=5)


def test_central_hub_startup_rebinds_serves_the_run_and_never_kills_foreign_owner(
    tmp_path: Path,
) -> None:
    base_port = None
    for candidate in range(42000, 62000):
        sockets = []
        try:
            for port in (candidate, candidate + 1):
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.bind(("127.0.0.1", port))
                sockets.append(sock)
            base_port = candidate
            break
        except OSError:
            pass
        finally:
            for sock in sockets:
                sock.close()
    assert base_port is not None

    foreign_root = tmp_path / "foreign-startup"
    foreign_root.mkdir()
    (foreign_root / "index.html").write_text("Benchmark runs foreign-workspace\n")
    runs_root = tmp_path / "runs-startup"
    (runs_root / "visible-run" / "_batch").mkdir(parents=True)
    (runs_root / "visible-run" / "_batch" / "report-card.json").write_text(
        json.dumps({"run_id": "visible-run", "status": "starting"})
    )
    hub_context = runs_root / "_hub"

    foreign = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(base_port), "--bind", "127.0.0.1"],
        cwd=foreign_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    fleet = FLEET_SCRIPT.read_text()
    startup = _extract_fleet_function(fleet, "start_central_hub() {")
    visibility = _extract_fleet_function(fleet, "require_central_hub_visibility() {")
    shell = f'''set -uo pipefail
source "$HELPER"
ROOT_DIR="$ROOT"
RUNS_ROOT="$RUNS_ROOT"
HUB_CTX_DIR="$HUB_CTX_DIR"
DASH_BASE="$FOREIGN_PORT"
RUN_ID=visible-run
UNIFIED_DASH_PID=
CLOUDBENCH_HUB_VISIBILITY_ATTEMPTS=10
{startup}
{visibility}
start_central_hub
require_central_hub_visibility
first_port="$DASH_BASE"
start_central_hub
require_central_hub_visibility
[ "$DASH_BASE" = "$first_port" ]
printf 'SELECTED_PORT=%s\n' "$DASH_BASE"
'''
    try:
        for _ in range(50):
            if foreign.poll() is None:
                probe = subprocess.run(
                    ["curl", "--noproxy", "*", "-fsS", f"http://127.0.0.1:{base_port}/"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if probe.returncode == 0:
                    break
            time.sleep(0.05)

        result = subprocess.run(
            ["bash", "-c", shell],
            env={
                **os.environ,
                "HELPER": str(ENV_HELPER_SCRIPT),
                "ROOT": str(ROOT),
                "RUNS_ROOT": str(runs_root),
                "HUB_CTX_DIR": str(hub_context),
                "FOREIGN_PORT": str(base_port),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert f"SELECTED_PORT={base_port + 1}" in result.stdout
        assert "central hub registration verified: run=visible-run" in result.stdout
        assert foreign.poll() is None, "fleet startup must not kill the foreign hub"

        # The post-provisioning revalidation must precede the aggregator fork so
        # its subshell captures the final rebound DASH_BASE for every agent URL.
        manifest = fleet.index('} > "$UNIFIED_DIR/benches.json"')
        late_start = fleet.index("start_central_hub || exit 1", manifest)
        aggregator = fleet.index("(\n    while :; do", late_start)
        assert late_start < aggregator
        assert fleet.index("require_central_hub_visibility || exit 1", late_start) < aggregator
        assert 'env FLEET_DIR="$FLEET_DIR" UNIFIED_DIR="$UNIFIED_DIR" DASH_BASE="$DASH_BASE"' in fleet[aggregator:]
        assert 'kill "$pp"' not in fleet
    finally:
        foreign.terminate()
        foreign.wait(timeout=5)
        pid_file = hub_context / "agent-link-server.pid"
        if pid_file.exists():
            os.kill(int(pid_file.read_text().strip()), signal.SIGTERM)


def test_central_hub_runs_in_own_session_after_launcher_exit(tmp_path: Path) -> None:
    """The hub is a persistent user surface, not a child of the fleet PTY.

    A plain ``command &`` remains in the launcher's session and is hung up when
    a PTY-backed controller exits. Prove the production launch function puts the
    hub in a distinct session and that it still serves the run after the launcher
    shell is completely gone.
    """
    port = None
    for candidate in range(42000, 62000):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", candidate))
            port = candidate
            break
        except OSError:
            pass
        finally:
            sock.close()
    assert port is not None

    runs_root = tmp_path / "runs-detached-hub"
    (runs_root / "visible-run" / "_batch").mkdir(parents=True)
    (runs_root / "visible-run" / "_batch" / "report-card.json").write_text(
        json.dumps({"run_id": "visible-run", "status": "starting"})
    )
    hub_context = runs_root / "_hub"
    launcher_sid_file = tmp_path / "launcher.sid"
    fleet = FLEET_SCRIPT.read_text()
    startup = _extract_fleet_function(fleet, "start_central_hub() {")
    visibility = _extract_fleet_function(fleet, "require_central_hub_visibility() {")
    shell = f'''set -uo pipefail
source "$HELPER"
ROOT_DIR="$ROOT"
RUNS_ROOT="$RUNS_ROOT"
HUB_CTX_DIR="$HUB_CTX_DIR"
DASH_BASE="$DASH_BASE"
RUN_ID=visible-run
UNIFIED_DASH_PID=
CLOUDBENCH_HUB_VISIBILITY_ATTEMPTS=10
{startup}
{visibility}
python3 -c 'import os; print(os.getsid(0))' > "$LAUNCHER_SID_FILE"
start_central_hub
require_central_hub_visibility
'''
    hub_pid = None
    try:
        result = subprocess.run(
            ["bash", "-c", shell],
            env={
                **os.environ,
                "HELPER": str(ENV_HELPER_SCRIPT),
                "ROOT": str(ROOT),
                "RUNS_ROOT": str(runs_root),
                "HUB_CTX_DIR": str(hub_context),
                "DASH_BASE": str(port),
                "LAUNCHER_SID_FILE": str(launcher_sid_file),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        hub_pid = int((hub_context / "agent-link-server.pid").read_text().strip())
        launcher_sid = int(launcher_sid_file.read_text().strip())
        os.kill(hub_pid, 0)
        assert os.getsid(hub_pid) != launcher_sid, (
            "persistent central hub must not share the launcher's terminal session"
        )
        probe = subprocess.run(
            [
                "curl",
                "--noproxy",
                "*",
                "-fsS",
                f"http://127.0.0.1:{port}/hub-meta.json",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert probe.returncode == 0, probe.stderr
        assert str(runs_root.resolve()) in probe.stdout
    finally:
        if hub_pid is not None:
            try:
                os.kill(hub_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def test_central_hub_startup_retries_when_foreign_process_wins_bind_race(
    tmp_path: Path,
) -> None:
    base_port = None
    for candidate in range(42000, 62000):
        sockets = []
        try:
            for port in (candidate, candidate + 1):
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.bind(("127.0.0.1", port))
                sockets.append(sock)
            base_port = candidate
            break
        except OSError:
            pass
        finally:
            for sock in sockets:
                sock.close()
    assert base_port is not None

    runs_root = tmp_path / "race-runs"
    (runs_root / "race-run" / "_batch").mkdir(parents=True)
    (runs_root / "race-run" / "_batch" / "report-card.json").write_text(
        json.dumps({"run_id": "race-run", "status": "starting"})
    )
    hub_context = runs_root / "_hub"
    race_marker = tmp_path / "race-selected"
    competitor_pid_file = tmp_path / "competitor.pid"
    competitor_root = tmp_path / "competitor"
    competitor_root.mkdir()
    (competitor_root / "index.html").write_text("Benchmark runs bind-race winner\n")

    fleet = FLEET_SCRIPT.read_text()
    startup = _extract_fleet_function(fleet, "start_central_hub() {")
    visibility = _extract_fleet_function(fleet, "require_central_hub_visibility() {")
    shell = f'''set -uo pipefail
source "$HELPER"
eval "$(declare -f cloudbench_select_central_hub_port | sed '1s/cloudbench_select_central_hub_port/cloudbench_select_central_hub_port_original/')"
cloudbench_select_central_hub_port() {{
    if [ ! -e "$RACE_MARKER" ]; then
        : > "$RACE_MARKER"
        cloudbench_detach_reexec "$COMPETITOR_LOG" \
            python3 -m http.server "$FOREIGN_PORT" --bind 127.0.0.1
        for _ in $(seq 1 50); do
            lsof -tiTCP:"$FOREIGN_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
            sleep 0.05
        done
        lsof -tiTCP:"$FOREIGN_PORT" -sTCP:LISTEN | head -1 > "$COMPETITOR_PID_FILE"
        printf '%s\n' "$FOREIGN_PORT"
        return 0
    fi
    cloudbench_select_central_hub_port_original "$@"
}}
ROOT_DIR="$ROOT"
RUNS_ROOT="$RUNS_ROOT"
HUB_CTX_DIR="$HUB_CTX_DIR"
DASH_BASE="$FOREIGN_PORT"
RUN_ID=race-run
UNIFIED_DASH_PID=
CLOUDBENCH_HUB_VISIBILITY_ATTEMPTS=10
{startup}
{visibility}
start_central_hub
require_central_hub_visibility
printf 'SELECTED_PORT=%s\n' "$DASH_BASE"
'''
    try:
        result = subprocess.run(
            ["bash", "-c", shell],
            env={
                **os.environ,
                "HELPER": str(ENV_HELPER_SCRIPT),
                "ROOT": str(ROOT),
                "RUNS_ROOT": str(runs_root),
                "HUB_CTX_DIR": str(hub_context),
                "FOREIGN_PORT": str(base_port),
                "RACE_MARKER": str(race_marker),
                "COMPETITOR_PID_FILE": str(competitor_pid_file),
                "COMPETITOR_ROOT": str(competitor_root),
                "COMPETITOR_LOG": str(tmp_path / "competitor.log"),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr
        assert f"SELECTED_PORT={base_port + 1}" in result.stdout
        competitor_pid = int(competitor_pid_file.read_text().strip())
        os.kill(competitor_pid, 0)
    finally:
        for path in (competitor_pid_file, hub_context / "agent-link-server.pid"):
            if path.exists():
                try:
                    os.kill(int(path.read_text().strip()), signal.SIGTERM)
                except ProcessLookupError:
                    pass


def test_warm_source_parks_between_maintenance_and_fleet_runs() -> None:
    """The stopped donor must not consume the config transaction's CPU margin."""
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    park_at = fleet.index("parking warm source at $WARM_PARKED_VM_SIZE")
    fanout_at = fleet.index("# ── Phase 1:")
    assert park_at < fanout_at
    assert 'WARM_PARKED_VM_SIZE="${CLOUDBENCH_WARM_PARKED_VM_SIZE:-shared-cpu-1x}"' in fleet
    assert 'WARM_PARKED_VM_MEMORY="${CLOUDBENCH_WARM_PARKED_VM_MEMORY:-2048}"' in fleet
    assert 'prepare_warm_source "$mid" || exit 1' in cloud
    assert 'park_warm_source "${mid:-${maintenance_mid:-}}" || true' in cloud
    assert cloud.count('park_warm_source "${mid:-${maintenance_mid:-}}" || true') == 2


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
        text=True,
        capture_output=True,
        check=False,
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


def test_refresh_wmh_bounds_the_archive_scan_by_default() -> None:
    """Maintenance must not scan every historical R2 bundle before a run."""
    cloud = CLOUD_SCRIPT.read_text()
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-wmh" ]; then') : cloud.index("# MODE: run (default)")]

    assert 'WMH_REFRESH_MAX_BUNDLES="${WMH_REFRESH_MAX_BUNDLES:-20}"' in refresh
    assert "WMH_REFRESH_MAX_BUNDLES must be a non-negative integer" in refresh
    assert "WMH_MAX_BUNDLES='$WMH_REFRESH_MAX_BUNDLES'" in refresh


def test_refresh_wmh_can_select_an_exact_attributable_corpus() -> None:
    """A one-trace delta proof must name the admitted live root explicitly."""
    cloud = CLOUD_SCRIPT.read_text()
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-wmh" ]; then') : cloud.index("# MODE: run (default)")]

    assert 'WMH_REFRESH_ROOT_AGENT_IDS="${WMH_REFRESH_ROOT_AGENT_IDS:-}"' in refresh
    assert "WMH_REFRESH_ROOT_AGENT_IDS must be comma-separated UUIDs" in refresh
    assert "explicit WMH root count exceeds WMH_REFRESH_MAX_BUNDLES" in refresh
    assert "explicit_roots=" in refresh
    assert "WMH_ROOT_AGENT_IDS='$WMH_REFRESH_ROOT_AGENT_IDS'" in refresh
    assert "u(root_agent_ids=ids or None" in refresh


def test_benchmark_stack_does_not_override_injected_r2_archive_backend() -> None:
    """Gold live traces must survive disposal of their fleet volume."""
    stack = STACK_SCRIPT.read_text()
    benchmark_env = stack[stack.index("if $BENCHMARK_MODE; then") : stack.index("# Build the benchmark frontend")]

    assert 'export TRACE_ARCHIVE_ENABLED="${TRACE_ARCHIVE_ENABLED:-1}"' in benchmark_env
    assert 'export TRACE_ARCHIVE_LOCAL_DIR="${TRACE_ARCHIVE_LOCAL_DIR:-$PWD/.context}"' in benchmark_env
    assert 'TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}"' not in benchmark_env
    assert "disposable fleet volume" in benchmark_env


def test_refresh_wmh_publishes_the_rebuilt_volume_as_the_proven_fleet_snapshot() -> None:
    """A warm-volume rebuild is useless if fleet clones keep selecting the prior snapshot."""
    cloud = CLOUD_SCRIPT.read_text()
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-wmh" ]; then') : cloud.index("# MODE: run (default)")]

    assert 'create_volume_snapshot_exact "$VOL_ID"' in refresh
    assert 'NEW_SNAP="$CREATED_SNAPSHOT_ID"' in refresh
    assert '"$NEW_SNAP" > "$GIT_COMMON_DIR/cloudbench-warm-deps.fp"' in refresh
    assert "WMH model snapshot published for fleet clones" in refresh


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
        state_file = tmp_path / "cloudbench-driver.state"
        for state in (None, "booting"):
            if state is not None:
                state_file.write_text(f"{state}\n")
            try:
                local_opener.open(f"{base}/driver-health", timeout=1)
                raise AssertionError("pre-launch driver unexpectedly reported terminal/healthy")
            except urllib.error.HTTPError as exc:
                assert exc.code == 425
        pid_file.write_text(f"{os.getpid()}\n")
        state_file.write_text("running\n")
        with local_opener.open(f"{base}/driver-health", timeout=1) as response:
            assert response.status == 204
        health_probe = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "probe_driver_health() {")

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
        state_file.write_text("exited\n")
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
    proxies; readiness comes from the authoritative marker, not streamed logs,
    and one unavailable endpoint makes the run fail immediately and visibly.

    RCA (2026-07-17): two healthy Fly stacks wrote their ``.ready`` marker in
    74 seconds, but their lossy ``fleet-child.log`` streams omitted the READY
    line. The controller grepped those streams, falsely excluded both stacks at
    720 seconds, and reset the clean-run streak. The status server exposes the
    persisted marker over the same data plane used for release, so the barrier
    must observe that artifact directly.
    """
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
            (root / "bench.log").write_text(f"synchronized start barrier ready: {barrier}\n")
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
                with local_opener.open(f"http://127.0.0.1:{ports[-1]}/bench.log", timeout=0.2):
                    break
            except (OSError, urllib.error.URLError):
                if time.time() >= deadline:
                    raise
                time.sleep(0.05)

        for root, port in zip(roots, ports, strict=True):
            # Mirror the production failure: the on-box marker exists while
            # the controller's streamed log never received the READY line.
            (root / f"cloudbench-start-{barrier}.ready").touch()
            (root / "fleet-child.log").write_text(f"status proxy: 127.0.0.1:{port} -> fly:8011\n")
            (root / "status-proxy.port").write_text(f"{port}\n")

        release_fn = _extract_fleet_function(
            FLEET_SCRIPT.read_text(), "release_start_barrier() {"
        )
        # Thirty concurrent curl subprocesses can be scheduler-delayed on a
        # shared CI host. Keep the production curl/attempt deadlines unchanged,
        # but give the enclosing test process enough wall time to observe them.
        subprocess_timeout_seconds = 20
        quoted_roots = " ".join(shlex.quote(str(root)) for root in roots)
        script = f"""set +e
SYNCHRONIZED_START=1
RUN_ID={barrier}
START_BARRIER_WAIT_SECONDS=2
CLOUDBENCH_PER_BOX_BARRIER_WAIT_SECONDS=2
CLOUDBENCH_BARRIER_TOKEN={token}
CLOUDBENCH_BARRIER_RELEASE_ATTEMPTS=2
CHILD_PIDS=({" ".join([str(os.getpid())] * 30)})
CHILD_OUT=({quoted_roots})
CHILD_BENCH=({' '.join(f'task-{i}' for i in range(30))})
CHILD_MACHINE=({' '.join(f'machine-{i}' for i in range(30))})
wait_for_mandatory_autoscaler_startup() {{ return 0; }}
{release_fn}
release_start_barrier
"""
        success = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=subprocess_timeout_seconds,
        )
        assert success.returncode == 0, success.stderr
        assert all((root / f"cloudbench-start-{barrier}.release").exists() for root in roots)

        for root in roots:
            (root / f"cloudbench-start-{barrier}.release").unlink()
        # The second half isolates release failure (not readiness discovery):
        # retain the compatibility READY signal after taking its server down so
        # the controller must attempt, and fail, the release POST.
        (roots[-1] / "fleet-child.log").write_text(
            f"status proxy: 127.0.0.1:{ports[-1]} -> fly:8011\nsynchronized start barrier ready: {barrier}\n"
        )
        servers[-1].terminate()
        servers[-1].wait(timeout=5)
        failed = subprocess.run(
            ["bash", "-c", script.replace("ATTEMPTS=2", "ATTEMPTS=1")],
            text=True,
            capture_output=True,
            check=False,
            timeout=subprocess_timeout_seconds,
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
    assert 'max_attempts="${CLOUDBENCH_CLONE_MAX_ATTEMPTS:-${CLOUDBENCH_CLONE_ATTEMPTS:-5}}"' in fleet
    # Launch burst is staggered, not simultaneous.
    assert "CLOUDBENCH_CLONE_LAUNCH_STAGGER_SECONDS" in fleet
    # Exponential backoff (bit-shift by attempt) with a cap and jitter.
    clone_fn = _clone_machine_bundle(fleet)
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
    assert "CLOUDBENCH_LAUNCH_STAGGER_SECONDS:-0.25}" in fleet
    assert "CLOUDBENCH_LAUNCH_STAGGER_SECONDS:-3.5}" in fleet
    # Stack-health FATAL captures the actual death cause (exit code + tail + OOM).
    run = (CLOUD_SCRIPT.parent / "cloudbench-run.sh").read_text()
    assert "stack process exited (rc=$stack_rc)" in run
    assert "last 40 lines of stack log" in run


def test_imessage_relay_heartbeat_wait_aborts_when_remote_driver_is_dead() -> None:
    """A message-person relay cannot establish its backend heartbeat after the
    on-box driver has exited. The launcher must consume the existing data-plane
    /driver-health contract instead of holding fleet cleanup for the full run
    timeout while a local relay polls a permanently dead backend.
    """
    cloud = CLOUD_SCRIPT.read_text()
    relay_wait = cloud[cloud.index("RELAY_HEARTBEAT_WAIT_SECONDS="):]
    relay_wait = relay_wait[: relay_wait.index("# ── 3. Mirror the live dashboard")]

    assert "/driver-health" in relay_wait
    assert "410" in relay_wait
    assert "remote benchmark driver exited before relay heartbeat" in relay_wait
    assert relay_wait.index("/driver-health") < relay_wait.index("sleep 1")


def test_dead_driver_refetches_durable_done_before_infra(tmp_path: Path) -> None:
    """RCA (2026-07-17): a benchmark finished and durably wrote its tokenized
    result + DONE marker, but the collector's preceding bench.log GET failed.
    The next /driver-health probe returned 410, and the collector immediately
    classified the run as dead-driver infra without refetching the durable log.
    Require a bounded reconnect/refetch before that classification so a genuine
    terminal verdict cannot become NORESULT because of a transport race."""
    cloud = CLOUD_SCRIPT.read_text()
    recovery = _extract_fleet_function(cloud, "recover_terminal_marker_after_dead_driver() {")
    ssh_log = tmp_path / "bench.log"
    read_state = tmp_path / "read-count"
    script = f"""
{recovery}
ensure_status_proxy() {{ :; }}
read_bench_log() {{
    count=0
    [ ! -f "$READ_STATE" ] || count="$(cat "$READ_STATE")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$READ_STATE"
    [ "$count" -gt 1 ] || return 1
    printf '%s\n' 'report payload' "$DONE_MARKER exit=1"
}}
SSH_LOG="$1"
READ_STATE="$2"
DONE_MARKER='::CLOUDBENCH-DONE:: token=race-token'
FINISHED=0
BENCH_EXIT=''
CLOUDBENCH_DEAD_DRIVER_FINAL_READ_ATTEMPTS=2
CLOUDBENCH_DEAD_DRIVER_FINAL_READ_SLEEP_SECONDS=0
recover_terminal_marker_after_dead_driver
printf 'finished=%s exit=%s reads=%s\n' "$FINISHED" "$BENCH_EXIT" "$(cat "$READ_STATE")"
"""
    result = subprocess.run(
        ["bash", "-c", script, "recover", str(ssh_log), str(read_state)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "finished=1 exit=1 reads=2" in result.stdout
    assert "recover_terminal_marker_after_dead_driver" in cloud
    dead_branch = cloud.split('if [ "$driver_health" = "dead" ]; then', 1)[1]
    assert "recover_terminal_marker_after_dead_driver" in dead_branch.split("fi", 1)[0]


def test_corrupt_pool_guest_is_quarantined_instead_of_reused(tmp_path: Path) -> None:
    """RCA (2026-07-17): one pooled guest produced SIGBUS from fuser and
    SIGSEGV from dropdb during stack startup. Returning that guest to the pool
    makes the same corrupt runtime eligible for later benchmark runs. Require a
    high-confidence multi-binary signature and durable pool eviction."""
    fleet = FLEET_SCRIPT.read_text()
    signature = _extract_fleet_function(fleet, "pool_machine_guest_corruption_signature() {")
    corrupt = tmp_path / "corrupt.log"
    corrupt.write_text(
        '/repo/scripts/run.sh: line 320: 1104 Bus error fuser "$port/tcp"\n'
        "line 516: 1122 Segmentation fault PGPASSWORD=x dropdb -h localhost\n"
    )
    benign = tmp_path / "benign.log"
    benign.write_text("application worker Segmentation fault\n")
    detected = subprocess.run(
        ["bash", "-c", f'{signature}\npool_machine_guest_corruption_signature "$1"', "sig", str(corrupt)],
        check=False,
    )
    ignored = subprocess.run(
        ["bash", "-c", f'{signature}\npool_machine_guest_corruption_signature "$1"', "sig", str(benign)],
        check=False,
    )
    assert detected.returncode == 0
    assert ignored.returncode != 0
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    assert "record_tainted_claimed_pool_machines" in cleanup
    assert "destroying quarantined pool machine" in cleanup
    assert 'pool_ledger_remove_id "$id"' in cleanup


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
    assert "cloudbench-status-server.py" in cloud
    assert "--directory /data" in cloud
    assert "http.server ${REMOTE_STATUS_PORT} --directory /data" not in cloud
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


def test_live_but_unreachable_status_tunnel_is_replaced(tmp_path: Path) -> None:
    """RCA (2026-07-17): a Fly status-proxy process survived while its lazy
    GraphQL/DNS setup was wedged, so ``kill -0`` reported healthy even though
    every HTTP read failed. The launcher then remained blind to a healthy
    on-box driver and the fleet falsely excluded the task at the barrier.

    Reproduce that exact boundary with a live PID plus an unreachable HTTP
    contract. ``ensure_status_proxy`` must terminate/release/restart the tunnel,
    not accept process survival as transport health.
    """
    cloud = CLOUD_SCRIPT.read_text()
    ensure = _extract_fleet_function(cloud, "ensure_status_proxy() {")
    transport = (
        _extract_fleet_function(cloud, "status_proxy_transport_healthy() {")
        if "status_proxy_transport_healthy() {" in cloud
        else ""
    )
    restarted = tmp_path / "restarted"
    script = f"""set -eu
STATUS_PROXY_PID=$$
LOCAL_STATUS_PORT=61945
REMOTE_STATUS_PORT=8011
REMOTE_STATUS_HOST=machine.internal
OUT_DIR={shlex.quote(str(tmp_path))}
curl() {{ printf 000; return 0; }}
cloudbench_terminate_and_wait() {{ :; }}
release_local_port_lease() {{ :; }}
start_leased_data_plane_proxy() {{
  touch {shlex.quote(str(restarted))}
  printf -v "$6" '%s' "$$"
}}
{transport}
{ensure}
ensure_status_proxy
test -f {shlex.quote(str(restarted))}
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=5)
    assert result.returncode == 0, result.stderr


def test_boot_config_updates_bound_provider_cpu_reservations(tmp_path: Path) -> None:
    """RCA (2026-07-17): the stopped-fleet barrier prevented guest starts but
    still submitted all 37 ``machine update`` operations concurrently. Fly
    temporarily reserves replacement CPU for those config updates, and one
    child exhausted all retries at ``cpu_overcommit_exceeded`` before any
    benchmark reached the synchronized start barrier.

    The shared config phase must cap provider mutations independently of the
    later full-width guest start.
    """
    cloud = CLOUD_SCRIPT.read_text()
    acquire = (
        _extract_fleet_function(cloud, "acquire_boot_config_update_slot() {")
        if "acquire_boot_config_update_slot() {" in cloud
        else ""
    )
    release = (
        _extract_fleet_function(cloud, "release_boot_config_update_slot() {")
        if "release_boot_config_update_slot() {" in cloud
        else ""
    )
    barrier = tmp_path / "config-barrier"
    observed = tmp_path / "observed"
    script = f"""set -eu
CLOUDBENCH_BOOT_CONFIG_BARRIER={shlex.quote(str(barrier))}
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
CLOUDBENCH_BOOT_CONFIG_SLOT_WAIT_SECONDS=5
BOOT_CONFIG_UPDATE_SLOT=""
{acquire}
{release}
mkdir -p "$CLOUDBENCH_BOOT_CONFIG_BARRIER"
for _worker in $(seq 1 12); do
  (
    BOOT_CONFIG_UPDATE_SLOT=""
    acquire_boot_config_update_slot
    find "$CLOUDBENCH_BOOT_CONFIG_BARRIER/update-slots" -mindepth 1 -maxdepth 1 -type d | wc -l >> {shlex.quote(str(observed))}
    sleep 0.1
    release_boot_config_update_slot
  ) &
done
wait
test "$(wc -l < {shlex.quote(str(observed))} | tr -d ' ')" = 12
test "$(sort -nr {shlex.quote(str(observed))} | head -1 | tr -d ' ')" -le 4
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
    assert result.returncode == 0, result.stderr


def test_capacity_guard_reserves_machine_slots_for_boot_config_replacements(tmp_path: Path) -> None:
    """Fly enforces a Machine-count ceiling independently of shared CPU units.

    A config-only update temporarily allocates a replacement Machine.  Admission
    must reserve every allowed in-flight replacement slot before cloning, or a
    CPU-safe workstream can fill the app to the Machine ceiling and then fail
    every boot update before the synchronized start barrier.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = _fleet_primary_shape_helpers(fleet) + "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "available_stopped_pool_machine_count() {",
            "capacity_reserve_slots() {",
        )
    )
    guard = (
        _extract_fleet_function(fleet, "enforce_app_capacity_guard() {")
        if "enforce_app_capacity_guard() {" in fleet
        else ""
    )
    machines = [
        {
            "id": f"active-{index}",
            "state": "started",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for index in range(12)
    ]
    machines.append(
        {
            "id": "warm-source",
            "state": "stopped",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 1}},
        }
    )
    benches = " ".join(f"bench-{index}" for index in range(42))
    script = f"""set -eu
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=({benches})
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
APP=navi-whisper-lux-bench
RUN_ID=test-replacement-boundary
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={'d' * 32}
POOL_IDS_FILE={shlex.quote(str(tmp_path / "no-pool.ids"))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=56
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{support}
{guard}
enforce_app_capacity_guard
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 1, result.stderr
    assert "Machine-count capacity admission denied: 13 app Machines" in result.stderr
    assert "this run's 42 fresh primaries (0 from stopped pool)" in result.stderr
    assert "4 boot-config replacement slots = 59" in result.stderr
    assert "benchmark-app Machine ceiling 56" in result.stderr


def test_capacity_guard_serializes_cross_workspace_reservations(tmp_path: Path) -> None:
    """Two workspaces must not both admit from the same provider snapshot.

    With ten existing Machines, either twenty-benchmark fleet fits by itself
    (10 + 20 primaries + 4 replacement slots = 34), but both fleets together
    peak at 58 and exceed the benchmark app's 56-Machine allocation.  Durable
    host-wide reservations must make exactly one controller lose admission.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = [_fleet_primary_shape_helpers(fleet)]
    for signature in (
        "available_stopped_pool_machine_count() {",
        "capacity_reserve_slots() {",
    ):
        if signature in fleet:
            support.append(_extract_fleet_function(fleet, signature))
    guard = (
        _extract_fleet_function(fleet, "enforce_app_capacity_guard() {")
        if "enforce_app_capacity_guard() {" in fleet
        else ""
    )
    machines = [
        {
            "id": f"active-{index}",
            "state": "started",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for index in range(10)
    ]
    benches = " ".join(f"bench-{index}" for index in range(20))
    worker = tmp_path / "guard-worker.sh"
    worker.write_text(
        f"""#!/usr/bin/env bash
set -u
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=({benches})
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
APP=navi-whisper-lux-bench
RUN_ID="test-$1"
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN="$1"
POOL_IDS_FILE={shlex.quote(str(tmp_path / "no-pool.ids"))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=56
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{''.join(support)}
{guard}
status=0
enforce_app_capacity_guard || status=$?
printf '%s\n' "$status" > "$2"
sleep 1
exit "$status"
"""
    )
    worker.chmod(0o755)
    statuses = [tmp_path / "a.status", tmp_path / "b.status"]
    processes = [
        subprocess.Popen(
            ["bash", str(worker), token, str(status)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for token, status in zip(("a" * 32, "b" * 32), statuses, strict=True)
    ]
    results = [process.communicate(timeout=10) for process in processes]

    observed = sorted(int(status.read_text().strip()) for status in statuses)
    assert observed == [0, 1], results


def test_capacity_guard_does_not_count_available_pool_machines_twice(tmp_path: Path) -> None:
    """Stopped pool Machines already appear in app inventory.

    Four requested benches can claim four available stopped pool Machines, so
    a 50-Machine app projects to 54 only after reserving the four transient
    boot-config replacements.  Treating all four primaries as new would
    incorrectly reject the safe boundary as 58 > 56.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = [_fleet_primary_shape_helpers(fleet)]
    for signature in (
        "available_stopped_pool_machine_count() {",
        "capacity_reserve_slots() {",
    ):
        if signature in fleet:
            support.append(_extract_fleet_function(fleet, signature))
    guard = (
        _extract_fleet_function(fleet, "enforce_app_capacity_guard() {")
        if "enforce_app_capacity_guard() {" in fleet
        else ""
    )
    machines = [
        {
            "id": f"active-{index}",
            "state": "started",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for index in range(46)
    ]
    pool_ids = [f"{index + 1:014x}" for index in range(4)]
    machines.extend(
        {
            "id": machine_id,
            "state": "stopped",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for machine_id in pool_ids
    )
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("\n".join(pool_ids) + "\n")
    benches = " ".join(f"bench-{index}" for index in range(4))
    script = f"""set -u
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=({benches})
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
APP=navi-whisper-lux-bench
RUN_ID=test-pool-boundary
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={'c' * 32}
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=56
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{''.join(support)}
{guard}
enforce_app_capacity_guard
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 0, result.stderr


def test_capacity_guard_reserves_bundled_frontend_shape_and_pool_eligibility(
    tmp_path: Path,
) -> None:
    """Bundled-frontend benches need larger primaries and cannot use the 4GB pool.

    Two bundled tasks plus two normal tasks request 4 + 4 + 2 + 2 shared CPU
    units.  The stopped pool can satisfy only the two normal primaries; treating
    all four benches as default 2x pool-eligible work would under-reserve both
    shared CPU and fresh Machine slots.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = _fleet_primary_shape_helpers(fleet) + "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "available_stopped_pool_machine_count() {",
            "capacity_reserve_slots() {",
        )
    )
    guard = _extract_fleet_function(fleet, "enforce_app_capacity_guard() {")
    machines = [
        {
            "id": f"active-{index}",
            "state": "started",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for index in range(65)
    ]
    pool_ids = [f"{index + 1:014x}" for index in range(4)]
    machines.extend(
        {
            "id": machine_id,
            "state": "stopped",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for machine_id in pool_ids
    )
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("\n".join(pool_ids) + "\n")
    script = f"""set -u
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=(gate-subscription-card-mint agent-payment-test-shop ordinary-a ordinary-b)
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
FLEET_PRIMARY_VM_MEMORY=4096
FLEET_BUNDLED_FRONTEND_VM_SIZE=shared-cpu-4x
FLEET_BUNDLED_FRONTEND_VM_MEMORY=8192
APP=navi-whisper-lux-bench
RUN_ID=test-bundled-primary-capacity
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={'2' * 32}
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=200
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{support}
{guard}
enforce_app_capacity_guard
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 1, result.stderr
    assert "Shared-CPU capacity governor reached: 130 active shared units" in result.stderr
    assert "this run's 4 primaries (12 units) = 142" in result.stderr


def test_capacity_guard_never_subtracts_unclaimable_pool_ids(tmp_path: Path) -> None:
    """Pool admission must use the exact same Machine-ID contract as claim.

    An invalid ledger ID can describe a stopped inventory entry, but
    ``claim_pool_machine`` will skip it and fall back to cloning.  Counting such
    an ID as reusable would under-reserve a physical Machine slot.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = _fleet_primary_shape_helpers(fleet) + "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "available_stopped_pool_machine_count() {",
            "capacity_reserve_slots() {",
        )
    )
    guard = _extract_fleet_function(fleet, "enforce_app_capacity_guard() {")
    machines = [
        {
            "id": f"active-{index}",
            "state": "started",
            "config": {"guest": {"cpu_kind": "shared", "cpus": 2}},
        }
        for index in range(46)
    ]
    invalid_ids = [f"not-hex-{index}" for index in range(4)]
    machines.extend(
        {"id": machine_id, "state": "stopped", "config": {"guest": {"cpu_kind": "shared", "cpus": 2}}}
        for machine_id in invalid_ids
    )
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("\n".join(invalid_ids) + "\n")
    script = f"""set -u
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=(a b c d)
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
APP=navi-whisper-lux-bench
RUN_ID=test-invalid-pool
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={'1' * 32}
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=56
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{support}
{guard}
enforce_app_capacity_guard
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 1, result.stderr
    assert "4 fresh primaries (0 from stopped pool)" in result.stderr


def test_startup_capacity_release_requires_full_requested_width(tmp_path: Path) -> None:
    """A successful subset cannot release a whole-fleet reservation early."""
    fleet = FLEET_SCRIPT.read_text()
    release = _extract_fleet_function(
        fleet, "release_capacity_reservation_after_primary_start_accounted() {"
    )
    output = tmp_path / "only-success"
    output.mkdir()
    (output / "post-config-start.accepted").write_text("abc123\n")
    released = tmp_path / "released"
    script = f"""set -u
CAPACITY_RESERVATION_PUBLISHED=1
CAPACITY_RESERVATION_TOKEN=test-primary
CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS=1
BENCHES=(first second)
CHILD_MACHINE=(abc123)
CHILD_OUT=({shlex.quote(str(output))})
APP=navi-whisper-lux-bench
FLY() {{ printf '%s\n' '[{{"id":"abc123","state":"started"}}]'; }}
capacity_release_reservation() {{ touch {shlex.quote(str(released))}; }}
{release}
release_capacity_reservation_after_primary_start_accounted
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode != 0, result.stderr
    assert not released.exists()


def test_pool_capacity_classification_streams_full_provider_inventory_without_exec_size_limit(
    tmp_path: Path,
) -> None:
    """Provider inventory must remain stdin data in the stopped-pool path too.

    Bash 3.2 preserves an inherited export attribute when ``local`` reuses an
    environment-variable name.  A large local ``machines_json`` would therefore
    be copied into Python's environment and fail before the parser could run.
    """
    fleet = FLEET_SCRIPT.read_text()
    classify = _extract_fleet_function(
        fleet, "available_stopped_pool_machine_count() {"
    )
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("abcd\n")
    script = f"""set -u
PROVISION_POOL=""
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
{classify}
payload="$(python3 -c '
import json, sys
print(json.dumps([{{"id": "abcd", "state": "stopped", "events": ["x" * int(sys.argv[1])]}}]))
' "$(( $(getconf ARG_MAX) + 65536 ))")"
count="$(available_stopped_pool_machine_count "$payload")"
[ "$count" = "1" ]
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={**os.environ, "machines_json": "sentinel"},
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


def test_all_buffered_provider_json_names_are_unexported_before_fleet_execs() -> None:
    """Bash 3.2 must not inherit export attributes for unbounded JSON buffers."""
    fleet = FLEET_SCRIPT.read_text()
    guard = next(
        line for line in fleet.splitlines() if line.startswith("export -n inventory ")
    )

    assert {
        "inventory",
        "machines",
        "machines_json",
        "warm_json",
        "POOL_INVENTORY_JSON",
        "SNAPSHOTS_JSON",
    }.issubset(set(guard.split()))


def test_worker_capacity_reservation_streams_full_provider_inventory_without_exec_size_limit() -> None:
    """Autoscaler admission must parse provider JSON without exporting it."""
    fleet = FLEET_SCRIPT.read_text()
    reserve_worker = _extract_fleet_function(
        fleet, "reserve_worker_machine_slot() {"
    )
    script = f"""set -u
APP=navi-whisper-lux-bench
CLOUDBENCH_APP_MACHINE_CEILING=56
FLY() {{
  python3 -c '
import json, sys
print(json.dumps([{{"id": "abcd", "state": "started", "events": ["x" * int(sys.argv[1])]}}]))
' "$(( $(getconf ARG_MAX) + 65536 ))"
}}
capacity_reserve_slots() {{ printf '%s\n' 'OK 0 0 2 0'; }}
{reserve_worker}
reserve_worker_machine_slot test-worker
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={**os.environ, "inventory": "sentinel"},
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


def test_pool_shape_normalization_unexports_full_provider_inventory_buffers(
    tmp_path: Path,
) -> None:
    """Repeated pool-shape parsing must not leak cached JSON into exec env."""
    fleet = FLEET_SCRIPT.read_text()
    support = "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "pool_machine_shape_from_json() {",
            "normalize_current_pool_shape() {",
        )
    )
    pool_file = tmp_path / "pool.ids"
    pool_file.write_text("abcd\n")
    script = f"""set -u
POOL_IDS_FILE={shlex.quote(str(pool_file))}
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
FLEET_PRIMARY_VM_MEMORY=4096
payload="$(python3 -c '
import json, sys
print(json.dumps([{{
    "id": "abcd",
    "state": "stopped",
    "config": {{"guest": {{"cpu_kind": "shared", "cpus": 2, "memory_mb": 4096}}}},
    "events": ["x" * int(sys.argv[1])],
}}]))
' "$(( $(getconf ARG_MAX) + 65536 ))")"
POOL_INVENTORY_JSON="$payload"
{support}
normalize_current_pool_shape
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={
            **os.environ,
            "inventory": "sentinel",
            "POOL_INVENTORY_JSON": "sentinel",
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


def test_startup_capacity_release_streams_full_provider_inventory_without_exec_size_limit(
    tmp_path: Path,
) -> None:
    """RCA (2026-07-21): epoch 15 reached 42/42 boot configs and starts,
    but the release check exported Fly's full 45-Machine JSON as ``INVENTORY``
    when launching Python. The provider event history made that environment
    exceed macOS ARG_MAX, so Python never ran, the 46-slot startup reservation
    stayed live, and six mandatory dynamic workers were denied.

    Provider inventory is unbounded process data. Exercise the production
    release boundary with a valid inventory larger than this host's exec limit;
    it must still prove all exact primaries started and release the reservation.
    """
    fleet = FLEET_SCRIPT.read_text()
    release = _extract_fleet_function(
        fleet, "release_capacity_reservation_after_primary_start_accounted() {"
    )
    outputs = []
    for index in range(42):
        output = tmp_path / f"bench-{index}"
        output.mkdir()
        (output / "post-config-start.accepted").write_text(f"machine-{index}\n")
        outputs.append(output)
    released = tmp_path / "released"
    benches = " ".join(f"bench-{index}" for index in range(42))
    machine_ids = " ".join(f"machine-{index}" for index in range(42))
    child_outputs = " ".join(shlex.quote(str(output)) for output in outputs)
    script = f"""set -u
CAPACITY_RESERVATION_PUBLISHED=1
CAPACITY_RESERVATION_TOKEN=test-full-inventory
CLOUDBENCH_CAPACITY_START_ACCOUNTING_SECONDS=1
BENCHES=({benches})
CHILD_MACHINE=({machine_ids})
CHILD_OUT=({child_outputs})
APP=navi-whisper-lux-bench
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    python3 -c '
import json, sys
size = int(sys.argv[1])
machines = [{{"id": f"machine-{{index}}", "state": "started"}} for index in range(42)]
machines[0]["events"] = ["x" * size]
print(json.dumps(machines))
' "$(( $(getconf ARG_MAX) + 65536 ))"
    return 0
  fi
  return 1
}}
capacity_release_reservation() {{ touch {shlex.quote(str(released))}; }}
{release}
release_capacity_reservation_after_primary_start_accounted
"""
    result = subprocess.run(
        ["bash", "-c", script],
        env={**os.environ, "inventory": "sentinel", "machines_json": "sentinel"},
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert released.exists()


def test_capacity_reservation_recovers_a_proven_dead_owner(tmp_path: Path) -> None:
    """SIGKILL must not wedge host-wide admission forever.

    A reservation is recoverable only when its same-host PID and exact process
    birth identity are no longer live.  The successor must prune that record
    while holding the admission lock, then publish its own reservation.
    """
    fleet = FLEET_SCRIPT.read_text()
    reserve = _extract_fleet_function(fleet, "capacity_reserve_slots() {")
    root = tmp_path / "reservations-root"
    records = root / "reservations"
    records.mkdir(parents=True)
    dead_token = "e" * 32 + "-primary"
    live_token = "f" * 32 + "-primary"
    (records / dead_token).write_text(
        "version=1\n"
        "app=navi-whisper-lux-bench\n"
        f"host={socket.gethostname()}\n"
        "pid=999999\n"
        "pid_start=Mon Jan  1 00:00:00 2001\n"
        "run_id=dead-owner\n"
        f"token={dead_token}\n"
        "machine_slots=50\n"
        "shared_units=100\n"
        "kind=primary\n"
    )
    script = f"""set -eu
CAPACITY_RESERVATION_ROOT={shlex.quote(str(root))}
APP=navi-whisper-lux-bench
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
RUN_ID=successor
{reserve}
capacity_reserve_slots {live_token} 1 2 56 140 10 20 primary
test ! -e {shlex.quote(str(records / dead_token))}
test -f {shlex.quote(str(records / live_token))}
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("OK ")


def test_autoscaler_worker_clones_take_a_serialized_machine_slot() -> None:
    """Post-start autoscaling must not bypass Machine-count admission."""
    fleet = FLEET_SCRIPT.read_text()
    worker = _extract_fleet_function(fleet, "provision_worker() {")

    assert 'reserve_worker_machine_slot "$worker_capacity_token"' in worker
    assert worker.index("reserve_worker_machine_slot") < worker.index("clone_machine_target")
    assert 'capacity_release_reservation "$worker_capacity_token"' in worker
    assert worker.index("clone_machine_target") < worker.index("capacity_release_reservation")


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
    mirror = cloud[cloud.index('expected_total="${#BENCH_TASKS[@]}"') : cloud.index("DASHBOARD_MIRROR_PID=$!")]

    assert 'if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then' in mirror
    assert "/repo/.context/cloudbench/report-card.json" in mirror
    assert "curl -fsS --max-time 6" in mirror
    assert "30 control-plane sessions/second" in mirror


def test_boot_supervisor_keeps_data_plane_alive_after_done() -> None:
    """A Fly Machine must not stop between the on-box DONE write and the
    controller's next data-plane poll, or a real verdict becomes NORESULT."""
    boot = (CLOUD_SCRIPT.parent / "cloudbench-boot.sh").read_text()

    assert 'DRIVER="${CLOUDBENCH_RUN_SCRIPT:-/cloudbench-run.sh}"' in boot
    assert 'bash "$DRIVER" >> "$LOG" 2>&1' in boot
    assert 'exec bash "$REPO/scripts/cloudbench-run.sh"' not in boot
    assert "holding for controller collection" in boot
    assert boot.rstrip().endswith("exec sleep infinity")


def test_claimed_pool_teardown_is_parallel_with_shared_inventory() -> None:
    """Thirty serial stop-and-list loops add N teardown latency and API load."""
    fleet = FLEET_SCRIPT.read_text()
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    claimed = cleanup[cleanup.index("pending_pool_ids=") : cleanup.index('if [ "$FLEET_REGISTRY_PUBLISHED"')]

    assert 'machine stop "$id"' in claimed
    assert "CLOUDBENCH_POOL_STOP_REQUEST_TIMEOUT" in claimed
    assert 'stop_pids+=("$!")' in claimed
    assert 'FLY machines list -a "$APP" --json' in claimed
    assert 'pool_machine_state "$id"' not in claimed
    assert "CLOUDBENCH_POOL_STOP_REQUEST_ATTEMPTS" in claimed
    assert "shared inventory" in claimed


def test_fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown(
    tmp_path: Path,
) -> None:
    """Cleanup must retain enough host space to run Fly/asdf after mid-run ENOSPC."""
    fleet = FLEET_SCRIPT.read_text()
    reserve = _extract_fleet_function(fleet, "reserve_cleanup_disk_space() {")
    release = _extract_fleet_function(fleet, "release_cleanup_disk_reserve() {")
    reserve_path = tmp_path / "cleanup-disk-reserve"
    script = f"""set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
CLOUDBENCH_CLEANUP_DISK_RESERVE_MB=1
{reserve}
{release}
reserve_cleanup_disk_space
test "$(wc -c < "$CLEANUP_DISK_RESERVE_FILE" | tr -d ' ')" = 1048576
provider_teardown() {{ test ! -e "$CLEANUP_DISK_RESERVE_FILE"; }}
if provider_teardown; then exit 41; fi
release_cleanup_disk_reserve
provider_teardown
"""
    result = subprocess.run(
        ["bash", "-c", script, "reserve", str(reserve_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not reserve_path.exists()

    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    release_call = "release_cleanup_disk_reserve"
    assert cleanup.index(release_call) < cleanup.index("cloudbench_terminate_and_wait")
    assert cleanup.index(release_call) < cleanup.index("reap_registry_clones")

    recovery = _extract_fleet_function(fleet, "reconcile_stale_fleet_registries() {")
    stale_release = 'release_cleanup_disk_reserve "$registry/cleanup-disk-reserve"'
    assert recovery.index(stale_release) < recovery.index('reap_registry_clones "$registry" stale')


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
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=6)
    assert "benchmark heartbeat" in result.stdout
    assert "rc=7" in result.stdout


def test_isolated_backend_production_only_cloud_route_targets_production() -> None:
    """A canonical production-only task must never be sent to the local box.

    Execute the driver's real BENCH_ARGS construction block in isolation so the
    regression measures the exact boundary that feeds run_benchmark.py without
    booting a Fly guest or weakening the harness's production-only protection.
    """
    driver = DRIVER_SCRIPT.read_text()
    command_builder = "BENCH_ARGS=()" + driver.split("\nBENCH_ARGS=()", 1)[1].split(
        'log "running benchmark:', 1
    )[0]
    script = f"""set -euo pipefail
REPO_DIR={shlex.quote(str(ROOT))}
BENCHMARK_TARGET_SCRIPT="$REPO_DIR/scripts/cloudbench-benchmark-target.py"
BENCH_TASK_LIST=(agent-payment-production-abandonment)
BACKEND_PORT=3001
BENCH_MAX_CONCURRENCY=5
BENCH_SIMULATE=0
{command_builder}
printf '%s\\n' "${{BENCH_ARGS[@]}}"
"""

    result = subprocess.run(
        ["bash", "-c", script], text=True, capture_output=True, check=False
    )

    assert result.returncode == 0, result.stderr
    assert "--prod" in result.stdout.splitlines(), result.stdout
    assert "--port" not in result.stdout.splitlines(), result.stdout


def test_production_only_cloud_route_clears_local_frontend_override() -> None:
    driver = DRIVER_SCRIPT.read_text()

    assert (
        "if [ '$BENCH_TARGET_MODE' = 'prod' ]; then\n"
        "  unset BENCHMARK_FRONTEND_URL"
    ) in driver


def test_cloud_dashboard_mirror_does_not_override_benchmark_frontend_url() -> None:
    """Dashboard links may use the localhost mirror, but task prompts must not.

    Cloud browser agents run outside the controller's localhost namespace. If
    dashboard mode exports BENCHMARK_FRONTEND_URL=http://localhost:<mirror>, the
    {frontend_url} prompt placeholder points browser tasks at an unreachable URL
    even though the child stack has already published a public tunnel.
    """
    cloud = CLOUD_SCRIPT.read_text()

    assert "BENCHMARK_FRONTEND_URL=http://localhost:$LOCAL_DASH_PORT" not in cloud
    assert "BENCHMARK_REPORT_FRONTEND_URL=http://localhost:$LOCAL_DASH_PORT" in cloud
    assert "BENCHMARK_REPORT_FRONTEND_URL" in DRIVER_SCRIPT.read_text()


def test_cloud_driver_exports_reachable_public_frontend_before_start_barrier() -> None:
    """Payment browser tasks must not start with localhost in {frontend_url}.

    The stack can report backend/worker health before the public tunnel manifest
    is usable. Browser agents run outside the Fly guest's localhost namespace, so
    the driver must block before the synchronized start barrier and export the
    reachable public frontend URL into run_benchmark.py.
    """
    driver = DRIVER_SCRIPT.read_text()

    assert "manifest_public_frontend_url()" in driver
    assert 'curl -fsS --max-time 5 "$public_url/test_payment"' in driver
    assert 'BENCHMARK_FRONTEND_URL="$public_url"' in driver
    assert "export BENCHMARK_FRONTEND_URL" in driver
    assert driver.index("wait_for_benchmark_frontend_url || finish 1") < driver.index(
        "synchronized start barrier ready"
    )


def test_cloud_test_payment_tasks_launch_bundled_frontend_with_supabase_env() -> None:
    """Cloud test-payment tasks must not expose Vite's dev module graph."""
    driver = DRIVER_SCRIPT.read_text()

    assert "BENCH_NEEDS_BUNDLED_FRONTEND=0" in driver
    assert "gate-subscription-card-mint|gate-kyc-card-mint" in driver
    assert "BENCHMARK_BUNDLED_FRONTEND=true" in driver
    assert 'cloudbench_env_value "$REPO_DIR/back-end/.env" SUPABASE_URL' in driver
    assert 'STACK_ENV+=("VITE_SUPABASE_URL=$FRONTEND_SUPABASE_URL")' in driver
    assert 'STACK_ENV+=("VITE_SUPABASE_ANON_KEY=$FRONTEND_SUPABASE_ANON_KEY")' in driver


def test_cloud_stack_failure_surfaces_frontend_build_log() -> None:
    driver = DRIVER_SCRIPT.read_text()

    assert "$CONTEXT_DIR/logs/frontend.log" in driver
    assert "front-end/frontend-logs.log" in driver
    assert "last 80 lines of frontend log" in driver


def test_production_only_cloud_route_rejects_mixed_target_batches() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench-benchmark-target.py"),
            str(ROOT / "agents/benchmarks/tasks.json"),
            "3001",
            "agent-payment-production-abandonment",
            "single-creator-arm",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "cannot mix production-only and isolated-backend tasks" in result.stderr


def test_production_only_cloud_route_keeps_ordinary_tasks_on_isolated_backend() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench-benchmark-target.py"),
            str(ROOT / "agents/benchmarks/tasks.json"),
            "3001",
            "single-creator-arm",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["local", "--port", "3001"]


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
    assert "release_local_port_lease" in _extract_fleet_function(cloud, "start_leased_data_plane_proxy() {")
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
    assert 'PORT_LEASE_HELPER="${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts}/cloudbench-port-lease.py"' in cloud
    lease_root = ROOT / ".context" / f"port-lease-test-{os.getpid()}"
    lease_root.mkdir(parents=True, exist_ok=True)
    script = f"""set -eu
PORT_LEASE_ROOT="$1"
PORT_LEASE_NONCE="$$-$RANDOM"
PORT_LEASE_HELPER="$3"
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
        ["bash", "-c", script, "lease", str(lease_root), "42000", str(PORT_LEASE_SCRIPT)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    second = subprocess.Popen(
        ["bash", "-c", script, "lease", str(lease_root), "42000", str(PORT_LEASE_SCRIPT)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    first_out, first_err = first.communicate(timeout=5)
    second_out, second_err = second.communicate(timeout=5)
    assert first.returncode == 0, first_err
    assert second.returncode == 0, second_err
    assert first_out.strip() != second_out.strip()
    assert not any(path.name.isdigit() for path in lease_root.iterdir())


def test_fleet_barrier_reads_the_authoritative_rotated_status_port(tmp_path: Path) -> None:
    """A recovered status tunnel may rotate after its first published log line.

    Barrier release must read the atomic port handoff, not stale console output.
    """
    fleet = FLEET_SCRIPT.read_text()
    release = _extract_fleet_function(fleet, "release_start_barrier() {")
    child_out = tmp_path / "child"
    child_out.mkdir()
    (child_out / "fleet-child.log").write_text(
        "status proxy: 127.0.0.1:60944 -> fly:8011\nsynchronized start barrier ready: rotation-test\n"
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
wait_for_mandatory_autoscaler_startup() {{ return 0; }}
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
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=5)
    assert result.returncode == 0, result.stderr
    assert observed_url.read_text().strip() == "http://127.0.0.1:61945/release"


def test_autoscaler_finalization_budget_covers_worker_provisioning_contract() -> None:
    """Child completion must not outrun capacity that was already committed.

    A worker can legitimately consume every bounded staging attempt and then
    its readiness timeout.  The autoscaler/controller terminalization ceiling
    therefore has to be derived from those same limits instead of racing them
    with an unrelated fixed timeout.
    """
    fleet = FLEET_SCRIPT.read_text()
    normalized_fleet = " ".join(fleet.replace("\\\n", " ").split())
    assert 'WORKER_STAGE_ATTEMPTS="${CLOUDBENCH_WORKER_STAGE_ATTEMPTS:-40}"' in fleet
    assert 'WORKER_READY_TIMEOUT="${CLOUDBENCH_WORKER_READY_TIMEOUT:-300}"' in fleet
    assert 'WORKER_STAGE_ATTEMPT_WALL_SECONDS="120"' in fleet
    assert (
        "WORKER_STAGE_ATTEMPTS * WORKER_STAGE_ATTEMPT_WALL_SECONDS "
        "+ WORKER_READY_TIMEOUT + 60"
    ) in normalized_fleet
    assert (
        'AUTOSCALER_FINALIZATION_WAIT_SECONDS="${CLOUDBENCH_AUTOSCALER_'
        'FINALIZATION_WAIT_SECONDS:-}"'
    ) in fleet

    provision = _extract_fleet_function(fleet, "provision_worker() {")
    assert 'stage_attempts="$WORKER_STAGE_ATTEMPTS"' in provision
    assert 'worker_ready_timeout="$WORKER_READY_TIMEOUT"' in provision
