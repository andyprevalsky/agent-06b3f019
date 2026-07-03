"""Canonical DB fixture / base-image registry for the eval catalog.

Every task in `tasks.json` runs on top of a base image — a known DB state the
agent's user context (contacts, messages, sessions, credentials) comes from.
Tasks that don't declare `environment.base_images` default to
`DEFAULT_BASE_IMAGE` (injected at load time in benchmark_tasks.py), so every
eval has a reproducible starting state by construction.

The default base image is the workspace's synced-prod Victoria DB, produced by
`bash scripts/setup-db.sh`. `ensure_base_image_snapshot()` freezes it to a
pg_dump file (same pattern as run_benchmark.py's grep frozen snapshot) so a
run's exact DB state can be archived alongside its trajectory and restored in
a sim later. Task-specific fixtures (e.g. `digital_twin_store_v1`) are deltas
applied on top of a base image.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_BASE_IMAGE = "base:victoria-prod-sync-v1"

BASE_IMAGES: dict[str, dict[str, str]] = {
    DEFAULT_BASE_IMAGE: {
        "description": (
            "Workspace Victoria DB synced from prod (users, people, messages, "
            "integrations, browser state, credentials)."
        ),
        "create": "bash scripts/setup-db.sh",
    },
}

BASE_IMAGE_SNAPSHOT_ENV = "EVAL_BASE_IMAGE_SNAPSHOT_PATH"


def base_image_snapshot_path(name: str = DEFAULT_BASE_IMAGE) -> Path:
    configured = os.environ.get(BASE_IMAGE_SNAPSHOT_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    slug = name.replace("base:", "").replace(":", "-")
    return REPO_ROOT / ".context" / "benchmarks" / f"base-image-{slug}.sql"


def _docker_daemon_ping() -> bool:
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, timeout=10)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _local_victoria_db_container() -> str | None:
    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace or not _docker_daemon_ping():
        return None
    container = f"victoria-db-{workspace}"
    ps = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{container}$", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    return container if container in ps.stdout.splitlines() else None


def _local_victoria_database_url() -> str | None:
    url = os.environ.get("LOCAL_VICTORIA_DATABASE_URL", "").strip()
    return url or None


def ensure_base_image_snapshot(name: str = DEFAULT_BASE_IMAGE, *, refresh: bool = False) -> Path:
    """Freeze the named base image to a pg_dump file and return its path.

    Idempotent: returns the existing snapshot unless `refresh=True`. Mirrors
    run_benchmark.py's grep frozen-snapshot mechanism so restore is
    `psql < snapshot` (the dump carries --clean --if-exists).
    """
    if name not in BASE_IMAGES:
        raise ValueError(f"Unknown base image '{name}'. Known: {sorted(BASE_IMAGES)}")
    path = base_image_snapshot_path(name)
    if path.exists() and path.stat().st_size > 0 and not refresh:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    dump_args = ["pg_dump", "--clean", "--if-exists", "--no-owner", "--no-privileges"]
    container = _local_victoria_db_container()
    if container:
        command = ["docker", "exec", container, *dump_args, "-U", "postgres", "-d", "victoria"]
    else:
        database_url = _local_victoria_database_url()
        if not database_url:
            raise RuntimeError(
                f"Cannot snapshot base image '{name}': local Victoria DB not found "
                f"(no victoria-db-$CONDUCTOR_WORKSPACE_NAME container and no "
                f"LOCAL_VICTORIA_DATABASE_URL). Run `bash scripts/setup-db.sh` first."
            )
        command = ["pg_dump", database_url, *dump_args[1:]]

    result = subprocess.run(command, capture_output=True, text=False, timeout=300)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Base image snapshot failed: {stderr}")
    path.write_bytes(result.stdout)
    print(f"    🧊 Base image snapshot written: {path}")
    return path
