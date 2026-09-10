import base64
import hashlib
import importlib.util
import inspect
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

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
FLEET_SCRIPT = Path(os.environ.get("CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST", ROOT / "scripts" / "run-bench-fleet"))
FLEET_CANARY_SCRIPT = ROOT / "scripts" / "run-fleet-infra-canary"
FLEET_CANARY_PREFLIGHT_SCRIPT = ROOT / "scripts" / "cloudbench-infra-canary-preflight.py"
CLOUD_SCRIPT = ROOT / "scripts" / "run-bench-cloud"
HUB_POLLER_SCRIPT = ROOT / "scripts" / "run-bench-hub-poller"
CLOUDBENCH_RESULT_SCRIPT = ROOT / "scripts" / "cloudbench_result.py"
EXECUTION_PROVENANCE_SCRIPT = ROOT / "scripts" / "cloudbench_execution_provenance.py"
AGENT_LINK_SERVER = ROOT / "agents" / "benchmarks" / "agent_link_server.py"
PORT_LEASE_SCRIPT = ROOT / "scripts" / "cloudbench-port-lease.py"
SCRIPT_SNAPSHOT_OWNER = ROOT / "scripts" / "cloudbench-script-snapshot.py"
EXACT_SESSION_CLEANUP_SCRIPT = ROOT / "scripts" / "cloudbench-exact-session-cleanup.py"
GUEST_RECOVERY_SCRIPT = ROOT / "scripts" / "cloudbench-guest-recovery.py"
PREDEPLOY_SCRIPT = ROOT / "scripts" / "run-predeploy-cloud"
TASKS_JSON = ROOT / "agents" / "benchmarks" / "tasks.json"
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
    budget_lib = SEED_BUDGET_SCRIPT.read_text()
    helper = _extract_fleet_function(budget_lib, "cloudbench_seed_dump_restorable() {") + _extract_fleet_function(
        budget_lib, "stack_wait_budget_seconds() {"
    )
    seed_dump = tmp_path / "victoria-seed.dump"
    repo = tmp_path / "repo"
    schema = repo / "back-end" / "prisma" / "schema.prisma"
    schema.parent.mkdir(parents=True)
    schema.write_text("model User { id String @id }\n")

    def budget(*, cold: bool, env: dict[str, str] | None = None) -> int:
        if not cold:
            seed_dump.write_bytes(b"valid seed")
            seed_dump.with_suffix(".dump.schemahash").write_text(hashlib.sha1(schema.read_bytes()).hexdigest())
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
    assert (
        budget(
            cold=True,
            env={
                "CLOUDBENCH_STACK_WAIT_SECONDS": "120",
                "CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS": "321",
            },
        )
        == 321
    )


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

    assert 'CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS="$FIRST_RUN_STACK_WAIT_SECONDS"' in fleet
    cold_default_pattern = re.compile(r"CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS:-([0-9]+)")
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
    assert '"$START_BARRIER_WAIT_SECONDS" -lt "$PER_BOX_BARRIER_WAIT_SECONDS"' in fleet
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
    helper = _extract_fleet_function(cloud, "boot_update_with_capacity_recovery() {")
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
    budget = _extract_fleet_function(SEED_CACHE_LIB.read_text(), "backend_ready_budget() {")
    helper = budget + "\n" + _extract_fleet_function(stack, "isolated_backend_ready_attempts() {")

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


def test_predeploy_cloud_runner_selects_via_predeploy_selector() -> None:
    """Cloud --list must match select_predeploy_benches(surface=cloud)."""
    from benchmarks.select_predeploy_benches import select_predeploy_benches

    result = subprocess.run(
        ["bash", str(PREDEPLOY_SCRIPT), "--list"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    expected = select_predeploy_benches(
        catalog=TASKS_JSON,
        changed_files=[],
        surface="cloud",
        cap=20,
        repo_root=ROOT,
    ).selected
    assert result.stdout.splitlines() == expected
    assert "select_predeploy_benches.py" in PREDEPLOY_SCRIPT.read_text()


def test_cloud_hub_poller_supervises_fleet_until_final_bundle(tmp_path: Path) -> None:
    """A Hub poller must not inherit the interactive fleet's detach default."""
    request_id = f"poller-foreground-{os.getpid()}-{tmp_path.name}"
    task_name = "poller-foreground-contract"
    observed: list[tuple[str, str, dict]] = []

    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")

        def do_GET(self) -> None:
            if self.path.startswith("/api/benchmarks/run-requests?status=queued"):
                self._json(
                    200,
                    {
                        "requests": [
                            {
                                "id": request_id,
                                "taskNames": [task_name],
                                "simOn": [],
                                "scope": "",
                                "createdAt": "2026-07-23T00:00:00Z",
                            }
                        ]
                    },
                )
                return
            self._json(404, {})

        def do_PATCH(self) -> None:
            body = self._body()
            observed.append(("PATCH", self.path, body))
            self._json(200, {"ok": True})

        def do_POST(self) -> None:
            body = self._body()
            observed.append(("POST", self.path, body))
            self._json(201, {"run": body})

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    runner = tmp_path / "run-bench"
    runner_args = tmp_path / "runner.args"
    runner.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        'printf "%s\\n" "$@" > "$RUNNER_ARGS_LOG"\n'
        'case " $* " in *" --wait "*) ;; *) exit 44 ;; esac\n'
        'mkdir -p "$BENCHMARK_CONTEXT_DIR"\n'
        'python3 - "$BENCHMARK_CONTEXT_DIR/run.json" "$TASK_NAME" <<\'PY\'\n'
        "import json, sys\n"
        "json.dump({\n"
        '    "run_id": "fixture-run",\n'
        '    "suite": "fixture",\n'
        '    "tasks": [{"name": sys.argv[2], "status": "passed", "passed": True}],\n'
        "}, open(sys.argv[1], 'w'))\n"
        "PY\n"
    )
    runner.chmod(0o755)

    local_artifact_root = ROOT / "agents" / ".context" / "benchmarks" / f"hub-{request_id}"
    controller_artifact_root = ROOT / ".context" / "hub-poller-runs" / request_id
    controller_log = ROOT / ".context" / f"hub-poller-run-{request_id}.log"
    env = os.environ.copy()
    env.update(
        {
            "BACKEND_API_KEY": "test-key",
            "HUB_URL": f"http://127.0.0.1:{server.server_address[1]}",
            "RUN_BENCH_BIN": str(runner),
            "RUNNER_ARGS_LOG": str(runner_args),
            "TASK_NAME": task_name,
            "HUB_SKIP_CATALOG_EXPORT": "1",
            "HUB_SNAPSHOT_INTERVAL_SECONDS": "0.1",
            "HUB_UPLOAD_SPOOL_DIR": str(tmp_path / "spool"),
        }
    )
    try:
        result = subprocess.run(
            ["bash", str(HUB_POLLER_SCRIPT), "--once"],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
            check=False,
        )
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(local_artifact_root, ignore_errors=True)
        shutil.rmtree(controller_artifact_root, ignore_errors=True)
        controller_log.unlink(missing_ok=True)

    assert result.returncode == 0, result.stdout + result.stderr
    observed_runner_args = runner_args.read_text().splitlines()
    assert "--wait" in observed_runner_args
    assert "--foreground" not in observed_runner_args
    assert any(method == "POST" and path == "/api/benchmarks/runs" for method, path, _body in observed), observed
    terminal = [
        body
        for method, path, body in observed
        if method == "PATCH"
        and path == f"/api/benchmarks/run-requests/{request_id}"
        and body.get("action") in {"complete", "fail"}
    ]
    assert terminal == [{"action": "complete", "run_id": f"hub-{request_id}"}]


def test_predeploy_local_runner_selects_via_predeploy_selector() -> None:
    """Local --list must match select_predeploy_benches(surface=local)."""
    from benchmarks.select_predeploy_benches import select_predeploy_benches

    result = subprocess.run(
        ["bash", str(PREDEPLOY_LOCAL_SCRIPT), "--list"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    expected = select_predeploy_benches(
        catalog=TASKS_JSON,
        changed_files=[],
        surface="local",
        cap=20,
        repo_root=ROOT,
    ).selected
    assert result.stdout.splitlines() == expected
    assert "select_predeploy_benches.py" in PREDEPLOY_LOCAL_SCRIPT.read_text()
    assert "PREDEPLOY_BENCH_CAP" in PREDEPLOY_LOCAL_SCRIPT.read_text()


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


def test_cloudbench_wrappers_require_strict_pass_without_claude_credential_skip() -> None:
    """Fleet/cloud must not count Claude Code credential SKIPs as PASS.

    The opt-in flag remains on cloudbench_result.py for explicit callers, but
    the daily/cloud wrappers must stay strict so missing Claude Code tokens
    surface as failures (INFRA), not green SKIPs.
    """
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()

    cloud_validation = cloud.split('"$CLOUDBENCH_RESULT_SCRIPT" "$RUN_OUT"', 1)[1].split("then", 1)[0]
    assert "--require-pass" in cloud_validation
    assert "--allow-claude-code-credential-skip" not in cloud_validation
    assert '"--allow-claude-code-credential-skip"' not in fleet


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
    assert "select_predeploy_benches.py" in PREDEPLOY_LOCAL_SCRIPT.read_text()
    assert "PREDEPLOY_BENCH_CAP" in PREDEPLOY_LOCAL_SCRIPT.read_text()
    assert "select_predeploy_benches" in step or "category floor" in step.lower() or "hard cap" in step.lower()
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
    gate_normalized = " ".join(gate.split())
    assert "bash scripts/tests/cloudbench-env.test.sh" in gate
    assert "bash scripts/tests/cloudbench-multi-workstream.test.sh" in gate
    assert "bash scripts/tests/seed-dump-toolchain.test.sh" in gate
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
    assert "fleet_shared_patch_remains_authoritative_until_transport_selection" in gate
    assert "fleet_patch_packages_clean_unpushed_head_from_fetchable_base" in gate
    assert "declared_patch_payload_cannot_be_missing_or_empty" in gate
    assert "empty_local_patch_cleanup_is_nounset_safe" in gate
    assert "autoscaled_worker_failure_publishes_durable_failure_marker" in gate
    assert "autoscaler_scale_down_cancels_pending_worker" in gate
    assert "fleet_registry_release_id_is_idempotent_with_other_records" in gate
    assert "refresh_deps_tracks_exact_created_snapshot" in gate
    assert "exact_volume_ownership_survives_delayed_visibility_and_failed_delete" in gate
    assert "cloud_agentcard_payment_tasks_provide_onboarding_callback_env" in gate
    assert "must never pause for human approval" in gate_normalized
    assert "Operational gate maintenance is pre-authorized" in deploy


def test_cloud_patch_includes_tracked_and_untracked_changes() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    fleet_normalized = " ".join(line.strip().rstrip("\\").strip() for line in fleet.splitlines())

    cloud_normalized = " ".join(line.strip().rstrip("\\").strip() for line in cloud.splitlines())

    # Both controllers build their payload through the one shared helper, so the
    # launch gate can never disagree with what the generator actually emits.
    assert (
        'cloudbench_prepare_workspace_patch "$ROOT_DIR" HEAD "$_candidate_patch" '
        '"$ROOT_DIR/scripts/create-worktree-patch.sh"' in cloud_normalized
    )
    assert (
        'cloudbench_prepare_workspace_patch "$ROOT_DIR" "$BENCH_REF" "$FLEET_PATCH_FILE" '
        '"$ROOT_DIR/scripts/create-worktree-patch.sh"' in fleet_normalized
    )
    assert (
        '[ "${CLOUDBENCH_SKIP_LOCAL_PATCH:-0}" != "1" ] && { '
        '[ "$REQUESTED_BENCH_REF" != "$BENCH_REF" ] '
        '|| cloudbench_worktree_has_changes "$ROOT_DIR"; }; then' in fleet_normalized
    )
    assert "cloudbench_fetchable_ref" in fleet
    # LOCAL_PATCH_FILE keeps exactly one initializer: it is only ever assigned
    # once a real, non-empty payload was produced.
    assert cloud.count('LOCAL_PATCH_FILE=""') == 1
    assert cloud.count('_local_patch_rc" -eq "$CLOUDBENCH_PATCH_NO_DELTA"') == 1
    assert cloud.count('fleet_patch_rc" -eq "$CLOUDBENCH_PATCH_NO_DELTA"') == 0
    assert fleet.count('fleet_patch_rc" -eq "$CLOUDBENCH_PATCH_NO_DELTA"') == 1
    # A genuinely broken generation must still abort both controllers.
    assert "could not create the local workspace patch" in cloud
    assert "could not create the fleet local workspace patch" in fleet
    assert cloud.count("STAGED_LOCAL_FILES=()") == 1
    assert '[ "$REQUESTED_BENCH_REF" != "$BENCH_REF" ]' in fleet
    clone_definition = fleet.index("clone_machine_target() {")
    provision_branch = fleet.index('if [ -n "$PROVISION_POOL" ]; then', clone_definition)
    assert fleet.index("worker_ledger_lock_acquire() {") < clone_definition
    assert clone_definition < provision_branch


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


def test_fleet_patch_packages_clean_unpushed_head_from_fetchable_base(
    tmp_path: Path,
) -> None:
    """A clean local commit still needs a patch when guests can fetch only its base."""
    fleet = FLEET_SCRIPT.read_text()
    patch_setup = fleet.split('FLEET_PATCH_FILE=""', 1)[1].split("_machine_priv_ip() {", 1)[0]
    repo = tmp_path / "repo"
    checkout = tmp_path / "checkout"
    output_patch = tmp_path / "fleet.patch"
    (repo / "scripts").mkdir(parents=True)
    patch_script = repo / "scripts/create-worktree-patch.sh"
    patch_script.write_text(WORKTREE_PATCH_SCRIPT.read_text())
    patch_script.chmod(0o755)
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "bench@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Bench"], check=True)
    (repo / "tracked.txt").write_text("base\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "base"], check=True, capture_output=True)
    base = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    (repo / "tracked.txt").write_text("clean unpushed commit\n")
    subprocess.run(["git", "-C", str(repo), "commit", "-am", "local"], check=True, capture_output=True)
    local = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()

    script = f"""set -euo pipefail
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
ROOT_DIR={shlex.quote(str(repo))}
BENCH_REF={shlex.quote(base)}
REQUESTED_BENCH_REF={shlex.quote(local)}
CLOUDBENCH_SKIP_LOCAL_PATCH=0
cloudbench_worktree_has_changes() {{ return 1; }}
FLEET_PATCH_FILE=""
{patch_setup}
test -s "$FLEET_PATCH_FILE"
cp "$FLEET_PATCH_FILE" {shlex.quote(str(output_patch))}
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr

    subprocess.run(["git", "clone", str(repo), str(checkout)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(checkout), "checkout", base], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(checkout), "apply", "--binary", str(output_patch)],
        check=True,
        capture_output=True,
    )
    assert (checkout / "tracked.txt").read_text() == "clean unpushed commit\n"


def test_fleet_launch_survives_a_ledger_only_unpushed_head(tmp_path: Path) -> None:
    """/descend commits its append-only timing ledger before every sync, so a
    descent from a clean branch has exactly one unpushed commit touching only
    agents/benchmarks/history/*.jsonl. The fleet gate fired on "HEAD != base"
    while create-worktree-patch.sh excludes those ledgers, so the patch came out
    empty and the controller aborted every bench (2026-07-27, antibot slice):
    "could not create the fleet local workspace patch". Nothing to ship must run
    the base ref instead of killing the fleet.
    """
    fleet = FLEET_SCRIPT.read_text()
    patch_setup = fleet.split('FLEET_PATCH_FILE=""', 1)[1].split("_machine_priv_ip() {", 1)[0]
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "agents/benchmarks/history").mkdir(parents=True)
    patch_script = repo / "scripts/create-worktree-patch.sh"
    patch_script.write_text(WORKTREE_PATCH_SCRIPT.read_text())
    patch_script.chmod(0o755)
    ledger = repo / "agents/benchmarks/history/descend_steps.jsonl"
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "bench@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Bench"], check=True)
    (repo / "tracked.txt").write_text("base\n")
    ledger.write_text('{"run":"a"}\n')
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "base"], check=True, capture_output=True)
    base = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()

    # The only unpushed commit is the descend timing ledger.
    ledger.write_text('{"run":"a"}\n{"run":"b"}\n')
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-am", "chore(descend): timing rows"],
        check=True,
        capture_output=True,
    )
    local = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    assert local != base

    script = f"""set -euo pipefail
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
ROOT_DIR={shlex.quote(str(repo))}
BENCH_REF={shlex.quote(base)}
REQUESTED_BENCH_REF={shlex.quote(local)}
CLOUDBENCH_SKIP_LOCAL_PATCH=0
cloudbench_worktree_has_changes() {{ return 1; }}
FLEET_PATCH_FILE=""
{patch_setup}
# The launch must continue with no declared patch payload.
[ -z "$FLEET_PATCH_FILE" ] || {{ echo "declared a patch for a ledger-only delta" >&2; exit 3; }}
[ -z "$FLEET_PATCH_SHA256" ] || {{ echo "fingerprinted an undeclared patch" >&2; exit 4; }}
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, f"stdout={result.stdout} stderr={result.stderr}"
    assert "no shippable workspace delta" in result.stdout


def test_boot_launch_wires_ipv6_status_server_and_driver_health() -> None:
    boot = BOOT_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    assert "cloudbench-status-server.py" in boot
    assert "cloudbench-driver.pid" in boot
    assert "cloudbench-driver.state" in boot
    assert 'python3 -m http.server "$STATUS_PORT"' not in boot
    assert '--file-local "/cloudbench-status-server.py=' in cloud
    assert "--env CLOUDBENCH_STATUS_SERVER_SCRIPT=/cloudbench-status-server.py" in cloud
    assert "export CLOUDBENCH_STATUS_SERVER_SCRIPT=/data/cloudbench-status-server.py" in cloud
    restart = driver[
        driver.index("# Replace the bootstrap read-only") : driver.index("# ── 2. Decode injected secrets")
    ]
    assert 'python3 "$STATUS_SERVER_SCRIPT"' in restart
    assert '--run-token "${CLOUDBENCH_RUN_TOKEN:-}"' in restart
    assert '--file-local "/cloudbench-seed-budget.sh=$CLOUDBENCH_GUEST_SEED_BUDGET_LIB"' in cloud
    assert '--env "CLOUDBENCH_SEED_BUDGET_LIB=/cloudbench-seed-budget.sh"' in cloud
    terminal = boot[boot.index('wait "$driver_pid"') :]
    assert terminal.index("driver exited rc=%s; holding for controller collection") < terminal.index(
        "publish_driver_state exited"
    )


def test_real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack(
    tmp_path: Path,
) -> None:
    """Execute boot -> driver trap -> runner cancellation, not extracted helpers."""
    import urllib.error
    import urllib.request

    data_dir = tmp_path / "data"
    repo = data_dir / "repo"
    fake_bin = tmp_path / "bin"
    controls = tmp_path / "controls"
    for directory in (
        repo / ".git",
        repo / "agents/benchmarks",
        repo / "agents/venv/bin",
        repo / "back-end",
        repo / "scripts",
        data_dir / "world-model/models/test-model",
        data_dir / "cloudbench-cache",
        fake_bin,
        controls,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    def write_executable(path: Path, content: str) -> None:
        path.write_text(content)
        path.chmod(0o755)

    status_pid_file = tmp_path / "status.pid"
    delete_marker = tmp_path / "delete.confirmed"
    status_wrapper = controls / "status-wrapper.py"
    status_wrapper.write_text(
        "import os, runpy\n"
        "from pathlib import Path\n"
        "Path(os.environ['CLOUDBENCH_TEST_STATUS_PID_FILE']).write_text(f'{os.getpid()}\\n')\n"
        f"runpy.run_path({str(STATUS_SERVER_SCRIPT)!r}, run_name='__main__')\n"
    )
    write_executable(
        fake_bin / "pkill",
        """#!/usr/bin/env bash
set -u
case "$*" in
  *cloudbench-status-server.py*)
    if [ -s "$CLOUDBENCH_TEST_STATUS_PID_FILE" ]; then
      pid="$(cat "$CLOUDBENCH_TEST_STATUS_PID_FILE")"
      kill "$pid" 2>/dev/null || true
    fi
    ;;
esac
exit 0
""",
    )
    write_executable(
        fake_bin / "gosu",
        """#!/usr/bin/env bash
set -eu
shift
exec "$@"
""",
    )
    for command in ("git", "pg_ctlcluster", "pg_isready", "service", "su", "find", "chown"):
        write_executable(fake_bin / command, "#!/usr/bin/env bash\nexit 0\n")
    write_executable(
        fake_bin / "pg_lsclusters",
        "#!/usr/bin/env bash\nprintf '15 main 5432 online postgres /tmp /tmp\\n'\n",
    )
    write_executable(fake_bin / "curl", "#!/usr/bin/env bash\nexit 0\n")

    write_executable(
        repo / "scripts/run.sh",
        """#!/usr/bin/env bash
set -u
mkdir -p "$BENCHMARK_CONTEXT_DIR"
printf '{"status":"running"}\n' > "$BENCHMARK_CONTEXT_DIR/services.json"
trap 'exit 0' TERM INT
while :; do sleep 1; done
""",
    )
    runner_wrapper = repo / "agents/benchmarks/run_benchmark.py"
    runner_wrapper.write_text(
        f"""import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, {str(ROOT / "agents")!r})
import benchmarks.run_benchmark as runner


async def fake_main_async(_args):
    task = runner.get_task_by_name("parallel-tool-calls")
    task.tags = []

    async def return_none(*_args, **_kwargs):
        return None

    async def create_agent(*_args, **_kwargs):
        return "root-agent"

    async def subscribe(*_args, **_kwargs):
        return "fixture"

    async def get_tree(*_args, **_kwargs):
        return []

    async def poll_forever(*_args, **_kwargs):
        await asyncio.Event().wait()

    async def get_agent(*_args, **_kwargs):
        return {{"agent": {{"status": "RUNNING", "progress": 0}}, "messages": []}}

    async def collect_logs(*_args, **_kwargs):
        return {{"messages": []}}

    async def finalize(*_args, **_kwargs):
        return None, None

    async def headers():
        return {{"X-API-Key": "fixture"}}

    class Response:
        status_code = 204

    class Client:
        def __init__(self, timeout):
            assert timeout == 30

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def delete(self, _url, *, headers):
            assert headers == {{"X-API-Key": "fixture"}}
            Path(os.environ["CLOUDBENCH_TEST_DELETE_MARKER"]).write_text("204\\n")
            return Response()

    runner.create_agent = create_agent
    runner.subscribe_supabase_realtime_agent = subscribe
    runner.get_agent_tree = get_tree
    runner.post_world_model_update_events = return_none
    runner.archive_agent_start = return_none
    runner.poll_agent = poll_forever
    runner.get_agent = get_agent
    runner.collect_logs = collect_logs
    runner.finalize_archive_and_score_world_model = finalize
    runner.ensure_payment_lifecycle_cleanup = return_none
    runner._apply_live_fixtures = return_none
    runner._restore_live_fixture_scenarios_async = return_none
    runner._api_headers = headers
    runner.httpx.AsyncClient = Client
    await runner.run_single_task(
        "http://127.0.0.1:39999",
        task,
        keep_failed_agents=True,
    )


runner.main_async = fake_main_async
runner.main()
"""
    )
    write_executable(
        repo / "agents/venv/bin/python",
        f"""#!/usr/bin/env bash
set -eu
if [ "${{1:-}}" = "-c" ]; then
  exit 10
fi
exec {str(ROOT / "agents/venv/bin/python")!r} "$@"
""",
    )
    (repo / "agents/benchmarks/tasks.json").write_text("{}\n")
    (data_dir / "world-model/build.manifest.json").write_text("{}\n")
    (data_dir / "cloudbench-cache/victoria-seed.dump").write_text("fixture\n")

    write_executable(controls / "fetch.sh", "#!/usr/bin/env bash\nexit 0\n")
    write_executable(controls / "sync-deps.sh", "#!/usr/bin/env bash\nexit 0\n")
    write_executable(controls / "sync-prisma.sh", "#!/usr/bin/env bash\nexit 0\n")
    write_executable(controls / "current-artifact.py", "#!/usr/bin/env python3\n")
    write_executable(controls / "prepare-patch.sh", "#!/usr/bin/env bash\nexit 0\n")
    write_executable(
        controls / "catalog.py",
        "#!/usr/bin/env python3\nimport sys\nsys.exit(10 if sys.argv[1] == 'requires-gate' else 0)\n",
    )
    write_executable(
        controls / "target.py",
        "#!/usr/bin/env python3\nimport sys\nprint('local')\nprint('--port')\nprint(sys.argv[2])\n",
    )
    (controls / "env.sh").write_text(
        """cloudbench_verify_env_file() { return 0; }
cloudbench_require_agentcard_org_oauth() { return 0; }
cloudbench_validate_browser_provider_contract() { return 0; }
cloudbench_env_value() { return 0; }
"""
    )
    (controls / "seed-budget.sh").write_text("stack_wait_budget_seconds() { printf '5\\n'; }\n")

    def unused_tcp_port() -> int:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            return int(reservation.getsockname()[1])

    status_port = unused_tcp_port()
    dashboard_port = unused_tcp_port()
    base_port = unused_tcp_port()
    run_token = f"boot-driver-{os.getpid()}"
    auth_token = f"auth-{os.getpid()}"
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "CLOUDBENCH_BOOT": "1",
            "CLOUDBENCH_RUN_TOKEN": run_token,
            "CLOUDBENCH_BARRIER_TOKEN": auth_token,
            "CLOUDBENCH_DATA_DIR": str(data_dir),
            "CLOUDBENCH_REPO_DIR": str(repo),
            "CLOUDBENCH_RUN_SCRIPT": str(DRIVER_SCRIPT),
            "CLOUDBENCH_FETCH_REF_SCRIPT": str(controls / "fetch.sh"),
            "CLOUDBENCH_STATUS_SERVER_SCRIPT": str(status_wrapper),
            "CLOUDBENCH_SYNC_DEPS_SCRIPT": str(controls / "sync-deps.sh"),
            "CLOUDBENCH_SYNC_PRISMA_SCRIPT": str(controls / "sync-prisma.sh"),
            "CLOUDBENCH_CURRENT_RUN_ARTIFACT_SCRIPT": str(controls / "current-artifact.py"),
            "CLOUDBENCH_PREPARE_PATCH_SCRIPT": str(controls / "prepare-patch.sh"),
            "CLOUDBENCH_BENCHMARK_TARGET_SCRIPT": str(controls / "target.py"),
            "CLOUDBENCH_CATALOG_SCRIPT": str(controls / "catalog.py"),
            "CLOUDBENCH_ENV_HELPER": str(controls / "env.sh"),
            "CLOUDBENCH_SEED_BUDGET_LIB": str(controls / "seed-budget.sh"),
            "CLOUDBENCH_DEPS_DIR": str(tmp_path / "deps"),
            "CLOUDBENCH_WMH_DIR": str(data_dir / "world-model"),
            "CLOUDBENCH_SEED_DUMP_PATH": str(data_dir / "cloudbench-cache/victoria-seed.dump"),
            "CLOUDBENCH_STATUS_PORT": str(status_port),
            "CLOUDBENCH_TEST_STATUS_PID_FILE": str(status_pid_file),
            "CLOUDBENCH_TEST_DELETE_MARKER": str(delete_marker),
            "CLOUDBENCH_HEARTBEAT_SECONDS": "30",
            "BENCH_DASHPORT": str(dashboard_port),
            "CONDUCTOR_PORT": str(base_port),
            "CONDUCTOR_WORKSPACE_NAME": "boot-driver-fixture",
            "BENCH_TASKS": "parallel-tool-calls",
            "BENCH_SIMULATE": "1",
            "WMH_MODEL_NAME": "test-model",
            "AGENTS_ENV_B64": base64.b64encode(b"fixture=1\n").decode(),
            "BACKEND_ENV_B64": base64.b64encode(b"fixture=1\n").decode(),
            "CLOUDBENCH_BROWSER_PROVIDER": "kernel",
        }
    )
    boot = subprocess.Popen(
        ["bash", str(BOOT_SCRIPT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def request(path: str, *, method: str = "GET") -> int:
        req = urllib.request.Request(
            f"http://127.0.0.1:{status_port}{path}",
            method=method,
            headers={"Authorization": f"Bearer {auth_token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=1) as response:
                return int(response.status)
        except urllib.error.HTTPError as exc:
            return int(exc.code)

    try:
        startup_deadline = time.monotonic() + 15
        driver_health = 0
        bench_log = data_dir / "bench.log"
        while time.monotonic() < startup_deadline:
            if boot.poll() is not None:
                break
            try:
                driver_health = request("/driver-health")
            except (OSError, urllib.error.URLError):
                driver_health = 0
            log_text = bench_log.read_text() if bench_log.exists() else ""
            if driver_health == 204 and "Agent created: root-agent" in log_text:
                break
            time.sleep(0.05)
        assert driver_health == 204 and "Agent created: root-agent" in log_text, (
            f"actual boot/driver runner did not become active; boot={boot.poll()} "
            f"log={bench_log.read_text() if bench_log.exists() else '<missing>'}"
        )

        assert request("/shutdown", method="POST") == 202
        cleanup_deadline = time.monotonic() + 15
        cleanup_health = 0
        while time.monotonic() < cleanup_deadline:
            cleanup_health = request("/shutdown-health")
            if cleanup_health in {204, 500}:
                break
            time.sleep(0.05)

        log_text = bench_log.read_text()
        assert cleanup_health == 204, (
            "actual boot/driver trap did not receive a canonical runner cleanup "
            f"ack (HTTP {cleanup_health})\n{log_text[-6000:]}"
        )
        assert delete_marker.read_text() == "204\n"
        cleanup_status = (data_dir / f"cloudbench-interrupt-cleanup-{run_token}.status").read_text()
        assert f"token={run_token}" in cleanup_status
        assert "state=clean" in cleanup_status
        assert (data_dir / f"cloudbench-driver-clean-{run_token}.ack").read_text() == f"{run_token}\n"
        assert (data_dir / "cloudbench-driver.state").read_text() == "exited\n"
        assert log_text.index("benchmark cancellation signal dispatched") < log_text.index("Deleted cancelled agent")
        assert log_text.index("Deleted cancelled agent") < log_text.index(
            "benchmark root cleanup evidence: state=clean"
        )
        assert log_text.index("benchmark root cleanup evidence: state=clean") < log_text.index(
            "driver cleanup evidence interrupt_status=1 cleanup_ack=1"
        )
    finally:

        def kill_exact_process_tree(pid: int) -> None:
            children_file = Path(f"/proc/{pid}/task/{pid}/children")
            try:
                children = [int(value) for value in children_file.read_text().split()]
            except (FileNotFoundError, ProcessLookupError):
                children = []
            for child_pid in children:
                kill_exact_process_tree(child_pid)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        driver_pid_file = data_dir / "cloudbench-driver.pid"
        if driver_pid_file.is_file():
            kill_exact_process_tree(int(driver_pid_file.read_text()))
        if boot.poll() is None:
            boot.terminate()
            try:
                boot.wait(timeout=2)
            except subprocess.TimeoutExpired:
                boot.kill()
                boot.wait(timeout=2)
        if status_pid_file.is_file():
            status_pid = int(status_pid_file.read_text())
            try:
                os.kill(status_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def test_boot_and_legacy_launch_pin_the_complete_guest_control_bundle() -> None:
    """The requested ref is product code under test, not a source of driver
    control helpers. Both launch transports must stage the same co-versioned
    immutable bundle and explicitly select it in the guest environment."""
    cloud = CLOUD_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    worker = WORKER_SCRIPT.read_text()
    sync_deps = SCRIPT.read_text()
    mappings = (
        ("FETCH_REF", "cloudbench-fetch-ref.sh"),
        ("SYNC_DEPS", "cloudbench-sync-deps.sh"),
        ("SYNC_PRISMA", "cloudbench-sync-prisma-client.sh"),
        ("CURRENT_RUN_ARTIFACT", "cloudbench-current-run-artifact.py"),
        ("PREPARE_PATCH", "cloudbench-prepare-patch.sh"),
        ("STATUS_SERVER", "cloudbench-status-server.py"),
        ("BENCHMARK_TARGET", "cloudbench-benchmark-target.py"),
        ("ENV_HELPER", "cloudbench-env.sh"),
    )
    for env_stem, basename in mappings:
        guest_var = {
            "FETCH_REF": "CLOUDBENCH_GUEST_FETCH_REF_SCRIPT",
            "SYNC_DEPS": "CLOUDBENCH_GUEST_SYNC_DEPS_SCRIPT",
            "SYNC_PRISMA": "CLOUDBENCH_GUEST_SYNC_PRISMA_SCRIPT",
            "CURRENT_RUN_ARTIFACT": "CLOUDBENCH_GUEST_CURRENT_RUN_ARTIFACT_SCRIPT",
            "PREPARE_PATCH": "CLOUDBENCH_GUEST_PREPARE_PATCH_SCRIPT",
            "STATUS_SERVER": "CLOUDBENCH_GUEST_STATUS_SERVER",
            "BENCHMARK_TARGET": "CLOUDBENCH_GUEST_BENCHMARK_TARGET_SCRIPT",
            "ENV_HELPER": "CLOUDBENCH_GUEST_ENV_HELPER",
        }[env_stem]
        assert f"--env CLOUDBENCH_{env_stem}_SCRIPT=/{basename}" in cloud or (
            env_stem == "ENV_HELPER" and f"--env CLOUDBENCH_ENV_HELPER=/{basename}" in cloud
        )
        assert f'--file-local "/{basename}=${guest_var}"' in cloud
        assert f"export CLOUDBENCH_{env_stem}_SCRIPT=/data/{basename}" in cloud or (
            env_stem == "ENV_HELPER" and f"export CLOUDBENCH_ENV_HELPER=/data/{basename}" in cloud
        )
        assert f'"${guest_var}" /data/{basename}' in cloud

    assert '--file-local "/cloudbench_catalog.py=$CLOUDBENCH_GUEST_CATALOG_SCRIPT"' in cloud
    assert '"$CLOUDBENCH_GUEST_CATALOG_SCRIPT" /data/cloudbench_catalog.py' in cloud
    assert "--env CLOUDBENCH_CATALOG_SCRIPT=/cloudbench_catalog.py" in cloud
    assert "export CLOUDBENCH_CATALOG_SCRIPT=/data/cloudbench_catalog.py" in cloud
    assert '--file-local "/cloudbench-seed-budget.sh=$CLOUDBENCH_GUEST_SEED_BUDGET_LIB"' in cloud
    assert '"$CLOUDBENCH_GUEST_SEED_BUDGET_LIB" /data/cloudbench-seed-budget.sh' in cloud
    assert "export CLOUDBENCH_SEED_BUDGET_LIB=/data/cloudbench-seed-budget.sh" in cloud
    for variable, basename in (
        ("CLOUDBENCH_GUEST_EXACT_SESSION_CLEANUP_SCRIPT", "cloudbench-exact-session-cleanup.py"),
        ("CLOUDBENCH_GUEST_RECOVERY_SCRIPT", "cloudbench-guest-recovery.py"),
    ):
        assert f'{variable}="$CLOUDBENCH_RUNTIME_SCRIPT_ROOT/{basename}"' in cloud
        assert f'--file-local "/{basename}=${variable}"' in cloud
        assert f'"${variable}"' in cloud
        assert f'"${variable}" /data/{basename}' in cloud

    # Direct repo runs keep using the same-version scripts/lib directory, while
    # flattened staged bundles select their own directory. Neither falls back
    # to the requested checkout through REPO_DIR.
    for source in (driver, worker, sync_deps):
        assert 'CONTROL_LIB_DIR="$CONTROL_DIR/lib"' in source
    assert "$REPO_DIR/scripts/cloudbench-fetch-ref.sh" not in driver
    assert "$REPO_DIR/scripts/cloudbench-fetch-ref.sh" not in worker
    assert 'source "$REPO_DIR/scripts/lib/cloudbench-env.sh"' not in sync_deps
    assert 'CATALOG_SCRIPT="${CLOUDBENCH_CATALOG_SCRIPT:-$CONTROL_DIR/cloudbench_catalog.py}"' in driver
    assert 'ENV_HELPER="${CLOUDBENCH_ENV_HELPER:-$CONTROL_LIB_DIR/cloudbench-env.sh}"' in driver
    assert 'SEED_BUDGET_LIB="${CLOUDBENCH_SEED_BUDGET_LIB:-$CONTROL_LIB_DIR/cloudbench-seed-budget.sh}"' in driver


def test_task_gate_uses_pinned_catalog_only_after_exact_checkout_and_patch(
    tmp_path: Path,
) -> None:
    """A reused checkout may contain the opposite gate metadata or executable
    Python. Production resolves the final requested+patched catalog only after
    sync, through the immutable stdlib-only catalog helper."""
    driver = DRIVER_SCRIPT.read_text()
    resolve_gate = _extract_fleet_function(driver, "resolve_task_gate() {")
    patch_end = driver.index('log "verified local workspace patch $_actual_patch_sha"')
    production_resolve = driver.index("\nresolve_task_gate\n", patch_end)
    status_restart = driver.index("# Replace the bootstrap read-only", patch_end)
    assert patch_end < production_resolve < status_restart
    assert "from benchmarks.benchmark_tasks" not in driver
    assert '"$task_gate_python" "$CATALOG_SCRIPT" requires-gate' in resolve_gate

    repo = tmp_path / "repo"
    catalog_dir = repo / "agents/benchmarks"
    checkout_scripts = repo / "scripts"
    catalog_dir.mkdir(parents=True)
    checkout_scripts.mkdir(parents=True)
    marker = tmp_path / "malicious-checkout-code-ran"
    (checkout_scripts / "cloudbench_catalog.py").write_text(
        f"raise SystemExit(open({str(marker)!r}, 'w').write('catalog'))\n"
    )
    (catalog_dir / "benchmark_tasks.py").write_text(f"raise SystemExit(open({str(marker)!r}, 'w').write('python'))\n")
    polar = catalog_dir / "polar_tasks.json"
    polar.write_text(json.dumps([{"name": "polar-dummy"}]))
    catalog = catalog_dir / "tasks.json"
    # Stale warm-checkout metadata says the selected task has no gate.
    catalog.write_text(json.dumps([{"name": "selected"}, {"name": "plain"}]))
    stale = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench_catalog.py"),
            "requires-gate",
            str(catalog),
            "source_connect",
            "selected",
        ],
        check=False,
    )
    assert stale.returncode == 10

    # Exact ref sync + local patch replace the catalog with the opposite truth.
    catalog.write_text(
        json.dumps(
            [
                {"name": "selected", "expected_gate": {"type": "source_connect"}},
                {"name": "plain"},
            ]
        )
    )
    for task, expected in (("selected", "NON_PURCHASE_GATES_ENABLED=1"), ("plain", "")):
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
{resolve_gate}
REPO_DIR="$1"
CATALOG_SCRIPT="$2"
CLOUDBENCH_TASK_GATE_PYTHON="$3"
BENCH_TASK_LIST=("$4")
TASK_WORKER_ENV=()
resolve_task_gate
printf '%s' "${{TASK_WORKER_ENV[*]:-}}"
""",
                "gate-parity",
                str(repo),
                str(ROOT / "scripts/cloudbench_catalog.py"),
                sys.executable,
                task,
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout == expected
    assert not marker.exists(), "checkout-owned catalog/Python executed as control code"


def test_legacy_launch_wrapper_publishes_complete_driver_lifecycle() -> None:
    """The legacy SSH path shares /driver-health with boot-launch. A reused
    machine must clear a stale terminal state before serving health, then move
    through running and exited atomically around the staged driver."""
    cloud = CLOUD_SCRIPT.read_text()
    wrapper = cloud.split('WRAPPER_LOCAL="$(mktemp)"', 1)[1].split('} > "$WRAPPER_LOCAL"', 1)[0]
    status_launch = cloud.split("# Start a tiny status HTTP server", 1)[1].split("launch_attempts=", 1)[0]

    assert "cloudbench-driver.state.tmp" in status_launch
    assert "printf 'booting" in status_launch
    assert status_launch.index("printf 'booting") < status_launch.index("cloudbench-status-server.py")
    assert "publish_driver_state" in wrapper
    assert "cloudbench-driver.pid.tmp" in wrapper
    assert wrapper.index("cloudbench-driver.pid.tmp") < wrapper.index("publish_driver_state running")
    assert "exec bash /data/cloudbench-run.sh" not in wrapper
    assert wrapper.index("bash /data/cloudbench-run.sh") < wrapper.index("publish_driver_state exited")


def test_boot_launch_stages_and_exports_complete_local_patch() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    assert '_boot_patch_guest="/cloudbench-local.patch"' in cloud
    assert '--env "LOCAL_PATCH_FILE=$_boot_patch_guest"' in cloud
    assert '_boot_file_args+=(--file-local "$_boot_patch_guest=$_boot_patch_local")' in cloud
    assert cloud.index('LOCAL_PATCH_FILE=""') < cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]')


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
    assert (
        subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; cloudbench_worktree_has_changes "$2"',
                "staged-check",
                str(ENV_HELPER_SCRIPT),
                str(repo),
            ],
            check=False,
        ).returncode
        == 0
    )
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


def test_fleet_shared_patch_remains_authoritative_until_transport_selection(
    tmp_path: Path,
) -> None:
    """A child must not rebuild a fleet-pinned payload from its own HEAD."""
    cloud = CLOUD_SCRIPT.read_text()
    block_start = cloud.index("STAGED_LOCAL_FILES=()")
    block_end = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then', block_start)
    pre_transport = cloud[block_start:block_end]

    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts/create-worktree-patch.sh").write_text(WORKTREE_PATCH_SCRIPT.read_text())
    tracked = repo / "tracked.txt"
    tracked.write_text("committed\n")
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "bench@example.com"],
        check=True,
    )
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Bench"], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-m", "baseline"],
        check=True,
        capture_output=True,
    )
    tracked.write_text("child-head-differs\n")

    payload = tmp_path / "fleet.patch"
    payload.write_text("fleet-authoritative-payload\n")
    digest = hashlib.sha256(payload.read_bytes()).hexdigest()
    marker = tmp_path / "preserved"
    script = f"""
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
ROOT_DIR={shlex.quote(str(repo))}
LOCAL_DASH_PORT=8765
claim_local_port() {{ :; }}
CLOUDBENCH_LOCAL_PATCH_SOURCE={shlex.quote(str(payload))}
CLOUDBENCH_LOCAL_PATCH_SHA256={shlex.quote(digest)}
{pre_transport}
[ "$LOCAL_PATCH_FILE" = {shlex.quote(str(payload))} ] || {{
    echo "fleet patch was replaced before transport selection" >&2
    exit 91
}}
[ "$LOCAL_PATCH_SHA256" = {shlex.quote(digest)} ] || exit 92
touch {shlex.quote(str(marker))}
cleanup_staged_local_files
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert marker.exists()
    assert payload.exists(), "child cleanup removed the fleet-owned shared patch"


def test_declared_patch_payload_cannot_be_missing_or_empty(tmp_path: Path) -> None:
    driver = DRIVER_SCRIPT.read_text()
    worker = WORKER_SCRIPT.read_text()
    driver_start = driver.index('if [ -n "${LOCAL_PATCH_FILE:-}" ]; then')
    driver_end = driver.index("\nfi\n\n# Gate metadata", driver_start) + len("\nfi\n")
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
    assert (
        subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; cloudbench_worktree_has_changes "$2"',
                "history-only-check",
                str(ENV_HELPER_SCRIPT),
                str(only_history),
            ],
            check=False,
        ).returncode
        == 1
    )


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
    assert 'create-worktree-patch.sh"' in patch_block
    assert "cloudbench_prepare_workspace_patch" in patch_block
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
    assert '_boot_patch_guest="/cloudbench-local.patch"' in boot
    assert '--env "LOCAL_PATCH_FILE=$_boot_patch_guest"' in boot
    assert '--env "LOCAL_PATCH_SHA256=$LOCAL_PATCH_SHA256"' in boot
    assert '_boot_file_args+=(--file-local "$_boot_patch_guest=$_boot_patch_local")' in boot
    assert "LOCAL_PATCH_COMPRESSION" in boot
    assert 'CLOUDBENCH_LOCAL_PATCH_SOURCE="$FLEET_PATCH_FILE"' in fleet

    for guest in (driver, worker):
        assert "LOCAL_PATCH_SHA256" in guest
        assert 'sha256sum "$LOCAL_PATCH_FILE"' in guest
        assert "patch payload checksum mismatch" in guest

    worker_stage = fleet[fleet.index("provision_worker() {") : fleet.index("bench_autoscaler() {")]
    assert cloud.count('LOCAL_PATCH_FILE=""') == 1
    assert "LOCAL_PATCH_SHA256=$FLEET_PATCH_SHA256" in worker_stage
    assert "sftp put" in worker_stage
    patch_upload = worker_stage.split('if [ -n "$FLEET_PATCH_FILE" ]', 1)[1].split(
        'if run_worker_stage_cmd "launch worker wrapper"', 1
    )[0]
    assert 'if ! run_worker_stage_cmd "upload local patch"' in patch_upload
    assert "|| true" not in patch_upload
    assert "continue" in patch_upload


def test_boot_launch_runs_the_current_driver_before_applying_the_patch() -> None:
    """Updating the executing repo script can shift bytes under Bash itself."""
    cloud = CLOUD_SCRIPT.read_text()
    boot = (ROOT / "scripts" / "cloudbench-boot.sh").read_text()

    boot_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    legacy_start = cloud.index("# ── 1. Start the warm machine", boot_start)
    launch = cloud[boot_start:legacy_start]
    assert "--env CLOUDBENCH_RUN_SCRIPT=/cloudbench-run.sh" in launch
    assert '--file-local "/cloudbench-run.sh=$CLOUDBENCH_GUEST_RUN_SCRIPT"' in launch
    assert 'DRIVER="${CLOUDBENCH_RUN_SCRIPT:-/cloudbench-run.sh}"' in boot
    assert 'bash "$DRIVER" >> "$LOG" 2>&1' in boot


def test_boot_launch_missing_injected_control_seals_without_checkout_fallback(
    tmp_path: Path,
) -> None:
    """A missing immutable bootstrap helper must never delegate control flow
    to the arbitrary requested ref. Because no driver/browser was launched,
    the boot supervisor durably acknowledges cleanup and seals exited.
    """
    boot = BOOT_SCRIPT.read_text()
    publish_state = _extract_fleet_function(boot, "publish_driver_state() {")
    publish_ack = _extract_fleet_function(boot, "publish_cleanup_ack() {")
    seal_missing = _extract_fleet_function(boot, "seal_missing_injected_helper() {")

    status_check = boot.index('if [ ! -s "$STATUS_SERVER_SCRIPT" ]; then')
    status_launch = boot.index('setsid python3 "$STATUS_SERVER_SCRIPT"')
    driver_check = boot.index('if [ ! -s "$DRIVER" ]; then')
    fetch_check = boot.index('if [ ! -s "$FETCH_REF_SCRIPT" ]; then')
    checkout = boot.index("bootstrap_checkout_ref >>")
    driver_launch = boot.index('bash "$DRIVER" >> "$LOG" 2>&1 &')
    assert status_check < status_launch < driver_check < checkout < driver_launch
    assert status_launch < fetch_check < checkout
    assert 'DRIVER="$REPO/scripts/cloudbench-run.sh"' not in boot
    assert 'bash "$REPO/scripts/cloudbench-fetch-ref.sh"' not in boot
    assert "refusing checked-out fallback" in seal_missing
    assert seal_missing.index("publish_cleanup_ack") < seal_missing.index("publish_driver_state exited")

    for helper_name in ("driver", "fetch-ref-helper", "status-server"):
        for payload in ("missing", "empty"):
            injected = tmp_path / f"{helper_name}-{payload}"
            if payload == "empty":
                injected.write_text("")
            state = tmp_path / f"{helper_name}-{payload}.state"
            ack = tmp_path / f"{helper_name}-{payload}.ack"
            log = tmp_path / f"{helper_name}-{payload}.log"
            script = f"""set -uo pipefail
{publish_state}
{publish_ack}
{seal_missing}
DRIVER_STATE_FILE="$1"
CLEANUP_ACK_FILE="$2"
LOG="$3"
CLOUDBENCH_RUN_TOKEN=token-no-launch
seal_missing_injected_helper "$4" "$5"
"""
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    script,
                    "missing-helper",
                    str(state),
                    str(ack),
                    str(log),
                    helper_name,
                    str(injected),
                ],
                text=True,
                capture_output=True,
                check=False,
                timeout=5,
            )
            assert result.returncode == 0, result.stderr
            assert state.read_text() == "exited\n"
            assert ack.read_text() == "token-no-launch\n"
            assert f"controller-injected {helper_name} missing or empty" in log.read_text()

    # Even a malicious helper inside the requested ref cannot replace the
    # controller-staged fetch helper used before checkout.
    bootstrap = _extract_fleet_function(boot, "bootstrap_checkout_ref() {")
    repo = tmp_path / "repo"
    checkout_scripts = repo / "scripts"
    checkout_scripts.mkdir(parents=True)
    checkout_marker = tmp_path / "checkout-fetch-ran"
    pinned_marker = tmp_path / "pinned-fetch-ran"
    (checkout_scripts / "cloudbench-fetch-ref.sh").write_text(
        f"#!/usr/bin/env bash\nprintf ran > {shlex.quote(str(checkout_marker))}\n"
    )
    pinned_fetch = tmp_path / "cloudbench-fetch-ref.sh"
    pinned_fetch.write_text(f'#!/usr/bin/env bash\nprintf \'%s|%s\' "$1" "$2" > {shlex.quote(str(pinned_marker))}\n')
    checkout = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
git() {{ :; }}
{bootstrap}
REPO="$1"
REF=arbitrary-old-ref
FETCH_REF_SCRIPT="$2"
bootstrap_checkout_ref
""",
            "pinned-fetch",
            str(repo),
            str(pinned_fetch),
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert checkout.returncode == 0, checkout.stderr
    assert pinned_marker.read_text() == f"{repo}|arbitrary-old-ref"
    assert not checkout_marker.exists()


def test_autoscaled_worker_failure_publishes_durable_failure_marker(tmp_path: Path) -> None:
    """Storage, upload, and readiness failures must remain diagnosable while
    the failed worker is removed so replacement capacity can be created."""
    fleet = FLEET_SCRIPT.read_text()
    pool_count = _extract_fleet_function(fleet, "_pool_ids() {")
    reap = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "machine_status_exact_read() {",
            "registry_machine_details() {",
            "reap_machine() {",
        )
    )
    cleanup = _worker_cleanup_bundle(fleet)
    provision = _extract_fleet_function(fleet, "provision_worker() {")
    root = tmp_path / "root"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts/cloudbench-worker.sh").write_text("#!/usr/bin/env bash\n")
    patch_file = tmp_path / "workspace.patch"
    patch_file.write_text("patch\n")

    for mode in (
        "storage-not-ready",
        "storage-failed",
        "upload-failure",
        "upload-and-reap-failure",
        "upload-and-status-failure",
        "readiness-failure",
    ):
        out = tmp_path / mode
        reaped = tmp_path / f"{mode}.reaped"
        calls = tmp_path / f"{mode}.calls"
        script = f"""set -euo pipefail
ROOT_DIR={shlex.quote(str(root))}
CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(root / "scripts"))}
APP=test-app
FLEET_OWNER_TOKEN=test-owner
BENCH_REF=test-ref
BOX_BACKEND_PORT=3001
BOX_WMH_PORT=3007
FLEET_WORKER_VM_SIZE=shared-cpu-1x
FLEET_WORKER_VM_MEMORY=1024
FLEET_WORKER_HEALTH_PORT=3103
FLEET_PATCH_FILE={shlex.quote(str(patch_file))}
FLEET_PATCH_SHA256=expected
FLEET_OWNER_TOKEN=test-owner
CLOUDBENCH_WORKER_STAGE_ATTEMPTS=3
CLOUDBENCH_WORKER_STAGE_RETRY_SECONDS=0
WORKER_STAGE_ATTEMPTS=3
WORKER_READY_TIMEOUT=1
MODE={shlex.quote(mode)}
OUT={shlex.quote(str(out))}
REAPED={shlex.quote(str(reaped))}
CALLS={shlex.quote(str(calls))}
: > "$CALLS"
clone_machine_target() {{
  mkdir -p "$(dirname "$1")"
  printf '%s\n' abc123 >> "$1"
  printf '%s' abc123
}}
reserve_worker_machine_slot() {{ return 0; }}
capacity_release_reservation() {{ return 0; }}
controller_github_token_b64() {{ printf token; }}
machine_storage_ready() {{ [ "$MODE" != storage-not-ready ] && [ "$MODE" != storage-failed ]; }}
machine_storage_failed() {{ [ "$MODE" = storage-failed ]; }}
worker_operational() {{ [ "$MODE" != readiness-failure ]; }}
fly_with_timeout() {{
  shift
  printf '%s\n' "$*" >> "$CALLS"
  case "$*" in
    *"ssh sftp put"*"cloudbench-local.patch"*)
      if [ "$MODE" = upload-failure ] \
          || [ "$MODE" = upload-and-reap-failure ] \
          || [ "$MODE" = upload-and-status-failure ]; then
        printf '%s\n' 'SFTP_PROVIDER_SENTINEL: remote volume rejected write' >&2
        return 42
      fi ;;
    *) return 0 ;;
  esac
}}
machine_volume_id() {{ printf '%s' volume-abc123; }}
reap_volume() {{ :; }}
FLY() {{
  case "$*" in
    "machine destroy"*)
      if [ "$MODE" = upload-and-reap-failure ]; then
        printf '%s\n' 'DESTROY_PROVIDER_SENTINEL: provider refused destroy' >&2
        return 37
      fi
      [ "$MODE" = upload-and-status-failure ] || printf '%s\n' "$4" > "$REAPED" ;;
    "machine status"*)
      if [ "$MODE" = upload-and-status-failure ]; then
        printf '%s\n' 'STATUS_PROVIDER_SENTINEL: exact Machine unreadable' >&2
        return 55
      elif [ "$MODE" = upload-and-reap-failure ]; then
        cat <<'STATUS'
Machine ID: abc123
Instance ID: fixture
State: started
HostStatus: ok

VM
  ID            = abc123
  Instance ID   = fixture
  State         = started
  Image         = fixture
  Name          = cloudbench-worker
  Private IP    = fdaa::123
  Region        = iad
  Process Group =
  CPU Kind      = shared
  vCPUs         = 1
  Memory        = 1024
  Created       = fixture
  Updated       = fixture
  Entrypoint    =
  Command       =
  Volume        = volume-abc123
STATUS
      else
        printf "Error: machine abc123 was not found in app '%s'\\n" "$APP" >&2
        return 1
      fi ;;
    "machine stop"*) return 0 ;;
    *) return 0 ;;
  esac
}}
fleet_registry_release_id() {{ :; }}
sleep() {{ :; }}
{pool_count}
{reap}
{cleanup}
{provision}
provision_worker bench workspace primary fd00::1 0 "$OUT"
wait || true
test -s "$OUT/worker-abc123.stage.log"
if [ "$MODE" = upload-and-reap-failure ] || [ "$MODE" = upload-and-status-failure ]; then
  test "$(_pool_ids "$OUT")" = 1
  test ! -e "$REAPED"
  test -e "$OUT/worker-abc123.pending"
  test -s "$OUT/worker-abc123.failed"
  test -s "$OUT/worker-abc123.cleanup.log"
else
  test "$(_pool_ids "$OUT")" = 0
  test -s "$REAPED"
  test ! -e "$OUT/worker-abc123.pending"
  test ! -e "$OUT/worker-abc123.ready"
fi
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
        if mode == "storage-failed":
            assert fly_calls == []
            assert "storage failed before staging" in stage_log
            continue
        neutralize = next(i for i, call in enumerate(fly_calls) if "machine update abc123" in call)
        first_start = next(i for i, call in enumerate(fly_calls) if "machine start abc123" in call)
        clear_stage = next(i for i, call in enumerate(fly_calls) if "rm -f /data/cloudbench-worker.sh" in call)
        first_upload = next(
            i for i, call in enumerate(fly_calls) if "ssh sftp put" in call and "cloudbench-worker.sh" in call
        )
        assert neutralize < first_start < clear_stage < first_upload
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
        elif mode == "upload-failure":
            assert launch_calls == []
            assert "upload local patch failed rc=42" in stage_log
            assert "SFTP_PROVIDER_SENTINEL" in stage_log
        elif mode == "upload-and-reap-failure":
            assert launch_calls == []
            assert "upload local patch failed rc=42" in stage_log
            assert "SFTP_PROVIDER_SENTINEL" in stage_log
            cleanup_log = (out / "worker-abc123.cleanup.log").read_text()
            assert "destroy failed rc=37" in cleanup_log
            assert "DESTROY_PROVIDER_SENTINEL" in cleanup_log
        elif mode == "upload-and-status-failure":
            assert launch_calls == []
            assert "SFTP_PROVIDER_SENTINEL" in stage_log
            cleanup_log = (out / "worker-abc123.cleanup.log").read_text()
            assert "exact machine status unreadable" in cleanup_log
            assert "STATUS_PROVIDER_SENTINEL" in cleanup_log
            assert "refusing to forget worker" in cleanup_log

        assert "ready_deadline=$((SECONDS + worker_ready_timeout))" in provision
        assert 'if worker_operational "$wid"; then' in provision

    worker = WORKER_SCRIPT.read_text()
    assert worker.index("patch payload checksum mismatch") < worker.index(
        'printf \'%s\\n\' "$$" > "$WORKER_READY_FILE"'
    )


def test_autoscaler_scale_down_cancels_pending_worker_contract_is_rejected(
    tmp_path: Path,
) -> None:
    """A transient low target cannot revoke capacity committed to staging."""
    fleet = FLEET_SCRIPT.read_text()
    pool_count = _extract_fleet_function(fleet, "_pool_ids() {")
    ready_count = _extract_fleet_function(fleet, "_ready_pool_ids() {")
    worker_is_tracked = _extract_fleet_function(fleet, "worker_is_tracked() {")
    pool_has_pending_worker = _extract_fleet_function(fleet, "pool_has_pending_worker() {")
    ledger_locks = _worker_ledger_lock_bundle(fleet)
    cancel_scale_down = (
        _extract_fleet_function(fleet, "cancel_worker_for_scale_down() {")
        if "cancel_worker_for_scale_down() {" in fleet
        else ""
    )
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")
    worker_id = "deadbeef000003"
    output = tmp_path / "oscillating-target"
    output.mkdir()
    calls = tmp_path / "desired-calls"
    observed = tmp_path / "desired-observed"
    now = tmp_path / "clock"
    provisions = tmp_path / "provisions"
    cleaned = tmp_path / "cleaned"
    cleaned_at = tmp_path / "cleaned-at"
    premature = tmp_path / "premature-cleanup"
    calls.write_text("0\n")
    now.write_text("0\n")
    provisions.write_text("0\n")

    script = f"""set -u
APP=test-app
RUN_ID=test-run
BOX_HEALTH_PORT=3003
AUTOSCALE_MAX=15
AUTOSCALE_POLL=0
AUTOSCALE_SCALE_DOWN_CONFIRM_SECONDS=60
AUTOSCALER_FINALIZATION_WAIT_SECONDS=1
CLOUDBENCH_BOOT_LAUNCH=0
OUT={shlex.quote(str(output))}
WID={worker_id}
CALLS={shlex.quote(str(calls))}
OBSERVED={shlex.quote(str(observed))}
NOW={shlex.quote(str(now))}
PROVISIONS={shlex.quote(str(provisions))}
CLEANED={shlex.quote(str(cleaned))}
CLEANED_AT={shlex.quote(str(cleaned_at))}
PREMATURE={shlex.quote(str(premature))}
_machine_priv_ip() {{ printf '%s\n' fd00::1; }}
inventory_machine_exists() {{ return 0; }}
release_autoscaler_metrics_owner() {{ return 0; }}
claim_autoscaler_metrics_port() {{ printf -v "$1" '%s' 5555; }}
flyctl() {{ /bin/sleep 30; }}
curl() {{ return 0; }}
fleet_job_running() {{ kill -0 "$1" 2>/dev/null; }}
cloudbench_terminate_and_wait() {{
  shift
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
date() {{
  if [ "${{1:-}}" = +%s ]; then
    cat "$NOW"
  else
    command date "$@"
  fi
}}
_box_desired() {{
  local call desired tick
  call=$(( $(cat "$CALLS") + 1 ))
  printf '%s\n' "$call" > "$CALLS"
  case "$call" in
    1) desired=2; tick=0 ;;
    2) desired=1; tick=10 ;;
    3) desired=2; tick=20 ;;
    4)
      desired=1
      tick=30
      printf '%s\n' "$WID" > "$OUT/worker-ready.ids"
      : > "$OUT/worker-$WID.ready"
      rm -f "$OUT/worker-$WID.pending"
      ;;
    5) desired=""; tick=80 ;;
    6) desired=1; tick=81 ;;
    7) desired=1; tick=130 ;;
    *) desired=1; tick=142 ;;
  esac
  printf '%s\n' "$tick" > "$NOW"
  printf '%s\n' "${{desired:-<invalid>}}" >> "$OBSERVED"
  printf '%s\n' "$desired"
}}
cleanup_failed_worker() {{
  [ ! -e "$1/worker-$2.pending" ] || : > "$PREMATURE"
  printf '%s\n' "$2" >> "$CLEANED"
  cat "$CALLS" > "$CLEANED_AT"
  awk -v id="$2" '$0 != id' "$1/worker-clones.ids" > "$1/worker-clones.ids.tmp"
  mv "$1/worker-clones.ids.tmp" "$1/worker-clones.ids"
  awk -v id="$2" '$0 != id' "$1/worker-ready.ids" > "$1/worker-ready.ids.tmp"
  mv "$1/worker-ready.ids.tmp" "$1/worker-ready.ids"
  rm -f "$1/worker-$2.pending" "$1/worker-$2.ready"
}}
reconcile_worker_ready_outcomes() {{
  if [ "$(cat "$CALLS")" -ge 8 ] && [ -s "$CLEANED" ]; then
    : > "$1/benchmark-child.finished"
  fi
  return 0
}}
reconcile_worker_failure_outcomes() {{ return 0; }}
provision_worker() {{
  local count
  count=$(( $(cat "$PROVISIONS") + 1 ))
  printf '%s\n' "$count" > "$PROVISIONS"
  printf '%s\n' "$WID" > "$OUT/worker-clones.ids"
  : > "$OUT/worker-ready.ids"
  : > "$OUT/worker-$WID.pending"
  rm -f "$OUT/worker-$WID.ready" "$OUT/worker-$WID.cancelled"
}}
{pool_count}
{ready_count}
{worker_is_tracked}
{pool_has_pending_worker}
{ledger_locks}
{cancel_scale_down}
autoscaler_monotonic_seconds() {{
  printf -v "$1" '%s' "$(cat "$NOW")"
}}
{autoscaler}
bench_autoscaler task primary workspace 0 "$OUT" 6000
test -e "$OUT/autoscaler.completed-after-child"
"""

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert observed.read_text().splitlines()[:4] == ["2", "1", "2", "1"]
    assert observed.read_text().splitlines()[4:] == ["<invalid>", "1", "1", "1"]
    provision_count = int(provisions.read_text().strip())
    assert provision_count == 1 and not premature.exists(), (
        "desired 2,1,2,1 must provision once and retain committed pending "
        f"capacity; got provisions={provision_count}, "
        f"premature_cleanup={premature.exists()}"
    )
    assert cleaned.read_text().splitlines() == [worker_id]
    assert cleaned_at.read_text().strip() == "8"
    assert (output / "autoscaler.completed-after-child").exists()


def test_worker_token_falls_back_to_workspace_env_without_gh(tmp_path: Path) -> None:
    fleet = FLEET_SCRIPT.read_text()
    resolver = _extract_fleet_function(fleet, "controller_github_token_b64() {")
    (tmp_path / "back-end").mkdir()
    (tmp_path / "back-end/.env").write_text('GITHUB_TOKEN="workspace-token"\n')
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""
ROOT_DIR={shlex.quote(str(tmp_path))}
CONTROLLER_GITHUB_TOKEN_B64_CACHE=""
unset GITHUB_TOKEN GH_TOKEN
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
cloudbench_git_insteadof_github_token() {{ return 1; }}
{resolver}
controller_github_token_b64 | base64 --decode
""",
        ],
        env={"PATH": "/usr/bin:/bin"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "workspace-token"

    # An explicit worker workspace must never borrow a token from the launcher's
    # current directory when its own dotenv files are empty.
    empty_root = tmp_path / "empty-root"
    empty_root.mkdir()
    decoy_cwd = tmp_path / "decoy-cwd"
    (decoy_cwd / "back-end").mkdir(parents=True)
    (decoy_cwd / "back-end/.env").write_text("GITHUB_TOKEN=wrong-workspace-token\n")
    missing = subprocess.run(
        [
            "bash",
            "-c",
            f"""
ROOT_DIR={shlex.quote(str(empty_root))}
CONTROLLER_GITHUB_TOKEN_B64_CACHE=""
unset GITHUB_TOKEN GH_TOKEN
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
cloudbench_git_insteadof_github_token() {{ return 1; }}
{resolver}
controller_github_token_b64
""",
        ],
        cwd=decoy_cwd,
        env={"PATH": "/usr/bin:/bin"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert missing.returncode == 1, missing.stderr
    assert missing.stdout == ""


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

    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)

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

    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)

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


def test_fleet_registry_release_id_is_idempotent_with_other_records(tmp_path: Path) -> None:
    """Removing one worker must not inherit a later nonmatching record's status."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "\n".join(
        (
            _extract_fleet_function(fleet, "registry_meta_value() {"),
            _extract_fleet_function(fleet, "fleet_registry_release_id() {"),
        )
    )
    registry = tmp_path / "registry"
    clones = registry / "clones"
    clones.mkdir(parents=True)
    target = clones / "a-target"
    target.write_text("name=target\nid=deadbeef000020\n")
    other = clones / "z-other"
    other.write_text("name=other\nid=deadbeef000021\n")
    script = f"""set -euo pipefail
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
{helpers}
fleet_registry_release_id deadbeef000020
test ! -e {shlex.quote(str(target))}
test -e {shlex.quote(str(other))}
fleet_registry_release_id deadbeef000020
test -e {shlex.quote(str(other))}
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
    assert result.returncode == 0, result.stderr + result.stdout


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
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
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
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
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
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
    assert result.returncode == 0, result.stderr + result.stdout

    cloner = _extract_fleet_function(fleet, "clone_machine_target() {")
    lock = cloner.index('worker_ledger_lock_acquire "$(dirname "$ledger")"')
    append = cloner.index('printf \'%s\\n\' "$target_id" >> "$ledger"', lock)
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
        result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)
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
    assert (index / "current/machines/machine-1").read_text().splitlines()[-1] == ("storage_failed=0")
    assert "storage_ready=1" in (index / "current/machines/machine-1").read_text().splitlines()
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

    spec = importlib.util.spec_from_file_location("cloudbench_machine_readiness_complexity", MACHINE_READINESS_SCRIPT)
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
    volumes = CountingList([{"id": f"volume-{index}", "state": "created"} for index in range(width)])

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
        # The helper owns a 0.2s process deadline plus a 1s termination grace.
        # Leave scheduler headroom when this regression runs beside every
        # repository coverage suite; an unbounded 30s read still fails closed.
        timeout=5,
    )

    assert result.returncode == 1, result.stderr


def test_fresh_clone_start_paths_honor_storage_readiness_contract() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    startup = cloud.split("# ── 1. Start the warm machine", 1)[1].split("# ── 2.", 1)[0]

    assert 'MACHINE_READINESS_SCRIPT="$CLOUDBENCH_RUNTIME_SCRIPT_ROOT/cloudbench-machine-readiness.py"' in cloud
    assert startup.count('if machine_storage_ready "$mid"') == 2
    assert startup.count('request_machine_start "$mid"') == 2
    assert startup.index('if machine_storage_ready "$mid"') < startup.index('request_machine_start "$mid"')
    assert 'MACHINE_READINESS_SCRIPT="$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-machine-readiness.py"' in fleet
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
    update_retry = _extract_fleet_function(cloud, "boot_update_with_capacity_recovery() {")
    assert "CLOUDBENCH_BOOT_UPDATE_TIMEOUT" in update_retry
    assert '_with_timeout "$timeout_seconds" "$@"' in update_retry
    assert 'boot_update_with_capacity_recovery "$_update_log"' in branch
    assert "final Fly update error" in branch
    post_config_start = branch[branch.index("# The update above is explicitly `--skip-start`") :]
    post_config_start = post_config_start[: post_config_start.index("\nelse\n# ── 1.")]
    assert "machine_state" not in post_config_start
    assert "machine_storage_ready" not in post_config_start
    assert "request_machine_start" not in post_config_start
    assert "CLOUDBENCH_BOOT_START_ATTEMPTS" in post_config_start
    assert "CLOUDBENCH_BOOT_START_TIMEOUT" in post_config_start
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
    storage_gate = worker_provision.index('if ! machine_storage_ready "$wid"; then')
    storage_gate_end = worker_provision.index("\n        fi", storage_gate)
    storage_wait = worker_provision[storage_gate:storage_gate_end]
    assert 'machine_storage_failed "$wid"' in storage_wait
    assert "continue" in storage_wait
    neutralize = worker_provision.index('machine update "$wid"', storage_gate_end)
    first_start = worker_provision.index('machine start "$wid"', neutralize)
    assert storage_gate < storage_gate_end < neutralize < first_start
    assert "--env CLOUDBENCH_BOOT=0" in worker_provision[neutralize:first_start]
    assert "--skip-start" in worker_provision[neutralize:first_start]


def test_boot_launch_delivers_the_advertised_local_workspace_patch() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    branch_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    setup = cloud[:branch_start]
    branch = cloud[branch_start:]

    assert '_candidate_patch="$(mktemp)"' in setup
    assert 'LOCAL_PATCH_FILE="$_candidate_patch"' in setup
    assert '--env "LOCAL_PATCH_FILE=$_boot_patch_guest"' in branch
    assert '_boot_file_args+=(--file-local "$_boot_patch_guest=$_boot_patch_local")' in branch
    assert '--env "LOCAL_PATCH_FILE="' in branch


def test_boot_launch_executes_the_current_injected_driver() -> None:
    """Driver edits must take effect before that driver applies the workspace patch."""
    cloud = CLOUD_SCRIPT.read_text()
    boot = (CLOUD_SCRIPT.parent / "cloudbench-boot.sh").read_text()
    branch_start = cloud.index('if [ "${CLOUDBENCH_BOOT_LAUNCH:-0}" = "1" ]; then')
    branch = cloud[branch_start:]

    assert '--file-local "/cloudbench-run.sh=$CLOUDBENCH_GUEST_RUN_SCRIPT"' in branch
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
    assert autoscaler.index("post-config-start.accepted") < autoscaler.index(
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
    claim = _extract_fleet_function(fleet, "claim_autoscaler_metrics_port() {")
    release = _extract_fleet_function(fleet, "release_autoscaler_metrics_port() {")

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
                "bash",
                "-c",
                script,
                "port-test",
                str(lease_root),
                str(occupied_port),
                str(PORT_LEASE_SCRIPT),
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
        result = subprocess.run(command, text=True, capture_output=True, check=False, timeout=10)
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
        subprocess.run(command("release", token, "--port", str(port)), check=True)

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
    autoscaler = _extract_fleet_function(FLEET_SCRIPT.read_text(), "bench_autoscaler() {")
    recovery = autoscaler.split('if ! fleet_job_running "$metrics_proxy_pid"; then', 1)[1].split(
        "local desired want cur", 1
    )[0]

    assert "until start_metrics_proxy 30; do" in autoscaler
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
    provision_worker = _extract_fleet_function(FLEET_SCRIPT.read_text(), "provision_worker() {")
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

    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode != 0
    failure = output / "autoscaler.failed"
    assert failure.is_file(), result.stderr
    assert "could not allocate worker clone" in failure.read_text()


def test_worker_health_distinguishes_candidate_standby_from_production_running() -> None:
    worker = (ROOT / "agents" / "worker.py").read_text()
    health = (ROOT / "agents" / "health_server.py").read_text()

    validation_worker = worker.index("validation_worker = Worker(")
    standby = worker.index('set_worker_status(True, phase="standby"')
    activation_wait = worker.index("marker_id = await wait_for_worker_build_activation")
    worker_task = worker.index("worker_task = asyncio.create_task(worker.run())")
    running = worker.index('set_worker_status(True, phase="running"')
    legacy_ready_log = worker.index("Worker started, waiting for tasks...")
    ready_log = worker.index("Worker ready, polling Temporal task queue")

    assert validation_worker < standby < activation_wait < worker_task
    assert worker_task < running < legacy_ready_log < ready_log
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

    assert 'FETCH_REF_SCRIPT="${CLOUDBENCH_FETCH_REF_SCRIPT:-$CONTROL_DIR/cloudbench-fetch-ref.sh}"' in worker
    assert 'CLOUDBENCH_APP_USER="$APP_USER" bash "$FETCH_REF_SCRIPT" "$REPO_DIR" "$REF"' in worker
    assert 'git -C "$REPO_DIR" fetch origin "$REF"' not in worker
    assert worker.index("unset CLOUDBENCH_GITHUB_TOKEN_B64") < worker.index("bash ./scripts/run_local_worker.sh")
    assert "rm -f /tmp/rbw.env" in worker

    assert "controller_github_token_b64" in provision
    assert "export CLOUDBENCH_GITHUB_TOKEN_B64=" not in provision
    assert "export CLOUDBENCH_FETCH_REF_SCRIPT=/data/cloudbench-fetch-ref.sh" in provision
    assert "export CLOUDBENCH_ENV_HELPER=/data/cloudbench-env.sh" in provision
    assert 'CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-fetch-ref.sh" /data/cloudbench-fetch-ref.sh' in provision
    assert 'CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-env.sh" /data/cloudbench-env.sh' in provision
    assert '-m 0600 "$worker_env" /tmp/rbw.env' in provision
    assert "rm -f /tmp/rbw.env" in provision

    output = tmp_path / "bench"
    output.mkdir()
    calls = tmp_path / "calls.log"
    captured_wrapper = tmp_path / "rbw.sh"
    captured_env = tmp_path / "rbw.env"
    captured_env_mode = tmp_path / "rbw.env.mode"
    encoded_token = base64.b64encode(b"secret-token").decode()
    script = f"""set +e
ROOT_DIR={shlex.quote(str(ROOT))}
CLOUDBENCH_SCRIPT_SNAPSHOT={shlex.quote(str(ROOT / "scripts"))}
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

    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False, timeout=10)

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


def test_autoscaler_publishes_failure_when_readiness_reconcile_exits(
    tmp_path: Path,
) -> None:
    """Startup must not collapse a silent autoscaler return into an opaque abort."""
    autoscaler = _extract_fleet_function(FLEET_SCRIPT.read_text(), "bench_autoscaler() {")
    out_dir = tmp_path / "bench"
    script = f"""
set -uo pipefail
APP=test-app
RUN_ID=test-run
AUTOSCALE_POLL=1
AUTOSCALER_FINALIZATION_WAIT_SECONDS=1
BOX_HEALTH_PORT=3003
CLOUDBENCH_BOOT_LAUNCH=0
mkdir -p {shlex.quote(str(out_dir))}
_machine_priv_ip() {{ printf 'fdaa::1'; }}
inventory_machine_exists() {{ return 0; }}
reconcile_worker_ready_outcomes() {{ return 1; }}
reconcile_worker_failure_outcomes() {{ return 0; }}
release_autoscaler_metrics_owner() {{ return 0; }}
claim_autoscaler_metrics_port() {{ printf -v "$1" 62345; }}
cloudbench_terminate_and_wait() {{
  shift
  for pid in "$@"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}}
curl() {{ return 0; }}
flyctl() {{ while :; do sleep 60; done; }}
fleet_job_running() {{
  local pid="${{1:-}}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  jobs -pr | grep -qx "$pid"
}}
{autoscaler}
if bench_autoscaler bench primary ws 0 {shlex.quote(str(out_dir))} 61000; then
  echo "autoscaler unexpectedly succeeded" >&2
  exit 2
fi
test -s {shlex.quote(str(out_dir / "autoscaler.failed"))}
grep -F "could not reconcile worker readiness outcomes" \\
  {shlex.quote(str(out_dir / "autoscaler.failed"))}
"""

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )

    assert result.returncode == 0, result.stderr


def test_autoscaler_stops_cleanly_when_its_benchmark_child_finishes(
    tmp_path: Path,
) -> None:
    """A remote driver tears down /metrics immediately after its benchmark.
    That expected lifecycle must stop the autoscaler before its unreadable-
    metrics threshold can rewrite a completed benchmark as infrastructure."""
    fleet = FLEET_SCRIPT.read_text()
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")
    supervisor = _extract_fleet_function(fleet, "run_fleet_child_supervised() {")
    launch = fleet.split("# ── Phase 2: launch each provisioned bench", 1)[1].split("CHILD_PIDS+=(", 1)[0]
    final_acceptance = fleet.split("AUTOSCALER_FAILURE=0", 1)[1].split(
        "# Normal completion has already reaped every child", 1
    )[0]

    assert 'run_fleet_child_supervised "$out/benchmark-child.finished"' in launch
    assert 'marker_tmp="$finished_marker.tmp.$$"' in supervisor
    assert 'mv "$marker_tmp" "$finished_marker"' in supervisor
    assert "benchmark-child.finished" in autoscaler
    assert autoscaler.index("benchmark-child.finished") < autoscaler.index('desired="$(_box_desired "$metrics_url")"')
    unreadable = autoscaler.split('if [ -z "$desired" ]; then', 1)[1].split("scrape_failures=0", 1)[0]
    assert unreadable.index("benchmark-child.finished") < unreadable.index(
        "metrics returned no valid desired_machine_count"
    )
    assert "autoscaler.completed-after-child.tmp" in autoscaler
    assert 'mv "$completed_tmp" "$out/autoscaler.completed-after-child"' in autoscaler
    assert "primary disappeared from provider inventory before child completion" in autoscaler
    assert "mandatory_autoscaler_process_acceptable" in final_acceptance
    assert final_acceptance.index("worker capacity below desired") < final_acceptance.index(
        "mandatory_autoscaler_process_acceptable"
    )

    # Inverse regression: an autoscaler that dies first must not be forgiven
    # merely because the child later publishes its independent finish marker.
    acceptance = _extract_fleet_function(fleet, "mandatory_autoscaler_process_acceptable() {")
    (tmp_path / "benchmark-child.finished").write_text("0\n")
    dead_before_child = subprocess.run(
        [
            "bash",
            "-c",
            (f'{acceptance}\nfleet_job_running() {{ return 1; }}\nmandatory_autoscaler_process_acceptable "$1" 999'),
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
    supervisor = _extract_fleet_function(FLEET_SCRIPT.read_text(), "run_fleet_child_supervised() {")
    terminator = _extract_fleet_function(FLEET_SCRIPT.read_text(), "terminate_fleet_runner_group() {")
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
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
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
    terminator = _extract_fleet_function(FLEET_SCRIPT.read_text(), "terminate_fleet_runner_group() {")
    supervisor = _extract_fleet_function(FLEET_SCRIPT.read_text(), "run_fleet_child_supervised() {")
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
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


def test_data_plane_proxies_retry_machine_dns_and_restart_if_lost() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    environment_helpers = ENV_HELPER_SCRIPT.read_text()
    accepted = _extract_fleet_function(environment_helpers, "cloudbench_status_proxy_lifecycle_response_accepted() {")
    starter = _extract_fleet_function(environment_helpers, "cloudbench_start_data_plane_proxy() {")
    transport = _extract_fleet_function(cloud, "status_proxy_transport_healthy() {")
    ensure = _extract_fleet_function(cloud, "ensure_status_proxy() {")
    accepted_wrapper = _extract_fleet_function(cloud, "status_proxy_lifecycle_response_accepted() {")
    starter_wrapper = _extract_fleet_function(cloud, "start_data_plane_proxy() {")

    assert "204|410|425" in accepted
    assert "CLOUDBENCH_DATA_PROXY_READY_TIMEOUT" in starter
    assert 'flyctl proxy "$local_port:$remote_port" "$host"' in starter
    assert 'kill -0 "$pid"' in starter
    assert '"http://127.0.0.1:$local_port/driver-health"' in starter
    assert 'probe_path="/"' in starter
    assert '[ "$label" = "status" ] && probe_path="/driver-health"' in starter
    assert 'status_proxy_lifecycle_response_accepted "$health_code"' in starter
    assert 'status_proxy_lifecycle_response_accepted "$health_code"' in transport
    assert "204|410|425" not in transport
    assert "resolves the remote host lazily" in starter
    assert "CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS" in starter
    assert "post-probe survival window" in starter
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))"' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 1))"' in cloud
    assert "start_leased_data_plane_proxy" in ensure
    assert "ensure_status_proxy >/dev/null 2>&1 || true" in cloud
    assert "cloudbench_status_proxy_lifecycle_response_accepted" in accepted_wrapper
    assert "cloudbench_start_data_plane_proxy" in starter_wrapper


def test_data_plane_proxy_waits_for_accepted_lifecycle_response(tmp_path: Path) -> None:
    """A live proxy PID is not ready until the remote status service answers HTTP."""
    cloud = CLOUD_SCRIPT.read_text()
    accepted_wrapper = _extract_fleet_function(cloud, "status_proxy_lifecycle_response_accepted() {")
    starter_wrapper = _extract_fleet_function(cloud, "start_data_plane_proxy() {")
    leased_starter = _extract_fleet_function(cloud, "start_leased_data_plane_proxy() {")
    transport_health = _extract_fleet_function(cloud, "status_proxy_transport_healthy() {")
    ensure = _extract_fleet_function(cloud, "ensure_status_proxy() {")
    read_log = _extract_fleet_function(cloud, "read_bench_log() {")
    read_gate = _extract_fleet_function(cloud, "cloudbench_log_read_gate() {")

    remote_reservation = socket.socket()
    remote_reservation.bind(("127.0.0.1", 0))
    remote_port = remote_reservation.getsockname()[1]
    delayed_ready = tmp_path / "delayed-status.ready"
    stop_delayed_status = threading.Event()
    delayed_servers: list[ThreadingHTTPServer] = []

    class DelayedStatusHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/driver-health":
                self.send_response(425)
            elif self.path.startswith("/bench.log?"):
                self.send_response(204)
                self.send_header("X-Cloudbench-Log-Size", "0")
                self.send_header("X-Cloudbench-Log-Generation", "0" * 32)
                self.send_header("X-Cloudbench-Log-Continuity", "1")
            else:
                self.send_response(404)
            self.end_headers()

        def log_message(self, _format: str, *args: object) -> None:
            return

    def serve_delayed_status() -> None:
        if stop_delayed_status.wait(8):
            remote_reservation.close()
            return
        remote_reservation.close()
        server = ThreadingHTTPServer(("127.0.0.1", remote_port), DelayedStatusHandler)
        delayed_servers.append(server)
        delayed_ready.write_text("ready\n")
        server.serve_forever()

    delayed_thread = threading.Thread(target=serve_delayed_status, daemon=True)
    delayed_thread.start()

    fake_proxy = tmp_path / "fake-flyctl-proxy.py"
    fake_proxy.write_text(
        """import http.client
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

remote_port = int(sys.argv[2])

class ProxyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        connection = http.client.HTTPConnection("127.0.0.1", remote_port, timeout=1)
        try:
            connection.request("GET", self.path, headers=dict(self.headers))
            response = connection.getresponse()
            body = response.read()
        except (OSError, http.client.HTTPException):
            self.close_connection = True
            return
        finally:
            connection.close()
        self.send_response(response.status)
        for name, value in response.getheaders():
            if name.lower() not in {"connection", "date", "server"}:
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *args):
        return

class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True

ReusableServer(("127.0.0.1", int(sys.argv[1])), ProxyHandler).serve_forever()
"""
    )
    fake_flyctl = tmp_path / "flyctl"
    fake_flyctl.write_text(
        "#!/usr/bin/env bash\n"
        "set -eu\n"
        '[ "$1" = proxy ]\n'
        'spec="$2"\n'
        f"exec {shlex.quote(sys.executable)} {shlex.quote(str(fake_proxy))} "
        '"${spec%%:*}" "$FAKE_REMOTE_STATUS_PORT"\n'
    )
    fake_flyctl.chmod(0o755)

    local_reservation = socket.socket()
    local_reservation.bind(("127.0.0.1", 0))
    local_port = local_reservation.getsockname()[1]
    local_reservation.close()
    script = f"""set -u
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
{accepted_wrapper}
{starter_wrapper}
{leased_starter}
{transport_health}
{ensure}
{read_log}
{read_gate}
claim_local_port() {{ printf -v "$2" '%s' "$1"; }}
release_local_port_lease() {{ :; }}
publish_status_proxy_port() {{ :; }}
cloudbench_terminate_and_wait() {{
  shift
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
cleanup() {{
  cloudbench_terminate_and_wait 1 "${{STATUS_PROXY_PID:-}}"
}}
trap cleanup EXIT
PATH={shlex.quote(str(tmp_path))}:$PATH
FAKE_REMOTE_STATUS_PORT="$2"
export FAKE_REMOTE_STATUS_PORT
APP=fake-cloudbench
OUT_DIR={shlex.quote(str(tmp_path))}
LOCAL_STATUS_PORT="$1"
REMOTE_STATUS_PORT="$2"
REMOTE_STATUS_HOST=127.0.0.1
STATUS_PROXY_PID=
CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
SSH_LOG={shlex.quote(str(tmp_path / "bench.log"))}
BENCH_LOG_HEADERS_FILE={shlex.quote(str(tmp_path / "headers"))}
: > "$SSH_LOG"
log_read_failures=0
BENCH_LOG_READ_MAX_FAILURES=5

starter_rc=0
start_leased_data_plane_proxy "$LOCAL_STATUS_PORT" LOCAL_STATUS_PORT \
  "$REMOTE_STATUS_PORT" "$REMOTE_STATUS_HOST" "$OUT_DIR/cloudbench-status-proxy.log" \
  STATUS_PROXY_PID status 12 || starter_rc=$?
[ "$starter_rc" = 0 ] || exit 90
lifecycle_code="$(curl --noproxy '*' -sS --max-time 1 -o /dev/null -w '%{{http_code}}' \
  "http://127.0.0.1:$LOCAL_STATUS_PORT/driver-health" 2>/dev/null || true)"
endpoint_ready=false
[ -f {shlex.quote(str(delayed_ready))} ] && endpoint_ready=true
premature=0
case "$lifecycle_code" in 204|410|425) ;; *) premature=1 ;; esac

bounded_failure=0
read_succeeded=0
for attempt in 1 2 3 4 5; do
  ensure_status_proxy >/dev/null 2>&1 || true
  refresh_ok=0
  read_bench_log > "$OUT_DIR/read-$attempt.chunk" && refresh_ok=1
  if cloudbench_log_read_gate "$refresh_ok"; then gate_rc=0; else gate_rc=$?; fi
  endpoint_ready=false
  [ -f {shlex.quote(str(delayed_ready))} ] && endpoint_ready=true
  case "$gate_rc" in
    0) read_succeeded=1; break ;;
    10) [ "$attempt" = "$BENCH_LOG_READ_MAX_FAILURES" ] || sleep 1 ;;
    20) bounded_failure=1; break ;;
    *) exit 91 ;;
  esac
done
if [ "$premature" = 1 ] && [ "$bounded_failure" = 1 ]; then
  echo "RCA_REPRO: proxy launcher returned ready with lifecycle HTTP $lifecycle_code; bounded bench.log read gate exhausted" >&2
  exit 97
fi
[ "$read_succeeded" = 1 ] || exit 98
"""
    try:
        result = subprocess.run(
            ["bash", "-c", script, "proxy-startup-repro", str(local_port), str(remote_port)],
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
    finally:
        stop_delayed_status.set()
        try:
            remote_reservation.close()
        except OSError:
            pass
        if delayed_servers:
            delayed_servers[0].shutdown()
            delayed_servers[0].server_close()
        delayed_thread.join(timeout=2)

    assert result.returncode == 0, f"{result.stderr}\n{result.stdout}"


def test_backend_data_plane_proxy_keeps_process_readiness_contract(tmp_path: Path) -> None:
    """Generic backend tunnels need process readiness, not status lifecycle."""
    cloud = CLOUD_SCRIPT.read_text()
    accepted_wrapper = _extract_fleet_function(cloud, "status_proxy_lifecycle_response_accepted() {")
    starter_wrapper = _extract_fleet_function(cloud, "start_data_plane_proxy() {")
    attempts = tmp_path / "attempts"
    proxy_log = tmp_path / "proxy.log"
    script = f"""set -u
ATTEMPTS={shlex.quote(str(attempts))}
APP=proxy-readiness-regression
CLOUDBENCH_PROXY_POST_PROBE_SETTLE_SECONDS=0
sleep() {{ command sleep 0.05; }}
flyctl() {{
  printf 'attempt\\n' >> "$ATTEMPTS"
  trap 'exit 0' TERM
  while :; do sleep 1; done
}}
curl() {{ printf 000; return 0; }}
source {shlex.quote(str(ENV_HELPER_SCRIPT))}
{accepted_wrapper}
{starter_wrapper}
proxy_pid=""
cleanup() {{
  cloudbench_terminate_and_wait 1 "${{proxy_pid:-}}"
}}
trap cleanup EXIT
start_data_plane_proxy 61946 3001 backend.internal {shlex.quote(str(proxy_log))} proxy_pid backend 4
test "$(wc -l < "$ATTEMPTS" | tr -d ' ')" = 1 || exit 97
kill -0 "$proxy_pid" 2>/dev/null || exit 96
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


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
    # The image must be activated before the machine is brought up, or it boots the
    # stale one. The inline `start_machine "$mid"` was centralized into
    # `require_machine_ready`, which now owns start + readiness; the ordering
    # invariant is unchanged and is still exactly what this asserts.
    assert setup.index('activate_owned_machine_images "$IMAGE_REF"') < setup.index('require_machine_ready "$mid"')


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
    assert r"\"\$CLOUDBENCH_GITHUB_TOKEN_B64\"" in setup
    assert r"git_auth() { env \"GIT_CONFIG_GLOBAL=\$auth_config\"" in setup
    assert 'setup_token_local="$(mktemp)"' in setup
    assert '-q -m 0600 "$setup_token_local" "$remote_setup_token"' in setup
    assert "CLONE_CMD_B64=" not in setup
    assert "base64 -d | bash" not in setup
    assert '-C "bash -lc \\"trap' in setup
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
    assert (
        'if ! cloudbench_terminate_tree_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" \\\n'
        '        "${AUTOSCALER_PIDS[@]:-}"; then'
    ) in cleanup
    assert (
        'if ! cloudbench_terminate_tree_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" \\\n'
        '        "${PROVISION_PIDS[@]:-}"; then'
    ) in cleanup
    assert ('cloudbench_terminate_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" "${CHILD_PIDS[@]:-}"') in cleanup
    assert "CLOUDBENCH_CHILD_TERM_SECONDS:-30" in fleet
    helper = ENV_HELPER_SCRIPT.read_text()
    assert "cloudbench_terminate_and_wait() {" in helper
    assert "cloudbench_terminate_tree_and_wait() {" in helper
    assert "cloudbench_detach_reexec_tracked() {" in helper
    assert "cloudbench_wait_tracked_detached() {" in helper
    assert "ps -axo pid=,ppid=,lstart=" in helper
    assert "cloudbench_pid_matches_start" in helper
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
    write_end = fleet.index("# Self-heal a same-host dead claim", write_start)
    write_function = (
        _extract_fleet_function(fleet, "registry_meta_value() {")
        + _extract_fleet_function(fleet, "pool_claim_fs_transaction() {")
        + fleet[write_start:write_end]
    )
    function_start = fleet.index("claim_pool_machine() {")
    function_end = fleet.index("\n}\n", function_start) + 3
    claim_function = fleet[function_start:function_end]
    pool_file = tmp_path / "pool.ids"
    pool_meta_file = Path(f"{pool_file}.deps")
    claims_file = tmp_path / "run" / "claimed-pool.ids"
    global_claims = tmp_path / "global-claims"
    starts_file = tmp_path / "starts"
    pool_file.write_text("abc123\ndef456\nfed789\n")
    pool_meta_file.write_text("snapshot=snapshot-1\n")

    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
POOL_IDS_FILE="$POOL_FILE"
POOL_META_FILE="$POOL_META_FILE"
CLAIMED_POOL_FILE="$CLAIMS_FILE"
POOL_CLAIMS_DIR="$GLOBAL_CLAIMS"
POOL_INVENTORY_JSON='[]'
UNAVAILABLE_POOL_IDS=(abc123)
FLEET_OWNER_HOST=test-host
FLEET_OWNER_PID_START='Mon Jan  1 00:00:00 2001'
FLEET_OWNER_TOKEN={"a" * 32}
FLEET_OWNERSHIP_ROOT={shlex.quote(str(tmp_path / "fleet-ownership"))}
cloudbench_env_sha256() {{ printf '%064d' 0; }}
registry_owner_alive() {{ return 0; }}
machine_volume_id_from_json() {{ cat >/dev/null; printf 'vol-%s' "$1"; }}
fleet_audit_record_pool_machine() {{ return 0; }}
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
            "POOL_META_FILE": str(pool_meta_file),
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


def test_cleanup_unconfirmed_pool_claim_survives_successor_fleet(tmp_path: Path) -> None:
    """A dead controller is not cleanup authority after its guest failed ack.

    Successor reconciliation, claiming, and exact-owner recovery must all leave
    the same running pool machine and claim untouched until an operator resolves
    the browser/session cleanup boundary.
    """
    fleet = FLEET_SCRIPT.read_text()
    support = "".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "registry_owner_alive() {",
            "pool_claim_owned_by_current() {",
            "pool_claim_cleanup_unconfirmed() {",
            "pool_machine_state_from_json() {",
            "pool_machine_state() {",
            "reconcile_pool() {",
            "claim_pool_machine() {",
            "recover_exact_pool_claims() {",
        )
        if signature in fleet
    )
    git_common = tmp_path / "git-common"
    pool_file = git_common / "cloudbench-pools" / "workspace.ids"
    claims_dir = git_common / "cloudbench-pool-claims"
    registry_root = git_common / "cloudbench-fleet-ownership"
    owner_token = "b" * 32
    claim = claims_dir / "abc123"
    owner_meta = registry_root / owner_token / "meta"
    operations = tmp_path / "operations"
    machine_state = tmp_path / "machine-state"
    claimed_file = tmp_path / "successor" / "claimed.ids"
    pool_file.parent.mkdir(parents=True)
    claims_dir.mkdir(parents=True)
    owner_meta.parent.mkdir(parents=True)
    pool_file.write_text("abc123\n")
    machine_state.write_text("started\n")
    claim.write_text(
        f"host={socket.gethostname()}\n"
        "pid=999999\n"
        "pid_start=Mon Jan  1 00:00:00 2001\n"
        f"fleet_owner_token={owner_token}\n"
        "cleanup_state=unconfirmed\n"
    )
    owner_meta.write_text(f"host={socket.gethostname()}\npid=999999\npid_start=Mon Jan  1 00:00:00 2001\n")
    (owner_meta.parent / "guest-cleanup-unconfirmed").touch()

    script = f"""set -uo pipefail
APP=bench-app
GIT_COMMON_DIR={shlex.quote(str(git_common))}
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(claims_dir))}
FLEET_OWNERSHIP_ROOT={shlex.quote(str(registry_root))}
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={"c" * 32}
CLAIMED_POOL_FILE={shlex.quote(str(claimed_file))}
UNAVAILABLE_POOL_IDS=()
FLY() {{
  if [ "$1 $2" = "machines list" ]; then
    printf '[{{"id":"abc123","state":"%s"}}]\n' "$(cat {shlex.quote(str(machine_state))})"
    return 0
  fi
  if [ "$1 $2" = "machine stop" ]; then
    printf 'stopped\n' > {shlex.quote(str(machine_state))}
  fi
  printf '%s\n' "$*" >> {shlex.quote(str(operations))}
  return 0
}}
registry_runner_count() {{ printf 'runner-probe\n' >> {shlex.quote(str(operations))}; printf 0; }}
cloudbench_env_sha256() {{ printf '%064d' 0; }}
sleep() {{ :; }}
{support}
reconcile_pool || exit $?
claimed="$(claim_pool_machine)"
[ -z "$claimed" ] || exit 20
if recover_exact_pool_claims {shlex.quote(str(owner_meta))}; then
  exit 21
fi
[ -f {shlex.quote(str(claim))} ] || exit 22
printf 'unavailable=%s\n' "${{UNAVAILABLE_POOL_IDS[*]}}"
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 0, result.stderr
    assert "unavailable=abc123" in result.stdout
    assert claim.exists()
    assert not operations.exists(), operations.read_text() if operations.exists() else ""


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
machine_volume_id() {{ printf 'vol-owned-target'; }}
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
    """Only failures before volume creation may discard ownership outright.

    A VM-launch rejection can leave a provider-created volume behind. Its
    exact ID must remain the cleanup authority instead of being misclassified
    as an allocation-free failure.
    """
    fleet = FLEET_SCRIPT.read_text()
    classifier = _extract_fleet_function(fleet, "clone_failure_definitively_unallocated() {")
    owned_volume = _extract_fleet_function(fleet, "clone_failure_owned_volume_id() {")
    cloner = _clone_machine_bundle(fleet)
    script = f"""SOURCE_ID=683e47df5094d8
{classifier}
{owned_volume}
for message in \
  'Error: failed to create volume: resource_exhausted: rate limit exceeded' \
  'Error: failed to create volume: machine capacity hold failed' \
  'Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded (Request ID: captured-lax)'; do
  clone_failure_definitively_unallocated 1 "$SOURCE_ID" "$message" || exit 1
done
clone_failure_definitively_unallocated 1 "$SOURCE_ID" \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_x'\" \
  && exit 2
clone_failure_definitively_unallocated 1 "$SOURCE_ID" \
  'Error: failed to launch VM: volume not found' && exit 2
clone_failure_definitively_unallocated 1 "$SOURCE_ID" \
  'Error: could not get machine feedface000000: failed to get VM feedface000000: resource_exhausted: rate limit exceeded' \
  && exit 2
clone_failure_definitively_unallocated 142 "$SOURCE_ID" \
  'Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded' \
  && exit 2
clone_failure_definitively_unallocated 1 "$SOURCE_ID" \
  $'Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded\\nError: failed to create volume: resource_exhausted' \
  && exit 2
test -z \"$(clone_failure_owned_volume_id 1 \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_exact_123'\")\" || exit 3
[ \"$(clone_failure_owned_volume_id 1 \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_exact123'\")\" \
  = vol_exact123 ] || exit 4
test -z \"$(clone_failure_owned_volume_id 1 'Error: failed to create volume: resource_exhausted')\" \
  || exit 5
test -z \"$(clone_failure_owned_volume_id 1 \
  \"notice: retrying existing volume 'vol_unowned123' after timeout\")\" || exit 6
test -z \"$(clone_failure_owned_volume_id 1 \
  \"timed out; Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_unowned123'\")\" || exit 7
test -z \"$(clone_failure_owned_volume_id 1 \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'neighbor123'\")\" || exit 8
ambiguous_output="$(printf '%s\n' \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_first123'\" \
  'operation timed out while waiting for clone response')"
test -z \"$(clone_failure_owned_volume_id 1 "$ambiguous_output")\" || exit 9
test -z \"$(clone_failure_owned_volume_id 142 \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_timeout123'\")\" || exit 10
runtime_log="$(printf '%s\n' \
  'clone name=cloudbench-ff94c207ec984ab8922dfc65 source=871535c0322758 status=1 attempt=1/5' \
  'Cloning Machine 871535c0322758 into region iad' \
  'Creating new volume from snapshot: vs_JO5KLvjwP8XuQG4X927' \
  'Provisioning a new Machine with image registry.fly.io/fixture-bench-app:cloudbench-warm-local-20260716-1935@sha256:6bc0b02589f731a02d8baf5236272f5d402c4c09adf4560272b2e396c78bf68a...' \
  \"Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_vp2q8xeydwjm79w4' (Request ID: 01M1XBMTXS1C4PWJAXJ66YHV08-iad)\")"
runtime_transcript="${{runtime_log#*$'\n'}}"
[ \"$(clone_failure_owned_volume_id 1 "$runtime_transcript")\" = vol_vp2q8xeydwjm79w4 ] || exit 11
multiple_errors="$runtime_transcript
Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_second123'"
test -z \"$(clone_failure_owned_volume_id 1 "$multiple_errors")\" || exit 12
bad_request="$runtime_transcript
"
bad_request="${{bad_request%$'\n'}}"
bad_request="${{bad_request/01M1XBMTXS1C4PWJAXJ66YHV08-iad/invalid request id}}"
test -z \"$(clone_failure_owned_volume_id 1 "$bad_request")\" || exit 13
exit 0
"""
    result = subprocess.run(["bash", "-c", script], check=False)
    assert result.returncode == 0
    assert 'fleet_registry_record_volume "$target_name" "$target_volume"' in cloner
    assert 'reap_volume "$target_volume"' in cloner
    assert 'fleet_registry_release_name "$target_name"' in cloner
    assert cloner.index('fleet_registry_record_volume "$target_name" "$target_volume"') < cloner.index(
        'reap_volume "$target_volume"'
    )
    assert cloner.index('reap_volume "$target_volume"') < cloner.index('fleet_registry_release_name "$target_name"')
    volume_classification = cloner.index(
        'target_volume="$(clone_failure_owned_volume_id "$clone_status" "$clone_out")"'
    )
    durable_volume = cloner.index(
        'fleet_registry_record_volume "$target_name" "$target_volume"',
        volume_classification,
    )
    name_reconciliation = cloner.index('target_id="$(machine_id_for_clone_name "$target_name" "$deadline")"')
    assert volume_classification < durable_volume < name_reconciliation


def test_failed_clone_captures_owned_volume_before_machine_name_reconciliation(
    tmp_path: Path,
) -> None:
    """A provider-created volume from a rejected VM launch is still owned.

    The exact ID returned by that clone attempt must be classified before any
    machine-name reconciliation, durably recorded, and reaped. No app-wide
    volume listing or neighbor-volume deletion is allowed.
    """
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "fly_with_timeout() {",
            "volume_inventory_contains_id() {",
            "reap_volume() {",
            "registry_meta_value() {",
            "fleet_registry_record_name() {",
            "fleet_registry_record_volume() {",
            "fleet_registry_release_name() {",
            "clone_failure_definitively_unallocated() {",
            "clone_failure_owned_volume_id() {",
            "clone_machine_target() {",
        )
    )
    registry = tmp_path / "registry"
    (registry / "clones").mkdir(parents=True)
    ledger = tmp_path / "owned.ids"
    calls = tmp_path / "calls"
    calls.write_text("")

    script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=683e47df5094d8
WARM_VOLUME_ID=vol_warm
SNAP_ID=vs_D7yODvl0BVgi9JajQpkR
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
LEDGER={shlex.quote(str(ledger))}
CALLS={shlex.quote(str(calls))}
CLOUDBENCH_CLONE_MAX_ATTEMPTS=1
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
python3() {{
  case "$*" in
    *uuid.uuid4*) printf '%s\n' 54c419a2a76f4b27bfc46694 ;;
    *) command python3 "$@" ;;
  esac
}}
FLY() {{
  case "$1 $2" in
    "machine clone")
      printf "%s\n" \
        'Cloning Machine 683e47df5094d8 into region iad' \
        'Creating new volume from snapshot: vs_D7yODvl0BVgi9JajQpkR' \
        'Provisioning a new Machine with image registry.fly.io/fixture-bench-app:cloudbench-warm-local-20260716-1935@sha256:6bc0b02589f731a02d8baf5236272f5d402c4c09adf4560272b2e396c78bf68a...' \
        "Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_vz8m80el8w7dwqxv' (Request ID: 01M24BSMAJSAD16GZG888ECDZG-lax)" >&2
      return 1 ;;
    "volumes destroy")
      printf '%s\n' "$*" >> "$CALLS"
      [ "$3" = vol_vz8m80el8w7dwqxv ] || return 99
      return 1 ;;
    "volumes show")
      printf '%s\n' "$*" >> "$CALLS"
      printf '%s\n' '{{"id":"vol_vz8m80el8w7dwqxv","state":"pending_destroy"}}'
      return 0 ;;
  esac
  return 99
}}
machine_id_for_clone_name() {{
  printf 'clone-name lookup entered: %s\n' "$1" >> "$CALLS"
  return 1
}}
registry_resolve_name() {{ return 1; }}
fleet_audit_record_fresh_clone() {{ return 0; }}
fleet_audit_update_fresh_clone() {{ return 0; }}
{functions}
clone_rc=0
clone_machine_target "$LEDGER" >/dev/null 2>&1 || clone_rc=$?
[ "$clone_rc" -ne 0 ] || exit 90
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    call_log = calls.read_text().splitlines()
    owner_records = list((registry / "clones").iterdir())
    assert result.returncode == 0, result.stderr + result.stdout
    assert not any("clone-name lookup entered" in call for call in call_log), (
        f"provider-owned volume failure crossed into target machine-name reconciliation: {call_log}"
    )
    assert call_log == [
        "volumes destroy vol_vz8m80el8w7dwqxv -a bench-app --yes",
        "volumes show vol_vz8m80el8w7dwqxv -a bench-app --json",
    ]
    diagnostic_lines = ledger.with_suffix(".log").read_text().splitlines()
    assert diagnostic_lines[:5] == [
        "clone name=cloudbench-54c419a2a76f4b27bfc46694 source=683e47df5094d8 status=1 attempt=1/1",
        "Cloning Machine 683e47df5094d8 into region iad",
        "Creating new volume from snapshot: vs_D7yODvl0BVgi9JajQpkR",
        "Provisioning a new Machine with image registry.fly.io/fixture-bench-app:cloudbench-warm-local-20260716-1935@sha256:6bc0b02589f731a02d8baf5236272f5d402c4c09adf4560272b2e396c78bf68a...",
        "Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_vz8m80el8w7dwqxv' (Request ID: 01M24BSMAJSAD16GZG888ECDZG-lax)",
    ]
    assert len(diagnostic_lines) == 6
    assert re.fullmatch(
        r"\[[^]]+\] volume destroy attempt 1/6 "
        r"id=vol_vz8m80el8w7dwqxv rc=1 response=<empty>",
        diagnostic_lines[-1],
    )
    assert not owner_records, "successful exact-volume cleanup must retire its owner record"


def test_failed_clone_retains_exact_owner_when_delete_absence_is_unknown(
    tmp_path: Path,
) -> None:
    """Destroy + lifecycle-read failure must retain ownership for recovery.

    The exact volume record must exist before the first delete attempt. Neither
    a failed provider read, invalid JSON, nor a live state proves deletion.
    """
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "fly_with_timeout() {",
            "volume_inventory_contains_id() {",
            "reap_volume() {",
            "registry_meta_value() {",
            "fleet_registry_record_name() {",
            "fleet_registry_record_volume() {",
            "fleet_registry_release_name() {",
            "clone_failure_definitively_unallocated() {",
            "clone_failure_owned_volume_id() {",
            "clone_machine_target() {",
        )
    )

    for show_mode in ("failure", "invalid-json", "present"):
        case_root = tmp_path / show_mode
        registry = case_root / "registry"
        (registry / "clones").mkdir(parents=True)
        ledger = case_root / "owned.ids"
        calls = case_root / "calls"
        calls.write_text("")
        script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=feedface000000
WARM_VOLUME_ID=vol_warm
SNAP_ID=snapshot-1
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
LEDGER={shlex.quote(str(ledger))}
CALLS={shlex.quote(str(calls))}
SHOW_MODE={shlex.quote(show_mode)}
CLOUDBENCH_CLONE_MAX_ATTEMPTS=1
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
sleep() {{ :; }}
FLY() {{
  case "$1 $2" in
    "machine clone")
      printf '%s\n' \
        "Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_exactowned'" >&2
      return 1 ;;
    "volumes destroy")
      record="$(find "$FLEET_REGISTRY_DIR/clones" -type f | head -1)"
      if [ -z "$record" ] || ! grep -Fxq 'volume_id=vol_exactowned' "$record"; then
        printf '%s\n' 'destroy-before-record' >> "$CALLS"
        return 97
      fi
      printf '%s\n' "$*" >> "$CALLS"
      return 0 ;;
    "volumes show")
      printf '%s\n' "$*" >> "$CALLS"
      if [ "$SHOW_MODE" = failure ]; then
        printf '%s\n' 'provider lifecycle read timed out' >&2
        return 1
      fi
      if [ "$SHOW_MODE" = present ]; then
        printf '%s\n' '{{"id":"vol_exactowned","state":"created"}}'
        return 0
      fi
      printf '%s\n' '{{not-json'
      return 0 ;;
  esac
  return 99
}}
machine_id_for_clone_name() {{ return 1; }}
registry_resolve_name() {{ return 1; }}
fleet_audit_record_fresh_clone() {{ return 0; }}
fleet_audit_update_fresh_clone() {{ return 0; }}
{functions}
clone_rc=0
clone_machine_target "$LEDGER" >/dev/null 2>&1 || clone_rc=$?
[ "$clone_rc" -ne 0 ] || exit 90
record="$(find "$FLEET_REGISTRY_DIR/clones" -type f | head -1)"
[ -n "$record" ] || exit 91
[ "$(registry_meta_value "$record" volume_id)" = vol_exactowned ] || exit 92
grep -Fxq "$(registry_meta_value "$record" name)" "${{LEDGER%.ids}}.names" || exit 93
"""
        result = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

        assert result.returncode == 0, f"{show_mode}: {result.stderr}{result.stdout}"
        log = calls.read_text()
        assert "destroy-before-record" not in log
        assert log.count("volumes destroy vol_exactowned -a bench-app --yes") == 6
        assert log.count("volumes show vol_exactowned -a bench-app --json") == 6


def test_pool_promotes_only_successful_owned_clone_ids() -> None:
    fleet = FLEET_SCRIPT.read_text()
    pool_function = _extract_fleet_function(fleet, "provision_pool_slot() {")

    clone_call = 'id="$(clone_machine_target "$slot_ledger")"'
    promotion = 'if ! pool_ledger_record_id "$id"; then'
    pending_transfer = 'if ! fleet_audit_update_fresh_clone "$clone_name" "$id" "" transfer-pending-stopped; then'
    registry_release = 'if ! fleet_registry_release_exact_clone "$clone_name" "$id"; then'
    immutable_handoff = 'if ! fleet_audit_record_pool_handoff "$claim_path" "$clone_name" "$id" "$volume_id"; then'
    terminal_transfer = 'if ! fleet_audit_update_fresh_clone "$clone_name" "$id" "" transferred-to-pool-stopped; then'
    claim_release = 'pool_claim_release_exact "$claim_path" "$claim_digest" "$FLEET_OWNER_TOKEN"'
    assert clone_call in pool_function
    assert pool_function.index(clone_call) < pool_function.index(promotion)
    assert pool_function.index(promotion) < pool_function.index(pending_transfer)
    assert pool_function.index(pending_transfer) < pool_function.index(registry_release)
    assert pool_function.index(registry_release) < pool_function.index(immutable_handoff)
    assert pool_function.index(immutable_handoff) < pool_function.index(terminal_transfer)
    terminal_index = pool_function.index(terminal_transfer)
    assert terminal_index < pool_function.index(claim_release, terminal_index)
    assert 'rm -f "$claim_path"' not in pool_function
    assert 'fleet_registry_release_id "$id"' not in pool_function
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

    pool_branch = fleet[fleet.index('if [ -n "$PROVISION_POOL" ]; then') :]
    assert pool_branch.index("start_machines_snapshot_loop") < pool_branch.index('provision_pool "$PROVISION_POOL"')


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


def test_fleet_terminal_projection_uses_two_archives_and_one_terminal_task_list(
    tmp_path: Path,
) -> None:
    fleet = tmp_path / "terminal-projection"
    batch = fleet / "_batch"
    batch.mkdir(parents=True)
    benches = [
        {"name": "success", "mode": "REAL"},
        {"name": "benchmark-failure", "mode": "REAL"},
        {"name": "early-failure", "mode": "REAL"},
    ]
    (batch / "benches.json").write_text(json.dumps(benches))
    archived_tasks = {
        "success": {
            "name": "success",
            "passed": True,
            "status": "PASSED",
            "duration_seconds": 11,
            "cost_cents": 2.5,
            "tokens_in": 10,
            "tokens_out": 4,
            "world_model_mode": "real",
        },
        "benchmark-failure": {
            "name": "benchmark-failure",
            "passed": False,
            "status": "FAILED",
            "duration_seconds": 13,
            "cost_cents": 1.5,
            "tokens_in": 8,
            "tokens_out": 2,
            "world_model_mode": "real",
            "failure_reason": "benchmark assertion failed",
        },
    }
    for name, task in archived_tasks.items():
        task_dir = fleet / name
        task_dir.mkdir()
        (task_dir / "cloudbench-run.json").write_text(json.dumps({"tasks": [task]}))

    output = batch / "run.json"
    env = {
        **os.environ,
        "CLOUDBENCH_CONTROLLER_ELAPSED_SECONDS": "47.5",
    }
    command = [sys.executable, str(AGGREGATE_SCRIPT), str(fleet), str(output)]
    first = subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert first.returncode == 0, first.stderr
    run = json.loads(output.read_text())
    report_path = batch / "report-card.json"
    report_names = []
    if report_path.is_file():
        report_names = [row.get("name") for row in json.loads(report_path.read_text()).get("per_task", [])]
    expected_names = [bench["name"] for bench in benches]
    missing = [name for name in expected_names if name not in report_names]
    assert not missing, f"terminal child outcomes absent from batch card: {missing}"

    report = json.loads(report_path.read_text())
    assert [task["name"] for task in run["tasks"]] == expected_names
    assert run["elapsed_s"] == 47.5
    assert report["elapsed_s"] == 47.5
    assert [row["status"] for row in report["per_task"]] == [
        "passed",
        "failed",
        "error",
    ]
    assert report["per_task"][1]["failure_reason"] == "benchmark assertion failed"
    assert report["per_task"][2]["failure_reason"] == "no current run artifact produced"
    assert report["tasks"] == {
        "total": 3,
        "running": 0,
        "completed": 3,
        "queued": 0,
    }
    assert report["results"] == {
        "passed": 1,
        "failed": 2,
        "transient": 0,
        "success_rate": 0.333,
    }

    second = subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert second.returncode == 0, second.stderr
    rerun = json.loads(output.read_text())
    rerun_report = json.loads(report_path.read_text())
    assert rerun["tasks"] == run["tasks"]
    assert rerun_report["per_task"] == report["per_task"]
    assert len(rerun["tasks"]) == len(benches)
    assert len(rerun_report["per_task"]) == len(benches)

    fleet_source = FLEET_SCRIPT.read_text()
    cleanup = _extract_fleet_function(fleet_source, "cleanup() {")
    assert 'finalize_terminal_projection "$ec"' in cleanup
    assert "trap cleanup EXIT" in fleet_source


def test_fleet_terminal_projection_runs_from_signal_exit_finalization(
    tmp_path: Path,
) -> None:
    fleet = tmp_path / "signal-finalization"
    batch = fleet / "_batch"
    batch.mkdir(parents=True)
    (batch / "benches.json").write_text(json.dumps([{"name": "interrupted-infra", "mode": "REAL"}]))
    finalizer = _extract_fleet_function(
        FLEET_SCRIPT.read_text(),
        "finalize_terminal_projection() {",
    )
    script = f"""set -uo pipefail
FLEET_DIR={shlex.quote(str(fleet))}
PROVISION_POOL=
FLEET_CONTROLLER_STARTED_EPOCH=$(($(date +%s) - 2))
AGGREGATE_RUNS_SCRIPT={shlex.quote(str(AGGREGATE_SCRIPT))}
EXECUTION_PROVENANCE_FILE=
EXECUTION_TASK_MATRIX_FILE=
{finalizer}
cleanup() {{
  result_ec=$?
  trap - EXIT
  trap '' HUP INT TERM
  finalize_terminal_projection "$result_ec" || exit 1
  exit "$result_ec"
}}
trap cleanup EXIT
trap 'exit 143' TERM
kill -TERM "$$"
exit 99
"""

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 143, result.stderr
    run = json.loads((batch / "run.json").read_text())
    report = json.loads((batch / "report-card.json").read_text())
    assert run["controller_exit_code"] == 143
    assert run["status"] == "failed"
    assert run["tasks"][0]["status"] == "INFRA_ERROR"
    assert run["elapsed_s"] >= 2
    assert report["controller_exit_code"] == 143
    assert report["status"] == "failed"
    assert report["per_task"][0]["status"] == "error"
    assert report["per_task"][0]["failure_reason"] == "no current run artifact produced"


def _make_execution_provenance(tmp_path: Path) -> tuple[Path, Path, Path]:
    snapshot = tmp_path / "controller-snapshot"
    snapshot.mkdir()
    shutil.copy2(EXECUTION_PROVENANCE_SCRIPT, snapshot / EXECUTION_PROVENANCE_SCRIPT.name)
    (snapshot / "run-bench-cloud").write_text("controller bytes\n")
    manifest = snapshot / "cloudbench-controller-snapshot-manifest.json"
    made_manifest = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "snapshot",
            "--snapshot-dir",
            str(snapshot),
            "--output",
            str(manifest),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert made_manifest.returncode == 0, made_manifest.stderr
    provenance = tmp_path / "execution-provenance.json"
    made_provenance = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "create",
            "--base-sha",
            "a" * 40,
            "--workspace-patch-sha256",
            "none",
            "--snapshot-dir",
            str(snapshot),
            "--snapshot-manifest",
            str(manifest),
            "--config-version",
            "cloudbench-fleet-config-v1",
            "--config-value",
            "region=iad",
            "--config-value",
            "run_timeout_seconds=3600",
            "--output",
            str(provenance),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert made_provenance.returncode == 0, made_provenance.stderr
    return snapshot, manifest, provenance


def test_execution_provenance_binds_immutable_snapshot_not_mutable_checkout(
    tmp_path: Path,
) -> None:
    snapshot, manifest, provenance = _make_execution_provenance(tmp_path)
    document = json.loads(provenance.read_text())
    assert document["schema_version"] == "cloudbench-execution-provenance-v1"
    assert document["base_sha"] == "a" * 40
    assert document["workspace_patch_sha256"] == "none"
    assert re.fullmatch(r"[0-9a-f]{64}", document["controller_snapshot"]["sha256"])
    assert document["config"]["values"] == {
        "region": "iad",
        "run_timeout_seconds": "3600",
    }

    # Editing the checkout after snapshot creation cannot alter the attested
    # bytes. Editing the actual immutable snapshot must fail closed as stale.
    mutable_checkout = tmp_path / "checkout" / "scripts" / "run-bench-cloud"
    mutable_checkout.parent.mkdir(parents=True)
    mutable_checkout.write_text("changed checkout bytes\n")
    verified = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "verify-snapshot",
            "--snapshot-dir",
            str(snapshot),
            "--manifest",
            str(manifest),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert verified.returncode == 0, verified.stderr
    assert json.loads(provenance.read_text()) == document

    (snapshot / "run-bench-cloud").write_text("stale controller bytes\n")
    stale = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "verify-snapshot",
            "--snapshot-dir",
            str(snapshot),
            "--manifest",
            str(manifest),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert stale.returncode != 0
    assert "snapshot digest mismatch" in stale.stderr


def test_execution_provenance_snapshot_stays_sealed_across_real_consumers(
    tmp_path: Path,
) -> None:
    """Snapshot-local imports must never create unattested bytecode at runtime."""
    fleet_source = FLEET_SCRIPT.read_text()
    cloud_source = CLOUD_SCRIPT.read_text()
    boot_source = BOOT_SCRIPT.read_text()
    driver_source = DRIVER_SCRIPT.read_text()
    no_bytecode_export = "export PYTHONDONTWRITEBYTECODE=1"
    first_snapshot_python_consumers = (
        (
            "fleet",
            fleet_source,
            'python3 "$CLOUDBENCH_SCRIPT_SNAPSHOT/$SCRIPT_SNAPSHOT_OWNER_HELPER" claim',
        ),
        (
            "cloud child",
            cloud_source,
            'python3 "$CLOUDBENCH_CATALOG_SCRIPT" metadata',
        ),
        (
            "guest boot",
            boot_source,
            'setsid python3 "$STATUS_SERVER_SCRIPT"',
        ),
        (
            "guest driver",
            driver_source,
            'python3 "$EXECUTION_PROVENANCE_SCRIPT" verify-code',
        ),
    )
    for entrypoint, source, first_consumer in first_snapshot_python_consumers:
        assert source.count(no_bytecode_export) == 1, entrypoint
        assert first_consumer in source, entrypoint
        assert source.index(no_bytecode_export) < source.index(first_consumer), entrypoint

    snapshot = tmp_path / "controller-snapshot"
    snapshot.mkdir()
    for source in (
        EXECUTION_PROVENANCE_SCRIPT,
        ROOT / "scripts" / "cloudbench_catalog.py",
        CLOUDBENCH_RESULT_SCRIPT,
        AGGREGATE_SCRIPT,
    ):
        shutil.copy2(source, snapshot / source.name)
    (snapshot / "run-bench-cloud").write_text("controller bytes\n")

    manifest = snapshot / "cloudbench-controller-snapshot-manifest.json"
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    def run_snapshot_python(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, *args],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_snapshot_still_sealed() -> None:
        verified = run_snapshot_python(
            str(snapshot / EXECUTION_PROVENANCE_SCRIPT.name),
            "verify-snapshot",
            "--snapshot-dir",
            str(snapshot),
            "--manifest",
            str(manifest),
        )
        assert verified.returncode == 0, verified.stderr
        assert not list(snapshot.rglob("__pycache__"))
        assert not list(snapshot.rglob("*.pyc"))

    sealed = run_snapshot_python(
        str(snapshot / EXECUTION_PROVENANCE_SCRIPT.name),
        "snapshot",
        "--snapshot-dir",
        str(snapshot),
        "--output",
        str(manifest),
    )
    assert sealed.returncode == 0, sealed.stderr

    catalog = run_snapshot_python(
        "-c",
        "import sys; sys.path.insert(0, sys.argv[1]); import cloudbench_catalog",
        str(snapshot),
    )
    assert catalog.returncode == 0, catalog.stderr
    assert_snapshot_still_sealed()

    matrix = tmp_path / "execution-task-matrix.json"
    matrix_result = run_snapshot_python(
        str(snapshot / EXECUTION_PROVENANCE_SCRIPT.name),
        "digest-task-matrix",
        "--task",
        "one=real",
        "--output",
        str(matrix),
    )
    assert matrix_result.returncode == 0, matrix_result.stderr
    provenance = tmp_path / "execution-provenance.json"
    created = run_snapshot_python(
        str(snapshot / EXECUTION_PROVENANCE_SCRIPT.name),
        "create",
        "--base-sha",
        "a" * 40,
        "--workspace-patch-sha256",
        "none",
        "--snapshot-dir",
        str(snapshot),
        "--snapshot-manifest",
        str(manifest),
        "--config-value",
        "region=iad",
        "--config-value",
        "task_count=1",
        "--config-value",
        f"task_matrix_sha256={matrix_result.stdout.strip()}",
        "--output",
        str(provenance),
    )
    assert created.returncode == 0, created.stderr
    assert_snapshot_still_sealed()

    raw_run = tmp_path / "raw-run.json"
    raw_run.write_text(
        json.dumps(
            {
                "timestamp": "2026-09-07T00:00:00+00:00",
                "summary": {"total": 1, "passed": 1, "failed": 0, "pass_rate": 1.0},
                "tasks": [{"name": "one", "passed": True, "world_model_mode": "real"}],
            }
        )
    )
    stamped_run = tmp_path / "stamped-run.json"
    stamped = run_snapshot_python(
        str(snapshot / EXECUTION_PROVENANCE_SCRIPT.name),
        "stamp",
        "--run-json",
        str(raw_run),
        "--provenance",
        str(provenance),
        "--output",
        str(stamped_run),
    )
    assert stamped.returncode == 0, stamped.stderr
    result = run_snapshot_python(
        str(snapshot / CLOUDBENCH_RESULT_SCRIPT.name),
        str(stamped_run),
        "--expected-task",
        "one",
        "--expected-world-model-mode",
        "real",
        "--expected-execution-provenance-file",
        str(provenance),
    )
    assert result.returncode == 0, result.stderr
    assert_snapshot_still_sealed()

    fleet_dir = tmp_path / "fleet"
    (fleet_dir / "_batch").mkdir(parents=True)
    (fleet_dir / "_batch" / "benches.json").write_text(json.dumps([{"name": "one", "mode": "REAL"}]))
    (fleet_dir / "one").mkdir()
    shutil.copy2(stamped_run, fleet_dir / "one" / "cloudbench-run.json")
    aggregated = run_snapshot_python(
        str(snapshot / AGGREGATE_SCRIPT.name),
        str(fleet_dir),
        str(fleet_dir / "_batch" / "run.json"),
        "--expected-execution-provenance-file",
        str(provenance),
        "--expected-execution-task-matrix-file",
        str(matrix),
    )
    assert aggregated.returncode == 0, aggregated.stderr
    assert_snapshot_still_sealed()


def test_execution_provenance_config_is_an_exact_nonsecret_allowlist(
    tmp_path: Path,
) -> None:
    snapshot, manifest, _provenance = _make_execution_provenance(tmp_path)
    for assignment in (
        "behavior_switch=arbitrary-future-value",
        "accesstoken=must-never-enter-artifact",
    ):
        output = tmp_path / f"rejected-{assignment.partition('=')[0]}.json"
        rejected = subprocess.run(
            [
                sys.executable,
                str(EXECUTION_PROVENANCE_SCRIPT),
                "create",
                "--base-sha",
                "a" * 40,
                "--workspace-patch-sha256",
                "none",
                "--snapshot-dir",
                str(snapshot),
                "--snapshot-manifest",
                str(manifest),
                "--config-value",
                assignment,
                "--output",
                str(output),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert rejected.returncode != 0
        assert "allowlisted" in rejected.stderr or "secret-like" in rejected.stderr
        assert "must-never-enter-artifact" not in rejected.stderr
        assert not output.exists()


def test_cloud_fleet_acceptance_rejects_missing_and_opposite_provenance(
    tmp_path: Path,
) -> None:
    _snapshot, _manifest, expected = _make_execution_provenance(tmp_path)
    bare_run = {
        "timestamp": "2026-09-07T00:00:00+00:00",
        "summary": {"total": 1, "passed": 1, "failed": 0, "pass_rate": 1.0},
        "tasks": [{"name": "one", "passed": True}],
    }
    unstamped = tmp_path / "unstamped.json"
    unstamped.write_text(json.dumps(bare_run))
    missing = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(unstamped),
            "--expected-task",
            "one",
            "--expected-execution-provenance-file",
            str(expected),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert missing.returncode != 0
    assert "execution provenance" in missing.stderr

    stamped = tmp_path / "stamped.json"
    stamp = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "stamp",
            "--run-json",
            str(unstamped),
            "--provenance",
            str(expected),
            "--output",
            str(stamped),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert stamp.returncode == 0, stamp.stderr
    accepted = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(stamped),
            "--expected-task",
            "one",
            "--expected-execution-provenance-file",
            str(expected),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert accepted.returncode == 0, accepted.stderr

    opposite = json.loads(expected.read_text())
    opposite["config"]["values"]["region"] = "ord"
    opposite["config"]["sha256"] = hashlib.sha256(
        json.dumps(
            {
                "schema_version": opposite["config"]["schema_version"],
                "values": opposite["config"]["values"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    opposite_path = tmp_path / "opposite.json"
    opposite_path.write_text(json.dumps(opposite))
    opposite_run = tmp_path / "opposite-run.json"
    changed = json.loads(stamped.read_text())
    changed["execution_provenance"] = opposite
    changed["tasks"][0]["execution_provenance"] = opposite
    opposite_run.write_text(json.dumps(changed))
    rejected = subprocess.run(
        [
            sys.executable,
            str(CLOUDBENCH_RESULT_SCRIPT),
            str(opposite_run),
            "--expected-task",
            "one",
            "--expected-execution-provenance-file",
            str(expected),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected.returncode != 0
    assert "does not match expected" in rejected.stderr

    fleet = tmp_path / "fleet"
    (fleet / "_batch").mkdir(parents=True)
    task_matrix = fleet / "execution-task-matrix.json"
    wrote_matrix = subprocess.run(
        [
            sys.executable,
            str(EXECUTION_PROVENANCE_SCRIPT),
            "digest-task-matrix",
            "--task",
            "one=real",
            "--task",
            "two=real",
            "--output",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert wrote_matrix.returncode == 0, wrote_matrix.stderr
    aggregate_expected = json.loads(expected.read_text())
    aggregate_expected["config"]["values"].update(
        {
            "task_count": "2",
            "task_matrix_sha256": wrote_matrix.stdout.strip(),
        }
    )
    aggregate_expected["config"]["sha256"] = hashlib.sha256(
        json.dumps(
            {
                "schema_version": aggregate_expected["config"]["schema_version"],
                "values": aggregate_expected["config"]["values"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    aggregate_expected_path = fleet / "execution-provenance.json"
    aggregate_expected_path.write_text(json.dumps(aggregate_expected))
    (fleet / "_batch" / "benches.json").write_text(
        json.dumps([{"name": "one", "mode": "REAL"}, {"name": "two", "mode": "REAL"}])
    )
    for name in ("one", "two"):
        child = json.loads(stamped.read_text())
        child["tasks"][0]["name"] = name
        child["tasks"][0]["world_model_mode"] = "real"
        child["execution_provenance"] = aggregate_expected
        child["tasks"][0]["execution_provenance"] = aggregate_expected
        (fleet / name).mkdir()
        (fleet / name / "cloudbench-run.json").write_text(json.dumps(child))
    aggregate_output = fleet / "_batch" / "run.json"
    merged = subprocess.run(
        [
            sys.executable,
            str(AGGREGATE_SCRIPT),
            str(fleet),
            str(aggregate_output),
            "--expected-execution-provenance-file",
            str(aggregate_expected_path),
            "--expected-execution-task-matrix-file",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert merged.returncode == 0, merged.stderr
    merged_document = json.loads(aggregate_output.read_text())
    assert merged_document["execution_provenance"] == aggregate_expected
    assert merged_document["execution_task_matrix"] == json.loads(task_matrix.read_text())
    assert all(
        task["execution_provenance"] == merged_document["execution_provenance"] for task in merged_document["tasks"]
    )

    bad_child = json.loads((fleet / "two" / "cloudbench-run.json").read_text())
    opposite_aggregate = json.loads(json.dumps(aggregate_expected))
    opposite_aggregate["config"]["values"]["region"] = "ord"
    opposite_aggregate["config"]["sha256"] = hashlib.sha256(
        json.dumps(
            {
                "schema_version": opposite_aggregate["config"]["schema_version"],
                "values": opposite_aggregate["config"]["values"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    bad_child["execution_provenance"] = opposite_aggregate
    bad_child["tasks"][0]["execution_provenance"] = opposite_aggregate
    (fleet / "two" / "cloudbench-run.json").write_text(json.dumps(bad_child))
    rejected_merge = subprocess.run(
        [
            sys.executable,
            str(AGGREGATE_SCRIPT),
            str(fleet),
            str(aggregate_output),
            "--expected-execution-provenance-file",
            str(aggregate_expected_path),
            "--expected-execution-task-matrix-file",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected_merge.returncode != 0
    assert "does not match expected" in rejected_merge.stderr

    wrong_mode_child = json.loads(stamped.read_text())
    wrong_mode_child["tasks"][0]["name"] = "two"
    wrong_mode_child["tasks"][0]["world_model_mode"] = "simulate"
    wrong_mode_child["execution_provenance"] = aggregate_expected
    wrong_mode_child["tasks"][0]["execution_provenance"] = aggregate_expected
    (fleet / "two" / "cloudbench-run.json").write_text(json.dumps(wrong_mode_child))
    wrong_mode_merge = subprocess.run(
        [
            sys.executable,
            str(AGGREGATE_SCRIPT),
            str(fleet),
            str(aggregate_output),
            "--expected-execution-provenance-file",
            str(aggregate_expected_path),
            "--expected-execution-task-matrix-file",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert wrong_mode_merge.returncode != 0
    assert "world_model_mode does not match" in wrong_mode_merge.stderr
    assert not aggregate_output.exists()

    wrong_name_child = json.loads(stamped.read_text())
    wrong_name_child["tasks"][0]["world_model_mode"] = "real"
    wrong_name_child["execution_provenance"] = aggregate_expected
    wrong_name_child["tasks"][0]["execution_provenance"] = aggregate_expected
    (fleet / "two" / "cloudbench-run.json").write_text(json.dumps(wrong_name_child))
    wrong_name_merge = subprocess.run(
        [
            sys.executable,
            str(AGGREGATE_SCRIPT),
            str(fleet),
            str(aggregate_output),
            "--expected-execution-provenance-file",
            str(aggregate_expected_path),
            "--expected-execution-task-matrix-file",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert wrong_name_merge.returncode != 0
    assert "exactly one requested task" in wrong_name_merge.stderr
    assert not aggregate_output.exists()

    # One isolated Fleet child must contribute exactly one task. Selecting a
    # matching row out of a larger artifact can promote another task/lane before
    # Fleet's later per-child summary validator runs, and turns O(N) aggregation
    # into O(N^2) when every child carries the whole matrix.
    good_child = json.loads(stamped.read_text())
    good_child["tasks"][0]["name"] = "two"
    good_child["tasks"][0]["world_model_mode"] = "real"
    good_child["execution_provenance"] = aggregate_expected
    good_child["tasks"][0]["execution_provenance"] = aggregate_expected
    extra_task = json.loads(json.dumps(good_child["tasks"][0]))
    extra_task["name"] = "one"
    good_child["tasks"].append(extra_task)
    good_child["summary"]["total"] = 2
    (fleet / "two" / "cloudbench-run.json").write_text(json.dumps(good_child))
    extra_merge = subprocess.run(
        [
            sys.executable,
            str(AGGREGATE_SCRIPT),
            str(fleet),
            str(aggregate_output),
            "--expected-execution-provenance-file",
            str(aggregate_expected_path),
            "--expected-execution-task-matrix-file",
            str(task_matrix),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert extra_merge.returncode != 0
    assert "exactly one requested task" in extra_merge.stderr
    assert not aggregate_output.exists()


def test_cloud_fleet_provenance_is_staged_stamped_aggregated_and_validated() -> None:
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()
    driver = DRIVER_SCRIPT.read_text()
    aggregate = AGGREGATE_SCRIPT.read_text()

    copy_block = fleet[
        fleet.index('cp "$ROOT_DIR/scripts/run-bench-fleet"') : fleet.index('enter_script_snapshot "$@"')
    ]
    assert "cloudbench_execution_provenance.py" in copy_block
    assert "cloudbench_result.py" in copy_block
    assert '" snapshot \\' in copy_block
    assert 'CLOUDBENCH_EXECUTION_PROVENANCE_FILE="$EXECUTION_PROVENANCE_FILE"' in fleet
    assert '--expected-execution-provenance-file "$EXECUTION_PROVENANCE_FILE"' in fleet
    assert '--expected-execution-task-matrix-file "$EXECUTION_TASK_MATRIX_FILE"' in fleet
    assert "digest-task-matrix \\" in fleet
    aggregate_acceptance = fleet.index("if ! finalize_terminal_projection 0; then")
    final_upload = fleet.index('python3 "$HUB_UPLOAD_HELPER" --upload-final', aggregate_acceptance)
    assert aggregate_acceptance < final_upload

    assert "CLOUDBENCH_GUEST_EXECUTION_PROVENANCE_SCRIPT=" in cloud
    assert '--file-local "/cloudbench-execution-provenance.py=' in cloud
    assert '--file-local "/cloudbench-execution-provenance.json=' in cloud
    assert "/data/cloudbench-execution-provenance.py" in cloud
    assert "/data/cloudbench-execution-provenance.json" in cloud
    assert 'CLOUDBENCH_RESULT_SCRIPT="$CLOUDBENCH_RUNTIME_SCRIPT_ROOT/cloudbench_result.py"' in cloud
    assert '--expected-execution-provenance-file "$CLOUDBENCH_EXECUTION_PROVENANCE_FILE"' in cloud

    assert '"$EXECUTION_PROVENANCE_SCRIPT" stamp' in driver
    assert 'cat "$CONTEXT_DIR/run.json"' in driver
    assert "expected_execution_provenance" in aggregate

    spec = importlib.util.spec_from_file_location(
        "cloudbench_execution_provenance_test_contract",
        EXECUTION_PROVENANCE_SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config_block = fleet.split("PROVENANCE_CONFIG_ARGS=(", 1)[1].split(
        ')\nif ! python3 "$EXECUTION_PROVENANCE_SCRIPT" create', 1
    )[0]
    emitted_scalar_keys = set(re.findall(r'--config-value "([a-z0-9_.-]+)=', config_block))
    assert emitted_scalar_keys == module._CONFIG_SCALAR_KEYS


def _extract_fleet_function(source: str, signature: str) -> str:
    start = source.index(signature)
    end = source.index("\n}\n", start) + 3
    return source[start:end]


def _cloudbench_incremental_log_functions() -> str:
    source = CLOUD_SCRIPT.read_text()
    return "".join(
        _extract_fleet_function(source, signature)
        for signature in (
            "read_bench_log() {",
            "cloudbench_response_header() {",
            "cloudbench_response_status() {",
            "cloudbench_store_log_generation() {",
            "refresh_bench_log() {",
            "refresh_bench_log_to_eof() {",
        )
    )


def _terminate_test_owned_pid(pid: int) -> None:
    if pid <= 1:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _terminate_test_owned_pid_file(path: Path) -> None:
    try:
        pid = int(path.read_text().strip())
    except (OSError, ValueError):
        return
    _terminate_test_owned_pid(pid)


def _read_test_owner_record(path: Path) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        key, separator, value = raw.partition("=")
        assert separator and key not in fields, f"malformed test owner record: {path}"
        fields[key] = value
    return fields


def _test_central_hub_owner_records(hub_context: Path) -> list[Path]:
    return sorted(hub_context.glob("agent-link-server.*.*.owner"))


def _terminate_test_owned_central_hubs(hub_context: Path, runs_root: Path) -> None:
    """Terminate only hubs whose immutable production owner proof validates."""
    for owner_file in _test_central_hub_owner_records(hub_context):
        fields = _read_test_owner_record(owner_file)
        try:
            pid = int(fields["pid"])
        except (KeyError, ValueError):
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; cloudbench_terminate_central_hub_owner "$2" "$3" "$4" "$5" 5',
                "_",
                str(ENV_HELPER_SCRIPT),
                fields.get("port", ""),
                str(runs_root),
                str(ROOT),
                str(owner_file),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
        assert result.returncode == 0, result.stderr + result.stdout


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
            "machine_volume_id() { printf 'vol-owned-fixture'; }",
            "reap_volume() { :; }",
            "fleet_audit_update_fresh_clone() { return 0; }",
            _worker_ledger_lock_bundle(source),
            _extract_fleet_function(source, "clone_failure_definitively_unallocated() {"),
            _extract_fleet_function(source, "clone_failure_owned_volume_id() {"),
            _extract_fleet_function(source, "clone_machine_target() {"),
        )
    )


def _worker_cleanup_bundle(source: str) -> str:
    return "\n".join(
        (
            "fleet_registry_volume_for_id() { printf 'vol-owned-fixture'; }",
            "reap_volume() { :; }",
            "fleet_audit_update_fresh_clone_by_id() { return 0; }",
            *(
                _extract_fleet_function(source, signature)
                for signature in (
                    "worker_is_tracked() {",
                    "worker_ledger_lock_acquire() {",
                    "worker_ledger_lock_release() {",
                    "cleanup_failed_worker() {",
                )
            ),
        )
    )


def _clone_index_adapter_fixture() -> str:
    """Model the controller's keyed inventory boundary in isolated clone tests.

    The publisher/index contract is exercised separately. Clone retry tests use
    an in-memory FLY stub, so this adapter converts that stub's provider-shaped
    response into the one-name lookup exposed by the production keyed index.
    """
    return r"""
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
"""


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
    assert 'FLEET_BUNDLED_FRONTEND_VM_SIZE="${CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE:-shared-cpu-4x}"' in fleet
    assert 'FLEET_BUNDLED_FRONTEND_VM_MEMORY="${CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_MEMORY:-8192}"' in fleet
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
    assert phase1.index('bench_needs_bundled_frontend_primary "$bench"') < phase1.index('pcid="$(claim_pool_machine)"')


def test_reap_machine_destroys_the_clones_forked_volume(tmp_path: Path) -> None:
    """`flyctl machine destroy` never destroys the clone's forked volume — it
    leaks and bills forever (observed: 42 x 20GB in one day). reap_machine must
    resolve the volume BEFORE the machine disappears and destroy it after,
    while never touching the warm source's volume."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "".join(
        _extract_fleet_function(fleet, sig)
        for sig in (
            "machine_status_exact_read() {",
            "machine_config_exact_read() {",
            "machine_volume_id_from_json() {",
            "machine_volume_id() {",
            "volume_inventory_contains_id() {",
            "reap_volume() {",
            "registry_machine_details() {",
            "reap_machine() {",
        )
    )
    calls = tmp_path / "calls"
    destroyed = tmp_path / "destroyed"
    machine_id = "c10e0001"

    script = f"""set -uo pipefail
APP=bench-app
WARM_ID=feedface000001
WARM_VOLUME_ID=vol_warm
export CALLS_FILE="$CALLS_FILE"
DESTROYED={shlex.quote(str(destroyed))}
FLY() {{
  echo "$*" >> "$CALLS_FILE"
  case "$1 $2" in
    "machine status")
      [ "$3" = {machine_id} ] || return 97
      if [ "${{6:-}}" = -d ]; then
        printf '{{"mounts":[{{"volume":"vol_clone"}}]}}\\n'
      elif [ -e "$DESTROYED" ]; then
        printf "Error: machine %s was not found in app '%s'\\n" "$3" "$APP" >&2
        return 1
      else
        return 98
      fi ;;
    "machine destroy") : > "$DESTROYED"; return 0 ;;
    "volumes destroy") return 0 ;;
    "volumes show")
      printf '%s\n' '{{"id":"vol_clone","state":"pending_destroy"}}' ;;
  esac
  return 0
}}
{helpers}
reap_machine {machine_id}
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
    assert f"machine destroy --force {machine_id}" in log
    assert "volumes destroy vol_clone" in log, "forked volume must be reaped with its machine"
    # The exact mounted Volume is captured before the Machine destroy.
    assert log.index(f"machine status {machine_id} -a bench-app -d") < log.index("machine destroy")
    assert "machines list" not in log
    assert "reap_machine_exit=0" in result.stdout
    # warm volume is never destroyable through the reap path
    assert "warm_guard=held" in result.stdout
    assert "volumes destroy vol_warm" not in log


def test_reap_volume_requires_an_exact_terminal_lifecycle_receipt(
    tmp_path: Path,
) -> None:
    """Only an exact terminal state or exact-ID absence can retire ownership."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "volume_inventory_contains_id() {",
            "reap_volume() {",
        )
    )
    cases = {
        "pending_destroy": (0, 1),
        "destroyed": (0, 1),
        "exact-absent": (0, 1),
        "created": (1, 6),
        "restoring": (1, 6),
        "scheduling_destroy": (1, 6),
        "recovering": (1, 6),
        "provider-failure": (1, 6),
        "invalid-json": (1, 6),
        "wrong-id": (1, 6),
    }

    for mode, (expected_status, expected_attempts) in cases.items():
        calls = tmp_path / f"{mode}.calls"
        script = f"""set -uo pipefail
APP=bench-app
WARM_VOLUME_ID=vol_warm
MODE={shlex.quote(mode)}
CALLS={shlex.quote(str(calls))}
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "volumes destroy") return 0 ;;
    "volumes show")
      case "$MODE" in
        exact-absent)
          printf 'Error: failed retrieving volume: failed to get volume vol_owned: volume not found (Request ID: fixture)\n' >&2
          return 1 ;;
        provider-failure)
          printf 'provider lifecycle read timed out\n' >&2
          return 1 ;;
        invalid-json) printf '{{not-json\n'; return 0 ;;
        wrong-id) printf '{{"id":"vol_neighbor","state":"destroyed"}}\n'; return 0 ;;
        *) printf '{{"id":"vol_owned","state":"%s"}}\n' "$MODE"; return 0 ;;
      esac ;;
  esac
  return 99
}}
{helpers}
reap_volume vol_owned
"""
        result = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

        assert result.returncode == expected_status, (
            mode,
            result.stdout,
            result.stderr,
        )
        call_log = calls.read_text().splitlines()
        assert call_log.count("volumes destroy vol_owned -a bench-app --yes") == expected_attempts
        assert call_log.count("volumes show vol_owned -a bench-app --json") == expected_attempts
        assert not any("volumes list" in call for call in call_log)


def test_reap_volume_durably_captures_bounded_destroy_responses(
    tmp_path: Path,
) -> None:
    """The owning boundary must preserve provider rejection evidence."""
    fleet = FLEET_SCRIPT.read_text()
    helpers = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "volume_inventory_contains_id() {",
            "reap_volume() {",
        )
    )
    calls = tmp_path / "provider.calls"
    diagnostic_log = tmp_path / "owned.log"
    script = f"""set -uo pipefail
APP=bench-app
WARM_VOLUME_ID=vol_warm
CALLS={shlex.quote(str(calls))}
DIAGNOSTIC_LOG={shlex.quote(str(diagnostic_log))}
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "volumes destroy")
      python3 - <<'PY' >&2
print("DESTROY_PROVIDER_SENTINEL: provider rejected deletion " + ("x" * 400))
PY
      return 37 ;;
    "volumes show")
      printf '{{"id":"vol_owned","state":"created"}}\n'
      return 0 ;;
  esac
  return 99
}}
{helpers}
reap_volume vol_owned "$DIAGNOSTIC_LOG"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 1, result.stderr + result.stdout
    call_log = calls.read_text().splitlines()
    assert call_log.count("volumes destroy vol_owned -a bench-app --yes") == 6
    assert call_log.count("volumes show vol_owned -a bench-app --json") == 6
    response_lines = diagnostic_log.read_text().splitlines()
    assert len(response_lines) == 6
    for attempt, line in enumerate(response_lines, start=1):
        assert f"volume destroy attempt {attempt}/6 id=vol_owned rc=37" in line
        assert "response=DESTROY_PROVIDER_SENTINEL: provider rejected deletion" in line
        assert re.search(r" \[truncated; \d+ bytes total\]$", line)
        assert len(line) < 400
    assert "DESTROY_PROVIDER_SENTINEL" not in result.stderr
    assert "DESTROY_PROVIDER_SENTINEL" not in result.stdout


def test_reap_volume_retains_authority_when_restore_reappears_after_absence(
    tmp_path: Path,
) -> None:
    """A restore-time destroy can transiently hide a volume for multiple lists.

    Teardown must not return success and retire its exact audit/registry authority
    when the same volume later settles back to detached ``created``.
    """
    fleet = FLEET_SCRIPT.read_text()
    helpers = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "volume_inventory_contains_id() {",
            "reap_volume() {",
        )
    )
    calls = tmp_path / "provider.calls"
    list_step = tmp_path / "list-step"
    list_step.write_text("0\n")

    script = f"""set -uo pipefail
APP=bench-app
WARM_VOLUME_ID=vol_warm
CALLS={shlex.quote(str(calls))}
LIST_STEP={shlex.quote(str(list_step))}
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "volumes destroy")
      [ "$3" = vol_restoring ] || return 99
      return 0 ;;
    "volumes list")
      step="$(cat "$LIST_STEP")"
      step=$((step + 1))
      printf '%s\n' "$step" > "$LIST_STEP"
      if [ "$step" -le 2 ]; then
        printf '[]\n'
      else
        printf '[{{"id":"vol_restoring","name":"cloudbench_data","state":"created","attached_machine_id":null}}]\n'
      fi
      return 0 ;;
  esac
  return 99
}}
{helpers}
if reap_volume vol_restoring; then
  settled="$(FLY volumes list -a "$APP" --json)" || exit 91
  if printf '%s' "$settled" | grep -q '"id":"vol_restoring"'; then
    echo "FAIL: teardown sealed destroyed-verified-absent after two transient absences; vol_restoring reappeared provider-visible as detached created" >&2
    exit 90
  fi
  exit 92
fi
for _ in 1 2 3; do
  settled="$(FLY volumes list -a "$APP" --json)" || exit 93
  printf '%s' "$settled" | grep -q '"id":"vol_restoring"' && break
done
printf '%s' "$settled" | grep -q '"id":"vol_restoring"' || exit 94
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_exact_volume_ownership_survives_delayed_visibility_and_failed_delete(
    tmp_path: Path,
) -> None:
    """A clone's mount can appear after its Machine ID. The controller must
    persist the exact volume before destroying a terminal-storage-failed
    machine, retain that record when volume deletion fails, and let a later
    exact-owner recovery delete only that volume."""
    fleet = FLEET_SCRIPT.read_text()
    reap_helpers = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "volume_inventory_contains_id() {",
            "reap_volume() {",
        )
    )
    postcondition_root = tmp_path / "postcondition"
    postcondition_root.mkdir()
    postcondition_calls = postcondition_root / "calls"
    lifecycle_step = postcondition_root / "lifecycle-step"
    lifecycle_step.write_text("0\n")
    postcondition_script = f"""set -uo pipefail
APP=bench-app
WARM_VOLUME_ID=vol_warm
CALLS={shlex.quote(str(postcondition_calls))}
LIFECYCLE_STEP={shlex.quote(str(lifecycle_step))}
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "volumes destroy")
      [ "$3" = vol_exact ] || return 99
      return 0 ;;
    "volumes show")
      step="$(cat "$LIFECYCLE_STEP")"
      step=$((step + 1))
      printf '%s\n' "$step" > "$LIFECYCLE_STEP"
      case "$step" in
        1) printf '%s\n' '{{"id":"vol_exact","state":"created"}}' ;;
        2) printf '%s\n' '{{not-json' ;;
        3) printf '%s\n' '{{"id":"vol_exact","state":"scheduling_destroy"}}' ;;
        *) printf '%s\n' '{{"id":"vol_exact","state":"pending_destroy"}}' ;;
      esac
      return 0 ;;
  esac
  return 99
}}
{reap_helpers}
reap_volume vol_exact
"""
    postcondition_result = subprocess.run(
        ["bash", "-c", postcondition_script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert postcondition_result.returncode == 0, postcondition_result.stderr + postcondition_result.stdout
    postcondition_log = postcondition_calls.read_text().splitlines()
    assert postcondition_log == [
        "volumes destroy vol_exact -a bench-app --yes",
        "volumes show vol_exact -a bench-app --json",
        "volumes destroy vol_exact -a bench-app --yes",
        "volumes show vol_exact -a bench-app --json",
        "volumes destroy vol_exact -a bench-app --yes",
        "volumes show vol_exact -a bench-app --json",
        "volumes destroy vol_exact -a bench-app --yes",
        "volumes show vol_exact -a bench-app --json",
    ]
    assert not any("volumes list" in call for call in postcondition_log)
    assert not any("volumes destroy vol_neighbor" in call for call in postcondition_log)

    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "fly_with_timeout() {",
            "volume_inventory_contains_id() {",
            "reap_volume() {",
            "reap_machine() {",
            "registry_meta_value() {",
            "fleet_registry_record_name() {",
            "fleet_audit_record_fresh_clone() {",
            "fleet_audit_update_fresh_clone() {",
            "fleet_audit_update_registry_clone() {",
            "registry_record_machine_identity() {",
            "fleet_registry_record_id() {",
            "fleet_registry_release_id() {",
            "worker_ledger_lock_acquire() {",
            "worker_ledger_lock_release() {",
            "registry_record_is_stale_phantom() {",
            "reap_registry_clones() {",
            "clone_machine_target() {",
        )
    )
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / ("a" * 32)
    (registry / "clones").mkdir(parents=True)
    audit = tmp_path / "audit"
    for directory in (audit / "fresh", audit / "expected-fresh", audit / "by-machine-id"):
        directory.mkdir(parents=True, exist_ok=True)
    ledger = tmp_path / "owned.ids"
    machine_state = tmp_path / "machine-state"
    volume_lookups = tmp_path / "volume-lookups"
    volumes = tmp_path / "volumes"
    calls = tmp_path / "calls"
    machine_state.write_text("1\n")
    volume_lookups.write_text("0\n")
    volumes.write_text("vol_exact\nvol_neighbor\n")

    script = f"""set -uo pipefail
APP=bench-app
REGION=iad
WARM_ID=feedface000000
WARM_VOLUME_ID=vol_warm
SNAP_ID=snapshot-1
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
FLEET_TEARDOWN_OWNERSHIP_DIR={shlex.quote(str(audit))}
FLEET_OWNER_TOKEN={"a" * 32}
RUN_ID=fixture-run
LEDGER={shlex.quote(str(ledger))}
MACHINE_STATE={shlex.quote(str(machine_state))}
VOLUME_LOOKUPS={shlex.quote(str(volume_lookups))}
VOLUMES={shlex.quote(str(volumes))}
CALLS={shlex.quote(str(calls))}
FAIL_VOLUME=1
CLOUDBENCH_CLONE_MAX_ATTEMPTS=1
CLOUDBENCH_CLONE_STORAGE_READY_SECONDS=10
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "machine clone")
      printf 'Machine deadbeef000001 has been created...\\n'
      return 0 ;;
    "machine destroy")
      printf '0\\n' > "$MACHINE_STATE"
      return 0 ;;
    "machines list")
      if [ "$(cat "$MACHINE_STATE")" = "1" ]; then
        printf '[{{"id":"deadbeef000001","name":"cloudbench-owned"}}]\\n'
      else
        printf '[]\\n'
      fi
      return 0 ;;
    "volumes destroy")
      [ "$3" = "vol_neighbor" ] && return 99
      [ "$FAIL_VOLUME" = "0" ] || return 0
      grep -Fxv "$3" "$VOLUMES" > "$VOLUMES.tmp"
      mv "$VOLUMES.tmp" "$VOLUMES"
      return 0 ;;
    "volumes show")
      if grep -Fxq "$3" "$VOLUMES"; then
        printf '{{"id":"%s","state":"created"}}\n' "$3"
        return 0
      fi
      printf 'Error: failed retrieving volume: failed to get volume %s: volume not found (Request ID: fixture)\n' \
        "$3" >&2
      return 1 ;;
  esac
  return 0
}}
machine_volume_id() {{
  n="$(cat "$VOLUME_LOOKUPS")"
  n=$((n + 1))
  printf '%s\\n' "$n" > "$VOLUME_LOOKUPS"
  [ "$n" -gt 1 ] && printf 'vol_exact'
}}
machine_storage_ready() {{ return 1; }}
machine_storage_failed() {{ return 0; }}
registry_resolve_name() {{ return 2; }}
registry_machine_details() {{
  [ "$(cat "$MACHINE_STATE")" = "1" ] || return 1
  record="$(find "$FLEET_REGISTRY_DIR/clones" -type f | head -1)"
  printf 'created %s' "$(registry_meta_value "$record" name)"
}}
registry_runner_count() {{ printf '0'; }}
printf 'version=1\n' > "$FLEET_REGISTRY_DIR/meta"
{functions}

clone_rc=0
clone_machine_target "$LEDGER" >/dev/null 2>&1 || clone_rc=$?
[ "$clone_rc" -ne 0 ] || exit 20
record="$(find "$FLEET_REGISTRY_DIR/clones" -type f | head -1)"
[ -n "$record" ] || exit 21
[ "$(registry_meta_value "$record" id)" = deadbeef000001 ] || exit 22
[ "$(registry_meta_value "$record" volume_id)" = vol_exact ] || exit 23
[ "$(cat "$MACHINE_STATE")" = 0 ] || exit 24
grep -Fxq vol_exact "$VOLUMES" || exit 25
grep -Fxq deadbeef000001 "$LEDGER" || exit 31
FAIL_VOLUME=0
reap_registry_clones "$FLEET_REGISTRY_DIR" forced || exit 26
[ ! -e "$record" ] || exit 27
grep -Fxq vol_neighbor "$VOLUMES" || exit 29
if grep -Fxq vol_exact "$VOLUMES"; then exit 30; fi
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert volume_lookups.read_text().strip() == "2"
    log = calls.read_text()
    assert "machine destroy --force deadbeef000001" in log
    assert "volumes destroy vol_exact" in log
    assert "volumes destroy vol_neighbor" not in log


def test_forced_recovery_retires_only_aged_absent_name_only_clone(
    tmp_path: Path,
) -> None:
    """Exact recovery has the same dead-owner proof as automatic stale recovery."""
    fleet = FLEET_SCRIPT.read_text()
    reaper = _extract_fleet_function(fleet, "reap_registry_clones() {")
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / ("c" * 32)
    clones = registry / "clones"
    clones.mkdir(parents=True)
    clone_name = "cloudbench-phantom"
    record = clones / clone_name
    record.write_text(f"name={clone_name}\n")
    (registry / "meta").write_text("version=2\n")
    audit_calls = tmp_path / "audit-calls"

    script = f"""set -uo pipefail
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
REG={shlex.quote(str(registry))}
RECORD={shlex.quote(str(record))}
AUDIT_CALLS={shlex.quote(str(audit_calls))}
registry_meta_value() {{ sed -n "s/^$2=//p" "$1" | head -1; }}
registry_resolve_name() {{ return 1; }}
registry_record_is_stale_phantom() {{ return 0; }}
fleet_audit_update_registry_clone() {{ printf '%s\n' "$*" >> "$AUDIT_CALLS"; }}
registry_retire_absent_stale_pre_volume_records() {{ return 0; }}
registry_record_is_stale_pre_volume_id() {{ return 1; }}
{reaper}

current_rc=0
reap_registry_clones "$REG" current >/dev/null 2>&1 || current_rc=$?
[ "$current_rc" -ne 0 ] || exit 20
[ -f "$RECORD" ] || exit 21
[ ! -e "$AUDIT_CALLS" ] || exit 22

reap_registry_clones "$REG" forced >/dev/null 2>&1 || exit 23
[ ! -e "$RECORD" ] || exit 24
grep -Fxq "$REG {clone_name}   not-allocated-verified" "$AUDIT_CALLS" || exit 25
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers(
    tmp_path: Path,
) -> None:
    """A canonical owner is not malformed merely because cleanup is unconfirmed.

    Exact cancellation recovery must enter the guest acknowledgement boundary
    and retain every durable handle when that boundary cannot prove teardown.
    """
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "fleet_registry_cleanup_state() {",
            "registry_owner_alive() {",
            "release_cleanup_disk_reserve() {",
            "acquire_registry_recovery_lock() {",
            "recover_exact_stale_fleet_owner() {",
        )
    )
    owner = "5" * 32
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    audit_root = tmp_path / "audits"
    audit_root.mkdir()
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=99999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        "cleanup_policy=retain\n"
    )
    (registry / "guest-cleanup-unconfirmed").touch()
    for index in range(9):
        clone_name = f"cloudbench-machine-volume-{index}"
        (clones / clone_name).write_text(f"name={clone_name}\nid=deadbeef00000{index}\nvolume_id=vol_machine_{index}\n")
    volume_only_name = "cloudbench-volume-only"
    (clones / volume_only_name).write_text(f"name={volume_only_name}\nvolume_id=vol_volume_only\n")
    guest_recovery_call = tmp_path / "guest-recovery-call"
    unexpected = tmp_path / "unexpected-reaper-call"

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(audit_root))}
FLEET_OWNER_HOST=test-host
GUEST_RECOVERY_CALL={shlex.quote(str(guest_recovery_call))}
UNEXPECTED={shlex.quote(str(unexpected))}
_agent_stale_owner_debug_log() {{ :; }}
fleet_recovery_reconnect_guest_shutdowns() {{
  touch "$GUEST_RECOVERY_CALL"
  return 1
}}
recover_registry_audit_only_fresh() {{ touch "$UNEXPECTED"; return 99; }}
reap_registry_clones() {{ touch "$UNEXPECTED"; return 99; }}
recover_exact_pool_claims() {{ touch "$UNEXPECTED"; return 99; }}
capacity_release_stale_owner_reservations() {{ touch "$UNEXPECTED"; return 99; }}
fleet_audit_finalize_recovered_registry() {{ touch "$UNEXPECTED"; return 99; }}
fleet_registry_remove_if_empty() {{ touch "$UNEXPECTED"; return 99; }}
{functions}

[ "$(fleet_registry_cleanup_state "$FLEET_OWNERSHIP_ROOT/{owner}" retain)" = quarantined ] || exit 80
[ "$(fleet_registry_cleanup_state "$FLEET_OWNERSHIP_ROOT/{owner}" reap)" = quarantined ] || exit 81
rm "$FLEET_OWNERSHIP_ROOT/{owner}/guest-cleanup-unconfirmed"
[ "$(fleet_registry_cleanup_state "$FLEET_OWNERSHIP_ROOT/{owner}" retain)" = retain ] || exit 82
[ "$(fleet_registry_cleanup_state "$FLEET_OWNERSHIP_ROOT/{owner}" reap)" = reap ] || exit 83
[ "$(fleet_registry_cleanup_state "$FLEET_OWNERSHIP_ROOT/{owner}" invalid)" = unsafe ] || exit 84
touch "$FLEET_OWNERSHIP_ROOT/{owner}/guest-cleanup-unconfirmed"
recovery_status=0
recover_exact_stale_fleet_owner {owner} || recovery_status=$?
[ "$recovery_status" -ne 0 ] || exit 90
[ ! -e "$UNEXPECTED" ] || exit 91
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert "reconnecting exact owned guests" in result.stdout
    assert "registry identity is unsafe" not in result.stderr
    assert guest_recovery_call.exists()
    assert not unexpected.exists()
    assert (registry / "guest-cleanup-unconfirmed").exists()
    records = list(clones.iterdir())
    assert len(records) == 10
    assert sum("\nid=" in f"\n{record.read_text()}" for record in records) == 9
    assert sum("volume_id=" in record.read_text() for record in records) == 10


def test_exact_recovery_reconnects_quarantined_owned_guests_before_provider_reap(
    tmp_path: Path,
) -> None:
    """Exact recovery must prove every configured guest ack before provider reap."""
    fleet = FLEET_SCRIPT.read_text()
    signatures = (
        "_agent_stale_owner_debug_log() {",
        "machine_status_exact_read() {",
        "machine_config_exact_read() {",
        "registry_machine_details() {",
        "registry_meta_value() {",
        "fleet_registry_cleanup_state() {",
        "registry_owner_alive() {",
        "fleet_registry_build_guest_recovery_plan() {",
        "machine_guest_recovery_configuration() {",
        "cloudbench_fsync_directory() {",
        "cloudbench_publish_guest_shutdown_confirmation() {",
        "cloudbench_confirm_guest_shutdowns() {",
        "fleet_registry_confirm_guest_teardown() {",
        "cleanup_stale_owner_recovery_proxies() {",
        "fleet_recovery_reconnect_guest_shutdowns() {",
        "acquire_registry_recovery_lock() {",
        "recover_exact_stale_fleet_owner() {",
    )
    # The pre-fix controller has no quarantine recovery functions, so this
    # unchanged reproduction reaches its real outer-gate rejection. Once the
    # production functions exist, the same fixture exercises them end-to-end.
    extracted = []
    for signature in signatures:
        if signature not in fleet:
            continue
        if signature == "fleet_registry_build_guest_recovery_plan() {":
            start = fleet.index(signature)
            end = fleet.index("\nPY\n}", start) + len("\nPY\n}")
            extracted.append(fleet[start:end])
        else:
            extracted.append(_extract_fleet_function(fleet, signature))
    functions = "\n".join(extracted)
    owner = "5a" * 16
    run_id = "20260910-021331-1465409"
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    audit_root = tmp_path / "audits"
    audit_root.mkdir()
    runs_root = tmp_path / "runs"
    run_dir = runs_root / run_id
    run_dir.mkdir(parents=True)
    machine_rows = []
    expected = (
        (
            "cloudbench-owned-alpha",
            "deadbeef000001",
            "vol_owned_alpha",
            "bench-alpha",
            61001,
            "fdaa::101",
            "guest-alpha",
        ),
        (
            "cloudbench-owned-beta",
            "deadbeef000002",
            "vol_owned_beta",
            "bench-beta",
            61002,
            "fdaa::102",
            "guest-beta",
        ),
    )
    barrier_token = "barrier-token-exact-owner"
    for clone_name, machine_id, volume_id, bench, port, private_ip, guest_token in expected:
        (clones / clone_name).write_text(f"name={clone_name}\nid={machine_id}\nvolume_id={volume_id}\n")
        output = run_dir / bench
        output.mkdir()
        (output / ".cid").write_text(f"clone {machine_id}\n")
        (output / "status-proxy.port").write_text(f"{port}\n")
        machine_rows.append(
            {
                "id": machine_id,
                "name": clone_name,
                "state": "started",
                "private_ip": private_ip,
                "config": {
                    "mounts": [{"volume": volume_id}],
                    "env": {
                        "CLOUDBENCH_BARRIER_TOKEN": barrier_token,
                        "CLOUDBENCH_RUN_TOKEN": guest_token,
                        "CLOUDBENCH_STATUS_PORT": "8011",
                    },
                },
            }
        )
    volume_only_name = "cloudbench-owned-volume-only"
    (clones / volume_only_name).write_text(f"name={volume_only_name}\nvolume_id=vol_owned_only\n")
    machine_rows.append(
        {
            "id": "neighbor0000001",
            "name": "cloudbench-neighbor",
            "state": "started",
            "private_ip": "fdaa::999",
            "config": {
                "env": {
                    "CLOUDBENCH_BARRIER_TOKEN": "neighbor-token",
                    "CLOUDBENCH_RUN_TOKEN": "neighbor-run",
                    "CLOUDBENCH_STATUS_PORT": "8011",
                }
            },
        }
    )
    (run_dir / "machines.json").write_text(json.dumps(machine_rows))
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=99999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        f"run_id={run_id}\n"
        f"runs_root={runs_root}\n"
        "cleanup_policy=retain\n"
    )
    (registry / "guest-cleanup-unconfirmed").touch()
    calls = tmp_path / "calls"

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(audit_root))}
FLEET_OWNER_HOST=test-host
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={owner}
FLEET_REGISTRY_DIR="$FLEET_OWNERSHIP_ROOT/$FLEET_OWNER_TOKEN"
FLEET_REGISTRY_PUBLISHED=0
KEEP_CLONES=0
RUN_ID=fixture-controller-run
CLOUDBENCH_CHILD_TERM_SECONDS=2
STALE_OWNER_RECOVERY_PROXY_PIDS=()
STALE_OWNER_RECOVERY_PORT_LEASE_TOKEN=""
STALE_OWNER_RECOVERY_PLAN_FILE=""
STALE_OWNER_RECOVERY_PORTS_FILE=""
AUTOSCALER_PORT_LEASE_HELPER=/nonexistent/port-helper
CALLS={shlex.quote(str(calls))}
release_cleanup_disk_reserve() {{ return 0; }}
FLY() {{
  printf 'provider %s\\n' "$*" >> "$CALLS"
  case "$1 $2 $3" in
    "machine status deadbeef000001")
      if [ "${{6:-}}" = -d ]; then
        printf '%s\\n' {shlex.quote(json.dumps(machine_rows[0]["config"]))}
      else
        cat <<'STATUS'
Machine ID: deadbeef000001
Instance ID: fixture-alpha
State: started
HostStatus: ok

VM
 ID            │ deadbeef000001
 Instance ID   │ fixture-alpha
 State         │ started
 Image         │ fixture
 Name          │ cloudbench-owned-alpha
 Private IP    │ fdaa::101
 Region        │ iad
 Process Group │
 CPU Kind      │ shared
 vCPUs         │ 2
 Memory        │ 4096
 Created       │ fixture
 Updated       │ fixture
 Entrypoint    │
 Command       │
 Volume        │ vol_owned_alpha
STATUS
      fi
      ;;
    "machine status deadbeef000002")
      if [ "${{6:-}}" = -d ]; then
        printf '%s\\n' {shlex.quote(json.dumps(machine_rows[1]["config"]))}
      else
        cat <<'STATUS'
Machine ID: deadbeef000002
Instance ID: fixture-beta
State: started
HostStatus: ok

VM
 ID            │ deadbeef000002
 Instance ID   │ fixture-beta
 State         │ started
 Image         │ fixture
 Name          │ cloudbench-owned-beta
 Private IP    │ fdaa::102
 Region        │ iad
 Process Group │
 CPU Kind      │ shared
 vCPUs         │ 2
 Memory        │ 4096
 Created       │ fixture
 Updated       │ fixture
 Entrypoint    │
 Command       │
 Volume        │ vol_owned_beta
STATUS
      fi
      ;;
    "machines list "*|*"neighbor"*) return 99 ;;
    *) return 98 ;;
  esac
}}
claim_recovery_status_proxy_ports() {{
  printf 'claim-ports %s %s\\n' "$2" "$3" >> "$CALLS"
  printf '62001\\n62002\\n' > "$1"
}}
release_recovery_status_proxy_ports() {{
  printf 'release-ports %s\\n' "$1" >> "$CALLS"
}}
start_data_plane_proxy() {{
  printf 'proxy %s %s %s\\n' "$1" "$2" "$3" >> "$CALLS"
  sleep 60 &
  printf -v "$5" '%s' "$!"
}}
cloudbench_terminate_and_wait() {{
  shift
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
curl() {{
  local method=GET authorization="" url="" arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      -X) method="$1"; shift ;;
      -H)
        case "$1" in Authorization:*) authorization="$1" ;; esac
        shift
        ;;
      http://*) url="$arg" ;;
    esac
  done
  [ "$authorization" = "Authorization: Bearer {barrier_token}" ] || {{
    printf 'bad-authorization %s\\n' "$authorization" >> "$CALLS"
    printf 403
    return
  }}
  case "$url" in
    http://127.0.0.1:62001/shutdown|http://127.0.0.1:62002/shutdown)
      [ "$method" = POST ] || return 1
      printf 'shutdown %s\\n' "$url" >> "$CALLS"
      printf 202
      ;;
    http://127.0.0.1:62001/shutdown-health|http://127.0.0.1:62002/shutdown-health)
      printf 'shutdown-health %s\\n' "$url" >> "$CALLS"
      printf 204
      ;;
    *) printf 'unexpected-url %s\\n' "$url" >> "$CALLS"; printf 404 ;;
  esac
}}
recover_registry_audit_only_fresh() {{
  [ ! -e "$FLEET_REGISTRY_DIR/guest-cleanup-unconfirmed" ] || return 91
  [ "$(registry_meta_value "$FLEET_REGISTRY_DIR/meta" cleanup_policy)" = reap ] || return 92
  printf 'audit-recovery\\n' >> "$CALLS"
}}
reap_registry_clones() {{
  [ ! -e "$FLEET_REGISTRY_DIR/guest-cleanup-unconfirmed" ] || return 93
  for output in {shlex.quote(str(run_dir))}/bench-alpha {shlex.quote(str(run_dir))}/bench-beta; do
    [ "$(cat "$output/guest-shutdown.confirmed")" = {run_id} ] || return 94
  done
  printf 'provider-reap %s\\n' "$*" >> "$CALLS"
}}
recover_exact_pool_claims() {{ printf 'pool-recovery\\n' >> "$CALLS"; }}
capacity_release_stale_owner_reservations() {{ printf 'capacity-release\\n' >> "$CALLS"; }}
fleet_audit_finalize_recovered_registry() {{ printf 'audit-finalize\\n' >> "$CALLS"; }}
fleet_registry_remove_if_empty() {{ printf 'registry-finish\\n' >> "$CALLS"; }}
{functions}

recover_exact_stale_fleet_owner {owner}
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    call_lines = calls.read_text().splitlines()
    assert "proxy 62001 8011 fdaa::101" in call_lines
    assert "proxy 62002 8011 fdaa::102" in call_lines
    assert all("fdaa::999" not in line and "neighbor" not in line for line in call_lines)
    assert sum(line.startswith("provider machine status ") for line in call_lines) == 4
    assert all("provider machines list" not in line for line in call_lines)
    assert sum(line.startswith("shutdown http://") for line in call_lines) == 2
    assert sum(line.startswith("shutdown-health http://") for line in call_lines) == 2
    transition_index = call_lines.index("audit-recovery")
    assert all(
        call_lines.index(line) < transition_index for line in call_lines if line.startswith("shutdown-health http://")
    )
    assert call_lines[transition_index : transition_index + 6] == [
        "audit-recovery",
        f"provider-reap {registry} forced",
        "pool-recovery",
        "capacity-release",
        "audit-finalize",
        "registry-finish",
    ]
    assert not (registry / "guest-cleanup-unconfirmed").exists()
    assert "cleanup_policy=reap\n" in (registry / "meta").read_text()


def test_pre_fix_guest_runner_receipt_authorizes_exact_reaper(
    tmp_path: Path,
) -> None:
    """A pre-fix driver can omit its top-level ack after the runner sealed clean.

    Recovery may authenticate and validate that exact private receipt, persist a
    controller receipt, and only then enter the existing exact-ID reaper.
    """
    fleet = FLEET_SCRIPT.read_text()
    signatures = (
        "_agent_stale_owner_debug_log() {",
        "registry_meta_value() {",
        "fleet_registry_cleanup_state() {",
        "registry_owner_alive() {",
        "cloudbench_fsync_directory() {",
        "cloudbench_seal_guest_evidence_file() {",
        "cloudbench_fetch_guest_evidence() {",
        "cloudbench_publish_guest_shutdown_confirmation() {",
        "cloudbench_confirm_guest_shutdowns() {",
        "cloudbench_recover_guest_cleanup_receipts() {",
        "fleet_registry_confirm_guest_teardown() {",
        "cleanup_stale_owner_recovery_proxies() {",
        "fleet_recovery_reconnect_guest_shutdowns() {",
        "acquire_registry_recovery_lock() {",
        "recover_exact_stale_fleet_owner() {",
    )
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in signatures
        if signature in fleet
    )
    owner = "6a" * 16
    run_id = "fixture-pre-fix-run"
    guest_token = "pre-fix-guest-token"
    machine_id = "deadbeef000009"
    bench = "pre-fix-bench"
    registry = tmp_path / "ownership" / owner
    output = tmp_path / "runs" / run_id / bench
    output.mkdir(parents=True)
    (registry / "clones").mkdir(parents=True)
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=99999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        f"run_id={run_id}\n"
        f"runs_root={tmp_path / 'runs'}\n"
        "cleanup_policy=retain\n"
    )
    (registry / "guest-cleanup-unconfirmed").touch()
    calls = tmp_path / "calls"
    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(tmp_path / "ownership"))}
FLEET_AUDIT_ROOT={shlex.quote(str(tmp_path / "audits"))}
FLEET_OWNER_HOST=test-host
FLEET_OWNER_TOKEN={owner}
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
FLEET_REGISTRY_PUBLISHED=0
KEEP_CLONES=0
RUN_ID=controller-run
CLOUDBENCH_BARRIER_TOKEN=controller-token
CLOUDBENCH_CHILD_TERM_SECONDS=1
EXACT_SESSION_CLEANUP_HELPER={shlex.quote(str(EXACT_SESSION_CLEANUP_SCRIPT))}
STALE_OWNER_RECOVERY_PROXY_PIDS=()
STALE_OWNER_RECOVERY_PORT_LEASE_TOKEN=""
STALE_OWNER_RECOVERY_PLAN_FILE=""
STALE_OWNER_RECOVERY_PORTS_FILE=""
CALLS={shlex.quote(str(calls))}
release_cleanup_disk_reserve() {{ return 0; }}
fleet_registry_build_guest_recovery_plan() {{
  printf 'guest\\t{bench}\\tcloudbench-pre-fix\\t{machine_id}\\tvol_pre_fix\\t%s\\t61009\\n' \
    {shlex.quote(str(output))} > "$2"
}}
registry_machine_details() {{ printf 'started cloudbench-pre-fix fdaa::109\\n'; }}
machine_guest_recovery_configuration() {{
  printf 'barrier-pre-fix\\t{guest_token}\\t8011\\n'
}}
claim_recovery_status_proxy_ports() {{ printf '62009\\n' > "$1"; }}
release_recovery_status_proxy_ports() {{ :; }}
start_data_plane_proxy() {{
  sleep 60 &
  printf -v "$5" '%s' "$!"
}}
cloudbench_terminate_and_wait() {{
  shift
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
curl() {{
  local method=GET output_file="" url="" arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      -X) method="$1"; shift ;;
      -o) output_file="$1"; shift ;;
      -H) shift ;;
      http://*) url="$arg" ;;
    esac
  done
  case "$url" in
    */shutdown)
      [ "$method" = POST ] || return 1
      printf 202
      ;;
    */shutdown-health) printf 500 ;;
    */cloudbench-interrupt-cleanup-{guest_token}.status)
      printf 'version=1\\ntoken={guest_token}\\nstate=clean\\n' > "$output_file"
      printf 200
      ;;
    *) printf 404 ;;
  esac
}}
recover_registry_audit_only_fresh() {{ printf 'audit-recovery\\n' >> "$CALLS"; }}
reap_registry_clones() {{
  [ ! -e "$FLEET_REGISTRY_DIR/guest-cleanup-unconfirmed" ] || return 91
  [ -s {shlex.quote(str(output / "guest-cleanup.recovery-receipt.json"))} ] || return 92
  [ "$(cat {shlex.quote(str(output / "guest-shutdown.confirmed"))})" = {run_id} ] || return 93
  printf 'provider-reap\\n' >> "$CALLS"
}}
recover_exact_pool_claims() {{ printf 'pool-recovery\\n' >> "$CALLS"; }}
capacity_release_stale_owner_reservations() {{ printf 'capacity-release\\n' >> "$CALLS"; }}
fleet_audit_finalize_recovered_registry() {{ printf 'audit-finalize\\n' >> "$CALLS"; }}
fleet_registry_remove_if_empty() {{ printf 'registry-finish\\n' >> "$CALLS"; }}
{functions}

recover_exact_stale_fleet_owner {owner}
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    receipt = json.loads((output / "guest-cleanup.recovery-receipt.json").read_text())
    assert receipt["kind"] == "runner-cleanup"
    assert receipt["fleet_owner_token"] == owner
    assert receipt["fleet_run_id"] == run_id
    assert receipt["bench"] == bench
    assert receipt["machine_id"] == machine_id
    assert receipt["guest_run_token"] == guest_token
    assert receipt["runner_receipt"]["state"] == "clean"
    assert (output / "guest-shutdown.confirmed").read_text() == f"{run_id}\n"
    assert calls.read_text().splitlines()[:2] == ["audit-recovery", "provider-reap"]


def test_exact_recovery_seals_actual_retained_owner_remote_evidence_paths(
    tmp_path: Path,
) -> None:
    """Fallback reads the retained guest's real /data layout before proxy release."""
    fleet = FLEET_SCRIPT.read_text()
    signatures = (
        "registry_meta_value() {",
        "fleet_registry_build_guest_recovery_plan() {",
        "cloudbench_fsync_directory() {",
        "cloudbench_seal_guest_evidence_file() {",
        "cloudbench_fetch_guest_evidence() {",
        "cloudbench_publish_guest_shutdown_confirmation() {",
        "cloudbench_confirm_guest_shutdowns() {",
        "cloudbench_recover_guest_cleanup_receipts() {",
        "cleanup_stale_owner_recovery_proxies() {",
        "fleet_recovery_reconnect_guest_shutdowns() {",
    )
    extracted = []
    for signature in signatures:
        if signature == "fleet_registry_build_guest_recovery_plan() {":
            start = fleet.index(signature)
            end = fleet.index("\nPY\n}", start) + len("\nPY\n}")
            extracted.append(fleet[start:end])
        else:
            extracted.append(_extract_fleet_function(fleet, signature))
    functions = "\n".join(extracted)

    owner = "6b" * 16
    retained_run_id = "20260910-021331-1465409"
    bench = "polar-odysseys-b1bd700090c2"
    machine_id = "deadbeef000019"
    clone_name = "cloudbench-retained-owner"
    guest_token = "retained-guest-token"
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    workspace_root = tmp_path / "rose-polar-streak-main"
    runs_root = (
        workspace_root
        / ".context"
        / "fleet"
        / "capability-stability-proof"
        / "capability-stability-20260910021331-1465395"
        / "runs"
    )
    output = runs_root / retained_run_id / bench
    output.mkdir(parents=True)
    (output / ".cid").write_text(f"clone {machine_id}\n")
    (output / "status-proxy.port").write_text("19813\n")
    (clones / clone_name).write_text(
        f"name={clone_name}\nid={machine_id}\nvolume_id=vol_retained_owner\n"
    )
    (clones / "cloudbench-volume-only").write_text(
        "name=cloudbench-volume-only\nvolume_id=vol_retained_only\n"
    )
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=99999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        f"run_id={retained_run_id}\n"
        f"workspace_root={workspace_root}\n"
        f"runs_root={runs_root}\n"
        f"audit_dir={tmp_path / 'audits' / owner}\n"
        f"owned_ids_file={tmp_path / 'audits' / owner / 'owned-clones.ids'}\n"
        f"owned_names_file={tmp_path / 'audits' / owner / 'owned-clones.names'}\n"
        "cleanup_policy=retain\n"
    )
    (registry / "guest-cleanup-unconfirmed").touch()
    helper = tmp_path / "exact-cleanup-helper"
    helper.write_text(
        """#!/usr/bin/env python3
from pathlib import Path
import sys

command = sys.argv[1]
arguments = dict(zip(sys.argv[2::2], sys.argv[3::2], strict=True))
receipt = Path(arguments["--receipt"])
if command == "cleanup-provider-sessions":
    for name in ("--run-json", "--backend-log", "--quiescence-receipt"):
        if not Path(arguments[name]).is_file():
            raise SystemExit(96)
    receipt.write_text('{"kind":"fixture-exact-provider-cleanup"}\\n')
elif command == "validate-recovery-receipt":
    if not receipt.is_file():
        raise SystemExit(95)
else:
    raise SystemExit(97)
"""
    )
    helper.chmod(0o755)
    guest_helper = GUEST_RECOVERY_SCRIPT
    state_payload = json.dumps(
        {
            "schema_version": "cloudbench-guest-state-v1",
            "version": 1,
            "state": "quiesced",
            "machine_id": machine_id,
            "guest_run_token": guest_token,
            "reason": "driver-exited-services-stopped",
            "driver_state": "exited",
            "driver_pid": None,
            "driver_process_state": None,
            "driver_token_match": False,
            "driver_descendants": [],
            "services_manifest": {
                "exists": True,
                "regular": True,
                "symlink": False,
                "bytes": 100,
                "within_limit": True,
            },
            "run_json": {
                "exists": True,
                "regular": True,
                "symlink": False,
                "bytes": 100,
                "within_limit": True,
            },
            "backend_log": {
                "exists": True,
                "regular": True,
                "symlink": False,
                "bytes": 100,
                "within_limit": True,
            },
            "services_status": "stopped",
            "stopped_service_pids": [99_999_991, 99_999_992],
            "live_service_pids": [],
            "backend_port": 3001,
            "backend_closed": True,
        },
        separators=(",", ":"),
    )
    calls = tmp_path / "calls"
    authorized = tmp_path / "authorized"

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_REGISTRY_DIR={shlex.quote(str(registry))}
FLEET_REGISTRY_PUBLISHED=0
KEEP_CLONES=0
RUN_ID=outer-controller-run
CLOUDBENCH_BARRIER_TOKEN=outer-controller-token
CLOUDBENCH_CHILD_TERM_SECONDS=1
EXACT_SESSION_CLEANUP_HELPER={shlex.quote(str(helper))}
GUEST_RECOVERY_HELPER={shlex.quote(str(guest_helper))}
AUTOSCALER_PORT_LEASE_HELPER=/unused
STALE_OWNER_RECOVERY_PROXY_PIDS=()
STALE_OWNER_RECOVERY_PORT_LEASE_TOKEN=""
STALE_OWNER_RECOVERY_PLAN_FILE=""
STALE_OWNER_RECOVERY_PORTS_FILE=""
CALLS={shlex.quote(str(calls))}
AUTHORIZED={shlex.quote(str(authorized))}
_agent_stale_owner_debug_log() {{ :; }}
registry_machine_details() {{ printf 'started {clone_name} fdaa::119\\n'; }}
machine_guest_recovery_configuration() {{
  printf 'retained-barrier-token\\t{guest_token}\\t8011\\n'
}}
claim_recovery_status_proxy_ports() {{ printf '62019\\n' > "$1"; }}
release_recovery_status_proxy_ports() {{ printf 'release\\n' >> "$CALLS"; }}
start_data_plane_proxy() {{
  sleep 60 &
  printf -v "$5" '%s' "$!"
}}
cloudbench_terminate_and_wait() {{
  shift
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
FLY() {{ printf 'fly %s\\n' "$*" >> "$CALLS"; }}
curl() {{
  local method=GET output_file="" authorization="" maximum="" url="" arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      -X) method="$1"; shift ;;
      -o) output_file="$1"; shift ;;
      -H)
        case "$1" in Authorization:*) authorization="$1" ;; esac
        shift
        ;;
      --max-filesize) maximum="$1"; shift ;;
      http://*) url="$arg" ;;
    esac
  done
  printf 'curl method=%s auth=%s max=%s url=%s\\n' \
    "$method" "$authorization" "$maximum" "$url" >> "$CALLS"
  case "$url" in
    */shutdown) printf 500 ;;
    */cloudbench-interrupt-cleanup-{guest_token}.status)
      [ "$authorization" = "Authorization: Bearer retained-barrier-token" ] || {{ printf 403; return; }}
      [ "$maximum" = 65536 ] || {{ printf 413; return; }}
      printf 404
      ;;
    */cloudbench-guest-quiescence-{guest_token}.json)
      [ "$authorization" = "Authorization: Bearer retained-barrier-token" ] || {{ printf 403; return; }}
      [ "$maximum" = 1048576 ] || {{ printf 413; return; }}
      printf '{{"schema_version":"cloudbench-guest-quiescence-v1"}}\\n' > "$output_file"
      printf 200
      ;;
    */cloudbench-guest-state-{guest_token}.json)
      [ "$authorization" = "Authorization: Bearer retained-barrier-token" ] || {{ printf 403; return; }}
      [ "$maximum" = 1048576 ] || {{ printf 413; return; }}
      printf '%s\\n' {shlex.quote(state_payload)} > "$output_file"
      printf 200
      ;;
    */repo/.context/cloudbench/run.json)
      [ "$authorization" = "Authorization: Bearer retained-barrier-token" ] || {{ printf 403; return; }}
      [ "$maximum" = 536870912 ] || {{ printf 413; return; }}
      printf '{{"tasks":[{{"name":"{bench}","agent_id":"11111111-2222-4333-8444-555555555555"}}]}}\\n' > "$output_file"
      printf 200
      ;;
    */repo/.context/cloudbench/logs/backend.log)
      [ "$authorization" = "Authorization: Bearer retained-barrier-token" ] || {{ printf 403; return; }}
      [ "$maximum" = 536870912 ] || {{ printf 413; return; }}
      printf 'exact root 11111111-2222-4333-8444-555555555555 sessionId=kernel-session-exact\\n' > "$output_file"
      printf 200
      ;;
    *) printf 404 ;;
  esac
}}
fleet_registry_confirm_guest_teardown() {{
  [ "$(cat {shlex.quote(str(output / 'guest-shutdown.confirmed'))})" = {retained_run_id} ] || return 96
  touch "$AUTHORIZED"
}}
{functions}

fleet_recovery_reconnect_guest_shutdowns {shlex.quote(str(registry))}
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert authorized.exists()
    assert (output / "guest-cleanup.quiescence.json").is_file()
    assert (output / "guest-cleanup.run.json").is_file()
    assert (output / "guest-cleanup.backend.log").is_file()
    assert not list(output.glob("guest-cleanup.*.tmp.*"))
    call_lines = calls.read_text().splitlines()
    assert any(
        line.endswith(f"/cloudbench-interrupt-cleanup-{guest_token}.status")
        for line in call_lines
    )
    assert any(
        line.endswith(f"/cloudbench-guest-quiescence-{guest_token}.json")
        for line in call_lines
    )
    assert all(
        f"/repo/.context/cloudbench/cloudbench-interrupt-cleanup-{guest_token}.status"
        not in line
        for line in call_lines
    )
    assert any(
        line.startswith("fly ssh console")
        and f"--receipt '/data/cloudbench-guest-quiescence-{guest_token}.json'" in line
        for line in call_lines
    )
    assert all(
        f"/data/cloudbench-guest-quiescence-{guest_token}.json" not in line
        for line in call_lines
        if line.startswith("curl ")
    )
    evidence_fetches = [
        line
        for line in call_lines
        if line.startswith("curl ") and "/shutdown" not in line
    ]
    assert evidence_fetches
    assert all(
        "auth=Authorization: Bearer retained-barrier-token" in line
        for line in evidence_fetches
    )
    assert call_lines[-1] == "release"


def test_runner_cleanup_receipt_recovery_rejects_incomplete_evidence(
    tmp_path: Path,
) -> None:
    """Missing, malformed, or token-mismatched runner evidence stays closed."""
    cases = {
        "missing": None,
        "malformed": "version=1\ntoken=guest-token\nstate=clean\nextra=unsafe\n",
        "token-mismatch": "version=1\ntoken=neighbor-token\nstate=clean\n",
        "not-clean": "version=1\ntoken=guest-token\nstate=failed\n",
    }
    for label, payload in cases.items():
        case_root = tmp_path / label
        case_root.mkdir()
        source = case_root / "runner.status"
        receipt = case_root / "recovery.json"
        if payload is not None:
            source.write_text(payload)
        result = subprocess.run(
            [
                sys.executable,
                str(EXACT_SESSION_CLEANUP_SCRIPT),
                "recover-runner-receipt",
                "--source",
                str(source),
                "--receipt",
                str(receipt),
                "--owner",
                "7a" * 16,
                "--fleet-run-id",
                "fixture-run",
                "--bench",
                "fixture-bench",
                "--machine-id",
                "deadbeef000001",
                "--output-dir",
                str(case_root),
                "--guest-run-token",
                "guest-token",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode != 0, label
        assert not receipt.exists(), label


def test_exact_provider_cleanup_uses_only_manifest_sessions_and_is_idempotent(
    tmp_path: Path,
) -> None:
    """Provider fallback never inventories sessions and receipts exact responses."""
    owner = "7b" * 16
    root_agent = "11111111-2222-4333-8444-555555555555"
    kernel_session = "kernel-session-exact"
    steel_session = "steel-session-exact"
    run_json = tmp_path / "run.json"
    backend_log = tmp_path / "backend.log"
    quiescence = tmp_path / "quiescence.json"
    manifest = tmp_path / "manifest.json"
    receipt = tmp_path / "receipt.json"
    output = tmp_path / "output"
    output.mkdir()
    run_json.write_text(
        json.dumps(
            {
                "tasks": [
                    {
                        "name": "fixture-bench",
                        "agent_id": root_agent,
                    }
                ]
            }
        )
    )
    backend_log.write_text(
        f"[HTTP] GET /api/agents/{root_agent} -> 200\n"
        f"[Kernel] Created Kernel browser session sessionId={kernel_session} contextId=context-a\n"
        f"[Steel] ✓ Created Steel session: {steel_session}\n"
    )
    quiescence.write_text(
        json.dumps(
            {
                "schema_version": "cloudbench-guest-quiescence-v1",
                "version": 1,
                "state": "quiesced",
                "guest_run_token": "guest-token",
                "machine_id": "deadbeef000001",
                "reason": "driver-exited-services-stopped",
                "driver_state": "exited",
                "driver_pid": None,
                "driver_process_state": None,
                "stopped_service_pids": [99999991, 99999992],
                "backend_port": 3001,
                "services_sha256": "1" * 64,
                "run_json_sha256": hashlib.sha256(run_json.read_bytes()).hexdigest(),
                "backend_log_sha256": hashlib.sha256(backend_log.read_bytes()).hexdigest(),
            }
        )
    )
    calls: list[tuple[str, str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_DELETE(self) -> None:
            calls.append(("DELETE", self.path, self.headers.get("Authorization", "")))
            self.send_response(204)
            self.end_headers()

        def do_POST(self) -> None:
            calls.append(("POST", self.path, self.headers.get("steel-api-key", "")))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"success":true,"message":"released"}')

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    env = {
        **os.environ,
        "KERNEL_API_KEY": "kernel-key",
        "STEEL_API_KEY": "steel-key",
        "KERNEL_API_BASE_URL": f"http://127.0.0.1:{port}",
        "STEEL_BASE_URL": f"http://127.0.0.1:{port}",
    }
    command = [
        sys.executable,
        str(EXACT_SESSION_CLEANUP_SCRIPT),
        "cleanup-provider-sessions",
        "--run-json",
        str(run_json),
        "--backend-log",
        str(backend_log),
        "--quiescence-receipt",
        str(quiescence),
        "--manifest",
        str(manifest),
        "--receipt",
        str(receipt),
        "--owner",
        owner,
        "--fleet-run-id",
        "fixture-run",
        "--bench",
        "fixture-bench",
        "--machine-id",
        "deadbeef000001",
        "--output-dir",
        str(output),
        "--guest-run-token",
        "guest-token",
        "--agents-env",
        str(tmp_path / "missing-agents.env"),
        "--backend-env",
        str(tmp_path / "missing-backend.env"),
    ]
    try:
        first = subprocess.run(command, env=env, text=True, capture_output=True, check=False)
        second = subprocess.run(command, env=env, text=True, capture_output=True, check=False)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    assert calls == [
        ("DELETE", f"/browsers/{kernel_session}", "Bearer kernel-key"),
        ("POST", f"/v1/sessions/{steel_session}/release", "steel-key"),
    ]
    manifest_value = json.loads(manifest.read_text())
    assert manifest_value["sessions"] == {
        "kernel": [kernel_session],
        "steel": [steel_session],
    }
    receipt_value = json.loads(receipt.read_text())
    assert receipt_value["kind"] == "provider-exact-cleanup"
    assert [(entry["provider"], entry["session_id"], entry["http_status"]) for entry in receipt_value["results"]] == [
        ("kernel", kernel_session, 204),
        ("steel", steel_session, 200),
    ]


def test_active_legacy_guest_seals_sessions_then_stops_exact_machine_before_cleanup(
    tmp_path: Path,
) -> None:
    """An immutable active guest is fenced by exact Machine stop before cleanup."""
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "machine_status_exact_read() {",
            "registry_machine_details() {",
            "cloudbench_seal_guest_evidence_file() {",
            "cloudbench_fetch_guest_evidence() {",
            "cloudbench_publish_guest_shutdown_confirmation() {",
            "cloudbench_recover_guest_cleanup_receipts() {",
        )
    )
    owner = "7c" * 16
    machine_id = "deadbeef000019"
    clone_name = "cloudbench-active-legacy"
    bench = "active-legacy-bench"
    guest_token = "active-legacy-token"
    root_agent = "11111111-2222-4333-8444-555555555555"
    kernel_session = "kernel-active-exact"
    output = tmp_path / "runs" / "fixture-run" / bench
    output.mkdir(parents=True)
    registry = tmp_path / "ownership" / owner
    registry.mkdir(parents=True)
    manifest = output / "guest-cleanup.provider-manifest.json"
    stopped_proof = output / "guest-cleanup.machine-stopped.json"
    receipt = output / "guest-cleanup.recovery-receipt.json"
    stopped_marker = tmp_path / "machine-stopped"
    calls = tmp_path / "calls"
    backend_log = (
        "[Server] Server started mode=fixture port=3001\n"
        "[HTTP] POST /api/agents -> 201 method=POST path=/api/agents status=201\n"
        f"[Tracing] span.start agent_id={root_agent} method=PATCH "
        f"path=/api/agents/{root_agent}\n"
        f"[Kernel] Created Kernel browser session sessionId={kernel_session} "
        "contextId=context-exact\n"
    )
    state_payload = json.dumps(
        {
            "schema_version": "cloudbench-guest-state-v1",
            "version": 1,
            "state": "active",
            "machine_id": machine_id,
            "guest_run_token": guest_token,
            "reason": "exact guest driver is still active",
            "driver_state": "running",
            "driver_pid": 99999991,
            "driver_process_state": "S",
            "driver_token_match": True,
            "driver_descendants": [
                {
                    "pid": 99999992,
                    "parent_pid": 99999991,
                    "process_state": "S",
                    "command": "run_benchmark.py",
                }
            ],
            "services_manifest": {
                "exists": True,
                "regular": True,
                "symlink": False,
                "bytes": 100,
                "within_limit": True,
            },
            "run_json": {
                "exists": False,
                "regular": False,
                "symlink": False,
                "bytes": None,
                "within_limit": False,
            },
            "backend_log": {
                "exists": True,
                "regular": True,
                "symlink": False,
                "bytes": len(backend_log),
                "within_limit": True,
            },
            "services_status": None,
            "stopped_service_pids": [],
            "live_service_pids": [],
            "backend_port": None,
            "backend_closed": None,
        },
        separators=(",", ":"),
    )

    class Handler(BaseHTTPRequestHandler):
        def do_DELETE(self) -> None:
            assert self.path == f"/browsers/{kernel_session}"
            assert stopped_proof.is_file(), "provider cleanup preceded exact stopped-state proof"
            with calls.open("a") as handle:
                handle.write("provider-delete\n")
            self.send_response(204)
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider_port = server.server_address[1]
    script = f"""set -uo pipefail
APP=bench-app
ROOT_DIR={shlex.quote(str(tmp_path))}
RUN_ID=fixture-run
CLOUDBENCH_BARRIER_TOKEN=barrier-token
EXACT_SESSION_CLEANUP_HELPER={shlex.quote(str(EXACT_SESSION_CLEANUP_SCRIPT))}
GUEST_RECOVERY_HELPER={shlex.quote(str(GUEST_RECOVERY_SCRIPT))}
REGISTRY={shlex.quote(str(registry))}
MANIFEST={shlex.quote(str(manifest))}
STOPPED_PROOF={shlex.quote(str(stopped_proof))}
STOPPED_MARKER={shlex.quote(str(stopped_marker))}
CALLS={shlex.quote(str(calls))}
recovery_benches=({shlex.quote(bench)})
recovery_clone_names=({shlex.quote(clone_name)})
recovery_machine_ids=({shlex.quote(machine_id)})
recovery_guest_tokens=({shlex.quote(guest_token)})
recovery_proxy_ports=(62019)
recovery_outputs=({shlex.quote(str(output))})
recovery_machine_states=(started)
_agent_stale_owner_debug_log() {{ :; }}
FLY() {{
  case "$1 $2" in
    "ssh console")
      case "$*" in *" quiesce "*) return 1 ;; *) return 0 ;; esac
      ;;
    "ssh sftp") return 0 ;;
    "machine stop")
      [ "$3" = {shlex.quote(machine_id)} ] || return 91
      [ -s "$MANIFEST" ] || return 92
      [ ! -e "$STOPPED_PROOF" ] || return 93
      printf 'machine-stop\\n' >> "$CALLS"
      touch "$STOPPED_MARKER"
      ;;
    "machine status")
      [ "$3" = {shlex.quote(machine_id)} ] || return 94
      if [ -e "$STOPPED_MARKER" ]; then state=stopped; else state=started; fi
      printf 'machine-status-%s\\n' "$state" >> "$CALLS"
      cat <<STATUS
Machine ID: {machine_id}
State: $state

VM
 ID         │ {machine_id}
 State      │ $state
 Name       │ {clone_name}
 Private IP │ fdaa::119
STATUS
      ;;
    *) return 95 ;;
  esac
}}
curl() {{
  local output_file="" url="" arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      -o) output_file="$1"; shift ;;
      -H|--max-time|--max-filesize|-w) shift ;;
      http://*) url="$arg" ;;
    esac
  done
  case "$url" in
    */cloudbench-interrupt-cleanup-{guest_token}.status) printf 404 ;;
    */cloudbench-guest-state-{guest_token}.json)
      printf '%s\\n' {shlex.quote(state_payload)} > "$output_file"
      printf 200
      ;;
    */repo/.context/cloudbench/logs/backend.log)
      printf '%s' {shlex.quote(backend_log)} > "$output_file"
      printf 200
      ;;
    *) printf 404 ;;
  esac
}}
{functions}

cloudbench_recover_guest_cleanup_receipts "$REGISTRY"
"""
    env = {
        **os.environ,
        "KERNEL_API_KEY": "kernel-key",
        "KERNEL_API_BASE_URL": f"http://127.0.0.1:{provider_port}",
    }
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            env=env,
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert result.returncode == 0, result.stderr + result.stdout
    assert json.loads(manifest.read_text())["sessions"] == {
        "kernel": [kernel_session],
        "steel": [],
    }
    assert json.loads(stopped_proof.read_text())["state"] == "stopped"
    assert json.loads(receipt.read_text())["kind"] == "provider-exact-cleanup"
    call_lines = calls.read_text().splitlines()
    assert call_lines.index("machine-stop") < call_lines.index("machine-status-stopped")
    assert call_lines.index("machine-status-stopped") < call_lines.index("provider-delete")
    assert (output / "guest-shutdown.confirmed").read_text() == "fixture-run\n"
    assert all("machines list" not in line for line in call_lines)


@pytest.mark.parametrize(
    ("database_container", "database_volume"),
    (
        ("", ""),
        (
            "victoria-db-exact-zero",
            "victoria-pgdata-exact-zero",
        ),
    ),
    ids=("canonical-system-postgres", "legacy-nominal-docker-labels"),
)
def test_quiesced_guest_writes_hashed_authoritative_zero_allocated_receipt(
    tmp_path: Path,
    database_container: str,
    database_volume: str,
) -> None:
    """Complete lifecycle plus an exact root/tree query can prove zero allocation."""
    owner = "7d" * 16
    machine_id = "deadbeef000020"
    guest_token = "zero-allocated-token"
    root_agent = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    bench = "zero-allocated-bench"
    data_dir = tmp_path / "data"
    repo_dir = data_dir / "repo"
    context_dir = repo_dir / ".context" / "cloudbench"
    logs_dir = context_dir / "logs"
    logs_dir.mkdir(parents=True)
    output = tmp_path / "output"
    output.mkdir()
    run_json = context_dir / "run.json"
    backend_log = logs_dir / "backend.log"
    services_path = context_dir / "services.json"
    quiescence = data_dir / "quiescence.json"
    query_proof = data_dir / "zero-query.json"
    manifest = output / "manifest.json"
    receipt = output / "receipt.json"
    database_name = "victoria_bench_exact_zero"
    run_json.write_text(
        json.dumps({"tasks": [{"name": bench, "agent_id": root_agent}]}) + "\n"
    )
    backend_log.write_text(
        "[Server] Server started mode=fixture port=3001\n"
        "[HTTP] POST /api/agents -> 201 method=POST path=/api/agents status=201\n"
        f"[HTTP] GET /api/agents/{root_agent} -> 200 method=GET "
        f"path=/api/agents/{root_agent} status=200 agent_id={root_agent}\n"
        f"[Prisma] db.query agent_id={root_agent} model=BrowserSession "
        "operation=findMany status=ok\n"
        "[Server] SIGTERM received, closing server...\n"
    )
    services = {
        "schema_version": 1,
        "benchmark_mode": True,
        "worktree": str(repo_dir),
        "status": "stopped",
        "run_sh_pid": 99999991,
        "ports": {"backend": 3001},
        "services": [{"name": "back-end", "pid": 99999992}],
        "database": {
            "container": database_container,
            "volume": database_volume,
            "owned_by_run_sh": True,
            "use_system_postgres": True,
            "name": database_name,
            "port": 5432,
            "runtime_port": 5432,
        },
    }
    services_path.write_text(json.dumps(services) + "\n")
    quiescence.write_text(
        json.dumps(
            {
                "schema_version": "cloudbench-guest-quiescence-v1",
                "version": 1,
                "state": "quiesced",
                "machine_id": machine_id,
                "guest_run_token": guest_token,
                "reason": "driver-exited-services-stopped",
                "driver_state": "exited",
                "driver_pid": None,
                "driver_process_state": None,
                "stopped_service_pids": [99999991, 99999992],
                "backend_port": 3001,
                "services_sha256": hashlib.sha256(services_path.read_bytes()).hexdigest(),
                "run_json_sha256": hashlib.sha256(run_json.read_bytes()).hexdigest(),
                "backend_log_sha256": hashlib.sha256(backend_log.read_bytes()).hexdigest(),
            }
        )
        + "\n"
    )
    psql_calls = tmp_path / "psql-calls"
    postgres_common = tmp_path / "usr" / "share" / "postgresql-common"
    postgres_common.mkdir(parents=True)
    fake_psql_target = postgres_common / "pg_wrapper"
    fake_psql_target.write_text(
        f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> {shlex.quote(str(psql_calls))}
case "$*" in
  *pg_database*) printf '%s\\n' {shlex.quote(database_name)} ;;
  *'UPDATE "Agent"'*) : ;;
  *json_build_object*)
    if [ -e {shlex.quote(str(tmp_path / "deleted"))} ]; then deleted=true; else deleted=false; fi
    printf '{{"root_exists":true,"root_deleted":%s,"tree_agent_ids":["{root_agent}"],"browser_sessions":[]}}\\n' "$deleted"
    ;;
  *) exit 91 ;;
esac
case "$*" in *'UPDATE "Agent"'*) touch {shlex.quote(str(tmp_path / "deleted"))} ;; esac
"""
    )
    fake_psql_target.chmod(0o755)
    psql_bin = tmp_path / "usr" / "bin"
    psql_bin.mkdir(parents=True)
    fake_psql = psql_bin / "psql"
    fake_psql.symlink_to("../share/postgresql-common/pg_wrapper")

    query = subprocess.run(
        [
            sys.executable,
            str(GUEST_RECOVERY_SCRIPT),
            "prove-zero-allocation",
            "--machine-id",
            machine_id,
            "--guest-run-token",
            guest_token,
            "--services",
            str(services_path),
            "--run-json",
            str(run_json),
            "--backend-log",
            str(backend_log),
            "--quiescence-receipt",
            str(quiescence),
            "--receipt",
            str(query_proof),
            "--psql-command",
            str(fake_psql),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert query.returncode == 0, query.stderr

    recover_command = [
        sys.executable,
        str(EXACT_SESSION_CLEANUP_SCRIPT),
        "recover-zero-allocation",
        "--owner",
        owner,
        "--fleet-run-id",
        "fixture-run",
        "--bench",
        bench,
        "--machine-id",
        machine_id,
        "--output-dir",
        str(output),
        "--guest-run-token",
        guest_token,
        "--run-json",
        str(run_json),
        "--backend-log",
        str(backend_log),
        "--quiescence-receipt",
        str(quiescence),
        "--zero-query-proof",
        str(query_proof),
        "--manifest",
        str(manifest),
        "--receipt",
        str(receipt),
    ]
    recovered = subprocess.run(recover_command, text=True, capture_output=True, check=False)
    assert recovered.returncode == 0, recovered.stderr
    validate_command = list(recover_command)
    validate_command[2] = "validate-recovery-receipt"
    validated = subprocess.run(
        validate_command,
        text=True,
        capture_output=True,
        check=False,
    )
    assert validated.returncode == 0, validated.stderr
    proof_value = json.loads(query_proof.read_text())
    assert proof_value["root_agent_id"] == root_agent
    assert proof_value["root_disposition"] == "deleted-exact-tree"
    assert proof_value["browser_sessions"] == []
    receipt_value = json.loads(receipt.read_text())
    assert receipt_value["kind"] == "provider-zero-allocated"
    assert receipt_value["allocation_event_count"] == 0
    assert receipt_value["browser_session_mutation_count"] == 0
    assert re.fullmatch(r"[0-9a-f]{64}", receipt_value["zero_query_proof_sha256"])
    psql_lines = psql_calls.read_text().splitlines()
    assert any("pg_database" in line and database_name in line for line in psql_lines)
    assert any(root_agent in line and '"BrowserSession"' in line for line in psql_lines)
    assert all("Kernel" not in line and "Steel" not in line for line in psql_lines)


@pytest.mark.parametrize(
    ("database_container", "database_volume"),
    (
        ("victoria-db-exact-zero", ""),
        ("", "victoria-pgdata-exact-zero"),
        ("victoria-db-exact-zero", "victoria-pgdata-other-zero"),
        ("victoria-db-wrong-zero", "victoria-pgdata-wrong-zero"),
    ),
    ids=(
        "container-only",
        "volume-only",
        "mismatched-labels",
        "wrong-database-suffix",
    ),
)
def test_zero_allocation_rejects_ambiguous_legacy_database_identity(
    tmp_path: Path,
    database_container: str,
    database_volume: str,
) -> None:
    """Legacy labels cannot widen an exact root query to an ambiguous database."""
    context = tmp_path / "repo" / ".context" / "cloudbench"
    context.mkdir(parents=True)
    services = context / "services.json"
    services.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "benchmark_mode": True,
                "worktree": str(tmp_path / "repo"),
                "status": "stopped",
                "database": {
                    "container": database_container,
                    "volume": database_volume,
                    "owned_by_run_sh": True,
                    "use_system_postgres": True,
                    "name": "victoria_bench_exact_zero",
                    "runtime_port": 5432,
                },
            }
        )
        + "\n"
    )
    receipt = tmp_path / "zero-allocation.json"
    result = subprocess.run(
        [
            sys.executable,
            str(GUEST_RECOVERY_SCRIPT),
            "prove-zero-allocation",
            "--machine-id",
            "deadbeef000020",
            "--guest-run-token",
            "zero-allocated-token",
            "--services",
            str(services),
            "--run-json",
            str(context / "run.json"),
            "--backend-log",
            str(context / "logs" / "backend.log"),
            "--quiescence-receipt",
            str(tmp_path / "quiescence.json"),
            "--receipt",
            str(receipt),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert (
        result.stderr
        == "ERROR: services evidence has no exact isolated stopped database identity\n"
    )
    assert not receipt.exists()


def test_system_postgres_services_manifest_omits_inactive_docker_identity(
    tmp_path: Path,
) -> None:
    """System-Postgres manifests must not publish nominal Docker ownership."""
    stack = STACK_SCRIPT.read_text()
    start = stack.index("write_services_manifest() {")
    end = stack.index("\n}\n\n# ── World Model Harness", start) + 3
    function = stack[start:end]
    repo = tmp_path / "repo"
    repo.mkdir()
    context = repo / ".context" / "cloudbench"
    script = f"""set -uo pipefail
cd {shlex.quote(str(repo))}
RUN_CONTEXT_DIR=.context/cloudbench
SERVICE_STATUS=stopped
NAMES=(back-end)
PIDS=(99999992)
BENCHMARK_MODE=true
DB_CONTAINER=victoria-db-exact-zero
DB_VOLUME=victoria-pgdata-exact-zero
DB_OWNED_BY_US=true
USE_SYSTEM_PG=true
LOCAL_DB_NAME=victoria_bench_exact_zero
LOCAL_DB_ACTUAL_PORT=5432
LOCAL_DB_PORT=5432
BACKEND_PORT=3001
FRONTEND_PORT=3002
HEALTH_PORT=3003
MAC_APP_PORT=0
SDK_METRICS_PORT=0
NGROK_WEB_PORT=0
{function}
write_services_manifest
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    database = json.loads((context / "services.json").read_text())["database"]
    assert database == {
        "container": "",
        "name": "victoria_bench_exact_zero",
        "owned_by_run_sh": True,
        "port": 5432,
        "runtime_port": 5432,
        "use_system_postgres": True,
        "volume": "",
    }


def test_zero_allocated_receipt_rejects_incomplete_or_nonzero_evidence(
    tmp_path: Path,
) -> None:
    """Missing terminal lifecycle or any provider allocation remains quarantined."""
    root_agent = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    bench = "zero-allocated-bench"
    output = tmp_path / "output"
    output.mkdir()
    run_json = tmp_path / "run.json"
    run_json.write_text(
        json.dumps({"tasks": [{"name": bench, "agent_id": root_agent}]}) + "\n"
    )
    quiescence = tmp_path / "quiescence.json"
    command_prefix = [
        sys.executable,
        str(EXACT_SESSION_CLEANUP_SCRIPT),
        "recover-zero-allocation",
        "--owner",
        "7e" * 16,
        "--fleet-run-id",
        "fixture-run",
        "--bench",
        bench,
        "--machine-id",
        "deadbeef000020",
        "--output-dir",
        str(output),
        "--guest-run-token",
        "zero-allocated-token",
        "--run-json",
        str(run_json),
        "--quiescence-receipt",
        str(quiescence),
    ]
    cases = {
        "missing-terminal-boundary": (
            "[Server] Server started mode=fixture\n"
            f"[HTTP] GET /api/agents/{root_agent} -> 200 agent_id={root_agent}\n"
        ),
        "provider-allocation": (
            "[Server] Server started mode=fixture\n"
            f"[HTTP] GET /api/agents/{root_agent} -> 200 agent_id={root_agent}\n"
            "[Kernel] Created Kernel browser session sessionId=kernel-nonzero\n"
            "[Server] SIGTERM received, closing server...\n"
        ),
        "browser-session-mutation": (
            "[Server] Server started mode=fixture\n"
            f"[HTTP] GET /api/agents/{root_agent} -> 200 agent_id={root_agent}\n"
            f"[Prisma] db.query agent_id={root_agent} model=BrowserSession "
            "operation=create status=ok\n"
            "[Server] SIGTERM received, closing server...\n"
        ),
    }
    for label, backend_payload in cases.items():
        case_root = tmp_path / label
        case_root.mkdir()
        backend_log = case_root / "backend.log"
        backend_log.write_text(backend_payload)
        quiescence.write_text(
            json.dumps(
                {
                    "schema_version": "cloudbench-guest-quiescence-v1",
                    "version": 1,
                    "state": "quiesced",
                    "machine_id": "deadbeef000020",
                    "guest_run_token": "zero-allocated-token",
                    "reason": "driver-exited-services-stopped",
                    "driver_state": "exited",
                    "driver_pid": None,
                    "driver_process_state": None,
                    "stopped_service_pids": [99999991],
                    "backend_port": 3001,
                    "services_sha256": "1" * 64,
                    "run_json_sha256": hashlib.sha256(run_json.read_bytes()).hexdigest(),
                    "backend_log_sha256": hashlib.sha256(backend_log.read_bytes()).hexdigest(),
                }
            )
            + "\n"
        )
        zero_query = case_root / "zero-query.json"
        zero_query.write_text(
            json.dumps(
                {
                    "schema_version": "cloudbench-guest-zero-allocation-v1",
                    "version": 1,
                    "machine_id": "deadbeef000020",
                    "guest_run_token": "zero-allocated-token",
                    "root_agent_id": root_agent,
                    "root_disposition": "root-absent",
                    "database_name": "victoria_bench_exact_zero",
                    "database_state": "present",
                    "tree_agent_ids": [],
                    "browser_sessions": [],
                    "services_sha256": "1" * 64,
                    "run_json_sha256": hashlib.sha256(run_json.read_bytes()).hexdigest(),
                    "backend_log_sha256": hashlib.sha256(backend_log.read_bytes()).hexdigest(),
                    "quiescence_receipt_sha256": hashlib.sha256(
                        quiescence.read_bytes()
                    ).hexdigest(),
                }
            )
            + "\n"
        )
        result = subprocess.run(
            [
                *command_prefix,
                "--backend-log",
                str(backend_log),
                "--zero-query-proof",
                str(zero_query),
                "--manifest",
                str(case_root / "manifest.json"),
                "--receipt",
                str(case_root / "receipt.json"),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode != 0, label
        assert not (case_root / "receipt.json").exists(), label


def test_exited_guest_quiescence_requires_stopped_services_and_seals_run_evidence(
    tmp_path: Path,
) -> None:
    """Driver exit is never cleanup proof; exact stopped services and evidence are."""
    data_dir = tmp_path / "data"
    repo_dir = data_dir / "repo"
    context_dir = repo_dir / ".context" / "cloudbench"
    logs_dir = context_dir / "logs"
    logs_dir.mkdir(parents=True)
    (data_dir / "cloudbench-driver.state").write_text("exited\n")
    run_json = context_dir / "run.json"
    backend_log = logs_dir / "backend.log"
    run_json.write_text('{"tasks":[]}\n')
    backend_log.write_text("durable exact backend evidence\n")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        backend_port = reservation.getsockname()[1]

    services = {
        "schema_version": 1,
        "benchmark_mode": True,
        "worktree": str(repo_dir),
        "status": "stopped",
        "run_sh_pid": 99_999_991,
        "ports": {"backend": backend_port},
        "services": [{"name": "back-end", "pid": 99_999_992}],
    }
    services_path = context_dir / "services.json"
    services_path.write_text(json.dumps(services))
    receipt = data_dir / "quiescence.json"
    command = [
        sys.executable,
        str(GUEST_RECOVERY_SCRIPT),
        "quiesce",
        "--machine-id",
        "deadbeef000001",
        "--guest-run-token",
        "guest-token",
        "--data-dir",
        str(data_dir),
        "--repo-dir",
        str(repo_dir),
        "--receipt",
        str(receipt),
        "--run-json",
        str(run_json),
        "--backend-log",
        str(backend_log),
    ]

    first = subprocess.run(command, text=True, capture_output=True, check=False)
    second = subprocess.run(command, text=True, capture_output=True, check=False)
    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    value = json.loads(receipt.read_text())
    assert value["reason"] == "driver-exited-services-stopped"
    assert value["run_json_sha256"] == hashlib.sha256(run_json.read_bytes()).hexdigest()
    assert value["backend_log_sha256"] == hashlib.sha256(backend_log.read_bytes()).hexdigest()

    receipt.unlink()
    services["status"] = "running"
    services_path.write_text(json.dumps(services))
    running_manifest = subprocess.run(command, text=True, capture_output=True, check=False)
    assert running_manifest.returncode != 0
    assert not receipt.exists()

    services["status"] = "stopped"
    services["run_sh_pid"] = os.getpid()
    services_path.write_text(json.dumps(services))
    live_service = subprocess.run(command, text=True, capture_output=True, check=False)
    assert live_service.returncode != 0
    assert not receipt.exists()


def test_running_guest_is_diagnosed_active_and_never_sealed_quiescent(
    tmp_path: Path,
) -> None:
    """A live exact benchmark process is active evidence, not a timeout verdict."""
    data_dir = tmp_path / "data"
    repo_dir = data_dir / "repo"
    context_dir = repo_dir / ".context" / "cloudbench"
    logs_dir = context_dir / "logs"
    logs_dir.mkdir(parents=True)
    backend_log = logs_dir / "backend.log"
    backend_log.write_text("bounded backend evidence from an active run\n")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        backend_port = reservation.getsockname()[1]
    (context_dir / "services.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "benchmark_mode": True,
                "worktree": str(repo_dir),
                "status": "stopped",
                "run_sh_pid": 99_999_991,
                "ports": {"backend": backend_port},
                "services": [{"name": "back-end", "pid": 99_999_992}],
            }
        )
    )
    run_token = "active-guest-token"
    driver = subprocess.Popen(
        ["sleep", "60"],
        env={**os.environ, "CLOUDBENCH_RUN_TOKEN": run_token},
    )
    try:
        (data_dir / "cloudbench-driver.state").write_text("running\n")
        (data_dir / "cloudbench-driver.pid").write_text(f"{driver.pid}\n")
        receipt = data_dir / "quiescence.json"
        state_receipt = data_dir / "state.json"
        result = subprocess.run(
            [
                sys.executable,
                str(GUEST_RECOVERY_SCRIPT),
                "quiesce",
                "--machine-id",
                "deadbeef000001",
                "--guest-run-token",
                run_token,
                "--data-dir",
                str(data_dir),
                "--repo-dir",
                str(repo_dir),
                "--receipt",
                str(receipt),
                "--state-receipt",
                str(state_receipt),
                "--run-json",
                str(context_dir / "run.json"),
                "--backend-log",
                str(backend_log),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
    finally:
        driver.terminate()
        driver.wait(timeout=5)

    assert result.returncode != 0
    assert "exact guest driver is still active" in result.stderr
    assert not receipt.exists()
    value = json.loads(state_receipt.read_text())
    assert value["schema_version"] == "cloudbench-guest-state-v1"
    assert value["state"] == "active"
    assert value["machine_id"] == "deadbeef000001"
    assert value["guest_run_token"] == run_token
    assert value["driver_state"] == "running"
    assert value["driver_pid"] == driver.pid
    assert value["driver_process_state"] is not None
    assert value["driver_token_match"] is True
    assert value["run_json"]["exists"] is False
    assert value["backend_log"]["exists"] is True
    assert value["reason"] == "exact guest driver is still active"
    described = subprocess.run(
        [
            sys.executable,
            str(GUEST_RECOVERY_SCRIPT),
            "describe-state",
            "--machine-id",
            "deadbeef000001",
            "--guest-run-token",
            run_token,
            "--receipt",
            str(state_receipt),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert described.returncode == 0, described.stderr
    assert described.stdout == "active\trunning\t0\texact guest driver is still active\n"


def test_uninspectable_driver_still_seals_fail_closed_state_evidence(
    tmp_path: Path,
) -> None:
    """A malformed driver boundary is unsafe, but remains exactly diagnosable."""
    data_dir = tmp_path / "data"
    repo_dir = data_dir / "repo"
    context_dir = repo_dir / ".context" / "cloudbench"
    context_dir.mkdir(parents=True)
    (data_dir / "cloudbench-driver.state").write_text("corrupt\n")
    receipt = data_dir / "quiescence.json"
    state_receipt = data_dir / "state.json"
    command = [
        sys.executable,
        str(GUEST_RECOVERY_SCRIPT),
        "quiesce",
        "--machine-id",
        "deadbeef000001",
        "--guest-run-token",
        "unsafe-guest-token",
        "--data-dir",
        str(data_dir),
        "--repo-dir",
        str(repo_dir),
        "--receipt",
        str(receipt),
        "--state-receipt",
        str(state_receipt),
    ]

    result = subprocess.run(command, text=True, capture_output=True, check=False)

    assert result.returncode != 0
    assert "exact guest driver state is not terminal or inspectable" in result.stderr
    assert not receipt.exists()
    value = json.loads(state_receipt.read_text())
    assert value["schema_version"] == "cloudbench-guest-state-v1"
    assert value["state"] == "unsafe"
    assert value["driver_state"] == "unreadable"
    assert value["driver_pid"] is None
    assert value["driver_descendants"] == []
    assert value["reason"] == "exact guest driver state is not terminal or inspectable"


def test_exact_guest_recovery_mapping_is_complete_and_volume_only_safe(
    tmp_path: Path,
) -> None:
    """Only one-to-one local output mappings may authorize guest reconnection."""
    fleet = FLEET_SCRIPT.read_text()
    start = fleet.index("fleet_registry_build_guest_recovery_plan() {")
    end = fleet.index("\nPY\n}", start) + len("\nPY\n}")
    build_plan = fleet[start:end]
    owner = "5b" * 16
    machine_id = "deadbeef000001"
    clone_name = "cloudbench-owned-machine"
    cases = (
        ("valid-with-volume-only-sibling", f"clone {machine_id}\n", "61001\n", True),
        ("missing-cid", None, "61001\n", False),
        ("malformed-cid", "clone not-hex\n", "61001\n", False),
        ("mismatched-cid", "clone deadbeef999999\n", "61001\n", False),
        ("missing-port", f"clone {machine_id}\n", None, False),
        ("malformed-port", f"clone {machine_id}\n", "70000\n", False),
    )

    for label, cid_payload, port_payload, should_pass in cases:
        case_root = tmp_path / label
        runs_root = case_root / "runs"
        run_id = "fixture-run"
        output = runs_root / run_id / "bench-owned"
        output.mkdir(parents=True)
        registry = case_root / "ownership" / owner
        clones = registry / "clones"
        clones.mkdir(parents=True)
        (registry / "meta").write_text(
            "version=2\n"
            "app=bench-app\n"
            f"fleet_owner_token={owner}\n"
            f"run_id={run_id}\n"
            f"runs_root={runs_root}\n"
            "cleanup_policy=retain\n"
        )
        (clones / clone_name).write_text(f"name={clone_name}\nid={machine_id}\nvolume_id=vol_owned_machine\n")
        (clones / "cloudbench-volume-only").write_text("name=cloudbench-volume-only\nvolume_id=vol_owned_only\n")
        if cid_payload is not None:
            (output / ".cid").write_text(cid_payload)
        if port_payload is not None:
            (output / "status-proxy.port").write_text(port_payload)
        plan = case_root / "plan"
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
{build_plan}
fleet_registry_build_guest_recovery_plan "$1" "$2"
""",
                "exact-recovery-plan",
                str(registry),
                str(plan),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

        if should_pass:
            assert result.returncode == 0, result.stderr
            rows = plan.read_text().splitlines()
            assert len(rows) == 1
            assert machine_id in rows[0]
            assert "vol_owned_machine" in rows[0]
            assert "vol_owned_only" not in rows[0]
        else:
            assert result.returncode != 0, f"{label} unexpectedly passed"
            assert not plan.exists()


def test_exact_guest_status_and_shutdown_config_fail_closed(
    tmp_path: Path,
) -> None:
    """Absent/malformed exact-ID state or config never reaches proxy startup."""
    fleet = FLEET_SCRIPT.read_text()
    status_functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "machine_status_exact_read() {",
            "registry_machine_details() {",
        )
    )
    machine_id = "deadbeef000001"
    calls = tmp_path / "status-calls"
    for mode, expected_status in (("absent", 1), ("malformed", 2)):
        calls.write_text("")
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
APP=bench-app
MODE="$1"
CALLS="$2"
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  if [ "$MODE" = absent ]; then
    printf "Error: machine {machine_id} was not found in app 'bench-app'\n" >&2
    return 1
  fi
  printf 'Machine ID: neighbor000001\nState: started\n'
}}
{status_functions}
registry_machine_details {machine_id}
""",
                "exact-machine-status",
                mode,
                str(calls),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        assert result.returncode == expected_status, f"{mode}: {result.stderr}{result.stdout}"
        assert calls.read_text().splitlines() == [f"machine status {machine_id} -a bench-app"]

    config_function = _extract_fleet_function(fleet, "machine_guest_recovery_configuration() {")
    valid_config = {
        "mounts": [{"volume": "vol_owned"}],
        "env": {
            "CLOUDBENCH_BARRIER_TOKEN": "barrier-token",
            "CLOUDBENCH_RUN_TOKEN": "guest-token",
            "CLOUDBENCH_STATUS_PORT": "8011",
        },
    }
    config_cases: list[tuple[str, str | None, bool]] = [
        ("valid", json.dumps(valid_config), True),
        (
            "missing-barrier-token",
            json.dumps(
                {
                    **valid_config,
                    "env": {
                        key: value for key, value in valid_config["env"].items() if key != "CLOUDBENCH_BARRIER_TOKEN"
                    },
                }
            ),
            False,
        ),
        (
            "malformed-barrier-token",
            json.dumps(
                {
                    **valid_config,
                    "env": {
                        **valid_config["env"],
                        "CLOUDBENCH_BARRIER_TOKEN": "unsafe token",
                    },
                }
            ),
            False,
        ),
        (
            "missing-guest-token",
            json.dumps(
                {
                    **valid_config,
                    "env": {key: value for key, value in valid_config["env"].items() if key != "CLOUDBENCH_RUN_TOKEN"},
                }
            ),
            False,
        ),
        (
            "malformed-status-port",
            json.dumps(
                {
                    **valid_config,
                    "env": {
                        **valid_config["env"],
                        "CLOUDBENCH_STATUS_PORT": "70000",
                    },
                }
            ),
            False,
        ),
        (
            "volume-mismatch",
            json.dumps({**valid_config, "mounts": [{"volume": "vol_neighbor"}]}),
            False,
        ),
        ("malformed-config", "{", False),
        ("unreadable-config", None, False),
    ]
    for label, payload, should_pass in config_cases:
        config_script = (
            "machine_config_exact_read() { return 1; }"
            if payload is None
            else "machine_config_exact_read() { printf '%s' \"$CONFIG\"; }"
        )
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"""set -uo pipefail
CONFIG="$1"
{config_script}
{config_function}
machine_guest_recovery_configuration {machine_id} vol_owned
""",
                "exact-machine-config",
                payload or "",
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        assert (result.returncode == 0) is should_pass, f"{label}: {result.stderr}{result.stdout}"


def test_exact_guest_recovery_retains_quarantine_on_proxy_or_health_failure(
    tmp_path: Path,
) -> None:
    """Proxy startup and non-204 shutdown health are mandatory acknowledgements."""
    fleet = FLEET_SCRIPT.read_text()
    cleanup_proxy = _extract_fleet_function(fleet, "cleanup_stale_owner_recovery_proxies() {")
    reconnect = _extract_fleet_function(fleet, "fleet_recovery_reconnect_guest_shutdowns() {")
    confirm = _extract_fleet_function(fleet, "cloudbench_confirm_guest_shutdowns() {")
    owner = "5c" * 16
    machine_id = "deadbeef000001"
    clone_name = "cloudbench-owned-machine"

    for mode in ("proxy-start-failure", "non-204-health"):
        case_root = tmp_path / mode
        registry = case_root / "ownership" / owner
        output = case_root / "runs" / "fixture-run" / "bench-owned"
        output.mkdir(parents=True)
        (registry / "clones").mkdir(parents=True)
        (registry / "meta").write_text("run_id=fixture-run\ncleanup_policy=retain\n")
        (registry / "guest-cleanup-unconfirmed").touch()
        unexpected = case_root / "unexpected-authorization"
        calls = case_root / "calls"
        script = f"""set -uo pipefail
MODE="$1"
REGISTRY="$2"
OUTPUT="$3"
UNEXPECTED="$4"
CALLS="$5"
FLEET_REGISTRY_DIR="$REGISTRY"
FLEET_REGISTRY_PUBLISHED=0
KEEP_CLONES=0
RUN_ID=original-run
CLOUDBENCH_BARRIER_TOKEN=original-token
CLOUDBENCH_CHILD_TERM_SECONDS=1
STALE_OWNER_RECOVERY_PROXY_PIDS=()
STALE_OWNER_RECOVERY_PORT_LEASE_TOKEN=""
STALE_OWNER_RECOVERY_PLAN_FILE=""
STALE_OWNER_RECOVERY_PORTS_FILE=""
_agent_stale_owner_debug_log() {{ :; }}
registry_meta_value() {{ sed -n "s/^$2=//p" "$1" | head -1; }}
fleet_registry_build_guest_recovery_plan() {{
  printf 'guest\tbench-owned\t{clone_name}\t{machine_id}\tvol_owned\t%s\t61001\n' \
    "$OUTPUT" > "$2"
}}
registry_machine_details() {{ printf 'started {clone_name} fdaa::101\n'; }}
machine_guest_recovery_configuration() {{
  printf 'barrier-token\tguest-token\t8011\n'
}}
claim_recovery_status_proxy_ports() {{ printf '62001\n' > "$1"; }}
release_recovery_status_proxy_ports() {{ printf 'release %s\n' "$1" >> "$CALLS"; }}
cloudbench_terminate_and_wait() {{
  shift
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}}
start_data_plane_proxy() {{
  printf 'proxy-start\n' >> "$CALLS"
  [ "$MODE" != proxy-start-failure ] || return 1
  sleep 60 &
  printf -v "$5" '%s' "$!"
}}
cloudbench_publish_guest_shutdown_confirmation() {{ touch "$UNEXPECTED"; return 99; }}
fleet_registry_confirm_guest_teardown() {{ touch "$UNEXPECTED"; return 99; }}
curl() {{
  local url="${{@: -1}}"
  printf '%s\n' "$url" >> "$CALLS"
  case "$url" in
    */shutdown) printf 202 ;;
    */shutdown-health) printf 500 ;;
    *) printf 404 ;;
  esac
}}
{confirm}
{cleanup_proxy}
{reconnect}
if fleet_recovery_reconnect_guest_shutdowns "$REGISTRY"; then
  exit 90
fi
[ -e "$REGISTRY/guest-cleanup-unconfirmed" ] || exit 91
[ "$(registry_meta_value "$REGISTRY/meta" cleanup_policy)" = retain ] || exit 92
[ ! -e "$UNEXPECTED" ] || exit 93
"""
        result = subprocess.run(
            [
                "bash",
                "-c",
                script,
                "exact-recovery-failure",
                mode,
                str(registry),
                str(output),
                str(unexpected),
                str(calls),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        assert result.returncode == 0, f"{mode}: {result.stderr}{result.stdout}"
        call_lines = calls.read_text().splitlines()
        assert "proxy-start" in call_lines
        assert sum(line.startswith("release ") for line in call_lines) == 1
        if mode == "non-204-health":
            assert any(line.endswith("/shutdown") for line in call_lines)
            assert any(line.endswith("/shutdown-health") for line in call_lines)
        else:
            assert all("/shutdown" not in line for line in call_lines)


def test_exact_recovery_releases_only_its_capacity_and_proxy_leases(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    owner = "5d" * 16
    neighbor = "6d" * 16
    capacity_root = tmp_path / "capacity"
    reservations = capacity_root / "reservations"
    reservations.mkdir(parents=True)
    owner_meta = tmp_path / "meta"
    pid_start = "Mon Jan 1 00:00:00 2001"
    owner_meta.write_text(f"host=test-host\npid=999999\npid_start={pid_start}\nfleet_owner_token={owner}\n")

    def reservation_payload(token: str, fleet_owner: str) -> str:
        return (
            "version=1\n"
            "app=bench-app\n"
            "host=test-host\n"
            "pid=999999\n"
            f"pid_start={pid_start}\n"
            f"fleet_owner_token={fleet_owner}\n"
            f"token={token}\n"
        )

    owner_token = f"{owner}-primary"
    neighbor_token = f"{neighbor}-primary"
    (reservations / owner_token).write_text(reservation_payload(owner_token, owner))
    neighbor_reservation = reservations / neighbor_token
    neighbor_reservation.write_text(reservation_payload(neighbor_token, neighbor))
    capacity_functions = "\n".join(
        (
            _extract_fleet_function(fleet, "registry_meta_value() {"),
            _extract_fleet_function(fleet, "capacity_release_stale_owner_reservations() {"),
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
CAPACITY_RESERVATION_ROOT="$1"
{capacity_functions}
capacity_release_stale_owner_reservations "$2" "$3"
""",
            "exact-capacity-release",
            str(capacity_root),
            str(owner_meta),
            owner_token,
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not (reservations / owner_token).exists()
    assert neighbor_reservation.exists()

    release_proxy = _extract_fleet_function(fleet, "release_recovery_status_proxy_ports() {")
    assert "release-owner" not in release_proxy
    lease_root = tmp_path / "proxy-leases"
    lease_root.mkdir()
    ports_file = tmp_path / "ports"
    ports_file.write_text("62001\n")
    release_result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
CLOUDBENCH_RECOVERY_PORT_LEASE_ROOT="$1"
AUTOSCALER_PORT_LEASE_HELPER="$2"
STALE_OWNER_RECOVERY_PORTS_FILE="$3"
process_start="$(ps -o lstart= -p $$ | awk '{{$1=$1; print}}')"
printf '{{"pid":%s,"process_start":"%s","token":"exact-token"}}\n' \
  "$$" "$process_start" > "$1/62001"
printf '{{"pid":%s,"process_start":"%s","token":"neighbor-token"}}\n' \
  "$$" "$process_start" > "$1/62002"
{release_proxy}
release_recovery_status_proxy_ports exact-token
[ ! -e "$1/62001" ] && [ -e "$1/62002" ]
""",
            "exact-proxy-release",
            str(lease_root),
            str(PORT_LEASE_SCRIPT),
            str(ports_file),
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert release_result.returncode == 0, release_result.stderr


def test_exact_v2_pool_recovery_reads_only_owner_audit_claims(
    tmp_path: Path,
) -> None:
    fleet = FLEET_SCRIPT.read_text()
    owner = "5e" * 16
    exact_id = "deadbeef000001"
    neighbor_id = "feedface000002"
    audit_root = tmp_path / "audits"
    audit = audit_root / owner
    (audit / "pool").mkdir(parents=True)
    (audit / "fresh").mkdir()
    (audit / "meta").write_text(f"fleet_owner_token={owner}\napp=bench-app\n")
    (audit / "pool" / exact_id).write_text(
        f"machine_id={exact_id}\nfleet_owner_token={owner}\napp=bench-app\ndisposition=claimed\n"
    )
    claims = tmp_path / "claims"
    claims.mkdir()
    (claims / exact_id).write_text("exact\n")
    (claims / neighbor_id).write_text("malformed-neighbor-must-not-be-read\n")
    owner_meta = tmp_path / "ownership" / owner / "meta"
    owner_meta.parent.mkdir(parents=True)
    owner_meta.write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        f"audit_dir={audit}\n"
    )
    calls = tmp_path / "calls"
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "exact_owner_pool_claim_ids() {",
            "recover_exact_pool_claims() {",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -uo pipefail
APP=bench-app
FLEET_AUDIT_ROOT="$1"
POOL_CLAIMS_DIR="$2"
CALLS="$3"
pool_claim_cleanup_unconfirmed() {{ return 1; }}
recover_one_exact_pool_claim() {{ printf '%s\n' "${{1##*/}}" >> "$CALLS"; }}
{functions}
recover_exact_pool_claims "$4" exact
""",
            "exact-pool-recovery",
            str(audit_root),
            str(claims),
            str(calls),
            str(owner_meta),
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert calls.read_text().splitlines() == [exact_id]
    assert (claims / neighbor_id).exists()


def test_recovery_proxy_batch_claim_rolls_back_partial_publication(
    tmp_path: Path,
) -> None:
    """A failed all-or-nothing port batch leaves no partial recovery lease."""
    spec = importlib.util.spec_from_file_location(
        "cloudbench_port_lease_batch_rollback",
        PORT_LEASE_SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module._candidate_ports = lambda _start: [62010, 62011]
    module._port_is_bindable = lambda _port: True
    root = tmp_path / "leases"
    with module.Registry(root) as registry:
        original_publish = registry._publish
        publish_count = 0

        def fail_second_publish(lease: Path, record: dict[str, object]) -> None:
            nonlocal publish_count
            publish_count += 1
            if publish_count == 2:
                raise RuntimeError("injected second lease publication failure")
            original_publish(lease, record)

        registry._publish = fail_second_publish
        try:
            registry.claim_batch(
                owner_pid=os.getpid(),
                token="exact-recovery",
                start=62010,
                count=2,
            )
        except RuntimeError as error:
            assert "injected second lease publication failure" in str(error)
        else:
            raise AssertionError("partial batch publication unexpectedly succeeded")
    assert not [path for path in root.iterdir() if path.name.isdigit()]


def test_forced_exact_reaper_uses_only_owned_machine_ids_and_exact_volume_ids(
    tmp_path: Path,
) -> None:
    """Exact stale-owner cleanup must never inventory or resolve neighboring Machines."""
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "machine_status_exact_read() {",
            "machine_config_exact_read() {",
            "machine_volume_id_from_json() {",
            "machine_volume_id() {",
            "volume_inventory_contains_id() {",
            "reap_volume() {",
            "reap_machine() {",
            "registry_meta_value() {",
            "registry_resolve_name() {",
            "registry_machine_details() {",
            "registry_record_is_stale_phantom() {",
            "registry_record_is_stale_pre_volume_id() {",
            "reap_registry_clones() {",
        )
    )
    owner = "7b" * 16
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    machine_id = "deadbeef000001"
    machine_volume = "vol_owned_machine"
    volume_only = "vol_owned_only"
    machine_name = "cloudbench-owned-machine"
    volume_name = "cloudbench-owned-volume-only"
    (registry / "meta").write_text("version=2\n")
    (clones / machine_name).write_text(f"name={machine_name}\nid={machine_id}\nvolume_id={machine_volume}\n")
    (clones / volume_name).write_text(f"name={volume_name}\nvolume_id={volume_only}\n")
    calls = tmp_path / "provider-calls"
    destroyed_machine = tmp_path / "machine-destroyed"

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(tmp_path / "audits"))}
REGISTRY={shlex.quote(str(registry))}
CALLS={shlex.quote(str(calls))}
DESTROYED_MACHINE={shlex.quote(str(destroyed_machine))}
WARM_ID=feedface000001
WARM_VOLUME_ID=vol_warm_source
sleep() {{ :; }}
fleet_audit_update_registry_clone() {{ :; }}
registry_record_machine_identity() {{ return 99; }}
registry_retire_absent_stale_pre_volume_records() {{ return 0; }}
registry_runner_count() {{ return 99; }}
FLY() {{
  printf '%s\\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "machines list")
      printf 'FORBIDDEN_NEIGHBOR_INVENTORY\\n' >> "$CALLS"
      return 98
      ;;
    "machine status")
      [ "$3" = {machine_id} ] || return 97
      if [ -e "$DESTROYED_MACHINE" ]; then
        printf "Error: machine %s was not found in app '%s'\\n" "$3" "$APP" >&2
        return 1
      fi
      cat <<'STATUS'
Machine ID: {machine_id}
Instance ID: fixture
State: started
HostStatus: ok

VM
  ID            = {machine_id}
  Instance ID   = fixture
  State         = started
  Image         = fixture
  Name          = {machine_name}
  Private IP    = fdaa::101
  Region        = iad
  Process Group =
  CPU Kind      = shared
  vCPUs         = 2
  Memory        = 4096
  Created       = fixture
  Updated       = fixture
  Entrypoint    =
  Command       =
  Volume        = {machine_volume}
STATUS
      ;;
    "machine destroy")
      [ "$4" = {machine_id} ] || return 96
      : > "$DESTROYED_MACHINE"
      ;;
    "machine stop")
      return 0
      ;;
    "volumes destroy")
      case "$3" in {machine_volume}|{volume_only}) ;; *) return 95 ;; esac
      ;;
    "volumes show")
      case "$3" in {machine_volume}|{volume_only}) ;; *) return 94 ;; esac
      printf '{{"id":"%s","state":"pending_destroy"}}\\n' "$3"
      ;;
    *) return 93 ;;
  esac
}}
{functions}

reap_registry_clones "$REGISTRY" forced || exit 90
[ ! -e "$REGISTRY/clones/{machine_name}" ] || exit 91
[ ! -e "$REGISTRY/clones/{volume_name}" ] || exit 92
! grep -q 'FORBIDDEN_NEIGHBOR_INVENTORY' "$CALLS" || exit 93
! grep -q 'neighbor' "$CALLS" || exit 94
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    call_lines = calls.read_text().splitlines()
    assert any(line.startswith(f"machine status {machine_id} ") for line in call_lines)
    assert all("machines list" not in line for line in call_lines)
    assert all(
        machine_id in line or machine_volume in line or volume_only in line or line.startswith("machine stop")
        for line in call_lines
    )


def test_exact_recovery_entrypoint_has_no_global_machine_or_proxy_sweep() -> None:
    fleet = FLEET_SCRIPT.read_text()
    start = fleet.index('if [ "$RECOVER_STALE_ONLY" = "1" ]; then', fleet.index("# ── One controller lock"))
    end = fleet.index("\nfi\n", start) + len("\nfi\n")
    recovery_entrypoint = fleet[start:end]

    assert "machines list" not in recovery_entrypoint
    assert "reap_orphaned_fleet_proxies" not in recovery_entrypoint
    assert "resolve_exact_recovery_warm_identity" in recovery_entrypoint


def test_exact_recovery_hands_volume_only_owned_audit_to_registry_reaper(
    tmp_path: Path,
) -> None:
    """A failed clone may own an exact volume without ever allocating a Machine.

    Audit-only crash-window recovery must accept that complete volume-only
    identity so the registry reaper can terminalize the exact owned volume.
    """
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "fleet_registry_cleanup_state() {",
            "registry_owner_alive() {",
            "recover_registry_audit_only_fresh() {",
            "reap_registry_clones() {",
            "fleet_registry_remove_if_empty() {",
            "acquire_registry_recovery_lock() {",
            "release_cleanup_disk_reserve() {",
            "recover_exact_stale_fleet_owner() {",
        )
    )
    owner = "6a7697fabc1e45d8891d8b2d835e02c7"
    clone_name = "cloudbench-54c419a2a76f4b27bfc46694"
    volume_id = "vol_vz8m80el8w7dwqxv"
    source_id = "683e47df5094d8"
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    audit_root = tmp_path / "audits"
    audit = audit_root / owner
    for directory in (audit / "fresh", audit / "expected-fresh", audit / "by-machine-id"):
        directory.mkdir(parents=True, exist_ok=True)
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=99999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        f"audit_dir={audit}\n"
        "cleanup_policy=reap\n"
    )
    (audit / "meta").write_text(f"version=1\nfleet_owner_token={owner}\napp=bench-app\n")
    (audit / "expected-fresh" / clone_name).write_text(f"clone_name={clone_name}\nsource_machine_id={source_id}\n")
    (audit / "fresh" / clone_name).write_text(
        "version=1\n"
        f"fleet_owner_token={owner}\n"
        "run_id=fixture-run\n"
        "app=bench-app\n"
        f"clone_name={clone_name}\n"
        "source=fresh-clone\n"
        f"source_machine_id={source_id}\n"
        "machine_id=\n"
        f"volume_id={volume_id}\n"
        "disposition=owned\n"
    )
    record = clones / clone_name
    record.write_text(f"name={clone_name}\nvolume_id={volume_id}\n")
    calls = tmp_path / "calls"

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(audit_root))}
FLEET_OWNER_HOST=test-host
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={owner}
REGISTRY={shlex.quote(str(registry))}
CALLS={shlex.quote(str(calls))}
registry_resolve_name() {{ return 1; }}
registry_record_is_stale_phantom() {{ return 99; }}
registry_record_machine_identity() {{
  printf 'unexpected machine identity repair: %s\n' "$*" >> "$CALLS"
  return 99
}}
registry_retire_absent_stale_pre_volume_records() {{ return 99; }}
reap_volume() {{
  printf 'reap_volume %s\n' "$1" >> "$CALLS"
  [ "$1" = {volume_id} ]
}}
fleet_audit_update_registry_clone() {{
  printf 'audit_update %s\n' "$*" >> "$CALLS"
  [ "$1" = "$REGISTRY" ] \
    && [ "$2" = {clone_name} ] \
    && [ -z "$3" ] \
    && [ "$4" = {volume_id} ] \
    && [ "$5" = destroyed-verified-absent ]
}}
recover_exact_pool_claims() {{
  printf 'recover_exact_pool_claims\n' >> "$CALLS"
}}
capacity_release_stale_owner_reservations() {{
  printf 'capacity_release %s\n' "$*" >> "$CALLS"
}}
fleet_audit_finalize_recovered_registry() {{
  printf 'audit_finalize %s\n' "$*" >> "$CALLS"
}}
{functions}

if ! recover_exact_stale_fleet_owner {owner}; then
  echo "FAIL: volume-only owned audit was rejected before registry reaper" >&2
  exit 91
fi
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert calls.read_text().splitlines() == [
        f"reap_volume {volume_id}",
        (f"audit_update {registry} {clone_name}  {volume_id} destroyed-verified-absent"),
        "recover_exact_pool_claims",
        f"capacity_release {registry / 'meta'} {owner}-primary",
        f"audit_finalize {registry}",
    ]
    assert not record.exists()


def test_audit_only_recovery_rejects_noncanonical_owned_identities(
    tmp_path: Path,
) -> None:
    """Owned recovery accepts only exact volume-only or machine+volume forms."""
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "recover_registry_audit_only_fresh() {",
        )
    )
    owner = "7" * 32
    clone_name = "cloudbench-owned-invariant"
    source_id = "683e47df5094d8"
    volume_id = "vol_exact"
    cases = (
        ("empty", "", "", f"name={clone_name}\n"),
        ("missing-registry", "", volume_id, None),
        ("partial-registry", "", volume_id, f"name={clone_name}\n"),
        (
            "conflicting-volume",
            "",
            volume_id,
            f"name={clone_name}\nvolume_id=vol_other\n",
        ),
        (
            "ambiguous-empty-machine-field",
            "",
            volume_id,
            f"name={clone_name}\nid=\nvolume_id={volume_id}\n",
        ),
        (
            "malformed-machine",
            "not-hex",
            volume_id,
            f"name={clone_name}\nid=not-hex\nvolume_id={volume_id}\n",
        ),
    )

    for label, machine_id, audit_volume_id, record_payload in cases:
        case_root = tmp_path / label
        ownership_root = case_root / "ownership"
        registry = ownership_root / owner
        clones = registry / "clones"
        clones.mkdir(parents=True)
        audit_root = case_root / "audits"
        audit = audit_root / owner
        for directory in (
            audit / "fresh",
            audit / "expected-fresh",
            audit / "by-machine-id",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        (registry / "meta").write_text(f"version=2\napp=bench-app\nfleet_owner_token={owner}\naudit_dir={audit}\n")
        (audit / "meta").write_text(f"fleet_owner_token={owner}\napp=bench-app\n")
        (audit / "expected-fresh" / clone_name).write_text(f"clone_name={clone_name}\nsource_machine_id={source_id}\n")
        (audit / "fresh" / clone_name).write_text(
            "version=1\n"
            f"fleet_owner_token={owner}\n"
            "run_id=fixture-run\n"
            "app=bench-app\n"
            f"clone_name={clone_name}\n"
            "source=fresh-clone\n"
            f"source_machine_id={source_id}\n"
            f"machine_id={machine_id}\n"
            f"volume_id={audit_volume_id}\n"
            "disposition=owned\n"
        )
        if record_payload is not None:
            (clones / clone_name).write_text(record_payload)
        unexpected = case_root / "unexpected-provider-or-repair-call"
        script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(audit_root))}
REGISTRY={shlex.quote(str(registry))}
UNEXPECTED={shlex.quote(str(unexpected))}
registry_resolve_name() {{ touch "$UNEXPECTED"; return 99; }}
registry_record_is_stale_phantom() {{ touch "$UNEXPECTED"; return 99; }}
registry_record_machine_identity() {{ touch "$UNEXPECTED"; return 99; }}
fleet_audit_update_registry_clone() {{ touch "$UNEXPECTED"; return 99; }}
{functions}
if recover_registry_audit_only_fresh "$REGISTRY"; then
  exit 90
fi
[ ! -e "$UNEXPECTED" ] || exit 91
"""
        result = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        assert result.returncode == 0, f"{label}: {result.stderr}{result.stdout}"


def test_stale_registry_identity_promotes_original_audit_before_publish_and_retries(
    tmp_path: Path,
) -> None:
    """A post-clone SIGKILL leaves a v2 audit pending and its registry name-only.

    Recovery must promote the original owner's audit before publishing the exact
    registry identity.  A failure in that second write stays retryable from the
    owned audit, while partial records repair only when their fields agree.
    """
    fleet = FLEET_SCRIPT.read_text()
    functions = "\n".join(
        _extract_fleet_function(fleet, signature)
        for signature in (
            "registry_meta_value() {",
            "fleet_audit_update_registry_clone() {",
            "registry_record_machine_identity() {",
            "recover_registry_audit_only_fresh() {",
        )
    )
    ownership_root = tmp_path / "ownership"
    owner = "d" * 32
    registry = ownership_root / owner
    clones = registry / "clones"
    clones.mkdir(parents=True)
    audit_root = tmp_path / "audits"
    audit = audit_root / owner
    for directory in (audit / "fresh", audit / "expected-fresh", audit / "by-machine-id"):
        directory.mkdir(parents=True, exist_ok=True)
    workspace = tmp_path / "workspace"
    runs_root = workspace / ".context" / "fleet" / "runs"
    runs_root.mkdir(parents=True)
    clone_name = "cloudbench-crash-window"
    machine_id = "deadbeef000001"
    volume_id = "vol_exact"
    source_id = "feedface000000"
    (registry / "meta").write_text(
        "version=2\n"
        "app=bench-app\n"
        f"fleet_owner_token={owner}\n"
        "host=test-host\n"
        "pid=999999\n"
        "pid_start=Mon Jan 1 00:00:00 2001\n"
        "run_id=fixture-run\n"
        f"workspace_root={workspace}\n"
        f"runs_root={runs_root}\n"
        f"audit_dir={audit}\n"
        f"owned_ids_file={audit / 'owned-clones.ids'}\n"
        f"owned_names_file={audit / 'owned-clones.names'}\n"
        "cleanup_policy=reap\n"
    )
    (audit / "meta").write_text(
        "version=1\n"
        f"fleet_owner_token={owner}\n"
        "run_id=fixture-run\n"
        "app=bench-app\n"
        f"workspace_root={workspace}\n"
        "status=incomplete\n"
    )
    (audit / "owned-clones.ids").write_text("")
    (audit / "owned-clones.names").write_text("")
    (audit / "expected-fresh" / clone_name).write_text(f"clone_name={clone_name}\nsource_machine_id={source_id}\n")
    fresh = audit / "fresh" / clone_name
    fresh.write_text(
        "version=1\n"
        f"fleet_owner_token={owner}\n"
        "run_id=fixture-run\n"
        "app=bench-app\n"
        f"clone_name={clone_name}\n"
        "source=fresh-clone\n"
        f"source_machine_id={source_id}\n"
        "machine_id=\n"
        "volume_id=\n"
        "disposition=ownership-pending\n"
    )
    record = clones / clone_name
    record.write_text(f"name={clone_name}\n")
    unexpected = tmp_path / "unexpected-provider-call"
    outside = tmp_path / "outside-record"
    outside.write_text(f"name={clone_name}\n")

    script = f"""set -uo pipefail
APP=bench-app
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
FLEET_AUDIT_ROOT={shlex.quote(str(audit_root))}
REGISTRY={shlex.quote(str(registry))}
CLONES={shlex.quote(str(clones))}
RECORD={shlex.quote(str(record))}
FRESH={shlex.quote(str(fresh))}
CLONE={clone_name}
MACHINE={machine_id}
VOLUME={volume_id}
UNEXPECTED={shlex.quote(str(unexpected))}
OUTSIDE={shlex.quote(str(outside))}
trap 'chmod 755 "$CLONES" 2>/dev/null || true' EXIT
registry_resolve_name() {{ touch "$UNEXPECTED"; return 99; }}
machine_volume_id() {{ touch "$UNEXPECTED"; return 99; }}
registry_record_is_stale_phantom() {{ touch "$UNEXPECTED"; return 99; }}
{functions}

# Make only registry publication fail. The original audit must already be an
# exact owned record when registry_record_machine_identity returns nonzero.
CLOUDBENCH_TEST_MODE=1
CLOUDBENCH_TEST_FAIL_IDENTITY_AFTER_AUDIT=1
first_rc=0
registry_record_machine_identity "$RECORD" "$CLONE" "$MACHINE" "$VOLUME" \
  2>{shlex.quote(str(tmp_path / "first.err"))} || first_rc=$?
[ "$first_rc" -ne 0 ] || exit 20
[ "$(registry_meta_value "$FRESH" disposition)" = owned ] || exit 21
[ "$(registry_meta_value "$FRESH" machine_id)" = "$MACHINE" ] || exit 22
[ "$(registry_meta_value "$FRESH" volume_id)" = "$VOLUME" ] || exit 23
[ "$(registry_meta_value "$RECORD" id)" = "" ] || exit 24
[ "$(registry_meta_value "$RECORD" volume_id)" = "" ] || exit 25
owned_audit="$(sha256sum "$FRESH" | awk '{{print $1}}')"

# Retry from the audit-first crash window: the existing name-only registry must
# be repaired without a provider query.
unset CLOUDBENCH_TEST_FAIL_IDENTITY_AFTER_AUDIT
recover_registry_audit_only_fresh "$REGISTRY" || exit 26
[ "$(registry_meta_value "$RECORD" id)" = "$MACHINE" ] || exit 27
[ "$(registry_meta_value "$RECORD" volume_id)" = "$VOLUME" ] || exit 28
[ "$(sha256sum "$FRESH" | awk '{{print $1}}')" = "$owned_audit" ] || exit 35

# An id-only partial publication is also repairable from the exact owned audit.
printf 'name=%s\nid=%s\n' "$CLONE" "$MACHINE" > "$RECORD"
recover_registry_audit_only_fresh "$REGISTRY" || exit 29
[ "$(registry_meta_value "$RECORD" volume_id)" = "$VOLUME" ] || exit 30

# Pool handoff owns its own recovery transaction. If it crashes after the audit
# moves to transfer-pending but before registry unlink, identity reconciliation
# must leave that exact record for downstream pool-claim recovery.
cp "$FRESH" "$FRESH.owned"
sed 's/^disposition=owned$/disposition=transfer-pending-stopped/' \
  "$FRESH.owned" > "$FRESH"
transfer_record="$(sha256sum "$RECORD" | awk '{{print $1}}')"
recover_registry_audit_only_fresh "$REGISTRY" || exit 38
[ "$(sha256sum "$RECORD" | awk '{{print $1}}')" = "$transfer_record" ] || exit 39
rm -f "$RECORD"
recover_registry_audit_only_fresh "$REGISTRY" || exit 40
[ ! -e "$RECORD" ] || exit 41
mv "$FRESH.owned" "$FRESH"

# A conflicting identity and a symlink are never repaired or dereferenced.
printf 'name=%s\nid=%s\nvolume_id=vol_wrong\n' "$CLONE" "$MACHINE" > "$RECORD"
if recover_registry_audit_only_fresh "$REGISTRY"; then exit 31; fi
[ "$(registry_meta_value "$RECORD" volume_id)" = vol_wrong ] || exit 32
rm -f "$RECORD"
ln -s "$OUTSIDE" "$RECORD"
if recover_registry_audit_only_fresh "$REGISTRY"; then exit 33; fi
[ ! -e "$UNEXPECTED" ] || exit 34

# A terminal audit can never be moved backwards into owned, even when the
# registry identity itself is exact.
rm -f "$RECORD"
printf 'name=%s\nid=%s\nvolume_id=%s\n' "$CLONE" "$MACHINE" "$VOLUME" > "$RECORD"
sed 's/^disposition=owned$/disposition=destroyed-verified-absent/' "$FRESH" > "$FRESH.tmp"
mv "$FRESH.tmp" "$FRESH"
if registry_record_machine_identity "$RECORD" "$CLONE" "$MACHINE" "$VOLUME"; then
  exit 36
fi
[ "$(registry_meta_value "$FRESH" disposition)" = destroyed-verified-absent ] || exit 37
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_stale_pre_volume_id_registry_retires_after_authoritative_absence(
    tmp_path: Path,
) -> None:
    """A dead-owner record written before exact volume attribution must not
    block every future fleet forever after both its machine and forked volume
    are gone. Recovery may retire it only after the exact machine and clone
    name are absent and a strict provider read proves there are no unattached
    clone-data volumes. Attached neighbors and other volume names are not
    ownership candidates and must remain untouched."""
    fleet = FLEET_SCRIPT.read_text()
    helpers_start = fleet.index("registry_meta_value() {")
    helpers_end = fleet.index("\nfleet_registry_remove_if_empty() {", helpers_start)
    helpers = fleet[helpers_start:helpers_end]
    ownership_root = tmp_path / "ownership"
    registry = ownership_root / ("b" * 32)
    clones = registry / "clones"
    clones.mkdir(parents=True)
    old = time.time() - 7200
    for index in range(64):
        clone_name = f"cloudbench-legacy-{index:03d}"
        record = clones / clone_name
        record.write_text(f"name={clone_name}\nid={index + 1:014x}\n")
        os.utime(record, (old, old))
    calls = tmp_path / "calls"

    script = f"""set -uo pipefail
APP=bench-app
VOLUME_NAME=cloudbench_data
WARM_ID=feedface000000
WARM_VOLUME_ID=vol_warm
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
REG={shlex.quote(str(registry))}
CALLS={shlex.quote(str(calls))}
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
sleep() {{ :; }}
    FLY() {{
      printf '%s\n' "$*" >> "$CALLS"
      case "$1 $2" in
        "machines list")
          printf '%s\n' '[{{"id":"facefeed000002","name":"cloudbench-neighbor","state":"started"}}]'
          return 0 ;;
    "volumes list")
      printf '%s\n' '[{{"id":"vol_warm","name":"cloudbench_data","attached_machine_id":"feedface000000"}},{{"id":"vol_neighbor","name":"cloudbench_data","attached_machine_id":"facefeed000002"}},{{"id":"vol_captest","name":"captest","attached_machine_id":null}}]'
      return 0 ;;
  esac
  return 99
}}
reap_volume() {{ echo "unexpected volume destroy: $1" >&2; return 99; }}
reap_machine() {{ echo "unexpected machine destroy: $1" >&2; return 99; }}
registry_runner_count() {{ echo "unexpected runner probe: $1" >&2; return 99; }}
{helpers}
reap_registry_clones "$REG" stale
rc=$?
[ "$rc" = "0" ] || exit "$rc"
if find "$REG/clones" -type f | grep -q .; then exit 90; fi
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert "retiring stale pre-volume-ID clone record" in result.stdout
    log = calls.read_text()
    assert log.count("machines list") == 2
    assert log.count("volumes list") == 2
    assert "destroy" not in log


def test_stale_pre_volume_id_registry_fails_closed_without_complete_absence_proof(
    tmp_path: Path,
) -> None:
    """A live exact name, an unattached clone-data volume, or malformed volume
    inventory each invalidates the legacy-record absence proof."""
    fleet = FLEET_SCRIPT.read_text()
    helpers_start = fleet.index("registry_meta_value() {")
    helpers_end = fleet.index("\nfleet_registry_remove_if_empty() {", helpers_start)
    helpers = fleet[helpers_start:helpers_end]
    cases = (
        (
            "live-name",
            '[{"id":"facefeed000002","name":"cloudbench-legacy","state":"stopped"}]',
            "[]",
            1,
            2,
            2,
        ),
        (
            "orphan-volume",
            "[]",
            '[{"id":"vol_orphan","name":"cloudbench_data","attached_machine_id":null}]',
            64,
            2,
            2,
        ),
        (
            "stale-attached-volume",
            "[]",
            '[{"id":"vol_legacy","name":"cloudbench_data","attached_machine_id":"deadbeef000001"}]',
            64,
            2,
            2,
        ),
        ("malformed-volumes", "[]", "{}", 1, 2, 2),
    )

    for (
        case_name,
        machines_json,
        volumes_json,
        record_count,
        expected_machine_reads,
        expected_volume_reads,
    ) in cases:
        ownership_root = tmp_path / case_name / "ownership"
        registry = ownership_root / ("c" * 32)
        clones = registry / "clones"
        clones.mkdir(parents=True)
        old = time.time() - 7200
        for index in range(record_count):
            clone_name = "cloudbench-legacy" if record_count == 1 else f"cloudbench-legacy-{index:03d}"
            record = clones / clone_name
            record.write_text(f"name={clone_name}\nid={index + 1:014x}\n")
            os.utime(record, (old, old))
        calls = tmp_path / case_name / "calls"

        script = f"""set -uo pipefail
APP=bench-app
VOLUME_NAME=cloudbench_data
WARM_ID=feedface000000
WARM_VOLUME_ID=vol_warm
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
REG={shlex.quote(str(registry))}
CALLS={shlex.quote(str(calls))}
MACHINES_JSON={shlex.quote(machines_json)}
VOLUMES_JSON={shlex.quote(volumes_json)}
CLOUDBENCH_CLONE_LOOKUP_SECONDS=0
sleep() {{ :; }}
FLY() {{
  printf '%s\n' "$*" >> "$CALLS"
  case "$1 $2" in
    "machines list") printf '%s\n' "$MACHINES_JSON"; return 0 ;;
    "volumes list") printf '%s\n' "$VOLUMES_JSON"; return 0 ;;
  esac
  return 99
}}
reap_volume() {{ echo "unexpected volume destroy: $1" >&2; return 99; }}
reap_machine() {{ echo "unexpected machine destroy: $1" >&2; return 99; }}
registry_runner_count() {{ echo "unexpected runner probe: $1" >&2; return 99; }}
{helpers}
reap_registry_clones "$REG" stale
rc=$?
[ "$rc" = "1" ] || exit 91
[ "$(find "$REG/clones" -type f | wc -l | tr -d ' ')" = {record_count} ] || exit 92
"""
        result = subprocess.run(
            ["bash", "-c", script],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

        assert result.returncode == 0, f"{case_name}:\n{result.stderr}{result.stdout}"
        log = calls.read_text()
        assert log.count("machines list") == expected_machine_reads
        assert log.count("volumes list") == expected_volume_reads
        assert "destroy" not in log


def test_fleet_startup_never_sweeps_unowned_unattached_volumes(tmp_path: Path) -> None:
    """Normal startup must not infer destructive ownership from provider state.

    An aged, unattached ``cloudbench_data`` volume can belong to a different
    workspace or operator.  Only the durable per-owner registry is authority to
    destroy it; name, age, and attachment state are not an ownership proof.
    """
    fleet = FLEET_SCRIPT.read_text()
    calls = tmp_path / "calls"
    calls.write_text("")

    # Execute the historical startup sweep when it is present so this remains a
    # behavioral reproduction of the destructive provider call, not only a
    # source-shape assertion.  The fixed implementation has no global sweep.
    sweep = ""
    invoke_sweep = ":"
    if "sweep_orphaned_volumes() {" in fleet:
        sweep = "".join(
            _extract_fleet_function(fleet, sig) for sig in ("reap_volume() {", "sweep_orphaned_volumes() {")
        )
        invoke_sweep = "sweep_orphaned_volumes"

    script = f"""set -uo pipefail
APP=bench-app
VOLUME_NAME=cloudbench_data
WARM_VOLUME_ID=vol_warm
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
  {{"id": "vol_unowned_neighbor", "name": "cloudbench_data", "attached_machine_id": None,
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
{sweep}
{invoke_sweep}
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
    for protected in (
        "vol_unowned_neighbor",
        "vol_fresh_fork",
        "vol_attached",
        "vol_other_app",
        "vol_warm",
    ):
        assert f"volumes destroy {protected}" not in log, f"{protected} must survive the sweep"
    assert "sweep_orphaned_volumes" not in fleet, "normal Fleet startup must not perform an app-global volume sweep"
    assert "reconcile_stale_fleet_registries || exit 1" in fleet, (
        "exact durable ownership recovery must remain the startup cleanup path"
    )


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
    # Every paid fleet detaches before any lock/machine acquisition. The
    # detached child receives the explicit foreground marker so default-detach
    # cannot recurse, while tests/debugging retain an intentional opt-out.
    fleet = FLEET_SCRIPT.read_text()
    assert '\nDETACH="1"\n' in fleet
    assert "--detach)" in fleet
    assert '--wait)           DETACH="1"; WAIT_FOR_DETACHED="1"' in fleet
    assert '--foreground)     DETACH="0"' in fleet
    assert '"${DETACH_ARGS[@]}" --foreground' in fleet
    assert 'cloudbench_detach_reexec_tracked "$DETACH_OWNER"' in fleet
    assert 'cloudbench_wait_tracked_detached "$DETACH_OWNER" "$DETACH_STATUS"' in fleet
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

    # The snapshot loop exists, initializes before Phase 1, and its complete
    # process tree is reaped in cleanup. A bare kill of the Bash root leaves its
    # current 5–37 second sleep orphaned in a tracked detached process group.
    assert "machines_snapshot_loop() {" in fleet
    assert "start_machines_snapshot_loop" in fleet
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    assert '"${UNIFIED_AGG_PID:-}" "${SNAPSHOT_LOOP_PID:-}"' in cleanup
    assert "cloudbench_terminate_tree_and_wait" in cleanup
    assert 'kill "$SNAPSHOT_LOOP_PID"' not in cleanup
    assert 'SNAPSHOT_LOOP_PID=""' in cleanup
    assert "Stop and\n# reap the aggregator's whole tree first" in fleet
    assert fleet.index("start_machines_snapshot_loop") < fleet.index("# ── Phase 1:")
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
        assert "registry_machine_details" in body, f"{fn_sig} must verify exact live state"
        assert "FLY machines list" not in body

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
        env={"SNAP": str(snap), "CALLS": str(tmp_path / "calls"), "ROOT": str(tmp_path), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
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
        text=True,
        capture_output=True,
        check=False,
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
    assert periodic.index("inventory_refresh_lock_acquire") < periodic.index("_refresh_inventory_snapshot_unlocked")
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
    holder_code = r"""
import fcntl, os, pathlib, sys, time
path = pathlib.Path(sys.argv[1])
ready = pathlib.Path(sys.argv[2])
with path.open("r+") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    inode = os.fstat(handle.fileno()).st_ino
    ready.write_text("ready")
    time.sleep(1.0)
    print("same" if path.stat().st_ino == inode else "replaced", flush=True)
"""
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
    late_holder_code = r"""
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
"""
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
    assert "_inventory_index_healthy" in _extract_fleet_function(cloud, "_machine_record_field() {")
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
    health_path.write_text(f"publisher_token=test-token\nvalid_until={int(time.time()) + 60}\n")

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

    # Once the first unambiguous poll binds this transaction to snap-owned,
    # another controller/provider snapshot that appears later must not erase
    # that ownership. Completion polling must stay pinned to snap-owned.
    created.unlink()
    polls = tmp_path / "polls"
    polls.write_text("0\n")
    late_racer_script = f"""set -uo pipefail
APP=bench-app
CLOUDBENCH_SNAPSHOT_READY_ATTEMPTS=2
FLY() {{
  echo "$*" >> "$CALLS"
  if [ "$1 $2 $3" = "volumes snapshots create" ]; then
    touch "$CREATED"
    return 0
  elif [ -f "$CREATED" ]; then
    poll=$(( $(cat "$POLLS") + 1 ))
    printf '%s\n' "$poll" > "$POLLS"
    if [ "$poll" = 1 ]; then
      echo '[{{"id":"snap-unrelated-older","status":"created","size":99}},{{"id":"snap-owned","status":"running","size":0}}]'
    else
      echo '[{{"id":"snap-unrelated-older","status":"created","size":99}},{{"id":"snap-owned","status":"created","size":10}},{{"id":"snap-racing-later","status":"running","size":0}}]'
    fi
  else
    echo '[{{"id":"snap-unrelated-older","status":"created","size":99}}]'
  fi
}}
sleep() {{ :; }}
{create_snapshot}
create_volume_snapshot_exact vol-1 || exit $?
echo "EXACT=$CREATED_SNAPSHOT_ID"
"""
    late_racer = subprocess.run(
        ["bash", "-c", late_racer_script],
        env={
            "CALLS": str(calls),
            "CREATED": str(created),
            "POLLS": str(polls),
            "PATH": os.environ["PATH"],
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert late_racer.returncode == 0, late_racer.stderr
    assert "transaction snapshot: snap-owned" in late_racer.stdout
    assert "EXACT=snap-owned" in late_racer.stdout

    created.unlink()
    duplicate_record_script = script.replace(
        '{"id":"snap-owned","status":"created","size":10}]',
        '{"id":"snap-owned","status":"running","size":0},{"id":"snap-owned","status":"created","size":10}]',
    )
    duplicate_record = subprocess.run(
        ["bash", "-c", duplicate_record_script],
        env={"CALLS": str(calls), "CREATED": str(created), "PATH": os.environ["PATH"]},
        text=True,
        capture_output=True,
        check=False,
    )
    assert duplicate_record.returncode == 0, duplicate_record.stderr
    assert "EXACT=snap-owned" in duplicate_record.stdout

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
    assert "snap-owned,snap-racing" in ambiguous.stderr
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
    helpers = _extract_fleet_function(SEED_CACHE_LIB.read_text(), "backend_ready_budget() {") + "".join(
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
        "count=$((count + 1))\n"
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
        json.dumps(
            [
                {"name": "smoke-fixture", "tags": ["smoke"], "timeout_seconds": 60, "deploy_category": "harness"},
                {
                    "name": "payment-fixture",
                    "tags": ["payment"],
                    "timeout_seconds": 60,
                    "deploy_category": "payment",
                    "deploy_canary": True,
                },
                {
                    "name": "grep-fixture",
                    "tags": ["grep"],
                    "timeout_seconds": 60,
                    "deploy_category": "grep",
                    "deploy_canary": True,
                },
                {
                    "name": "sms-fixture",
                    "tags": ["sms"],
                    "timeout_seconds": 60,
                    "deploy_category": "sms",
                    "deploy_canary": True,
                },
                {
                    "name": "browser-toast-nopa-write-lock",
                    "tags": ["browser"],
                    "timeout_seconds": 60,
                    "deploy_category": "browser_stateful",
                    "deploy_canary": True,
                },
            ]
        )
    )
    # History gate: only tasks with the last 3 attempts passing are selectable.
    history_dir = fixture / "agents" / "benchmarks" / "history"
    history_dir.mkdir(parents=True)
    attempt_rows = []
    for name in (
        "smoke-fixture",
        "payment-fixture",
        "grep-fixture",
        "sms-fixture",
        "browser-toast-nopa-write-lock",
    ):
        for index in range(3):
            attempt_rows.append(
                {
                    "task": name,
                    "passed": True,
                    "status": "COMPLETED",
                    "duration_seconds": 1.0,
                    "cost_cents": 0.0,
                    "timestamp": f"2026-01-01T00:00:{index:02d}+00:00",
                    "agent_id": f"{name}-{index}",
                    "failure_reason": None,
                    "fast_mode_cache": False,
                }
            )
    (history_dir / "task_attempts.jsonl").write_text("\n".join(json.dumps(row) for row in attempt_rows) + "\n")
    (fixture / "agents" / "benchmarks" / "select_predeploy_benches.py").write_text(
        (ROOT / "agents" / "benchmarks" / "select_predeploy_benches.py").read_text()
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
    capture_lines = capture.read_text().splitlines()
    assert capture_lines[0] == "1"
    # Second line is the run-bench argv. Require every selected fixture task and
    # the local concurrency flag; order may follow the predeploy scheduler.
    argv = capture_lines[1]
    assert argv.startswith("--local ")
    assert "--max-concurrency 2" in argv
    for task_name in (
        "smoke-fixture",
        "payment-fixture",
        "grep-fixture",
        "sms-fixture",
        "browser-toast-nopa-write-lock",
    ):
        assert task_name in argv.split(), argv

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


def test_cloud_isolated_stack_provides_frontend_build_identity(tmp_path: Path) -> None:
    """The on-box stack must receive the run identity required to isolate Vite output.

    Cloudbench launches scripts/run.sh through a strict STACK_ENV allow-list.
    Once bundled frontend builds became run-scoped, omitting BENCHMARK_RUN_ID
    made every real ecommerce guest exit before the synchronized start barrier.
    Exercise the production allow-list against run.sh's real path resolver so a
    string elsewhere in the driver cannot satisfy this regression.
    """
    driver = DRIVER_SCRIPT.read_text()
    stack_env_start = driver.index("STACK_ENV=(")
    stack_env_end = driver.index("\n)", stack_env_start) + 2
    stack_env = driver[stack_env_start:stack_env_end]
    resolve_frontend_dist_dir = _extract_fleet_function(STACK_SCRIPT.read_text(), "resolve_frontend_dist_dir() {")
    workspace_name = "flt-browser-alchemy-springs-sauna-2890-3"
    script = f"""set -euo pipefail
APP_USER=rose
BASE_PORT=3000
CONTEXT_DIR=/data/repo/.context/cloudbench
WORKSPACE_NAME={shlex.quote(workspace_name)}
STACK_SEED_DUMP=/data/cloudbench-cache/victoria-seed.dump
WMH_MODEL_NAME=fixture
WMH_DIR=/data/world-model
ROSE_EXCLUDE_ANTHROPIC_FAMILY=
{stack_env}
benchmark_run_id=
for item in "${{STACK_ENV[@]}}"; do
    case "$item" in
        BENCHMARK_RUN_ID=*) benchmark_run_id="${{item#BENCHMARK_RUN_ID=}}" ;;
    esac
done
{resolve_frontend_dist_dir}
resolve_frontend_dist_dir {shlex.quote(str(tmp_path))} true "$benchmark_run_id" 3002
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == str(tmp_path / ".context" / "frontend-builds" / workspace_name)


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
        "999999999999999999999999999999999999999999999999999999999999; using 180s" in result.stdout
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


def test_refresh_deps_git_sync_uses_controller_fetch_ref() -> None:
    """RCA 2026-08-19: --refresh-deps fetched a private SHA with optional
    box-side $GITHUB_TOKEN. The warm-box ssh login had no token, so git asked
    for a username on https://github.com and aborted the whole fleet before any
    task machine started ('exact remote checkout failed'). Guest drivers already
    use cloudbench-fetch-ref.sh + CLOUDBENCH_GITHUB_TOKEN_B64; maintenance must
    use that same controller-token path and fail closed when it is missing."""
    cloud = CLOUD_SCRIPT.read_text()
    helper = cloud[cloud.index("warm_source_fetch_ref() {") : cloud.index("ssh_exec() {")]
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-deps" ]; then') : cloud.index("# MODE: --refresh-wmh")]
    wmh = cloud[cloud.index('if [ "$MODE" = "refresh-wmh" ]; then') : cloud.index("# MODE: run (default)")]

    assert "cloudbench-fetch-ref.sh" in helper
    assert "CLOUDBENCH_GITHUB_TOKEN_B64" in helper
    assert "No controller GitHub token" in helper
    # Contents-validated resolver — not the unvalidated hosts.yml helper alone.
    assert "resolve_github_token" in helper
    assert "rm -f /data/cloudbench-fetch-ref.sh" in helper
    assert "warm_source_fetch_ref" in refresh
    assert "warm_source_fetch_ref" in wmh
    for mode in (refresh, wmh, helper):
        assert '[ -n "${GITHUB_TOKEN:-}" ] && AUTH_HDR=' not in mode
        assert "checkout -f FETCH_HEAD" not in mode


def test_warm_source_fetch_ref_retries_transient_sftp_tunnel_timeout(
    tmp_path: Path,
) -> None:
    """Epoch 3: Fly `ssh sftp put` of cloudbench-fetch-ref.sh failed once with
    `tunnel unavailable: ... timed out (context deadline exceeded)` and
    warm_source_fetch_ref aborted the fleet before any task started. Guest
    driver staging already retries sftp; maintenance git-sync must too."""
    cloud = CLOUD_SCRIPT.read_text()
    helper = _extract_fleet_function(cloud, "warm_source_fetch_ref() {")
    retry = _extract_fleet_function(ENV_HELPER_SCRIPT.read_text(), "cloudbench_retry_command() {")
    sha = "f9ad6715cc0d572a5ad54c3dbedae73bf5c5ee00"
    calls = tmp_path / "sftp-calls.txt"
    script = f"""
set -uo pipefail
APP=bench-app
ROOT_DIR={shlex.quote(str(ROOT))}
CLOUDBENCH_GUEST_FETCH_REF_SCRIPT={shlex.quote(str(FETCH_SCRIPT))}
REMOTE_REPO=/data/repo
CALLS={shlex.quote(str(calls))}
SFTP_ATTEMPTS=0
CLOUDBENCH_WARM_FETCH_REF_SFTP_ATTEMPTS=5
CLOUDBENCH_WARM_FETCH_REF_SFTP_RETRY_SECONDS=0
gh() {{ echo 'test-token'; }}
resolve_github_token() {{ echo 'test-token'; }}
cloudbench_controller_github_token() {{ echo 'test-token'; }}
ssh_exec() {{
  echo checkout {sha[:8]}
  echo "::CLOUDBENCH-REF::{sha}"
  return 0
}}
FLY() {{
  printf '%s\\n' "$*" >> "$CALLS"
  if [ "$1 $2 $3" = "ssh sftp put" ]; then
    SFTP_ATTEMPTS=$((SFTP_ATTEMPTS + 1))
    if [ "$SFTP_ATTEMPTS" -eq 1 ]; then
      echo 'Error: tunnel unavailable: Error contacting Fly.io API when probing "app": timed out (context deadline exceeded)' >&2
      return 1
    fi
  fi
  return 0
}}
sleep() {{ :; }}
{retry}
{helper}
if ! warm_source_fetch_ref mid123 {sha}; then
  echo "FETCH_REF_ABORTED attempts=$SFTP_ATTEMPTS"
  exit 14
fi
echo "FETCH_REF_OK attempts=$SFTP_ATTEMPTS"
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr + result.stdout
    # Two SFTP puts per attempt (fetch-ref.sh + token file); first attempt fails
    # on the first put, second attempt succeeds both → 3 total put calls.
    assert "FETCH_REF_OK attempts=3" in result.stdout
    assert "ssh sftp put" in calls.read_text()
    assert helper.count("ssh sftp put") >= 1
    assert "cloudbench_retry_command" in helper
    assert "CLOUDBENCH_WARM_FETCH_REF_SFTP_ATTEMPTS" in helper


def test_refresh_deps_git_sync_uses_controller_token_not_box_secret() -> None:
    """RCA (2026-08-20): fleet warm-deps heal aborted before any task machine
    with `fatal: could not read Username for 'https://github.com'` because
    maintenance auth came only from a durable/box-side GITHUB_TOKEN. Prefer the
    live controller token path (cloudbench_controller_github_token + export).
    """
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    env_lib = (ROOT / "scripts/lib/cloudbench-env.sh").read_text()
    refresh = cloud[cloud.index('if [ "$MODE" = "refresh-deps" ]; then') : cloud.index("# MODE: --refresh-wmh")]
    refresh_wmh = cloud[cloud.index('if [ "$MODE" = "refresh-wmh" ]; then') : cloud.index("# MODE: run (default)")]

    assert "cloudbench_resolve_controller_github_token" in env_lib
    assert "cloudbench_controller_github_token" in env_lib
    assert "cloudbench_git_insteadof_github_token" in env_lib
    assert "cloudbench_export_controller_github_token" in env_lib
    assert "cloudbench_export_controller_github_token" in cloud
    assert "warm_source_fetch_ref" in refresh
    assert "warm_source_fetch_ref" in refresh_wmh
    assert '[ -n "${GITHUB_TOKEN:-}" ] && AUTH_HDR=' not in refresh
    assert '[ -n "${GITHUB_TOKEN:-}" ] && AUTH_HDR=' not in refresh_wmh
    preflight = _extract_fleet_function(fleet, "warm_deps_preflight() {")
    assert "controller_github_token_b64" in preflight
    assert "export CLOUDBENCH_GITHUB_TOKEN_B64=" in preflight
    assert "cloudbench_controller_github_token" in fleet


def test_warm_source_park_retries_fly_machine_lease() -> None:
    """RCA (2026-08-20): fleet aborted at park with Fly 'lease currently held'
    after a failed --refresh-deps left the warm donor oversized. Park/resize
    must retry lease conflicts instead of a single fail-closed abort.
    """
    cloud = CLOUD_SCRIPT.read_text()
    fleet = FLEET_SCRIPT.read_text()
    resize = _extract_fleet_function(cloud, "resize_stopped_warm_source() {")
    assert "lease currently held" in resize
    assert "CLOUDBENCH_WARM_RESIZE_LEASE_ATTEMPTS" in resize
    assert "warm resize lease held — retry" in resize
    assert "parking warm source at" in fleet
    assert "CLOUDBENCH_WARM_PARK_LEASE_ATTEMPTS" in fleet
    assert "park lease held — retry" in fleet
    assert "could not park warm source for fleet capacity headroom (lease held)" in fleet


def test_controller_github_token_prefers_git_insteadof_over_stale_env(
    tmp_path: Path,
) -> None:
    """Invalid injected GITHUB_TOKEN must not beat a live git insteadOf credential."""
    script = f"""
set -euo pipefail
source {shlex.quote(str(ROOT / "scripts/lib/cloudbench-env.sh"))}
export GITHUB_TOKEN=github_pat_INVALID_MUST_NOT_WIN
export GH_TOKEN=
unset CLOUDBENCH_GITHUB_TOKEN_B64
# Simulate Cursor Cloud: working cred lives only in url.insteadOf.
git config --global --unset-all url.https://x-access-token:good-token@github.com/.insteadof 2>/dev/null || true
git config --global url.https://x-access-token:good-token@github.com/.insteadOf https://github.com/
tok="$(cloudbench_controller_github_token)"
printf '%s' "$tok"
"""
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "GIT_CONFIG_GLOBAL": str(tmp_path / "gitconfig"),
        "GIT_CONFIG_SYSTEM": "/dev/null",
    }
    (tmp_path / "gitconfig").write_text("")
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        env=env,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "good-token", result.stdout + result.stderr


def test_refresh_deps_controller_auth_header_fetches_private_repo(tmp_path: Path) -> None:
    """Owning-boundary repro: empty AUTH_HDR fails private fetch; controller
    header succeeds. Mirrors the warm-box failure mode without Fly."""
    seed_repo = tmp_path / "seed"
    private_repo = tmp_path / "private.git"
    subprocess.run(["git", "init", "-q", "-b", "main", str(seed_repo)], check=True)
    (seed_repo / "README").write_text("private fixture\n")
    subprocess.run(["git", "-C", str(seed_repo), "add", "README"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(seed_repo),
            "-c",
            "user.name=Cloudbench Test",
            "-c",
            "user.email=cloudbench@example.invalid",
            "commit",
            "-q",
            "-m",
            "fixture",
        ],
        check=True,
    )
    subprocess.run(["git", "clone", "-q", "--bare", str(seed_repo), str(private_repo)], check=True)
    subprocess.run(["git", "--git-dir", str(private_repo), "update-server-info"], check=True)

    token = "test-controller-token"
    auth = "Authorization: Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()
    observed_auth: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, content_type: str = "text/plain") -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            request_auth = self.headers.get("Authorization", "")
            observed_auth.append(request_auth)
            if self.path == "/repos/Rose-Ai-Labs/rose":
                if request_auth == f"Bearer {token}":
                    self._send(200, b'{"private":true}', "application/json")
                else:
                    self._send(401, b'{"message":"Bad credentials"}', "application/json")
                return
            if request_auth != auth.removeprefix("Authorization: "):
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="private-git"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            relative = self.path.partition("?")[0].lstrip("/")
            target = (tmp_path / relative).resolve()
            try:
                target.relative_to(tmp_path.resolve())
            except ValueError:
                self._send(403, b"")
                return
            if not target.is_file():
                self._send(404, b"")
                return
            self._send(200, target.read_bytes())

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    resolver = ROOT / "scripts/lib/cloudbench-github-token.sh"
    env = {
        **os.environ,
        "CLOUDBENCH_GITHUB_REPO_API": f"{base_url}/repos/Rose-Ai-Labs/rose",
        "CLOUDBENCH_GITHUB_TOKEN": token,
        "CLOUDBENCH_GITHUB_TOKEN_B64": "",
        "GITHUB_DISPATCH_TOKEN": "",
        "GITHUB_TOKEN": "",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "HOME": str(tmp_path / "client-home"),
    }
    Path(env["HOME"]).mkdir(parents=True, exist_ok=True)
    base = ["git", "-c", "credential.helper="]
    try:
        resolved = subprocess.run(
            [
                "bash",
                "-c",
                f"source {shlex.quote(str(resolver))}; cloudbench_resolve_github_token {shlex.quote(str(ROOT))}",
            ],
            text=True,
            capture_output=True,
            check=False,
            env=env,
            timeout=30,
        )
        assert resolved.returncode == 0, "canonical controller GitHub token resolver failed"
        assert resolved.stdout.strip() == token, "canonical controller GitHub token resolver returned the wrong token"

        url = f"{base_url}/private.git"
        observed_auth.clear()
        bug = subprocess.run(
            base + ["-c", "http.extraheader=", "ls-remote", url, "HEAD"],
            text=True,
            capture_output=True,
            cwd=env["HOME"],
            env=env,
            timeout=30,
            check=False,
        )
        assert bug.returncode != 0
        assert observed_auth and auth.removeprefix("Authorization: ") not in observed_auth

        observed_auth.clear()
        fixed = subprocess.run(
            base + ["-c", f"http.extraheader={auth}", "ls-remote", url, "HEAD"],
            text=True,
            capture_output=True,
            cwd=env["HOME"],
            env=env,
            timeout=30,
            check=False,
        )
        assert fixed.returncode == 0, fixed.stderr
        assert auth.removeprefix("Authorization: ") in observed_auth
        assert re.match(r"^[0-9a-f]{40}\s+HEAD$", fixed.stdout.strip().splitlines()[0])
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


def test_controller_execs_from_a_script_snapshot(tmp_path: Path) -> None:
    """bash reads scripts lazily from disk: editing run-bench-fleet or
    run-bench-cloud while a controller is mid-run shifts bytes under the
    interpreter and kills a healthy fleet with a parse error (observed: 28
    provisioned boxes torn down by "syntax error near unexpected token 'fi'"
    after an in-flight edit). The controller must enter an immutable
    per-invocation snapshot before any long-running work. It sources that copy
    in the already-guarded process so an exec-time signal cannot strand the
    snapshot; every child run-bench-cloud invocation uses the snapshot copy."""
    fleet = FLEET_SCRIPT.read_text()
    cloud = CLOUD_SCRIPT.read_text()

    # Snapshot entry happens before arg parsing / locks / machines.
    snapshot_entry = '    enter_script_snapshot "$@"'
    create_at = fleet.index('" create \\')
    snap_at = fleet.index(snapshot_entry, create_at)
    assert 'source "$CLOUDBENCH_SCRIPT_SNAPSHOT/run-bench-fleet" "$@"' in fleet[:snap_at]
    assert snap_at < fleet.index("while [ $# -gt 0 ]; do")
    assert snap_at < fleet.index("cloudbench_controller_lock_acquire")
    # the snapshot carries all co-versioned interpreter + lib files
    for f in (
        "run-bench-fleet",
        "run-bench-cloud",
        "cloudbench-boot.sh",
        "cloudbench-run.sh",
        "cloudbench-worker.sh",
        "cloudbench-fetch-ref.sh",
        "cloudbench-sync-deps.sh",
        "cloudbench-sync-prisma-client.sh",
        "cloudbench-current-run-artifact.py",
        "cloudbench-prepare-patch.sh",
        "cloudbench-status-server.py",
        "cloudbench-benchmark-target.py",
        "cloudbench-exact-session-cleanup.py",
        "cloudbench-guest-recovery.py",
        "cloudbench_catalog.py",
        "run-fleet-infra-canary",
        "cloudbench-infra-canary-preflight.py",
        "fleet_infra_sample.py",
        "cloudbench-port-lease.py",
        "cloudbench-machine-readiness.py",
        "cloudbench-select-snapshot.py",
        "cloudbench-aggregate-runs.py",
        "cloudbench-env.sh",
        "cloudbench-seed-budget.sh",
        "cloudbench-github-token.sh",
    ):
        assert f in fleet[create_at:snap_at], f"{f} missing from snapshot copy set"
    assert 'SCRIPT_SNAPSHOT_OWNER_HELPER="cloudbench-script-snapshot.py"' in fleet
    assert "shutil.copy2(Path(__file__), path / Path(__file__).name)" in (SCRIPT_SNAPSHOT_OWNER.read_text()), (
        "the signal-safe creator must self-seed cleanup before publishing the path"
    )
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
    assert 'CLOUDBENCH_RUNTIME_SCRIPT_ROOT="${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts}"' in cloud
    assert '--file-local "/cloudbench-run.sh=$CLOUDBENCH_GUEST_RUN_SCRIPT"' in cloud
    assert '--file-local "/cloudbench-status-server.py=$CLOUDBENCH_GUEST_STATUS_SERVER"' in cloud
    assert '"$ROOT_DIR/scripts/cloudbench-run.sh" /data/cloudbench-run.sh' not in cloud
    # Every process that owns the per-invocation snapshot reaps it through one
    # identity-fenced helper.  Preflight exits happen long before the paid
    # resource cleanup trap is installed, so this must be an early lifecycle
    # contract rather than a string buried in the late cleanup function.
    assert "cleanup_owned_script_snapshot_on_exit" in fleet[:snap_at]
    assert "cleanup_owned_script_snapshot" in fleet
    cleanup = _extract_fleet_function(fleet, "cleanup() {")
    autoscaler_reap = (
        'if ! cloudbench_terminate_tree_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" \\\n'
        '        "${AUTOSCALER_PIDS[@]:-}"; then'
    )
    assert cleanup.index(autoscaler_reap) < cleanup.index("cleanup_owned_script_snapshot")

    # Functional: snapshot entry is sound end-to-end (--help flows through the
    # immutable copy and still exits 0 with usage text).
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
    assert not list(tmp_path.glob("cloudbench-scripts.*")), (
        "a successful preflight-only exit leaked its invocation-owned script snapshot"
    )

    # Catalog rejection is a representative error before the full controller
    # cleanup trap exists. It must reap the same invocation-owned snapshot and
    # must not need a provider call to do so.
    rejected = subprocess.run(
        [
            "bash",
            str(FLEET_SCRIPT),
            "definitely-not-a-cloudbench-task",
            "--foreground",
        ],
        env={**os.environ, "CLOUDBENCH_SCRIPT_SNAPSHOT": "", "TMPDIR": str(tmp_path)},
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert rejected.returncode != 0
    assert "benchmark catalog preflight failed before Fly provisioning" in rejected.stderr
    assert not list(tmp_path.glob("cloudbench-scripts.*")), (
        "an error before provider allocation leaked its invocation-owned script snapshot"
    )


def test_nested_controller_borrows_parent_owned_script_snapshot(tmp_path: Path) -> None:
    """A nested control process may execute a parent's immutable snapshot, but
    inherited environment variables must not make it a second cleanup owner."""
    snapshot_root = tmp_path / "snapshots"
    snapshot_root.mkdir()
    entry_ready = tmp_path / "entry-ready"
    entry_release = tmp_path / "entry-release"
    owner = subprocess.Popen(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={
            **os.environ,
            "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_READY": str(entry_ready),
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_RELEASE": str(entry_release),
            "TMPDIR": str(snapshot_root),
        },
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not entry_ready.exists():
            if owner.poll() is not None:
                break
            time.sleep(0.02)
        assert entry_ready.exists(), "owner never entered its immutable script snapshot"
        snapshots = list(snapshot_root.glob("cloudbench-scripts.*"))
        assert len(snapshots) == 1
        snapshot = snapshots[0]
        marker = json.loads((snapshot / ".cloudbench-script-snapshot-owner.json").read_text())
        nested = subprocess.run(
            ["bash", str(snapshot / "run-bench-fleet"), "--help"],
            env={
                **os.environ,
                "CLOUDBENCH_FLEET_ROOT": str(ROOT),
                "CLOUDBENCH_SCRIPT_SNAPSHOT": str(snapshot),
                "CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE": "owner",
                "CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_TOKEN": str(marker["token"]),
                "CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_PID": str(marker["owner_pid"]),
                "CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_PID_START": str(marker["owner_pid_start"]),
                "TMPDIR": str(snapshot_root),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )
        assert nested.returncode == 0, nested.stderr
        assert snapshot.exists(), "nested borrower deleted its parent's snapshot"
        assert json.loads((snapshot / ".cloudbench-script-snapshot-owner.json").read_text()) == marker
        assert (snapshot / "run-fleet-infra-canary").read_bytes() == (FLEET_CANARY_SCRIPT.read_bytes())
        assert (snapshot / "cloudbench-infra-canary-preflight.py").read_bytes() == (
            FLEET_CANARY_PREFLIGHT_SCRIPT.read_bytes()
        )
        assert (snapshot / "fleet_infra_sample.py").is_file()
        canary_source = (snapshot / "run-fleet-infra-canary").read_text()
        assert 'CLOUDBENCH_RUNTIME_SCRIPT_ROOT="${CLOUDBENCH_SCRIPT_SNAPSHOT:-' in (canary_source)
        assert 'exec bash "$CLOUDBENCH_RUNTIME_SCRIPT_ROOT/run-bench-fleet"' in (canary_source)
    finally:
        entry_release.touch(exist_ok=True)
        owner_stdout, owner_stderr = owner.communicate(timeout=15)
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=5)
    assert owner.returncode == 0, (owner_stdout, owner_stderr)
    assert not list(snapshot_root.glob("cloudbench-scripts.*")), "the exact parent owner did not remove its snapshot"


def test_script_snapshot_initialization_signal_and_publish_failure_clean_up(
    tmp_path: Path,
) -> None:
    snapshot_root = tmp_path / "snapshots"
    snapshot_root.mkdir()
    init_ready = tmp_path / "init-ready"
    init_release = tmp_path / "init-release"
    env = {
        **os.environ,
        "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
        "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_READY": str(init_ready),
        "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_RELEASE": str(init_release),
        "TMPDIR": str(snapshot_root),
    }
    process = subprocess.Popen(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not init_ready.exists():
            if process.poll() is not None:
                break
            time.sleep(0.02)
        assert init_ready.exists(), "creator never reached the widened post-mkdir window"
        assert list(snapshot_root.glob("cloudbench-scripts.*")), (
            "the test must signal after snapshot creation, not before it"
        )
        os.killpg(process.pid, signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=15)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
    assert process.returncode == 143, (stdout, stderr)
    assert not list(snapshot_root.glob("cloudbench-scripts.*")), (
        "process-group TERM between mkdir and owner publication leaked the snapshot"
    )
    assert not list(snapshot_root.glob(".cloudbench-script-snapshot-*")), (
        "process-group TERM leaked a creation/adoption rendezvous"
    )

    creator_kill_ready = tmp_path / "creator-kill-ready"
    creator_kill_release = tmp_path / "creator-kill-release"
    creator_kill = subprocess.Popen(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={
            **os.environ,
            "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_READY": str(creator_kill_ready),
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INIT_RELEASE": str(creator_kill_release),
            "TMPDIR": str(snapshot_root),
        },
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not creator_kill_ready.exists():
            if creator_kill.poll() is not None:
                break
            time.sleep(0.02)
        assert creator_kill_ready.exists(), "creator never reached its private-path window"
        exact_creator_pid = int(creator_kill_ready.read_text())
        assert list(snapshot_root.glob("cloudbench-scripts.*"))
        os.kill(exact_creator_pid, signal.SIGKILL)
        kill_stdout, kill_stderr = creator_kill.communicate(timeout=15)
    finally:
        creator_kill_release.touch(exist_ok=True)
        if creator_kill.poll() is None:
            creator_kill.kill()
            creator_kill.wait(timeout=5)
    assert creator_kill.returncode != 0, (kill_stdout, kill_stderr)
    assert not list(snapshot_root.glob("cloudbench-scripts.*")), (
        "hard loss of the creator before result publication leaked its token-derived path"
    )
    assert not list(snapshot_root.glob(".cloudbench-script-snapshot-*")), (
        "hard creator loss leaked a creation/adoption rendezvous"
    )

    entry_ready = tmp_path / "entry-ready"
    entry_release = tmp_path / "entry-release"
    entry_process = subprocess.Popen(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={
            **os.environ,
            "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_READY": str(entry_ready),
            "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ENTRY_RELEASE": str(entry_release),
            "TMPDIR": str(snapshot_root),
        },
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not entry_ready.exists():
            if entry_process.poll() is not None:
                break
            time.sleep(0.02)
        assert entry_ready.exists(), "controller never entered the immutable script copy"
        snapshots = list(snapshot_root.glob("cloudbench-scripts.*"))
        assert len(snapshots) == 1
        immutable_sources = {
            "cloudbench-boot.sh": ROOT / "scripts/cloudbench-boot.sh",
            "cloudbench-run.sh": ROOT / "scripts/cloudbench-run.sh",
            "cloudbench-worker.sh": ROOT / "scripts/cloudbench-worker.sh",
            "cloudbench-fetch-ref.sh": ROOT / "scripts/cloudbench-fetch-ref.sh",
            "cloudbench-sync-deps.sh": ROOT / "scripts/cloudbench-sync-deps.sh",
            "cloudbench-sync-prisma-client.sh": ROOT / "scripts/cloudbench-sync-prisma-client.sh",
            "cloudbench-current-run-artifact.py": ROOT / "scripts/cloudbench-current-run-artifact.py",
            "cloudbench-prepare-patch.sh": ROOT / "scripts/cloudbench-prepare-patch.sh",
            "cloudbench-status-server.py": ROOT / "scripts/cloudbench-status-server.py",
            "cloudbench-benchmark-target.py": ROOT / "scripts/cloudbench-benchmark-target.py",
            "cloudbench-exact-session-cleanup.py": EXACT_SESSION_CLEANUP_SCRIPT,
            "cloudbench-guest-recovery.py": GUEST_RECOVERY_SCRIPT,
            "cloudbench_catalog.py": ROOT / "scripts/cloudbench_catalog.py",
            "cloudbench-env.sh": ROOT / "scripts/lib/cloudbench-env.sh",
            "cloudbench-seed-budget.sh": ROOT / "scripts/lib/cloudbench-seed-budget.sh",
        }
        for guest_helper, source in immutable_sources.items():
            assert (snapshots[0] / guest_helper).read_bytes() == source.read_bytes(), (
                f"snapshot changed {guest_helper} bytes"
            )
        entry_process.send_signal(signal.SIGTERM)
        entry_stdout, entry_stderr = entry_process.communicate(timeout=15)
    finally:
        if entry_process.poll() is None:
            entry_process.kill()
            entry_process.wait(timeout=5)
    assert entry_process.returncode == 143, (entry_stdout, entry_stderr)
    assert not list(snapshot_root.glob("cloudbench-scripts.*")), (
        "TERM while parsing the immutable entrypoint leaked the sole-owned snapshot"
    )

    failure_cases = {
        "owner-marker publish": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_REPLACE",
        "result publish": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_RESULT_REPLACE",
        "invalid result": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_INVALID_RESULT",
        "adoption publish": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_ADOPTION_REPLACE",
        "post-adoption copy": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_COPY",
        "rendezvous removal": "CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_FAIL_RESULT_REMOVE",
    }
    for description, fault_variable in failure_cases.items():
        failed = subprocess.run(
            ["bash", str(FLEET_SCRIPT), "--help"],
            env={
                **os.environ,
                "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
                fault_variable: "1",
                "TMPDIR": str(snapshot_root),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )
        assert failed.returncode != 0, (description, failed.stdout, failed.stderr)
        assert not list(snapshot_root.glob("cloudbench-scripts.*")), (
            f"{description} failure leaked its snapshot directory"
        )
        assert not list(snapshot_root.glob(".cloudbench-script-snapshot-*")), (
            f"{description} failure leaked a creation/adoption rendezvous"
        )


def test_borrowed_script_snapshot_and_invalid_owner_identity_are_never_deleted(
    tmp_path: Path,
) -> None:
    borrowed = tmp_path / "cloudbench-scripts.borrow"
    borrowed.mkdir()
    shutil.copy2(ENV_HELPER_SCRIPT, borrowed / "cloudbench-env.sh")
    sentinel = borrowed / "external-owner-sentinel"
    sentinel.write_text("retain\n")
    result = subprocess.run(
        ["bash", str(FLEET_SCRIPT), "--help"],
        env={
            **os.environ,
            "CLOUDBENCH_FLEET_ROOT": str(ROOT),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": str(borrowed),
            "CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE": "borrow",
            "TMPDIR": str(tmp_path),
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert sentinel.read_text() == "retain\n"

    owned = tmp_path / "cloudbench-scripts.abc123"
    owned.mkdir()
    owned_sentinel = owned / "sentinel"
    owned_sentinel.write_text("retain\n")
    marker = owned / ".cloudbench-script-snapshot-owner.json"
    owner_contract = r"""
set -uo pipefail
owner_start="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
python3 "$HELPER" initialize --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null || exit 10

if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$WRONG_TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null 2>&1; then exit 11; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 12
if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$(( $$ + 1 ))" --pid-start "$owner_start" >/dev/null 2>&1; then exit 13; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 14
if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "wrong birth identity" >/dev/null 2>&1; then exit 15; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 16

MARKER="$MARKER" OWNER_PID="$$" python3 - <<'PY'
import json, os
path = os.environ["MARKER"]
marker = json.load(open(path))
marker["owner_pid"] = int(os.environ["OWNER_PID"]) + 1
open(path, "w").write(json.dumps(marker) + "\n")
PY
if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null 2>&1; then exit 17; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 18
python3 "$HELPER" initialize --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null || exit 19

MARKER="$MARKER" python3 - <<'PY'
import json, os
path = os.environ["MARKER"]
marker = json.load(open(path))
marker["owner_pid_start"] = "wrong birth identity"
open(path, "w").write(json.dumps(marker) + "\n")
PY
if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null 2>&1; then exit 20; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 21
python3 "$HELPER" initialize --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null || exit 22

printf '{"version": 1}\n' > "$MARKER"
if python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null 2>&1; then exit 23; fi
[ -e "$SNAPSHOT/sentinel" ] || exit 24
python3 "$HELPER" initialize --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null || exit 25
python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null
cleanup_status=$?
exit "$cleanup_status"
"""
    refused = subprocess.run(
        ["bash", "-c", owner_contract],
        env={
            **os.environ,
            "HELPER": str(SCRIPT_SNAPSHOT_OWNER),
            "MARKER": str(marker),
            "SNAPSHOT": str(owned),
            "TEMP_ROOT": str(tmp_path),
            "TOKEN": "a" * 32,
            "WRONG_TOKEN": "b" * 32,
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )
    assert refused.returncode == 0, (refused.stdout, refused.stderr)
    assert not owned.exists(), "the exact valid owner cleanup should delete its snapshot"


def test_script_snapshot_unknown_transferee_identity_never_authorizes_deletion(
    tmp_path: Path,
) -> None:
    claimant = subprocess.Popen(["sleep", "30"])
    real_ps = shutil.which("ps")
    assert real_ps is not None
    try:
        claimant_start_result = subprocess.run(
            [real_ps, "-p", str(claimant.pid), "-o", "lstart="],
            text=True,
            capture_output=True,
            check=True,
        )
        claimant_start = " ".join(claimant_start_result.stdout.split())
        shim_dir = tmp_path / "shim"
        shim_dir.mkdir()
        counter = tmp_path / "ps-count"
        ps_shim = shim_dir / "ps"
        ps_shim.write_text(
            "#!/usr/bin/env bash\n"
            'count=$(cat "$PS_COUNTER" 2>/dev/null || echo 0)\n'
            "count=$((count + 1))\n"
            'printf \'%s\\n\' "$count" > "$PS_COUNTER"\n'
            'if [ "$count" -eq 1 ]; then exec "$REAL_PS" "$@"; fi\n'
            "exit 1\n"
        )
        ps_shim.chmod(0o755)

        token = "f" * 32
        observer = r"""
set -uo pipefail
caller_start="$("$REAL_PS" -p $$ -o lstart= | awk '{$1=$1; print}')"
printf '0\n' > "$PS_COUNTER"
case "$OPERATION" in
  cleanup)
    python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
      --token "$TOKEN" --pid $$ --pid-start "$caller_start" --allow-transfer
    ;;
  check-armed)
    python3 "$HELPER" check-armed --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
      --token "$TOKEN" --previous-pid $$ --previous-pid-start "$caller_start"
    ;;
  cancel-claim)
    python3 "$HELPER" cancel-claim --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
      --token "$TOKEN" --previous-pid $$ --previous-pid-start "$caller_start"
    ;;
esac
"""
        for index, operation in enumerate(("cleanup", "check-armed", "cancel-claim"), start=1):
            snapshot = tmp_path / f"cloudbench-scripts.unk00{index}"
            snapshot.mkdir()
            sentinel = snapshot / "sentinel"
            sentinel.write_text("retain\n")
            (snapshot / ".cloudbench-script-snapshot-owner.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "token": token,
                        "owner_pid": claimant.pid,
                        "owner_pid_start": claimant_start,
                        "state": "claiming" if operation == "cancel-claim" else "armed",
                    }
                )
                + "\n"
            )
            observed = subprocess.run(
                ["bash", "-c", observer],
                env={
                    **os.environ,
                    "PATH": f"{shim_dir}:{os.environ['PATH']}",
                    "REAL_PS": real_ps,
                    "PS_COUNTER": str(counter),
                    "HELPER": str(SCRIPT_SNAPSHOT_OWNER),
                    "SNAPSHOT": str(snapshot),
                    "TEMP_ROOT": str(tmp_path),
                    "TOKEN": token,
                    "OPERATION": operation,
                },
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
            assert observed.returncode != 0, (
                operation,
                observed.stdout,
                observed.stderr,
            )
            assert sentinel.read_text() == "retain\n", f"{operation} treated an inconclusive live-owner probe as stale"
            assert claimant.poll() is None
    finally:
        claimant.terminate()
        claimant.wait(timeout=5)


def test_detached_script_snapshot_transfer_covers_exit_death_timeout_and_waiter_loss(
    tmp_path: Path,
) -> None:
    def lifecycle_env(name: str, **extra: str) -> tuple[dict[str, str], Path, Path]:
        root = tmp_path / name
        snapshots = root / "snapshots"
        runs = root / "runs"
        snapshots.mkdir(parents=True)
        runs.mkdir()
        env = {
            **os.environ,
            "CLOUDBENCH_RUNS_ROOT": str(runs),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": "",
            "CLOUDBENCH_SKIP_LOCAL_PATCH": "1",
            "TMPDIR": str(snapshots),
            **extra,
        }
        return env, snapshots, runs

    def wait_for_file(path: Path, process: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not path.exists():
            if process.poll() is not None:
                break
            time.sleep(0.02)
        assert path.exists(), f"detached lifecycle did not publish {path.name}"

    def process_exists(pid: int) -> bool:
        observed = subprocess.run(
            ["ps", "-p", str(pid), "-o", "stat="],
            text=True,
            capture_output=True,
            check=False,
        )
        return observed.returncode == 0 and bool(observed.stdout.strip())

    def wait_for_no_snapshots(snapshot_root: Path) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and list(snapshot_root.glob("cloudbench-scripts.*")):
            time.sleep(0.02)

    command = [
        "bash",
        str(FLEET_SCRIPT),
        "spawn-sub-agents",
        "--ref",
        "origin/main",
    ]

    detach_ready = tmp_path / "detach-before-owner-ready"
    detach_release = tmp_path / "detach-before-owner-release"
    launch_env, launch_snapshots, launch_runs = lifecycle_env(
        "detach-launch-signal",
        CLOUDBENCH_TEST_TRACKED_DETACH_BEFORE_OWNER_READY=str(detach_ready),
        CLOUDBENCH_TEST_TRACKED_DETACH_BEFORE_OWNER_RELEASE=str(detach_release),
    )
    launch = subprocess.Popen(
        command,
        env=launch_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        wait_for_file(detach_ready, launch)
        unpublished_supervisor_pid = int(detach_ready.read_text())
        os.killpg(launch.pid, signal.SIGTERM)
        launch_stdout, launch_stderr = launch.communicate(timeout=15)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and process_exists(unpublished_supervisor_pid):
            time.sleep(0.05)
        assert not process_exists(unpublished_supervisor_pid), (
            "signal during detached owner publication left its unpublished session alive"
        )
    finally:
        detach_release.touch(exist_ok=True)
        if launch.poll() is None:
            launch.kill()
            launch.wait(timeout=5)
    assert launch.returncode != 0, (launch_stdout, launch_stderr)
    assert not list(launch_snapshots.glob("cloudbench-scripts.*"))
    assert not list(launch_runs.glob("detached-*.owner"))
    assert not list(launch_runs.glob("detached-*.status"))

    normal_env, normal_snapshots, _ = lifecycle_env("normal", CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_EXIT_AFTER_CLAIM="0")
    normal = subprocess.run(
        command,
        env=normal_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )
    assert normal.returncode == 0, (normal.stdout, normal.stderr)
    wait_for_no_snapshots(normal_snapshots)
    assert not list(normal_snapshots.glob("cloudbench-scripts.*"))

    error_env, error_snapshots, error_runs = lifecycle_env(
        "wait-error", CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_EXIT_AFTER_CLAIM="7"
    )
    error = subprocess.run(
        [*command, "--wait"],
        env=error_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )
    assert error.returncode == 7, (error.stdout, error.stderr)
    assert not list(error_snapshots.glob("cloudbench-scripts.*"))
    assert not list(error_runs.glob("detached-*.owner"))
    assert not list(error_runs.glob("detached-*.status"))

    claimed_ready = tmp_path / "claimed-ready"
    claimed_release = tmp_path / "claimed-release"
    death_env, death_snapshots, _ = lifecycle_env(
        "claim-death",
        CLOUDBENCH_SCRIPT_SNAPSHOT_HANDOFF_SECONDS="5",
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_CLAIMED_READY=str(claimed_ready),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_CLAIMED_RELEASE=str(claimed_release),
    )
    death = subprocess.Popen(
        command,
        env=death_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for_file(claimed_ready, death)
        claimant_pid = int(claimed_ready.read_text())
        active = list(death_snapshots.glob("cloudbench-scripts.*"))
        assert len(active) == 1
        marker = json.loads((active[0] / ".cloudbench-script-snapshot-owner.json").read_text())
        assert marker["state"] == "claiming"
        assert marker["owner_pid"] == claimant_pid
        os.kill(claimant_pid, signal.SIGKILL)
        death_stdout, death_stderr = death.communicate(timeout=15)
    finally:
        if death.poll() is None:
            death.kill()
            death.wait(timeout=5)
    assert death.returncode != 0, (death_stdout, death_stderr)
    assert not list(death_snapshots.glob("cloudbench-scripts.*")), (
        "a claimant killed before arming its EXIT trap leaked the snapshot"
    )

    before_claim_ready = tmp_path / "before-claim-ready"
    before_claim_release = tmp_path / "before-claim-release"
    timeout_env, timeout_snapshots, timeout_runs = lifecycle_env(
        "handoff-timeout",
        CLOUDBENCH_SCRIPT_SNAPSHOT_HANDOFF_SECONDS="1",
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_BEFORE_CLAIM_READY=str(before_claim_ready),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_BEFORE_CLAIM_RELEASE=str(before_claim_release),
    )
    timeout_process = subprocess.Popen(
        command,
        env=timeout_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for_file(before_claim_ready, timeout_process)
        paused_child_pid = int(before_claim_ready.read_text())
        timeout_stdout, timeout_stderr = timeout_process.communicate(timeout=15)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and process_exists(paused_child_pid):
            time.sleep(0.05)
        assert not process_exists(paused_child_pid), "pre-claim timeout left the exact default-detached child alive"
    finally:
        before_claim_release.touch(exist_ok=True)
        if timeout_process.poll() is None:
            timeout_process.kill()
            timeout_process.wait(timeout=5)
    assert timeout_process.returncode != 0, (timeout_stdout, timeout_stderr)
    assert not list(timeout_snapshots.glob("cloudbench-scripts.*")), (
        "a child that never claimed before the handoff deadline retained the parent snapshot"
    )
    assert not list(timeout_runs.glob("detached-*.owner"))
    assert not list(timeout_runs.glob("detached-*.status"))

    claim_lock_ready = tmp_path / "claim-lock-ready"
    claim_lock_release = tmp_path / "claim-lock-release"
    lock_env, lock_snapshots, lock_runs = lifecycle_env(
        "handoff-lock-timeout",
        CLOUDBENCH_SCRIPT_SNAPSHOT_HANDOFF_SECONDS="1",
        CLOUDBENCH_SCRIPT_SNAPSHOT_LOCK_SECONDS="1",
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_CLAIM_LOCK_READY=str(claim_lock_ready),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_CLAIM_LOCK_RELEASE=str(claim_lock_release),
    )
    lock_process = subprocess.Popen(
        command,
        env=lock_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    lock_supervisor_pid = 0
    try:
        wait_for_file(claim_lock_ready, lock_process)
        owner_files = list(lock_runs.glob("detached-*.owner"))
        assert len(owner_files) == 1
        owner_fields = dict(line.split("=", 1) for line in owner_files[0].read_text().splitlines())
        lock_supervisor_pid = int(owner_fields["pid"])
        lock_stdout, lock_stderr = lock_process.communicate(timeout=10)
        assert not process_exists(lock_supervisor_pid), (
            "a claimant holding the lifecycle lock outlived the bounded handoff"
        )
    finally:
        claim_lock_release.touch(exist_ok=True)
        if lock_process.poll() is None:
            lock_process.kill()
            lock_process.wait(timeout=5)
    assert lock_process.returncode != 0, (lock_stdout, lock_stderr)
    assert not list(lock_snapshots.glob("cloudbench-scripts.*"))
    assert not list(lock_runs.glob("detached-*.owner"))
    assert not list(lock_runs.glob("detached-*.status"))

    wait_before_claim_ready = tmp_path / "wait-before-claim-ready"
    wait_before_claim_release = tmp_path / "wait-before-claim-release"
    wait_timeout_env, wait_timeout_snapshots, wait_timeout_runs = lifecycle_env(
        "wait-handoff-timeout",
        CLOUDBENCH_SCRIPT_SNAPSHOT_HANDOFF_SECONDS="1",
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_BEFORE_CLAIM_READY=str(wait_before_claim_ready),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_BEFORE_CLAIM_RELEASE=str(wait_before_claim_release),
    )
    wait_timeout_process = subprocess.Popen(
        [*command, "--wait"],
        env=wait_timeout_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    wrapper_pid = 0
    try:
        wait_for_file(wait_before_claim_ready, wait_timeout_process)
        wait_paused_child_pid = int(wait_before_claim_ready.read_text())
        owner_files = list(wait_timeout_runs.glob("detached-*.owner"))
        assert len(owner_files) == 1
        owner_fields = dict(line.split("=", 1) for line in owner_files[0].read_text().splitlines())
        wrapper_pid = int(owner_fields["pid"])
        wait_timeout_stdout, wait_timeout_stderr = wait_timeout_process.communicate(timeout=15)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (process_exists(wrapper_pid) or process_exists(wait_paused_child_pid)):
            time.sleep(0.05)
        assert not process_exists(wrapper_pid), "tracked --wait handoff timeout left its wrapper alive"
        assert not process_exists(wait_paused_child_pid), "tracked --wait handoff timeout left its controller alive"
    finally:
        wait_before_claim_release.touch(exist_ok=True)
        if wait_timeout_process.poll() is None:
            wait_timeout_process.kill()
            wait_timeout_process.wait(timeout=5)
    assert wait_timeout_process.returncode != 0, (
        wait_timeout_stdout,
        wait_timeout_stderr,
    )
    assert not list(wait_timeout_snapshots.glob("cloudbench-scripts.*"))
    assert not list(wait_timeout_runs.glob("detached-*.owner"))
    assert not list(wait_timeout_runs.glob("detached-*.status"))

    armed_ready = tmp_path / "armed-ready"
    armed_release = tmp_path / "armed-release"
    waiter_env, waiter_snapshots, _ = lifecycle_env(
        "waiter-loss",
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ARMED_READY=str(armed_ready),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_ARMED_RELEASE=str(armed_release),
        CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_EXIT_AFTER_CLAIM="0",
    )
    waiter = subprocess.Popen(
        [*command, "--wait"],
        env=waiter_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for_file(armed_ready, waiter)
        controller_pid = int(armed_ready.read_text())
        active = list(waiter_snapshots.glob("cloudbench-scripts.*"))
        assert len(active) == 1, "the armed detached controller must retain its live script bundle"
        marker = json.loads((active[0] / ".cloudbench-script-snapshot-owner.json").read_text())
        assert marker["state"] == "armed"
        assert marker["owner_pid"] == controller_pid
        waiter.kill()
        waiter.communicate(timeout=5)
        armed_release.touch()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and list(waiter_snapshots.glob("cloudbench-scripts.*")):
            time.sleep(0.05)
    finally:
        armed_release.touch(exist_ok=True)
        if waiter.poll() is None:
            waiter.kill()
            waiter.wait(timeout=5)
    assert not list(waiter_snapshots.glob("cloudbench-scripts.*")), (
        "SIGKILL of the --wait supervisor stranded its detached controller's snapshot"
    )


def test_script_snapshot_handoff_refuses_a_mismatched_process_group_identity(
    tmp_path: Path,
) -> None:
    ready = tmp_path / "unrelated-ready"
    unrelated = subprocess.Popen(
        [
            "bash",
            "-c",
            'trap "" TERM; : > "$1"; while :; do sleep 1; done',
            "unrelated-group",
            str(ready),
        ],
        start_new_session=True,
    )
    owner = tmp_path / "detached.owner"
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not ready.exists():
            assert unrelated.poll() is None
            time.sleep(0.02)
        assert ready.exists()
        owner.write_text(
            "version=1\n"
            f"pid={unrelated.pid}\n"
            "pid_start=Mon Jan 1 00:00:00 2001\n"
            f"pgid={unrelated.pid}\n"
            f"group_token={'e' * 32}\n"
        )
        fleet_function = _extract_fleet_function(
            FLEET_SCRIPT.read_text(), "terminate_script_snapshot_handoff_group() {"
        )
        attempted = subprocess.run(
            [
                "bash",
                "-c",
                f"""\
set -uo pipefail
source "$ENV_HELPER"
{fleet_function}
SCRIPT_SNAPSHOT_HANDOFF_OWNER_FILE="$OWNER"
SCRIPT_SNAPSHOT_HANDOFF_STATUS_FILE=""
CLOUDBENCH_SCRIPT_SNAPSHOT_HANDOFF_DRAIN_SECONDS=1
terminate_script_snapshot_handoff_group
""",
            ],
            env={
                **os.environ,
                "ENV_HELPER": str(ENV_HELPER_SCRIPT),
                "OWNER": str(owner),
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        assert attempted.returncode != 0, (attempted.stdout, attempted.stderr)
        assert unrelated.poll() is None, "a stale PID birth record authorized signaling an unrelated process group"
        assert owner.exists(), "identity refusal must retain the handoff record for audit"
    finally:
        try:
            os.killpg(unrelated.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        unrelated.wait(timeout=5)


def test_script_snapshot_claim_and_cleanup_are_serialized_in_both_winner_orders(
    tmp_path: Path,
) -> None:
    def wait_path(path: Path, *processes: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not path.exists():
            assert all(process.poll() is None for process in processes), f"process exited before publishing {path.name}"
            time.sleep(0.01)
        assert path.exists(), f"timed out waiting for {path.name}"

    owner_script = r"""
set -uo pipefail
owner_start="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
printf '%s\n' "$$" > "$OWNER_PID_FILE"
printf '%s\n' "$owner_start" > "$OWNER_START_FILE"
python3 "$HELPER" initialize --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$owner_start" >/dev/null || exit 10
: > "$OWNER_READY"
while [ ! -e "$CLEANUP_GO" ]; do sleep 0.01; done
outcome="$(env \
  CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_WAITING="$CLEANUP_WAITING" \
  python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
    --token "$TOKEN" --pid "$$" --pid-start "$owner_start" --allow-transfer)" || exit 11
printf '%s\n' "$outcome" > "$OWNER_OUTCOME"
"""
    claimant_script = r"""
set -uo pipefail
claimant_start="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
env CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_WAITING="$CLAIM_WAITING" \
  CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_READY="$CLAIM_LOCKED" \
  CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_RELEASE="$CLAIM_RELEASE" \
  python3 "$HELPER" claim --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
    --token "$TOKEN" --pid "$$" --pid-start "$claimant_start" \
    --previous-pid "$PREVIOUS_PID" --previous-pid-start "$PREVIOUS_START" >/dev/null
claim_status=$?
[ "$claim_status" = 0 ] || exit "$claim_status"
: > "$CLAIMED"
while [ ! -e "$CLAIM_FINISH" ]; do sleep 0.01; done
python3 "$HELPER" arm --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$claimant_start" >/dev/null || exit 12
python3 "$HELPER" cleanup --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
  --token "$TOKEN" --pid "$$" --pid-start "$claimant_start" >/dev/null
cleanup_status=$?
exit "$cleanup_status"
"""

    claim_root = tmp_path / "claim-wins"
    claim_root.mkdir()
    claim_snapshot = claim_root / "cloudbench-scripts.abc123"
    claim_snapshot.mkdir()
    (claim_snapshot / "sentinel").write_text("live\n")
    claim_paths = {
        name: claim_root / name.replace("_", "-").lower()
        for name in (
            "OWNER_PID_FILE",
            "OWNER_START_FILE",
            "OWNER_READY",
            "CLEANUP_GO",
            "CLEANUP_WAITING",
            "OWNER_OUTCOME",
            "CLAIM_WAITING",
            "CLAIM_LOCKED",
            "CLAIM_RELEASE",
            "CLAIMED",
            "CLAIM_FINISH",
        )
    }
    common = {
        **os.environ,
        "HELPER": str(SCRIPT_SNAPSHOT_OWNER),
        "SNAPSHOT": str(claim_snapshot),
        "TEMP_ROOT": str(claim_root),
        "TOKEN": "c" * 32,
        **{key: str(value) for key, value in claim_paths.items()},
    }
    owner = subprocess.Popen(
        ["bash", "-c", owner_script],
        env=common,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    claimant: subprocess.Popen[str] | None = None
    try:
        wait_path(claim_paths["OWNER_READY"], owner)
        claim_env = {
            **common,
            "PREVIOUS_PID": claim_paths["OWNER_PID_FILE"].read_text().strip(),
            "PREVIOUS_START": claim_paths["OWNER_START_FILE"].read_text().strip(),
        }
        claimant = subprocess.Popen(
            ["bash", "-c", claimant_script],
            env=claim_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        wait_path(claim_paths["CLAIM_LOCKED"], owner, claimant)
        claim_paths["CLEANUP_GO"].touch()
        wait_path(claim_paths["CLEANUP_WAITING"], owner, claimant)
        claim_paths["CLAIM_RELEASE"].touch()
        wait_path(claim_paths["CLAIMED"], owner, claimant)
        wait_path(claim_paths["OWNER_OUTCOME"], owner, claimant)
        assert claim_paths["OWNER_OUTCOME"].read_text().strip() == "transferred"
        assert (claim_snapshot / "sentinel").read_text() == "live\n", (
            "parent cleanup deleted the live claimant snapshot after losing the lock race"
        )
        claim_paths["CLAIM_FINISH"].touch()
        claimant_stdout, claimant_stderr = claimant.communicate(timeout=10)
        owner_stdout, owner_stderr = owner.communicate(timeout=10)
    finally:
        claim_paths["CLAIM_RELEASE"].touch(exist_ok=True)
        claim_paths["CLAIM_FINISH"].touch(exist_ok=True)
        for process in (claimant, owner):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    assert owner.returncode == 0, (owner_stdout, owner_stderr)
    assert claimant is not None and claimant.returncode == 0, (
        claimant_stdout,
        claimant_stderr,
    )
    assert not claim_snapshot.exists()

    cleanup_root = tmp_path / "cleanup-wins"
    cleanup_root.mkdir()
    cleanup_snapshot = cleanup_root / "cloudbench-scripts.def456"
    cleanup_snapshot.mkdir()
    (cleanup_snapshot / "sentinel").write_text("live\n")
    cleanup_paths = {
        name: cleanup_root / name.replace("_", "-").lower()
        for name in (
            "OWNER_PID_FILE",
            "OWNER_START_FILE",
            "OWNER_READY",
            "CLEANUP_GO",
            "CLEANUP_WAITING",
            "OWNER_OUTCOME",
            "CLAIM_WAITING",
        )
    }
    cleanup_lock_ready = cleanup_root / "cleanup-locked"
    cleanup_lock_release = cleanup_root / "cleanup-release"
    cleanup_owner_script = owner_script.replace(
        'CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_WAITING="$CLEANUP_WAITING"',
        'CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_WAITING="$CLEANUP_WAITING" '
        'CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_READY="$CLEANUP_LOCKED" '
        'CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_RELEASE="$CLEANUP_RELEASE"',
    )
    cleanup_claimant_script = r"""
set -uo pipefail
claimant_start="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
if env CLOUDBENCH_TEST_SCRIPT_SNAPSHOT_LOCK_WAITING="$CLAIM_WAITING" \
  python3 "$HELPER" claim --path "$SNAPSHOT" --temp-root "$TEMP_ROOT" \
    --token "$TOKEN" --pid "$$" --pid-start "$claimant_start" \
    --previous-pid "$PREVIOUS_PID" --previous-pid-start "$PREVIOUS_START" \
    >/dev/null 2>&1; then
  exit 20
fi
exit 0
"""
    cleanup_common = {
        **os.environ,
        "HELPER": str(SCRIPT_SNAPSHOT_OWNER),
        "SNAPSHOT": str(cleanup_snapshot),
        "TEMP_ROOT": str(cleanup_root),
        "TOKEN": "d" * 32,
        "CLEANUP_LOCKED": str(cleanup_lock_ready),
        "CLEANUP_RELEASE": str(cleanup_lock_release),
        **{key: str(value) for key, value in cleanup_paths.items()},
    }
    cleanup_owner = subprocess.Popen(
        ["bash", "-c", cleanup_owner_script],
        env=cleanup_common,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    cleanup_claimant: subprocess.Popen[str] | None = None
    try:
        wait_path(cleanup_paths["OWNER_READY"], cleanup_owner)
        cleanup_paths["CLEANUP_GO"].touch()
        wait_path(cleanup_lock_ready, cleanup_owner)
        cleanup_claim_env = {
            **cleanup_common,
            "PREVIOUS_PID": cleanup_paths["OWNER_PID_FILE"].read_text().strip(),
            "PREVIOUS_START": cleanup_paths["OWNER_START_FILE"].read_text().strip(),
        }
        cleanup_claimant = subprocess.Popen(
            ["bash", "-c", cleanup_claimant_script],
            env=cleanup_claim_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        wait_path(cleanup_paths["CLAIM_WAITING"], cleanup_owner, cleanup_claimant)
        cleanup_lock_release.touch()
        cleanup_owner_stdout, cleanup_owner_stderr = cleanup_owner.communicate(timeout=10)
        cleanup_claimant_stdout, cleanup_claimant_stderr = cleanup_claimant.communicate(timeout=10)
    finally:
        cleanup_lock_release.touch(exist_ok=True)
        for process in (cleanup_claimant, cleanup_owner):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    assert cleanup_owner.returncode == 0, (
        cleanup_owner_stdout,
        cleanup_owner_stderr,
    )
    assert cleanup_claimant is not None and cleanup_claimant.returncode == 0, (
        cleanup_claimant_stdout,
        cleanup_claimant_stderr,
    )
    assert cleanup_paths["OWNER_OUTCOME"].read_text().strip() == "deleted"
    assert not cleanup_snapshot.exists(), "claimant resurrected a snapshot after parent cleanup won the lifecycle lock"


def test_script_snapshot_lifecycle_keeps_the_bash_32_portability_contract() -> None:
    fleet = FLEET_SCRIPT.read_text()
    bash_4_only = {
        "associative arrays": r"\b(?:declare|local)\s+-A\b",
        "nameref variables": r"\b(?:declare|local)\s+-n\b",
        "mapfile/readarray": r"\b(?:mapfile|readarray)\b",
        "case conversion expansion": r"\$\{[^}\n]*(?:,,|\^\^)",
        "quoted-transform expansion": r"\$\{[^}\n]+@[QEPAaKk]\}",
        "coprocesses": r"\bcoproc\b",
        "combined append redirect": r"&>>",
        "pipe stderr shorthand": r"\|&",
        "globstar": r"\bglobstar\b",
    }
    for feature, pattern in bash_4_only.items():
        assert not re.search(pattern, fleet), f"fleet controller uses Bash 4+ {feature}; macOS still ships Bash 3.2"

    syntax = subprocess.run(
        ["bash", "--posix", "-n", str(FLEET_SCRIPT)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert syntax.returncode == 0, syntax.stderr


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
CATALOG_MODES=(real simulate)
SIM_ON_CSV=
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
    manifest = json.loads((tmp_path / "_batch" / "benches.json").read_text())
    assert manifest == [
        {"name": "alpha", "mode": "REAL"},
        {"name": "beta", "mode": "SIM"},
    ]

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
                own_probe = subprocess.run(
                    ["curl", "--noproxy", "*", "-fsS", f"http://127.0.0.1:{base_port + 1}/hub-meta.json"],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                foreign_probe = subprocess.run(
                    ["curl", "--noproxy", "*", "-fsS", f"http://127.0.0.1:{base_port}/"],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                if own_probe.returncode == 0 and foreign_probe.returncode == 0:
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
    shell = f"""set -uo pipefail
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
"""
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
        manifest = fleet.index("# benches.json was frozen")
        late_start = fleet.index("start_central_hub || exit 1", manifest)
        aggregator = fleet.index("(\n    while :; do", late_start)
        assert late_start < aggregator
        assert fleet.index("require_central_hub_visibility || exit 1", late_start) < aggregator
        assert 'env FLEET_DIR="$FLEET_DIR" UNIFIED_DIR="$UNIFIED_DIR" DASH_BASE="$DASH_BASE"' in fleet[aggregator:]
        assert 'kill "$pp"' not in fleet
    finally:
        foreign.terminate()
        foreign.wait(timeout=5)
        _terminate_test_owned_central_hubs(hub_context, runs_root)


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
    shell = f"""set -uo pipefail
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
"""
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
        owner_files = _test_central_hub_owner_records(hub_context)
        assert len(owner_files) == 1
        owner_fields = _read_test_owner_record(owner_files[0])
        hub_pid = int(owner_fields["pid"])
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
        _terminate_test_owned_central_hubs(hub_context, runs_root)


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
    shell = f"""set -uo pipefail
source "$HELPER"
eval "$(declare -f cloudbench_select_central_hub_port | sed '1s/cloudbench_select_central_hub_port/cloudbench_select_central_hub_port_original/')"
cloudbench_select_central_hub_port() {{
    if [ ! -e "$RACE_MARKER" ]; then
        : > "$RACE_MARKER"
        cloudbench_detach_reexec "$COMPETITOR_LOG" bash -c '
            printf "%s\n" "$$" > "$1"
            cd "$2"
            exec python3 -m http.server "$3" --bind 127.0.0.1
        ' _ "$COMPETITOR_PID_FILE" "$COMPETITOR_ROOT" "$FOREIGN_PORT"
        for _ in $(seq 1 50); do
            cloudbench_tcp_listener_present "$FOREIGN_PORT" && break
            sleep 0.05
        done
        cloudbench_tcp_listener_present "$FOREIGN_PORT" || return 1
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
"""
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
        _terminate_test_owned_pid_file(competitor_pid_file)
        _terminate_test_owned_central_hubs(hub_context, runs_root)


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


def test_fleet_waits_for_warm_source_stopped_before_provisioning() -> None:
    """Parallel fleet launches must wait out concurrent warm maintenance instead
    of hard-failing the first non-stopped sample into INFRA."""
    fleet = FLEET_SCRIPT.read_text()
    wait_log = fleet.index("warm source is $warm_state; waiting until stopped before fleet provisioning")
    wait_helper = fleet.index(
        'cloudbench_wait_machine_stopped pool_machine_state "$WARM_ID"',
        wait_log,
    )
    gate = fleet.index("warm source must be stopped before fleet provisioning")
    park_at = fleet.index("parking warm source at $WARM_PARKED_VM_SIZE")
    fanout_at = fleet.index("# ── Phase 1:")
    # Wait log → shared helper → timeout gate → parking → Phase-1 fanout.
    assert wait_log < wait_helper < gate < park_at < fanout_at
    assert 'warm_stop_attempts="${CLOUDBENCH_WARM_STOP_ATTEMPTS:-60}"' in fleet
    assert 'warm_stop_sleep="${CLOUDBENCH_WARM_STOP_SLEEP_SECONDS:-5}"' in fleet
    # Must re-list machines after the wait settles (not cache the first sample).
    relist_at = fleet.index(
        'warm_json="$(FLY machines list -a "$APP" --json 2>/dev/null || echo \'[]\')"',
        wait_helper,
    )
    assert wait_helper < relist_at < park_at
    # Never stop/destroy the shared warm donor from the fleet wait path.
    wait_block = fleet[wait_log:park_at]
    assert "machine stop" not in wait_block
    assert "machines destroy" not in wait_block


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
            "registry_record_is_stale_pre_volume_id() {",
            "registry_retire_absent_stale_pre_volume_records() {",
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


def test_strict_barrier_and_infra_probe_fail_closed() -> None:
    """Infra canaries /descend must not accept "most boxes OK" as a green
    substrate. --infra-probe / --strict-barrier / CLOUDBENCH_STRICT_BARRIER=1
    fails closed on any exclusion or timeout; the guest driver skips
    run_benchmark when CLOUDBENCH_INFRA_PROBE=1."""
    fleet = FLEET_SCRIPT.read_text()
    fn = _extract_fleet_function(fleet, "release_start_barrier() {")
    assert "STRICT_BARRIER" in fn
    assert "STRICT barrier: refusing to release" in fn
    assert "STRICT barrier: timed out" in fn
    assert "--infra-probe" in fleet
    assert 'INFRA_PROBE="1"' in fleet and 'STRICT_BARRIER="1"' in fleet
    assert "CLOUDBENCH_INFRA_PROBE" in fleet
    # Width-N infra probes must not run mandatory autoscalers: guests tear down
    # /metrics immediately after DONE and the autoscaler race becomes CHILDFAIL
    # despite a green strict barrier.
    assert "per-bench autoscaler SKIPPED (infra-probe" in fleet
    assert "infra-probe: skipping mandatory autoscaler startup wait" in fleet

    cloud_runner = CLOUD_SCRIPT.read_text()
    assert "guest cleanup skipped for infra-probe" in cloud_runner
    assert 'CLOUDBENCH_INFRA_PROBE:-0}" = "1"' in cloud_runner

    driver = (ROOT / "scripts" / "cloudbench-run.sh").read_text()
    assert "CLOUDBENCH_INFRA_PROBE" in driver
    assert "skipping run_benchmark.py" in driver
    assert "infra_probe" in driver
    # Synthetic probe tasks must inherit real|simulate — literal "infra-probe"
    # mode fails cloudbench_result expected-world-model-mode checks (#1285).
    assert '"world_model_mode": "infra-probe"' not in driver
    assert "BENCHMARK_WORLD_MODEL_MODE" in driver

    cloud = CLOUD_SCRIPT.read_text()
    assert "CLOUDBENCH_INFRA_PROBE" in cloud


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
    (tmp_path / "bench-log-alias").symlink_to("bench.log")
    os.link(tmp_path / "bench.log", tmp_path / "bench-log-hardlink")
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
                with local_opener.open(f"{base}/bench.log?offset=0&limit=4", timeout=0.5) as response:
                    assert response.read() == b"read"
                    assert int(response.headers["Content-Length"]) <= 4
                break
            except (OSError, urllib.error.URLError):
                if time.time() >= deadline:
                    raise
                time.sleep(0.05)

        for unbounded_alias in (
            "/bench.log",
            "/./bench.log",
            "/%62ench.log",
            "/x/../bench.log",
            "/bench-log-alias",
            "/bench-log-hardlink",
        ):
            try:
                local_opener.open(f"{base}{unbounded_alias}", timeout=1)
                raise AssertionError(f"unbounded bench.log alias unexpectedly succeeded: {unbounded_alias}")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400

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
        # Reproduce the boot supervisor's finalization window dynamically:
        # wait(1) has reaped the driver and removed its PID file, but the final
        # log append and atomic state=exited seal have not happened yet. EOF in
        # this window must remain nonterminal, or the controller can accept an
        # incomplete artifact before the supervisor's last durable bytes.
        pid_file.unlink()
        state_file.write_text("running\n")
        try:
            local_opener.open(f"{base}/driver-health", timeout=1)
            raise AssertionError("unsealed driver exit unexpectedly reported terminal")
        except urllib.error.HTTPError as exc:
            assert exc.code == 503
        assert probe(port) == 20
        (tmp_path / "bench.log").write_text("ready\n[boot] driver exited rc=0; holding for controller collection\n")
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
        with opener.open(f"http://[::1]:{port}/bench.log?offset=0&limit=65536", timeout=2) as response:
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
                with local_opener.open(
                    f"http://127.0.0.1:{ports[-1]}/bench.log?offset=0&limit=65536",
                    timeout=0.2,
                ):
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

        release_fn = _extract_fleet_function(FLEET_SCRIPT.read_text(), "release_start_barrier() {")
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
CHILD_BENCH=({" ".join(f"task-{i}" for i in range(30))})
CHILD_MACHINE=({" ".join(f"machine-{i}" for i in range(30))})
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
    relay_wait = cloud[cloud.index("RELAY_HEARTBEAT_WAIT_SECONDS=") :]
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
    terminal_collect = _extract_fleet_function(cloud, "cloudbench_collect_terminal_log() {")
    recovery = _extract_fleet_function(cloud, "recover_terminal_marker_after_dead_driver() {")
    ssh_log = tmp_path / "bench.log"
    read_state = tmp_path / "read-count"
    script = f"""
{terminal_collect}
{recovery}
ensure_status_proxy() {{ :; }}
refresh_bench_log_to_eof() {{
    count=0
    [ ! -f "$READ_STATE" ] || count="$(cat "$READ_STATE")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$READ_STATE"
    [ "$count" -gt 1 ] || return 1
    printf '%s\n' 'report payload' "$DONE_MARKER exit=1" >> "$SSH_LOG"
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
    assert "cloudbench_collect_terminal_log" in recovery
    assert "refresh_bench_log_to_eof" in terminal_collect


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
    environment_helpers = ENV_HELPER_SCRIPT.read_text()
    # On-box status server over /data, and a data-plane proxy to it.
    assert "REMOTE_STATUS_PORT" in cloud
    assert "cloudbench-status-server.py" in cloud
    assert "--directory /data" in cloud
    assert "http.server ${REMOTE_STATUS_PORT} --directory /data" not in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))" LOCAL_STATUS_PORT' in cloud
    assert 'publish_status_proxy_port "$port"' in cloud
    # The poll reads only over the bounded data-plane proxy.
    assert "read_bench_log()" in cloud
    assert "curl --noproxy '*' -sS --max-time 6 -D \"$headers\"" in cloud
    assert "/bench.log?offset=$offset&limit=$limit" in cloud
    assert 'refresh_bench_log "$BENCH_LOG_CHUNKS_PER_POLL"' in cloud
    assert 'remote_log="$(read_bench_log' not in cloud
    read_log = _extract_fleet_function(cloud, "read_bench_log() {")
    assert "ssh_read" not in read_log
    refresh_log = _extract_fleet_function(cloud, "refresh_bench_log() {")
    assert 'cat "$BENCH_LOG_CHUNK_FILE" >> "$SSH_LOG"' in refresh_log
    assert refresh_log.index('read_bench_log "$offset" "$limit"') < refresh_log.index(
        'cat "$BENCH_LOG_CHUNK_FILE" >> "$SSH_LOG"'
    )
    assert "X-Cloudbench-Log-Anchor" in read_log
    assert "X-Cloudbench-Log-Generation" in read_log
    assert "X-Cloudbench-Log-Continuity" in refresh_log
    poll_loop = cloud[cloud.index('poll_start="$(date +%s)"') : cloud.index("# Preserve the complete remote driver")]
    assert poll_loop.index("refresh_bench_log") < poll_loop.index("cloudbench_update_progress_state")
    assert poll_loop.index('BENCH_LOG_HAS_MORE" = "1"') < poll_loop.rindex("cloudbench_watchdog_expired")
    # Proxy cleanup is PID-owned; no cross-run pattern kill is allowed.
    assert 'cloudbench_terminate_and_wait 5 "${PROXY_PID:-}" "${STATUS_PROXY_PID:-}"' in cloud
    assert 'flyctl proxy "$local_port:$remote_port"' in environment_helpers
    assert "cloudbench_start_data_plane_proxy" in _extract_fleet_function(cloud, "start_data_plane_proxy() {")
    assert 'FLY proxy "$local_port:$remote_port"' not in cloud
    assert 'pkill -f "flyctl proxy $LOCAL_STATUS_PORT' not in cloud

    # Backgrounding the FLY() shell function records a wrapper-subshell PID and
    # can orphan its flyctl child. Autoscaler metrics tunnels must also record
    # and reap the executable PID directly.
    fleet = FLEET_SCRIPT.read_text()
    assert 'flyctl proxy "$metrics_port:$BOX_HEALTH_PORT"' in fleet
    assert 'FLY proxy "$metrics_port:$BOX_HEALTH_PORT"' not in fleet
    assert 'cloudbench_terminate_and_wait 5 "${metrics_proxy_pid:-}"' in fleet


def test_status_log_poll_is_incremental_when_full_log_exceeds_deadline(
    tmp_path: Path,
) -> None:
    """RCA (2026-09-07): a healthy Polar guest kept making semantic progress,
    but each status poll retransmitted its multi-megabyte cumulative bench.log.
    On the slower live tunnel a complete GET took 7.5--13.5 seconds, so curl's
    six-second transport deadline hid new counters from the rolling watchdog.

    Preserve the exact boundary locally: the controller already has the prior
    cumulative prefix, the guest appends a new semantic counter, and a throttled
    data-plane hop cannot transfer the full file inside six seconds.  The poll
    must request only a bounded suffix and append it without relaxing the bound.
    """
    import http.client
    import urllib.request

    prior_progress = (
        b"RUNSTAMP-run-token\n"
        b"[cloudbench 00:00:00] STEP benchmark\n"
        b"  task-without-polar-prefix: Fixture title\n"
        b"     timeout=disabled (step budget), browser_steps<=100, price_limit=1000c\n"
        b"    ... ACTIVE | 1 agents (1 active, 0 failed) | 8 root msgs | 19c | 5000s\n"
    )
    chatter = b"report-card redraw without semantic progress\n" * 26_000
    previous_snapshot = prior_progress + chatter
    latest_progress = b"    ... ACTIVE | 1 agents (1 active, 0 failed) | 9 root msgs | 19c | 5030s\n"
    (tmp_path / "bench.log").write_bytes(previous_snapshot + latest_progress)
    (tmp_path / "cloudbench-driver.pid").write_text(f"{os.getpid()}\n")
    (tmp_path / "cloudbench-driver.state").write_text("running\n")
    controller_log = tmp_path / "controller-bench.log"
    controller_log.write_bytes(previous_snapshot)

    ready_file = tmp_path / "status.port"
    status_server = subprocess.Popen(
        [
            sys.executable,
            str(STATUS_SERVER_SCRIPT),
            "--directory",
            str(tmp_path),
            "--port",
            "0",
            "--bind",
            "127.0.0.1",
            "--ready-file",
            str(ready_file),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    proxy: ThreadingHTTPServer | None = None
    proxy_thread: threading.Thread | None = None
    observed: list[tuple[str, int, int]] = []
    try:
        deadline = time.time() + 5
        while not ready_file.is_file():
            if status_server.poll() is not None:
                raise AssertionError(status_server.stderr.read())
            if time.time() >= deadline:
                raise AssertionError("status server did not publish its port")
            time.sleep(0.02)
        status_port = int(ready_file.read_text().strip())

        class SlowDataPlaneProxy(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                connection = http.client.HTTPConnection("127.0.0.1", status_port, timeout=3)
                try:
                    connection.request("GET", self.path)
                    response = connection.getresponse()
                    self.send_response(response.status)
                    for name, value in response.getheaders():
                        if name.lower() not in {"connection", "date", "server"}:
                            self.send_header(name, value)
                    self.end_headers()
                    sent = 0
                    while block := response.read(16_384):
                        # 128 KiB/s: the ~1 MiB cumulative response cannot meet
                        # the real six-second client contract; a bounded suffix can.
                        time.sleep(len(block) / 131_072)
                        try:
                            self.wfile.write(block)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        sent += len(block)
                    observed.append((self.path, response.status, sent))
                finally:
                    connection.close()

            def log_message(self, _format: str, *args: object) -> None:
                return

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), SlowDataPlaneProxy)
        proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        proxy_thread.start()
        proxy_port = proxy.server_port
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{proxy_port}/driver-health", timeout=2) as response:
            assert response.status == 204

        read_log = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "read_bench_log() {")
        chunk = tmp_path / "bench-log.chunk"
        script = f"""set -u
{read_log}
STATUS_PROXY_PID=$$
LOCAL_STATUS_PORT="$1"
SSH_LOG="$2"
chunk="$3"
if read_bench_log > "$chunk"; then
    chunk_bytes="$(wc -c < "$chunk" | tr -d ' ')"
    max_bytes="${{CLOUDBENCH_LOG_CHUNK_BYTES:-65536}}"
    if [ "$chunk_bytes" -gt "$max_bytes" ]; then
        printf 'unbounded bench.log response: %s > %s bytes\n' "$chunk_bytes" "$max_bytes" >&2
        exit 97
    fi
    cat "$chunk" >> "$SSH_LOG"
else
    rc=$?
    printf 'incremental bench.log read failed rc=%s while driver-health=204\n' "$rc" >&2
    exit "$rc"
fi
grep -F '9 root msgs' "$SSH_LOG"
"""
        started = time.monotonic()
        result = subprocess.run(
            [
                "bash",
                "-c",
                script,
                "incremental-log",
                str(proxy_port),
                str(controller_log),
                str(chunk),
            ],
            env={**os.environ, "CLOUDBENCH_LOG_CHUNK_BYTES": "65536"},
            text=True,
            capture_output=True,
            check=False,
            timeout=8,
        )
        elapsed = time.monotonic() - started

        assert result.returncode == 0, result.stderr
        assert elapsed < 6, f"bounded suffix read took {elapsed:.3f}s"
        expected_query = f"/bench.log?offset={len(previous_snapshot)}&limit=65536"
        assert any(
            path == expected_query and status == 206 and sent == len(latest_progress) for path, status, sent in observed
        ), observed
        with opener.open(f"http://127.0.0.1:{proxy_port}/driver-health", timeout=2) as response:
            assert response.status == 204
    finally:
        if proxy is not None:
            proxy.shutdown()
            proxy.server_close()
        if proxy_thread is not None:
            proxy_thread.join(timeout=2)
        status_server.terminate()
        status_server.wait(timeout=5)


def test_incremental_status_log_refresh_owns_eof_reset_and_terminal_catchup(
    tmp_path: Path,
) -> None:
    """The production refresh helper owns every append-only state transition.

    An unchanged offset is a no-op; shorter, same-size, and regrown same-token
    replacements cannot mix epochs; and a 16.34 MiB terminal burst drains through
    bounded responses while preserving byte-exact report/result/cleanup evidence.
    """
    initial = b"RUNSTAMP-run-token\nprior\n" + (b"p" * 1_048_576)
    reset = b"RUNSTAMP-run-token\nrestarted\n"
    same_size_reset = b"RUNSTAMP-run-token\n" + (b"s" * (len(reset) - 20)) + b"\n"
    assert len(same_size_reset) == len(reset)
    regrown_reset = b"RUNSTAMP-run-token\nregrown replacement\n" + (b"r" * 9000)
    terminal_suffix = (
        b"\n::CLOUDBENCH-REPORT-CARD-BEGIN:: token=run-token\n"
        b'{"status":"passed"}\n'
        b"::CLOUDBENCH-REPORT-CARD-END:: token=run-token\n"
        b"::CLOUDBENCH-RESULT-BEGIN:: token=run-token\n"
        b'{"tasks":[{"passed":true}]}\n'
        b"::CLOUDBENCH-RESULT-END:: token=run-token\n"
        b"::CLOUDBENCH-DONE:: token=run-token exit=0\n" + (b"post-DONE cleanup evidence\n" * 12_000)
    )
    terminal_size = 16_340_000
    terminal_tail = b"t" * (terminal_size - len(regrown_reset) - len(terminal_suffix)) + terminal_suffix
    remote_log = tmp_path / "bench.log"
    remote_log.write_bytes(initial)
    controller_log = tmp_path / "controller.log"
    controller_log.write_bytes(initial)
    reset_file = tmp_path / "reset.log"
    reset_file.write_bytes(reset)
    same_size_file = tmp_path / "same-size.log"
    same_size_file.write_bytes(same_size_reset)
    regrown_file = tmp_path / "regrown.log"
    regrown_file.write_bytes(regrown_reset)
    terminal_tail_file = tmp_path / "terminal-tail.log"
    terminal_tail_file.write_bytes(terminal_tail)
    ready_file = tmp_path / "server.port"
    server = subprocess.Popen(
        [
            sys.executable,
            str(STATUS_SERVER_SCRIPT),
            "--directory",
            str(tmp_path),
            "--port",
            "0",
            "--bind",
            "127.0.0.1",
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
                raise AssertionError("status server did not publish its port")
            time.sleep(0.02)
        port = int(ready_file.read_text().strip())
        chunk = tmp_path / "chunk"
        headers = tmp_path / "headers"
        client_generation = tmp_path / "client.generation"
        progress_delta = tmp_path / "progress.delta"
        script = f"""set -eu
{_cloudbench_incremental_log_functions()}
STATUS_PROXY_PID=$$
LOCAL_STATUS_PORT="$1"
SSH_LOG="$2"
BENCH_LOG_CHUNK_FILE="$3"
BENCH_LOG_HEADERS_FILE="$4"
BENCH_LOG_GENERATION_FILE="$5"
BENCH_LOG_PROGRESS_FILE="$6"
RUN_LOG_TOKEN=run-token

before="$(cksum < "$SSH_LOG")"
refresh_bench_log 1
after="$(cksum < "$SSH_LOG")"
[ "$before" = "$after" ]
[ "$BENCH_LOG_HAS_MORE" = 0 ]
[ "$BENCH_LOG_RESET" = 0 ]

cp "$7" "$8"
refresh_bench_log 4
[ "$BENCH_LOG_RESET" = 1 ]
cmp "$SSH_LOG" "$7"

cp "$9" "$8"
refresh_bench_log 4
[ "$BENCH_LOG_RESET" = 1 ]
cmp "$SSH_LOG" "$9"

cp "${{10}}" "$8"
refresh_bench_log 4
[ "$BENCH_LOG_RESET" = 1 ]
cmp "$SSH_LOG" "${{10}}"

cat "${{11}}" >> "$8"
refresh_bench_log_to_eof
[ "$BENCH_LOG_HAS_MORE" = 0 ]
cmp "$SSH_LOG" "$8"
grep -F '::CLOUDBENCH-DONE:: token=run-token exit=0' "$SSH_LOG"
grep -F '{{"status":"passed"}}' "$SSH_LOG"
grep -F 'post-DONE cleanup evidence' "$SSH_LOG"
printf 'bytes=%s reset=%s\n' "$(wc -c < "$SSH_LOG" | tr -d ' ')" "$BENCH_LOG_RESET"
"""
        started = time.monotonic()
        result = subprocess.run(
            [
                "bash",
                "-c",
                script,
                "refresh-log",
                str(port),
                str(controller_log),
                str(chunk),
                str(headers),
                str(client_generation),
                str(progress_delta),
                str(reset_file),
                str(remote_log),
                str(same_size_file),
                str(regrown_file),
                str(terminal_tail_file),
            ],
            env={
                **os.environ,
                "CLOUDBENCH_LOG_CHUNK_BYTES": "262144",
                "CLOUDBENCH_TERMINAL_LOG_MAX_CHUNKS": "128",
            },
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        elapsed = time.monotonic() - started
        assert result.returncode == 0, result.stderr
        assert f"bytes={terminal_size}" in result.stdout
        assert elapsed < 6, f"terminal catch-up took {elapsed:.3f}s"
    finally:
        server.terminate()
        server.wait(timeout=5)


def test_incremental_status_log_rejects_partial_and_wrong_offset_atomically(
    tmp_path: Path,
) -> None:
    """Neither a truncated HTTP body nor a mismatched Content-Range may append."""
    from urllib.parse import parse_qs, urlsplit

    controller_log = tmp_path / "controller.log"
    controller_log.write_bytes(b"RUNSTAMP-run-token\nvalidated-prefix\n")
    original = tmp_path / "original.log"
    shutil.copyfile(controller_log, original)
    requests_seen = 0

    class InvalidChunkServer(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            nonlocal requests_seen
            parameters = parse_qs(urlsplit(self.path).query)
            offset = int(parameters["offset"][0])
            requests_seen += 1
            if requests_seen == 1:
                body = b"short"
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {offset}-{offset + 9}/{offset + 10}")
                self.send_header("Content-Length", "10")
                self.send_header("X-Cloudbench-Log-Generation", "a" * 32)
                self.send_header("X-Cloudbench-Log-Continuity", "1")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                self.close_connection = True
                return
            body = b"wrong-size"
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {offset + 1}-{offset + 10}/{offset + 11}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Cloudbench-Log-Generation", "a" * 32)
            self.send_header("X-Cloudbench-Log-Continuity", "1")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), InvalidChunkServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        chunk = tmp_path / "chunk"
        headers = tmp_path / "headers"
        generation = tmp_path / "generation"
        progress = tmp_path / "progress"
        script = f"""set -u
{_cloudbench_incremental_log_functions()}
STATUS_PROXY_PID=$$
LOCAL_STATUS_PORT="$1"
SSH_LOG="$2"
BENCH_LOG_CHUNK_FILE="$3"
BENCH_LOG_HEADERS_FILE="$4"
BENCH_LOG_GENERATION_FILE="$6"
BENCH_LOG_PROGRESS_FILE="$7"
RUN_LOG_TOKEN=run-token
for expected_failure in partial wrong-offset; do
    if refresh_bench_log 1; then
        printf '%s response unexpectedly committed\n' "$expected_failure" >&2
        exit 90
    fi
    cmp "$SSH_LOG" "$5" || exit 91
done
"""
        result = subprocess.run(
            [
                "bash",
                "-c",
                script,
                "atomic-log",
                str(server.server_port),
                str(controller_log),
                str(chunk),
                str(headers),
                str(original),
                str(generation),
                str(progress),
            ],
            env={**os.environ, "CLOUDBENCH_LOG_CHUNK_BYTES": "65536"},
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        assert result.returncode == 0, result.stderr
        assert controller_log.read_bytes() == original.read_bytes()
        assert requests_seen == 2
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_incremental_progress_state_is_bounded_monotonic_and_split_safe(
    tmp_path: Path,
) -> None:
    """Only newly accepted bytes may renew the Polar semantic lease.

    Replayed/regressed generations, keepalives, and elapsed-only redraws are
    inert; new identities/counters renew once; split lines survive poll
    boundaries; and an oversized terminal JSON line cannot grow parser state.
    """
    update = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "cloudbench_update_progress_state() {")
    state = tmp_path / "progress-state.json"
    delta = tmp_path / "delta"

    def consume(
        payload: bytes,
        *,
        reset: bool = False,
        state_path: Path = state,
        budget: int = 100,
    ) -> list[str]:
        state_path.touch(exist_ok=True)
        delta.write_bytes(payload)
        result = subprocess.run(
            [
                "bash",
                "-c",
                (f'{update}\ncloudbench_update_progress_state "$1" "$2" run-token task-without-polar-prefix "$4" "$3"'),
                "progress",
                str(state_path),
                str(delta),
                "1" if reset else "0",
                str(budget),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        fields = result.stdout.strip().split("|")
        assert len(fields) == 5, result.stdout
        return fields

    baseline = b"""RUNSTAMP-run-token
[cloudbench 00:00:00] STEP benchmark
  \xf0\x9f\x93\x8b task-without-polar-prefix: Fixture title
     timeout=disabled (step budget), browser_steps\xe2\x89\xa4100, price_limit=1000c
    Agent created: agent-one
    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 600s
"""
    assert consume(baseline) == ["1", "1", "-", "0", "0"]
    keepalive = b"""[cloudbench 00:00:30] benchmark heartbeat (pid=42)
    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 1770s
"""
    assert consume(keepalive)[1] == "0"
    assert consume(baseline, reset=True)[1] == "0"
    regressed = baseline.replace(b"4 root msgs", b"3 root msgs")
    assert consume(regressed, reset=True)[1] == "0"

    status_transition = b"    ... PAUSED | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1780s\n"
    active_transition = b"    ... ACTIVE | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1790s\n"
    assert consume(status_transition)[1] == "1"
    assert consume(active_transition)[1] == "1"
    assert (
        consume(b"    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 1800s\n" + status_transition)[
            1
        ]
        == "0"
    )
    assert consume(b"    ... OUT_OF_CREDITS | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1810s\n")[1] == "1"
    assert (
        consume(b"    ... COST_LIMIT_REACHED | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1820s\n")[1] == "1"
    )
    assert consume(b"    ... STARTING_UP | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1825s\n")[1] == "1"
    assert (
        consume(
            b"[cloudbench 00:01:00] STEP attacker-controlled-unbounded-phase\n"
            + "    🧭 Browser step budget reached: 999/999 — pausing for polar judge\n".encode()
        )[1]
        == "0"
    )
    exact_budget = ("    🧭 Browser step budget reached: 100/100 — pausing for polar judge\n").encode()
    assert consume(exact_budget)[1] == "1"
    assert consume(exact_budget)[1] == "0"
    wrong_state = tmp_path / "wrong-budget-state.json"
    wrong_budget = consume(baseline, state_path=wrong_state, budget=99)
    assert wrong_budget[:2] == ["0", "0"]

    assert consume(b"    Agent created: agent-two\n")[1] == "1"
    identities = b"".join(f"    Agent created: scale-agent-{index}\n".encode() for index in range(10_000))
    assert consume(identities)[1] == "1"
    assert consume(baseline + b"    Agent created: agent-two\n" + identities, reset=True)[1] == "0"
    assert consume(b"    Agent created: one-more-after-full-replay\n")[1] == "1"
    assert (
        consume(
            b"    UNBOUNDED_ATTACKER_STATUS | 99999 agents (99999 active, 0 failed) "
            b"| 99999 root msgs | 99999c | 99999s\n"
        )[1]
        == "0"
    )

    split = b"    ... ACTIVE | 2 agents (1 active, 0 failed) | 5 root msgs"
    assert consume(split)[1] == "0"
    assert consume(b" | 13.0c | 1790s\n")[1] == "1"

    assert consume(b"x" * 20_000)[1] == "0"
    barrier = consume(
        b"discarded remainder\n"
        b"[cloudbench 00:02:00] synchronized start barrier ready\n"
        b"[cloudbench 00:02:01] synchronized start barrier released\n"
    )
    assert barrier[3:] == ["1", "1"]
    terminal = consume(b"discarded remainder\n::CLOUDBENCH-DONE:: token=run-token exit=0\n")
    assert terminal[2] == "0"
    replaced = consume(baseline, reset=True)
    assert replaced[2:] == ["-", "0", "0"]
    parsed = json.loads(state.read_text())
    assert len(base64.b64decode(parsed["pending_b64"])) <= 8192
    assert parsed["max_agent_creations"] == 10_003
    assert len(state.read_bytes()) < 10_000


def test_incremental_progress_update_application_preserves_terminal_contract() -> None:
    """The production update applicator must not confuse an empty DONE field
    with exit zero, and malformed parser output must fail closed."""
    apply_update = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "cloudbench_apply_progress_update() {")
    script = f"""set -u
{apply_update}
progress_barrier_ready=0
progress_barrier_released=0
progress_attested=0
last_meaningful_progress=10
terminal_pending_exit=
terminal_pending_since=
terminal_read_failures=0
cloudbench_apply_progress_update '1|1|-|1|0' 42
[ "$progress_attested" = 1 ]
[ "$last_meaningful_progress" = 42 ]
[ -z "$terminal_pending_exit" ]
[ -z "$terminal_pending_since" ]
if cloudbench_apply_progress_update '1|1||1|0' 43; then exit 81; fi
cloudbench_apply_progress_update '1|0|7|1|1' 44
[ "$terminal_pending_exit" = 7 ]
[ "$terminal_pending_since" = 44 ]
terminal_read_failures=3
cloudbench_apply_progress_update '1|0|-|0|0' 45
[ -z "$terminal_pending_exit" ]
[ -z "$terminal_pending_since" ]
[ "$terminal_read_failures" = 0 ]
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr


def test_poll_read_failures_are_infra_before_semantic_deadline() -> None:
    """A healthy driver plus an unreadable incremental endpoint is transport
    failure, not evidence that the benchmark stopped making semantic progress."""
    cloud = CLOUD_SCRIPT.read_text()
    read_gate = _extract_fleet_function(cloud, "cloudbench_log_read_gate() {")
    script = f"""set -u
{read_gate}
log_read_failures=0
BENCH_LOG_READ_MAX_FAILURES=5
infra=0
timed_out=0
read_bench_log() {{ return 28; }}
refresh_bench_log() {{ read_bench_log; }}
probe_driver_health() {{ return 0; }}
cloudbench_watchdog_expired() {{ timed_out=1; return 0; }}
for _attempt in 1 2 3 4 5; do
  log_refresh_ok=0
  refresh_bench_log || :
  if cloudbench_log_read_gate "$log_refresh_ok"; then
    gate_rc=0
  else
    gate_rc=$?
  fi
  case "$gate_rc" in
    10) probe_driver_health; continue ;;
    20) infra=1; break ;;
    0) ;;
    *) exit 82 ;;
  esac
  cloudbench_watchdog_expired || :
done
[ "$infra" = 1 ]
[ "$timed_out" = 0 ]
[ "$log_read_failures" = 5 ]
"""
    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr

    poll_loop = cloud[cloud.index('poll_start="$(date +%s)"') : cloud.index("# Preserve the complete remote driver")]
    assert poll_loop.index("cloudbench_log_read_gate") < poll_loop.rindex("cloudbench_watchdog_expired")
    assert "bench.log could not be read" in poll_loop
    # A persistently unsealed/crashed driver remains bounded: terminal-DONE
    # candidates get at most the override-resistant 30-second seal window, and
    # ordinary transport failure is still exhausted after five reads above.
    assert 'if [ "$terminal_health_rc" = "10" ]; then' in poll_loop
    assert "driver did not exit within the bounded terminal log catch-up window" in poll_loop


def test_terminal_log_collection_retries_then_requires_exact_done(
    tmp_path: Path,
) -> None:
    """A transient sealed-log read is retryable, but EOF without the exact
    token-bound DONE marker is a malformed infrastructure result."""
    collect = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "cloudbench_collect_terminal_log() {")
    log = tmp_path / "controller.log"
    script = f"""set -u
{collect}
SSH_LOG="$1"
DONE_MARKER='::CLOUDBENCH-DONE:: token=run-token'
attempts=0
refresh_bench_log_to_eof() {{
  attempts=$((attempts + 1))
  if [ "$attempts" = 1 ]; then return 1; fi
  printf '%s\n' 'RUNSTAMP-run-token' \
    '::CLOUDBENCH-DONE:: token=run-token exit=0' > "$SSH_LOG"
}}
if cloudbench_collect_terminal_log; then exit 83; else first_rc=$?; fi
[ "$first_rc" = 10 ]
cloudbench_collect_terminal_log
[ "$CURRENT_TERMINAL_EXIT" = 0 ]
refresh_bench_log_to_eof() {{ :; }}
printf '%s\n' 'RUNSTAMP-run-token' \
  'prefix ::CLOUDBENCH-DONE:: token=run-token exit=0' \
  '::CLOUDBENCH-DONE:: token=run-token exit=0 suffix' > "$SSH_LOG"
if cloudbench_collect_terminal_log; then exit 84; else missing_rc=$?; fi
[ "$missing_rc" = 20 ]
"""
    result = subprocess.run(
        ["bash", "-c", script, "terminal-log", str(log)],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr


def test_incremental_log_bounds_ignore_hostile_overrides() -> None:
    """Inherited environment values cannot remove transport/backlog bounds."""
    cloud = CLOUD_SCRIPT.read_text()
    refresh = _extract_fleet_function(cloud, "refresh_bench_log() {")
    terminal = _extract_fleet_function(cloud, "refresh_bench_log_to_eof() {")
    result = subprocess.run(
        [
            "bash",
            "-c",
            f"""set -u
{refresh}
if refresh_bench_log 129; then exit 85; else [ "$?" = 2 ]; fi
CLOUDBENCH_LOG_CHUNK_BYTES=262145
if refresh_bench_log 1; then exit 86; else [ "$?" = 2 ]; fi
unset CLOUDBENCH_LOG_CHUNK_BYTES
refresh_bench_log() {{ [ "$1" = 128 ]; BENCH_LOG_HAS_MORE=0; }}
{terminal}
CLOUDBENCH_TERMINAL_LOG_MAX_CHUNKS=999999 refresh_bench_log_to_eof
""",
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr
    poll_loop = cloud[cloud.index('poll_start="$(date +%s)"') : cloud.index("# Preserve the complete remote driver")]
    assert '[ "$BENCH_LOG_CHUNKS_PER_POLL" -le 4 ]' in poll_loop
    assert '[ "$BENCH_LOG_BACKLOG_MAX_CHUNKS" -le 128 ]' in poll_loop
    assert '[ "$BENCH_LOG_BACKLOG_MAX_FAILURES" -le 5 ]' in poll_loop
    assert '[ "$BENCH_LOG_READ_MAX_FAILURES" -le 5 ]' in poll_loop
    assert '[ "$BENCH_LOG_TERMINAL_MAX_FAILURES" -le 5 ]' in poll_loop
    assert '[ "$BENCH_LOG_TERMINAL_WAIT_SECONDS" -le 30 ]' in poll_loop
    recovery = _extract_fleet_function(cloud, "recover_terminal_marker_after_dead_driver() {")
    assert '[ "$attempts" -le 5 ]' in recovery
    assert '[ "$retry_sleep" -le 1 ]' in recovery


def test_incremental_progress_consumes_committed_chunks_before_later_failure(
    tmp_path: Path,
) -> None:
    """A failed later response must not orphan an already committed semantic delta."""
    from urllib.parse import parse_qs, urlsplit

    initial = b"""RUNSTAMP-run-token
[cloudbench 00:00:00] STEP benchmark
  \xf0\x9f\x93\x8b task-without-polar-prefix: Fixture title
     timeout=disabled (step budget), browser_steps\xe2\x89\xa4100, price_limit=1000c
    ... ACTIVE | 1 agents (1 active, 0 failed) | 8 root msgs | 12c | 5000s
"""
    semantic = b"    ... ACTIVE | 1 agents (1 active, 0 failed) | 9 root msgs | 13c | 5030s\n"
    controller_log = tmp_path / "controller.log"
    controller_log.write_bytes(initial)
    expected = tmp_path / "expected.log"
    expected.write_bytes(initial + semantic)
    requests_seen = 0

    class LaterFailureServer(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            nonlocal requests_seen
            offset = int(parse_qs(urlsplit(self.path).query)["offset"][0])
            requests_seen += 1
            self.send_response(206)
            self.send_header("X-Cloudbench-Log-Generation", "b" * 32)
            self.send_header("X-Cloudbench-Log-Continuity", "1")
            if requests_seen == 1:
                total = offset + len(semantic) + 10
                self.send_header(
                    "Content-Range",
                    f"bytes {offset}-{offset + len(semantic) - 1}/{total}",
                )
                self.send_header("Content-Length", str(len(semantic)))
                self.end_headers()
                self.wfile.write(semantic)
                return
            self.send_header("Content-Range", f"bytes {offset}-{offset + 9}/{offset + 10}")
            self.send_header("Content-Length", "10")
            self.end_headers()
            self.wfile.write(b"short")
            self.wfile.flush()
            self.close_connection = True

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), LaterFailureServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        chunk = tmp_path / "chunk"
        headers = tmp_path / "headers"
        generation = tmp_path / "generation"
        progress = tmp_path / "progress"
        state = tmp_path / "state"
        baseline_delta = tmp_path / "baseline.delta"
        baseline_delta.write_bytes(initial)
        update = _extract_fleet_function(CLOUD_SCRIPT.read_text(), "cloudbench_update_progress_state() {")
        script = f"""set -u
{_cloudbench_incremental_log_functions()}
{update}
STATUS_PROXY_PID=$$
LOCAL_STATUS_PORT="$1"
SSH_LOG="$2"
BENCH_LOG_CHUNK_FILE="$3"
BENCH_LOG_HEADERS_FILE="$4"
BENCH_LOG_GENERATION_FILE="$5"
BENCH_LOG_PROGRESS_FILE="$6"
BENCH_PROGRESS_STATE_FILE="$7"
RUN_LOG_TOKEN=run-token
cloudbench_update_progress_state "$7" "$8" run-token task-without-polar-prefix 100 0 >/dev/null
if refresh_bench_log 2; then exit 80; fi
[ "$BENCH_LOG_CHUNKS_READ" = 1 ]
result="$(cloudbench_update_progress_state "$7" "$6" run-token task-without-polar-prefix 100 0)"
[ "$result" = "1|1|-|0|0" ]
cmp "$SSH_LOG" "$9"
"""
        result = subprocess.run(
            [
                "bash",
                "-c",
                script,
                "later-failure",
                str(server.server_port),
                str(controller_log),
                str(chunk),
                str(headers),
                str(generation),
                str(progress),
                str(state),
                str(baseline_delta),
                str(expected),
            ],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
        assert result.returncode == 0, result.stderr
        assert requests_seen == 2
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


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
APP=fixture-bench-app
RUN_ID=test-replacement-boundary
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={"d" * 32}
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


def test_single_task_capacity_reservations_scale_with_actual_fleet_width(tmp_path: Path) -> None:
    """Concurrent one-task fleets reserve one replacement slot apiece.

    Ten independent one-task controllers starting from the same 19-Machine
    inventory need two physical slots each: one fresh primary and at most one
    in-flight boot-config replacement.  A global four-update ceiling must not
    make each one-task fleet reserve four replacement Machines.
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
        for index in range(19)
    ]
    worker = tmp_path / "one-task-capacity-worker.sh"
    ready = tmp_path / "ready"
    done = tmp_path / "done"
    ready.mkdir()
    done.mkdir()
    worker.write_text(
        f"""#!/usr/bin/env bash
set -u
warm_json={shlex.quote(json.dumps(machines))}
BENCHES=(one-task)
PROVISION_POOL=""
FLEET_PRIMARY_VM_SIZE=shared-cpu-2x
APP=fixture-bench-app
RUN_ID="one-task-$1"
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
{support}
{guard}
touch "$3/$1"
while [ "$(find "$3" -type f | wc -l | tr -d ' ')" -lt 10 ]; do sleep 0.01; done
status=0
enforce_app_capacity_guard || status=$?
printf '%s\n' "$status" > "$2"
touch "$4/$1"
while [ "$(find "$4" -type f | wc -l | tr -d ' ')" -lt 10 ]; do sleep 0.01; done
exit "$status"
"""
    )
    worker.chmod(0o755)
    statuses = [tmp_path / f"{index}.status" for index in range(10)]
    processes = [
        subprocess.Popen(
            ["bash", str(worker), f"{index:032x}", str(statuses[index]), str(ready), str(done)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for index in range(10)
    ]
    results = [process.communicate(timeout=10) for process in processes]

    observed = [int(status.read_text().strip()) for status in statuses]
    assert observed == [0] * 10, results


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
APP=fixture-bench-app
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
{"".join(support)}
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
APP=fixture-bench-app
RUN_ID=test-pool-boundary
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={"c" * 32}
POOL_IDS_FILE={shlex.quote(str(pool_file))}
POOL_CLAIMS_DIR={shlex.quote(str(tmp_path / "claims"))}
CLOUDBENCH_CAPACITY_RESERVATION_ROOT={shlex.quote(str(tmp_path / "reservations"))}
CLOUDBENCH_APP_MACHINE_CEILING=56
CLOUDBENCH_SHARED_CPU_GOVERNOR=160
CLOUDBENCH_SHARED_CPU_HEADROOM=20
CLOUDBENCH_BOOT_CONFIG_MAX_IN_FLIGHT=4
{"".join(support)}
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
APP=fixture-bench-app
RUN_ID=test-bundled-primary-capacity
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={"2" * 32}
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
APP=fixture-bench-app
RUN_ID=test-invalid-pool
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={"1" * 32}
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
    release = _extract_fleet_function(fleet, "release_capacity_reservation_after_primary_start_accounted() {")
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
APP=fixture-bench-app
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
    classify = _extract_fleet_function(fleet, "available_stopped_pool_machine_count() {")
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
    guard = next(line for line in fleet.splitlines() if line.startswith("export -n inventory "))

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
    reserve_worker = _extract_fleet_function(fleet, "reserve_worker_machine_slot() {")
    script = f"""set -u
APP=fixture-bench-app
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
    release = _extract_fleet_function(fleet, "release_capacity_reservation_after_primary_start_accounted() {")
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
APP=fixture-bench-app
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
        "app=fixture-bench-app\n"
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
APP=fixture-bench-app
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


def test_capacity_reservation_retains_cleanup_unconfirmed_dead_owner(
    tmp_path: Path,
) -> None:
    """Admission must not prune ownership while its guest cleanup is unresolved."""
    fleet = FLEET_SCRIPT.read_text()
    reserve = _extract_fleet_function(fleet, "capacity_reserve_slots() {")
    root = tmp_path / "reservations-root"
    records = root / "reservations"
    ownership_root = tmp_path / "fleet-ownership"
    records.mkdir(parents=True)
    owner_token = "d" * 32
    dead_token = owner_token + "-primary"
    live_owner_token = "e" * 32
    live_token = live_owner_token + "-primary"
    registry = ownership_root / owner_token
    registry.mkdir(parents=True)
    (registry / "guest-cleanup-unconfirmed").touch()
    (records / dead_token).write_text(
        "version=1\n"
        "app=fixture-bench-app\n"
        f"host={socket.gethostname()}\n"
        "pid=999999\n"
        "pid_start=Mon Jan  1 00:00:00 2001\n"
        "run_id=dead-owner\n"
        f"token={dead_token}\n"
        f"fleet_owner_token={owner_token}\n"
        "machine_slots=50\n"
        "shared_units=100\n"
        "kind=primary\n"
    )
    script = f"""set -u
CAPACITY_RESERVATION_ROOT={shlex.quote(str(root))}
FLEET_OWNERSHIP_ROOT={shlex.quote(str(ownership_root))}
APP=fixture-bench-app
FLEET_OWNER_HOST="$(hostname)"
FLEET_OWNER_PID_START="$(ps -p $$ -o lstart= | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
FLEET_OWNER_TOKEN={live_owner_token}
RUN_ID=successor
{reserve}
capacity_reserve_slots {live_token} 1 2 56 140 10 20 primary
"""
    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 1, result.stderr
    assert result.stdout.startswith("DENY_MACHINE ")
    assert (records / dead_token).exists()
    assert not (records / live_token).exists()


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
CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB=0
CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB=1
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

    constrained_path = tmp_path / "constrained-reserve"
    constrained_script = f"""set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
CLOUDBENCH_CLEANUP_DISK_RESERVE_MB=4
CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB=2
CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB=1
df() {{
  printf '%s\n' \
    'Filesystem 1024-blocks Used Available Capacity Mounted on' \
    'fake 10000 5904 4096 60% /fake'
}}
{reserve}
reserve_cleanup_disk_space
test "$(wc -c < "$CLEANUP_DISK_RESERVE_FILE" | tr -d ' ')" = 2097152
rm -f "$CLEANUP_DISK_RESERVE_FILE"
"""
    constrained = subprocess.run(
        ["bash", "-c", constrained_script, "reserve", str(constrained_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert constrained.returncode == 0, constrained.stderr
    assert "scaled to 2MB to preserve 2MB controller headroom" in constrained.stderr

    insufficient_path = tmp_path / "insufficient-reserve"
    insufficient_script = f"""set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
CLOUDBENCH_CLEANUP_DISK_RESERVE_MB=4
CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB=2
CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB=1
df() {{
  printf '%s\n' \
    'Filesystem 1024-blocks Used Available Capacity Mounted on' \
    'fake 10000 7952 2048 80% /fake'
}}
{reserve}
if reserve_cleanup_disk_space; then exit 42; fi
test ! -e "$CLEANUP_DISK_RESERVE_FILE"
"""
    insufficient = subprocess.run(
        ["bash", "-c", insufficient_script, "reserve", str(insufficient_path)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert insufficient.returncode == 0, insufficient.stderr

    raced_path = tmp_path / "raced-reserve"
    df_calls = tmp_path / "df-calls"
    raced_script = f"""set -uo pipefail
CLEANUP_DISK_RESERVE_FILE="$1"
DF_CALLS="$2"
CLOUDBENCH_CLEANUP_DISK_RESERVE_MB=4
CLOUDBENCH_CONTROLLER_DISK_HEADROOM_MB=2
CLOUDBENCH_MIN_CLEANUP_DISK_RESERVE_MB=1
: > "$DF_CALLS"
df() {{
  count="$(wc -l < "$DF_CALLS" | tr -d ' ')"
  printf 'x\n' >> "$DF_CALLS"
  printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'
  if [ "$count" = 0 ]; then
    printf '%s\n' 'fake 10000 5904 4096 60% /fake'
  else
    printf '%s\n' 'fake 10000 8976 1024 90% /fake'
  fi
}}
{reserve}
if reserve_cleanup_disk_space; then exit 43; fi
test ! -e "$CLEANUP_DISK_RESERVE_FILE"
test "$(wc -l < "$DF_CALLS" | tr -d ' ')" = 2
"""
    raced = subprocess.run(
        ["bash", "-c", raced_script, "reserve", str(raced_path), str(df_calls)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert raced.returncode == 0, raced.stderr

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
    progress = _extract_fleet_function(cloud, "cloudbench_update_progress_state() {")
    assert 'if "synchronized start barrier ready" in line:' in progress
    assert 'if "synchronized start barrier released" in line:' in progress
    poll_loop = cloud[cloud.index('poll_start="$(date +%s)"') : cloud.index("# Preserve the complete remote driver")]
    assert 'if [ "$progress_barrier_ready" = "1" ]' in poll_loop
    assert '&& [ "$progress_barrier_released" != "1" ]' in poll_loop
    assert poll_loop.index('if [ "$progress_barrier_ready" = "1" ]') < poll_loop.index("cloudbench_watchdog_expired")
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


def test_run_bench_routes_production_only_batches_off_fly_fleet() -> None:
    """RCA (2026-08-20): production-only descend tasks never need a Fly guest.

    Under multi-workspace warm-box contention, fleet provisioning fails closed
    before any trustworthy --prod verdict. scripts/run-bench must detect an
    all-production_only batch and invoke run_benchmark.py --prod on the
    controller (same path as /deploy Step 13c).
    """
    run_bench = (ROOT / "scripts" / "run-bench").read_text()
    helper = (ROOT / "scripts" / "cloudbench-production-only-tasks.py").read_text()
    assert "cloudbench-production-only-tasks.py" in run_bench
    assert "production-only batch — controller-local --prod" in run_bench
    assert "run_benchmark.py --task" in run_bench
    assert "--prod" in run_bench
    assert "skipping Fly fleet" in run_bench
    assert run_bench.index("cloudbench-production-only-tasks.py") < run_bench.index(
        'exec bash "$ROOT_DIR/scripts/run-bench-fleet"'
    )
    # RCA (2026-08-21): --single-box must reject before the production-only
    # classifier. Sandbox multi-workstream has no tasks.json; classifier exit-2
    # otherwise masks the parallel-safe message (scenario 14).
    assert run_bench.index('if [[ "${1:-}" == "--single-box" ]]') < run_bench.index(
        "cloudbench-production-only-tasks.py"
    )
    assert "not parallel-safe" in run_bench
    assert "production_only" in helper

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "cloudbench-production-only-tasks.py"),
            "agent-payment-production-abandonment",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "agent-payment-production-abandonment"

    mixed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "cloudbench-production-only-tasks.py"),
            "agent-payment-production-abandonment",
            "single-creator-arm",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert mixed.returncode == 1

    polar = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "cloudbench-production-only-tasks.py"),
            "polar-bu-002",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert polar.returncode == 1, polar.stderr

    unknown = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "cloudbench-production-only-tasks.py"),
            "polar-not-a-real-task",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert unknown.returncode == 2, unknown.stderr
    assert "unknown benchmark task(s)" in unknown.stderr

    unsafe_name = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "cloudbench-production-only-tasks.py"),
            "name with space",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert unsafe_name.returncode == 2, unsafe_name.stderr

    assert "return 2" in helper
    assert "CatalogError" in helper
    assert "PROD_ONLY_STATUS" in run_bench
    assert "while IFS= read -r task" in run_bench
    assert 'done <<< "$PROD_ONLY_TASKS"' in run_bench
    assert "set -- $PROD_ONLY_TASKS" not in run_bench
    assert "exit 2" in run_bench


def test_isolated_backend_production_only_cloud_route_targets_production() -> None:
    """A canonical production-only task must never be sent to the local box.

    Execute the driver's real BENCH_ARGS construction block in isolation so the
    regression measures the exact boundary that feeds run_benchmark.py without
    booting a Fly guest or weakening the harness's production-only protection.
    """
    driver = DRIVER_SCRIPT.read_text()
    command_builder = "BENCH_ARGS=()" + driver.split("\nBENCH_ARGS=()", 1)[1].split('log "running benchmark:', 1)[0]
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

    result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, check=False)

    assert result.returncode == 0, result.stderr
    assert "--prod" in result.stdout.splitlines(), result.stdout
    assert "--port" not in result.stdout.splitlines(), result.stdout


def test_production_only_cloud_route_clears_local_frontend_override() -> None:
    driver = DRIVER_SCRIPT.read_text()

    assert ("if [ '$BENCH_TARGET_MODE' = 'prod' ]; then\n  unset BENCHMARK_FRONTEND_URL") in driver


def test_production_only_real_mode_skips_public_tunnel() -> None:
    """Prod-only fleets must not fail stack bring-up on trycloudflare NXDOMAIN.

    agent-payment-production-purchase runs with --prod against roselabs.ai, so a
    local public tunnel is unused as {frontend_url}. Without SKIP_PUBLIC_TUNNEL,
    cloudflare NXDOMAIN + missing ngrok on clones kills the stack before the
    synchronized start barrier (fleet run 20260819-183825-1437870).
    """
    driver = DRIVER_SCRIPT.read_text()

    assert 'BENCH_TARGET_MODE_FOR_STACK="$(printf' in driver
    assert 'elif [ "$BENCH_TARGET_MODE_FOR_STACK" = "prod" ]; then' in driver
    prod_idx = driver.index('elif [ "$BENCH_TARGET_MODE_FOR_STACK" = "prod" ]; then')
    else_idx = driver.index("\nelse\n", prod_idx)
    fi_idx = driver.index("\nfi\n", else_idx)
    prod_branch = driver[prod_idx:else_idx]
    else_branch = driver[else_idx:fi_idx]
    assert "BENCHMARK_SKIP_PUBLIC_TUNNEL=1" in prod_branch
    assert "BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1" not in prod_branch
    assert "BENCHMARK_EPHEMERAL_PUBLIC_TUNNEL=1" in else_branch
    assert "BENCHMARK_SKIP_PUBLIC_TUNNEL=1" not in else_branch


def test_cloud_dashboard_mirror_does_not_override_benchmark_frontend_url() -> None:
    """Dashboard links may use the localhost mirror, but task prompts must not.

    Cloud browser agents run outside the controller's localhost namespace. If
    dashboard mode exports BENCHMARK_FRONTEND_URL=http://localhost:<mirror>, the
    {frontend_url} prompt placeholder points browser tasks at an unreachable URL
    even though the child stack has already published a public tunnel.

    Report-card / RCA agent links must also stay durable (roselabs.ai), not the
    ephemeral localhost dashboard mirror that dies when the stack tears down.
    """
    cloud = CLOUD_SCRIPT.read_text()

    assert "BENCHMARK_FRONTEND_URL=http://localhost:$LOCAL_DASH_PORT" not in cloud
    assert "BENCHMARK_REPORT_FRONTEND_URL=http://localhost:$LOCAL_DASH_PORT" not in cloud
    assert "BENCHMARK_REPORT_FRONTEND_URL=https://roselabs.ai" in cloud
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


def test_cloud_agentcard_payment_tasks_provide_onboarding_callback_env() -> None:
    """AgentCard setup-gated payment tasks need the same callback env in cloud.

    Local benchmark setup injects AGENTCARD_ONBOARDING_RETURN_URL for these
    tasks. The cloud driver launches the backend through a strict STACK_ENV
    allow-list, so omitting the callback makes setup-session creation fail
    inside /api/purchases/mint before the benchmark can observe the setup gate.
    """
    driver = DRIVER_SCRIPT.read_text()

    assert "BENCH_NEEDS_AGENTCARD_ONBOARDING=0" in driver
    assert "agent-payment-setup-resume" in driver
    assert "gate-kyc-card-mint" in driver
    assert "AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL=" in driver
    assert 'STACK_ENV+=("AGENTCARD_ONBOARDING_RETURN_URL=$AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL")' in driver
    assert "export AGENTCARD_ONBOARDING_RETURN_URL='$AGENTCARD_BENCHMARK_ONBOARDING_RETURN_URL'" in driver
    assert "BENCH_NEEDS_PAYMENT_FIXTURE=0" in driver
    assert "BENCH_NEEDS_PAYMENT_FIXTURE=1" in driver
    assert "BENCHMARK_FORCE_CUSTOMER_PURCHASE_PATH=1" in driver
    assert "BENCHMARK_AGENT_PAYMENT_USER_ID=1f85ff25-6e29-4c1b-8739-f917bd101a30" in driver
    assert "scripts/setup-benchmark-payment.ts --user-id" in driver


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


def test_polar_cloud_route_keeps_tasks_on_isolated_backend() -> None:
    """Polar is part of the runnable catalog even though it is a separate shard."""
    for task_name in ("polar-odysseys-1211fbaa6464", "polar-bu-002"):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/cloudbench-benchmark-target.py"),
                str(ROOT / "agents/benchmarks/tasks.json"),
                "3001",
                task_name,
            ],
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        assert result.stdout.splitlines() == ["local", "--port", "3001"]


def test_cloud_catalog_metadata_exposes_polar_limits() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench_catalog.py"),
            "metadata",
            str(ROOT / "agents/benchmarks/tasks.json"),
            "polar-odysseys-1211fbaa6464",
            "polar-bu-002",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert [row["name"] for row in rows] == [
        "polar-odysseys-1211fbaa6464",
        "polar-bu-002",
    ]
    assert all(row["group"] == "polar-bench" for row in rows)
    assert all(row["timeout_seconds"] == 0 for row in rows)
    assert all(row["max_steps"] == {"browser": 100} for row in rows)
    assert all(row["browser_step_budget"] == 100 for row in rows)


def test_polar_progress_watchdog_fake_clock_ignores_keepalives() -> None:
    """RCA (2026-09-07): Polar tasks explicitly disable wall-clock timeout and
    terminate on their browser-step budget, but the outer cloud controller still
    killed them at RUN_TIMEOUT.  Its other timer followed raw log size, which a
    30-second benchmark heartbeat (or an elapsed-only STATUS line) advances even
    when the benchmark is stuck.

    Exercise the shipped deadline decision with an explicit clock: meaningful
    counters may carry a Polar run past the old absolute ceiling; heartbeat bytes
    and elapsed-only STATUS rewrites may not renew the inactivity lease; and an
    ordinary task retains the absolute deadline.
    """
    cloud = CLOUD_SCRIPT.read_text()
    signature = _extract_fleet_function(cloud, "cloudbench_progress_signature() {")
    deadline = _extract_fleet_function(cloud, "cloudbench_watchdog_expired() {")

    def progress_signature(log: str, task: str = "task-without-polar-prefix", budget: int = 100) -> str:
        result = subprocess.run(
            [
                "bash",
                "-c",
                f'{signature}\ncloudbench_progress_signature run-token "$1" "$2"',
                "signature",
                task,
                str(budget),
            ],
            input=log,
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        return result.stdout.strip()

    baseline = """RUNSTAMP-run-token
[cloudbench 00:00:00] STEP benchmark
  📋 task-without-polar-prefix: Fixture title
     timeout=disabled (step budget), browser_steps≤100, price_limit=1000c
    Agent created: 11111111-222...
    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 600s
"""
    keepalive_only = (
        baseline
        + """[cloudbench 00:00:30] benchmark heartbeat (pid=42)
    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 1770s
arbitrary raw log growth that is not a benchmark progress contract
"""
    )
    advanced = (
        keepalive_only
        + """    ... ACTIVE | 2 agents (1 active, 0 failed) | 5 root msgs | 13.0c | 1790s
"""
    )
    status_transition = (
        keepalive_only
        + """    ... WAITING | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1790s
"""
    )
    active_transition = (
        keepalive_only
        + """    ... ACTIVE | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1790s
"""
    )
    status_reversal = (
        status_transition
        + """    ... ACTIVE | 2 agents (1 active, 0 failed) | 4 root msgs | 12.5c | 1800s
    ... WAITING | 2 agents (0 active, 0 failed) | 4 root msgs | 12.5c | 1810s
"""
    )

    assert progress_signature(baseline) == progress_signature(keepalive_only)
    assert progress_signature(advanced) != progress_signature(keepalive_only)
    assert progress_signature(status_transition) != progress_signature(keepalive_only)
    assert progress_signature(active_transition) != progress_signature(keepalive_only)
    # Status/active shapes are a cumulative set. The first new transition
    # renews once; oscillating between shapes already observed cannot renew the
    # paid-resource lease indefinitely.
    assert progress_signature(status_reversal) == progress_signature(status_transition)
    assert progress_signature("RUNSTAMP-run-token\n[cloudbench] benchmark heartbeat (pid=42)\n") == ""
    assert progress_signature(baseline, budget=99) == ""
    spoofed = (
        baseline
        + """[cloudbench 00:01:00] STEP attacker-controlled-unbounded-phase
    🧭 Browser step budget reached: 999/999 — pausing for polar judge
"""
    )
    terminal_budget = (
        baseline
        + """    🧭 Browser step budget reached: 100/100 — pausing for polar judge
"""
    )
    assert progress_signature(spoofed) == progress_signature(baseline)
    assert progress_signature(terminal_budget) != progress_signature(baseline)

    def expired(mode: str, now: int, started: int, last_progress: int) -> bool:
        result = subprocess.run(
            [
                "bash",
                "-c",
                (f'{deadline}\ncloudbench_watchdog_expired "$1" "$2" "$3" "$4" 3600 1800'),
                "watchdog",
                mode,
                str(now),
                str(started),
                str(last_progress),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        assert result.returncode in (0, 1), result.stderr
        return result.returncode == 0

    # A semantic event at t=3590 renews the Polar lease past the former t=3600
    # wall-clock ceiling. A heartbeat at t=3700 would not change last_progress.
    assert not expired("progress", now=3601, started=0, last_progress=3590)
    assert not expired("progress", now=5389, started=0, last_progress=3590)
    assert expired("progress", now=5390, started=0, last_progress=3590)
    assert expired("absolute", now=3600, started=0, last_progress=3590)
    # Before guest attestation the poll loop uses this absolute branch, so the
    # 1800s rolling default cannot cut off a legitimate 2160s cold stack wait.
    assert not expired("absolute", now=1800, started=0, last_progress=0)
    assert expired("absolute", now=3600, started=0, last_progress=0)

    poll_loop = cloud[cloud.index('poll_start="$(date +%s)"') : cloud.index("# Preserve the complete remote driver")]
    assert poll_loop.count("cloudbench_watchdog_expired") == 3
    update_call = "cloudbench_update_progress_state"
    assert update_call in poll_loop
    assert "cloudbench_progress_signature" not in poll_loop
    assert poll_loop.index("refresh_bench_log") < poll_loop.index(update_call)
    assert poll_loop.index(update_call) < poll_loop.rindex("cloudbench_watchdog_expired")
    assert 'if [ "$progress_attested" != "1" ]; then' in poll_loop
    assert 'cloudbench_watchdog_expired "absolute"' in poll_loop
    assert '[ $((now - poll_start)) -ge "$RUN_TIMEOUT" ]' not in poll_loop
    assert "CLOUDBENCH_POLAR_PROGRESS_STALL_SECONDS:-1800" in cloud


def test_cloud_watchdog_policy_uses_one_batched_catalog_read() -> None:
    cloud = CLOUD_SCRIPT.read_text()
    policy = _extract_fleet_function(cloud, "cloudbench_watchdog_mode_from_metadata() {")

    polar_row = json.dumps(
        {
            "name": "task-without-polar-prefix",
            "group": "polar-bench",
            "tags": ["polar-bench", "browser"],
            "timeout_seconds": 0,
            "browser_step_budget": 100,
        }
    )
    result = subprocess.run(
        ["bash", "-c", f"{policy}\ncloudbench_watchdog_mode_from_metadata"],
        input=polar_row,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().split("\t") == [
        "progress",
        "task-without-polar-prefix",
        "100",
    ]

    for invalid_override in (
        {"timeout_seconds": True},
        {"timeout_seconds": 30},
        {"browser_step_budget": True},
        {"browser_step_budget": 0},
        {"group": "not-polar"},
        {"tags": ["browser"]},
    ):
        invalid_row = json.loads(polar_row)
        invalid_row.update(invalid_override)
        invalid = subprocess.run(
            ["bash", "-c", f"{policy}\ncloudbench_watchdog_mode_from_metadata"],
            input=json.dumps(invalid_row),
            text=True,
            capture_output=True,
            check=False,
        )
        assert invalid.returncode == 0, invalid.stderr
        assert invalid.stdout.strip() == "absolute"

    second_polar_row = json.dumps(
        {
            "name": "second-task-without-polar-prefix",
            "group": "polar-bench",
            "tags": ["polar-bench", "browser"],
            "timeout_seconds": 0,
            "browser_step_budget": 100,
        }
    )
    mixed_rows = (
        polar_row
        + "\n"
        + json.dumps(
            {
                "name": "ordinary",
                "group": "smoke",
                "tags": ["smoke"],
                "timeout_seconds": 900,
                "browser_step_budget": None,
            }
        )
    )
    mixed = subprocess.run(
        ["bash", "-c", f"{policy}\ncloudbench_watchdog_mode_from_metadata"],
        input=mixed_rows,
        text=True,
        capture_output=True,
        check=False,
    )
    assert mixed.returncode == 0, mixed.stderr
    assert mixed.stdout.strip() == "absolute"

    multi = subprocess.run(
        ["bash", "-c", f"{policy}\ncloudbench_watchdog_mode_from_metadata"],
        input=polar_row + "\n" + second_polar_row,
        text=True,
        capture_output=True,
        check=False,
    )
    assert multi.returncode == 0, multi.stderr
    assert multi.stdout.strip() == "absolute"

    # One ordered metadata invocation covers the whole array; no task-name
    # prefix can silently select the paid-resource policy.
    invocation = (
        'python3 "$CLOUDBENCH_CATALOG_SCRIPT" metadata "$ROOT_DIR/agents/benchmarks/tasks.json" "${BENCH_TASKS[@]}"'
    )
    assert invocation in cloud
    assert cloud.count(invocation) == 1
    assert 'CLOUDBENCH_CATALOG_SCRIPT="${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts}' in cloud
    assert "polar-*" not in policy
    assert "polar_" not in policy

    stall = _extract_fleet_function(cloud, "cloudbench_polar_stall_seconds() {")

    def stall_seconds(hard: int, requested: int | None = None) -> int:
        env = os.environ.copy()
        if requested is not None:
            env["CLOUDBENCH_POLAR_PROGRESS_STALL_SECONDS"] = str(requested)
        else:
            env.pop("CLOUDBENCH_POLAR_PROGRESS_STALL_SECONDS", None)
        capped = subprocess.run(
            ["bash", "-c", f'{stall}\ncloudbench_polar_stall_seconds "$1"', "stall", str(hard)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert capped.returncode == 0, capped.stderr
        return int(capped.stdout.strip())

    assert stall_seconds(3600) == 1800
    assert stall_seconds(60) == 60
    assert stall_seconds(3600, requested=1200) == 1200
    assert stall_seconds(3600, requested=5000) == 3600
    fleet_capped = subprocess.run(
        ["bash", "-c", f"{stall}\ncloudbench_polar_stall_seconds 2820"],
        env={
            **os.environ,
            "CLOUDBENCH_START_BARRIER": "fleet-run",
            "CLOUDBENCH_START_BARRIER_WAIT_SECONDS": "2760",
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert fleet_capped.returncode == 0, fleet_capped.stderr
    assert fleet_capped.stdout.strip() == "60"
    for bad_hard in ("", "0", "not-an-integer"):
        invalid = subprocess.run(
            ["bash", "-c", f'{stall}\ncloudbench_polar_stall_seconds "$1"', "stall", bad_hard],
            text=True,
            capture_output=True,
            check=False,
        )
        assert invalid.returncode == 2
    invalid_requested = subprocess.run(
        ["bash", "-c", f"{stall}\ncloudbench_polar_stall_seconds 3600"],
        env={**os.environ, "CLOUDBENCH_POLAR_PROGRESS_STALL_SECONDS": "invalid"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert invalid_requested.returncode == 2
    invalid_barrier = subprocess.run(
        ["bash", "-c", f"{stall}\ncloudbench_polar_stall_seconds 3600"],
        env={
            **os.environ,
            "CLOUDBENCH_START_BARRIER": "fleet-run",
            "CLOUDBENCH_START_BARRIER_WAIT_SECONDS": "3600",
        },
        text=True,
        capture_output=True,
        check=False,
    )
    assert invalid_barrier.returncode == 2
    assert 'POLAR_PROGRESS_STALL_SECONDS="$(cloudbench_polar_stall_seconds "$RUN_TIMEOUT")"' in cloud


def test_cloud_catalog_rejects_name_collisions(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    polar_catalog = tmp_path / "polar_tasks.json"
    catalog.write_text(json.dumps([{"name": "duplicate-task"}]))
    polar_catalog.write_text(json.dumps([{"name": "duplicate-task"}]))

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench_catalog.py"),
            "metadata",
            str(catalog),
            "duplicate-task",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "duplicate benchmark task name(s): duplicate-task" in result.stderr


def test_cloud_catalog_fails_closed_when_polar_shard_is_missing(tmp_path: Path) -> None:
    catalog = tmp_path / "tasks.json"
    catalog.write_text(json.dumps([{"name": "first-party-task"}]))

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/cloudbench_catalog.py"),
            "metadata",
            str(catalog),
            "first-party-task",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "polar_tasks.json" in result.stderr


def test_fleet_world_model_lookup_uses_fail_closed_unified_catalog() -> None:
    fleet = FLEET_SCRIPT.read_text()
    catalog_lookup = _extract_fleet_function(fleet, "_catalog_modes_for_batch() {")

    assert "from cloudbench_catalog import" in catalog_lookup
    assert "get_task_metadata" in catalog_lookup
    assert "python3 - \"$@\" <<'PY'" in catalog_lookup
    assert 'json.load(open("agents/benchmarks/tasks.json"))' not in catalog_lookup
    assert "|| echo real" not in catalog_lookup
    preflight = 'catalog_modes_output="$(_catalog_modes_for_batch "${BENCHES[@]}")"'
    assert preflight in fleet
    assert fleet.index(preflight) < fleet.index('if [ "$DETACH" = "1" ]')
    assert fleet.index(preflight) < fleet.index("if ! command -v flyctl")
    assert 'catalog_wmm="${CATALOG_MODES[$i]}"' in fleet
    assert "_catalog_wmm" not in fleet

    result_validator = CLOUDBENCH_RESULT_SCRIPT.read_text()
    assert "load_unified_catalog" in result_validator


def test_fleet_rejects_unknown_batch_before_any_fly_call(tmp_path: Path) -> None:
    """Direct Fleet entry must not provision known peers before finding a typo."""
    root = tmp_path / "repo"
    snapshot = tmp_path / "snapshot"
    fake_bin = tmp_path / "bin"
    calls = tmp_path / "fly-calls.log"
    for directory in (
        root / "agents/benchmarks",
        root / "back-end",
        root / ".git",
        snapshot,
        fake_bin,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    (root / "agents/benchmarks/tasks.json").write_text(
        json.dumps([{"name": "known-task", "world_model_mode": "simulate"}])
    )
    (root / "agents/benchmarks/polar_tasks.json").write_text(json.dumps([{"name": "polar-known-task"}]))
    shutil.copy(ROOT / "scripts/cloudbench_catalog.py", snapshot / "cloudbench_catalog.py")
    shutil.copy(ENV_HELPER_SCRIPT, snapshot / "cloudbench-env.sh")

    fake_fly = fake_bin / "flyctl"
    fake_fly.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FLY_CALLS"\nexit 97\n')
    fake_fly.chmod(0o755)
    calls.write_text("")

    result = subprocess.run(
        [
            "bash",
            str(FLEET_SCRIPT),
            "known-task",
            "not-in-either-catalog-shard",
            "--foreground",
        ],
        env={
            **os.environ,
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "CLOUDBENCH_FLEET_ROOT": str(root),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": str(snapshot),
            "CLOUDBENCH_GITHUB_TOKEN_B64": base64.b64encode(b"fixture-token").decode(),
            "CLOUDBENCH_RUNS_ROOT": str(tmp_path / "runs"),
            "CLOUDBENCH_TEST_FLEET_OWNER_TOKEN": "a" * 32,
            "FLY_BENCH_API_TOKEN": "fixture-fly-token",
            "FLY_CALLS": str(calls),
        },
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )

    assert result.returncode != 0
    assert "unknown benchmark task(s): not-in-either-catalog-shard" in (result.stdout + result.stderr)
    assert "before Fly provisioning" in result.stderr
    assert calls.read_text() == ""


def test_cloud_runner_avoids_live_run_port_collisions() -> None:
    """RCA (2026-07-16): concurrent runs in one workspace reused the same fixed
    per-task ports. Live evidence showed status proxies exiting with `bind:
    address already in use`, which blinded liveness/release and caused infra
    exclusions. Every locally bound per-task endpoint must resolve a free port,
    and the fleet must discover the selected status port from the child rather
    than reconstructing the preferred value.
    """
    cloud = CLOUD_SCRIPT.read_text()
    environment_helpers = ENV_HELPER_SCRIPT.read_text()
    assert 'claim_local_port "$LOCAL_DASH_PORT" LOCAL_DASH_PORT' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 3))" LOCAL_STATUS_PORT' in cloud
    assert 'start_leased_data_plane_proxy "$((LOCAL_DASH_PORT + 1))" LIVE_BACKEND_PORT' in cloud
    assert "return 98" in _extract_fleet_function(environment_helpers, "cloudbench_start_data_plane_proxy() {")
    assert "cloudbench_start_data_plane_proxy" in _extract_fleet_function(cloud, "start_data_plane_proxy() {")
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
    assert ("WORKER_STAGE_ATTEMPTS * WORKER_STAGE_ATTEMPT_WALL_SECONDS + WORKER_READY_TIMEOUT + 60") in normalized_fleet
    assert ('AUTOSCALER_FINALIZATION_WAIT_SECONDS="${CLOUDBENCH_AUTOSCALER_FINALIZATION_WAIT_SECONDS:-}"') in fleet

    provision = _extract_fleet_function(fleet, "provision_worker() {")
    assert 'stage_attempts="$WORKER_STAGE_ATTEMPTS"' in provision
    assert 'worker_ready_timeout="$WORKER_READY_TIMEOUT"' in provision
    autoscaler = _extract_fleet_function(fleet, "bench_autoscaler() {")
    assert '"worker capacity below desired: $ready_workers/$desired_workers workers queue-ready"' in autoscaler
    assert '"worker capacity incomplete: $ready_workers/$tracked_workers workers queue-ready"' in autoscaler
