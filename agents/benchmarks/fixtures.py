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

import hashlib
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

DEFAULT_BASE_IMAGE = "base:victoria-prod-sync-v1"

WHATSAPP_BASE_IMAGE = "base:victoria-whatsapp-v1"

BASE_IMAGES: dict[str, dict[str, str]] = {
    DEFAULT_BASE_IMAGE: {
        "description": (
            "Workspace Victoria DB synced from prod (users, people, messages, "
            "integrations, browser state, credentials)."
        ),
        "create": "bash scripts/setup-db.sh",
    },
    WHATSAPP_BASE_IMAGE: {
        "description": (
            "Prod-sync base plus a real WhatsApp history sync (MessageRecord rows "
            "with channel=WHATSAPP, their Person threads, and a CONNECTED whatsapp "
            "Integration). Produced by pairing the mac-app WhatsApp client, which "
            "uploads history through /api/integrations/whatsapp/upload. Kept as a "
            "SEPARATE image rather than folded into the prod-sync default so tasks "
            "that assume no WhatsApp data stay unaffected. The snapshot lives under "
            "the gitignored .context/ tree — it contains real personal messages and "
            "must never be committed."
        ),
        "create": "bash scripts/setup-db.sh && bash mac-app/scripts/whatsapp-live.sh",
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
    schema_path = REPO_ROOT / "back-end" / "prisma" / "schema.prisma"
    schema_hash = hashlib.sha1(schema_path.read_bytes()).hexdigest()
    hash_path = Path(f"{path}.schemahash")
    if (
        path.exists()
        and path.stat().st_size > 0
        and hash_path.exists()
        and hash_path.read_text().strip() == schema_hash
        and not refresh
    ):
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
    path_tmp = Path(f"{path}.tmp-{os.getpid()}")
    hash_tmp = Path(f"{hash_path}.tmp-{os.getpid()}")
    path_tmp.write_bytes(result.stdout)
    hash_tmp.write_text(schema_hash)
    os.replace(path_tmp, path)
    os.replace(hash_tmp, hash_path)
    print(f"    🧊 Base image snapshot written: {path}")
    return path
