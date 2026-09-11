"""Finalize an exclusively owned cloud batch while its backend stays available."""

from __future__ import annotations

import json
import os
import re
import runpy
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def contract() -> tuple[Path, str] | None:
    if os.environ.get("BENCHMARK_CLOUD_BATCH_CLEANUP") != "true":
        return None
    token = os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_TOKEN", "")
    status = Path(os.environ.get("BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE", ""))
    context = Path(os.environ.get("BENCHMARK_CONTEXT_DIR", "")).resolve()
    if (
        os.environ.get("BENCHMARK_ISOLATED_RUN") != "true"
        or not re.fullmatch(r"[A-Za-z0-9._-]+", token)
        or not status.is_absolute()
        or status.parent.resolve() != context
        or status.is_symlink()
    ):
        raise RuntimeError("invalid owned cloud cleanup contract")
    return status, token


def exact_root_sessions(base_url: str, root_id: str, *, require_deleted: bool = False) -> dict:
    """Read only the exact owned tree, including deleted rows, from its local DB."""
    if contract() is None:
        raise RuntimeError("provider verification requires an owned cloud stack")
    recovery = runpy.run_path(str(REPO_ROOT / "scripts/cloudbench-guest-recovery.py"))
    if recovery["SAFE_AGENT"].fullmatch(root_id) is None:
        raise RuntimeError("invalid exact root identity")
    manifest = json.loads((Path(os.environ["BENCHMARK_CONTEXT_DIR"]) / "services.json").read_text())
    database = manifest.get("database") or {}
    ports = manifest.get("ports") or {}
    name = database.get("name")
    port = database.get("port") or (5432 if database.get("use_system_postgres") else ports.get("local_db"))
    if (
        Path(manifest.get("worktree", "")).resolve() != REPO_ROOT
        or manifest.get("benchmark_mode") is not True
        or manifest.get("status") in {"failed", "stopped"}
        or base_url != f"http://localhost:{ports.get('backend')}"
        or manifest.get("temporal_task_queue") != os.environ.get("TEMPORAL_TASK_QUEUE")
        or not isinstance(name, str)
        or recovery["SAFE_DATABASE"].fullmatch(name) is None
        or not isinstance(port, int)
        or not 1 <= port <= 65535
    ):
        raise RuntimeError("provider verification database is not the owned local stack")
    payload = recovery["run_exact_psql"](
        shutil.which("psql") or "",
        database=name,
        port=port,
        sql=recovery["root_tree_query_sql"](root_id, include_sealing_state=True),
    )
    value = json.loads(payload)
    sessions = value.get("browser_sessions")
    tree = value.get("tree_agent_ids")
    if (
        value.get("root_exists") is not True
        or not isinstance(tree, list)
        or root_id not in tree
        or any(not isinstance(a, str) or recovery["SAFE_AGENT"].fullmatch(a) is None for a in tree)
        or not isinstance(sessions, list)
        or (require_deleted and (value.get("root_deleted") is not True or value.get("unsealed_tree_agent_ids") != []))
    ):
        raise RuntimeError("exact root database evidence is incomplete")
    for row in sessions:
        if (
            not isinstance(row, dict)
            or row.get("agent_id") not in tree
            or row.get("provider") not in {"kernel", "steel"}
            or not isinstance(row.get("session_id"), str)
            or re.fullmatch(r"[A-Za-z0-9_-]{8,128}", row["session_id"]) is None
        ):
            raise RuntimeError("exact tree has an unrecognized provider session")
    return value


def close_exact_root_sessions(base_url: str, root_id: str, before: dict) -> dict:
    """Canonical DELETE must seal the root before any fallback release is allowed."""
    after = exact_root_sessions(base_url, root_id, require_deleted=True)
    cleanup = runpy.run_path(str(REPO_ROOT / "scripts/cloudbench-exact-session-cleanup.py"))
    sessions = {(r["provider"], r["session_id"]) for r in before["browser_sessions"] + after["browser_sessions"]}
    receipts = []
    failures = []
    for provider, session_id in sorted(sessions):
        try:
            status, digest = cleanup["provider_request"](
                provider, session_id, (REPO_ROOT / "agents/.env", REPO_ROOT / "back-end/.env"),
            )
            receipts.append({"provider": provider, "session_id": session_id, "status": status, "response_sha256": digest})
        except Exception as error:
            failures.append(f"{provider}/{session_id}: {error}")
    try:
        final = exact_root_sessions(base_url, root_id, require_deleted=True)
        if final != after:
            failures.append("owned tree or provider sessions changed during terminal verification")
    except Exception as error:
        failures.append(f"terminal database verification failed: {error}")
    if failures:
        raise RuntimeError("; ".join(failures))
    return {"root_agent_id": root_id, "tree_sealed": True, "root_deleted": True, "provider_receipts": receipts}
