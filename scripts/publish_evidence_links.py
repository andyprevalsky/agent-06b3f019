#!/usr/bin/env python3
"""Publish durable FE + LLM-dump evidence for /RCA and approval requests.

Local ``scripts/run-bench --local`` stacks tear down after the run. Evidence
cited in approvals must outlive that stack:

  * FE  → ``https://www.roselabs.ai/?agent-id=…`` after the run
    bundle is on the always-on Benchmark Hub (dual-write or explicit upload)
    (``/open-agent?agent-id=…`` is an alias that redirects to the same URL).
    Verification fails closed unless every browser agent on that FE link has
    terminated (``task_complete``) with a correctly attached recording.
  * LLM dump → HTML under ``/opt/cursor/artifacts/rca_evidence/<agent_id>/`` (or
    ``RCA_EVIDENCE_ARTIFACTS_ROOT``; ``.context/rca_evidence`` without the Cursor mount)
    (Cursor uploads these for multi-day reachability in the agent UI)

Usage:

  python3 scripts/publish_evidence_links.py \\
    --run-json agents/benchmarks/runs/<run>.json \\
    --agent-id <uuid>

  python3 scripts/publish_evidence_links.py \\
    --agent-id <uuid> \\
    --dump .llm-dumps/<agent_id>/<last>.json

The CLI loads back-end/.env without replacing caller-provided variables. When
no local dump exists, it verifies and materializes the root's archived calls
before uploading the run. All generated artifacts stay under that agent's
evidence directory; no separate archive or renderer command is required.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS_VENV_PYTHON = REPO_ROOT / "agents" / "venv" / "bin" / "python"


def _ensure_agents_site_packages() -> None:
    """System python3 is the documented publisher entrypoint; markdown-it lives in agents/venv."""
    if any(Path(entry).name == "site-packages" and "agents/venv" in entry for entry in sys.path):
        return
    lib_root = AGENTS_VENV_PYTHON.parent.parent / "lib"
    for candidate in sorted(lib_root.glob("python*/site-packages")):
        sys.path.insert(0, str(candidate))
        return


def _load_cli_environment() -> None:
    """Use the canonical backend credentials while preserving explicit overrides."""
    _ensure_agents_site_packages()
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / "back-end" / ".env", override=False)


DEFAULT_HUB = "https://navi-j9a9.onrender.com"
DURABLE_ORIGIN = "https://www.roselabs.ai"
_CURSOR_ARTIFACTS = Path("/opt/cursor/artifacts")


def evidence_artifacts_root(env, *, cursor_mount_exists: bool) -> Path:
    """Explicit root, then Cursor's artifact mount, else private checkout storage."""
    if env.get("RCA_EVIDENCE_ARTIFACTS_ROOT"):
        return Path(env["RCA_EVIDENCE_ARTIFACTS_ROOT"])
    if env.get("CURSOR_ARTIFACTS_DIR"):
        return Path(env["CURSOR_ARTIFACTS_DIR"]) / "rca_evidence"
    if cursor_mount_exists:
        return _CURSOR_ARTIFACTS / "rca_evidence"
    return REPO_ROOT / ".context" / "rca_evidence"


ARTIFACTS_ROOT = evidence_artifacts_root(os.environ, cursor_mount_exists=_CURSOR_ARTIFACTS.is_dir())
_AGENT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _normalize_agent_id(raw: str) -> str:
    agent_id = raw.strip()
    if not _AGENT_ID_RE.fullmatch(agent_id):
        raise SystemExit(f"invalid agent_id (expected UUID): {raw!r}")
    return agent_id.lower()


class _LoopbackProxyHandler(urllib.request.ProxyHandler):
    def proxy_open(self, request, proxy, proxy_type):
        if urllib.parse.urlsplit(request.full_url).hostname in {"localhost", "127.0.0.1", "::1"}:
            return None
        return super().proxy_open(request, proxy, proxy_type)


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_LoopbackProxyHandler())


def _auth_headers() -> dict[str, str]:
    key = os.getenv("BENCHMARK_HUB_API_KEY") or os.getenv("BACKEND_API_KEY") or ""
    if not key:
        raise SystemExit(
            "BENCHMARK_HUB_API_KEY or BACKEND_API_KEY is required to verify durable FE links"
        )
    user = (
        os.getenv("BENCHMARK_HUB_USER_ID")
        or "1f85ff25-6e29-4c1b-8739-f917bd101a30"
    )
    return {
        "X-API-Key": key,
        "X-User-Id": user,
        "Content-Type": "application/json",
    }


def benchmark_share_token(run_id: str) -> str:
    key = os.getenv("BENCHMARK_SHARE_SECRET")
    if not key:
        raise SystemExit("BENCHMARK_SHARE_SECRET is required to sign benchmark share links")
    expiry = int(time.time()) + 30 * 24 * 60 * 60
    signature = hmac.new(
        key.encode(),
        f"benchmark-share:v1:{run_id.lower()}:{expiry}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{run_id.lower()}.{expiry}.{signature}"


def durable_fe_url(agent_id: str, run_id: str, token: str) -> str:
    query = urllib.parse.urlencode({"agent-id": agent_id})
    fragment = urllib.parse.urlencode({"benchmark-share": token})
    return f"{DURABLE_ORIGIN}/?{query}#{fragment}"


def evidence_bundle_for_agent(bundle: dict, agent_id: str) -> dict:
    """Expose one real root from a composite bench without changing its result.

    Composite benches retain their aggregate result under a comma-joined
    ``agent_id`` and keep each root's captured transcript in a named stage.
    The Hub cannot resolve either UUID from that aggregate task. Publish a
    separate, deterministic evidence run containing the original stage logs;
    never rewrite the aggregate benchmark run or invent transcript messages.
    """
    tasks = bundle.get("tasks") or []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        logs = task.get("logs") or {}
        if task.get("agent_id") == agent_id or (
            isinstance(logs, dict)
            and isinstance(logs.get("tree"), dict)
            and agent_id in logs["tree"]
        ):
            return bundle

    matches = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        joined = task.get("agent_id")
        if not isinstance(joined, str) or agent_id not in joined.split(","):
            continue
        logs = task.get("logs") or {}
        if not isinstance(logs, dict):
            continue
        for stage_name, stage_logs in logs.items():
            if not isinstance(stage_logs, dict):
                continue
            tree = stage_logs.get("tree")
            messages = stage_logs.get("messages")
            if isinstance(tree, dict) and agent_id in tree and isinstance(messages, list) and messages:
                matches.append((task, stage_name, stage_logs))
    if len(matches) != 1:
        raise SystemExit(
            f"expected exactly one captured stage transcript for {agent_id}; found {len(matches)}"
        )
    task, stage_name, stage_logs = matches[0]
    run_id = bundle.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise SystemExit("run bundle is missing run_id")
    projected_task = dict(task)
    projected_task.update(
        agent_id=agent_id,
        name=f"{task.get('name', 'composite')} [{stage_name} evidence]",
        logs=stage_logs,
        message_count=len(stage_logs["messages"]),
        tree_agent_count=len(stage_logs["tree"]),
        evidence_projection_of=task.get("name"),
    )
    return {
        **bundle,
        "run_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"rose-benchmark-evidence:{run_id}:{agent_id}")),
        "source": "durable-evidence-projection",
        "source_run_id": run_id,
        "tasks": [projected_task],
    }


def verified_zero_session_tasks(bundle: dict, agent_id: str) -> set[str]:
    """Bind pre-session cancellation to exact owned DB and cleanup receipts."""
    projected = evidence_bundle_for_agent(bundle, agent_id)
    matches = [
        task for task in projected.get("tasks", [])
        if task.get("agent_id") == agent_id
        or agent_id in ((task.get("logs") or {}).get("tree") or {})
    ]
    if len(matches) != 1:
        return set()
    logs = matches[0].get("logs") or {}
    receipt = logs.get("browser_zero_allocation_receipt")
    if receipt is None:
        return set()
    cleanup = logs.get("cloud_cleanup_evidence") or {}
    provider = logs.get("cloud_provider_cleanup") or {}
    ids = receipt.get("task_ids") if isinstance(receipt, dict) else None
    tree = receipt.get("tree_agent_ids") if isinstance(receipt, dict) else None
    task_map = receipt.get("task_ids_by_agent") if isinstance(receipt, dict) else None
    owner = receipt.get("root_agent_id") if isinstance(receipt, dict) else None
    valid = (
        isinstance(ids, list) and bool(ids)
        and all(isinstance(value, str) and value for value in ids)
        and len(ids) == len(set(ids))
        and isinstance(tree, list) and all(isinstance(value, str) for value in tree)
        and agent_id in tree
        and isinstance(task_map, dict)
        and set(task_map).issubset(set(tree))
        and all(isinstance(values, list) and all(isinstance(value, str) and value for value in values)
                for values in task_map.values())
        and sorted(value for values in task_map.values() for value in values) == sorted(ids)
        and isinstance(owner, str) and owner in tree
        and receipt.get("before_browser_sessions") == []
        and receipt.get("archive_browser_sessions") == []
        and cleanup.get("errors") == []
        and cleanup.get("provider_receipts") == []
        and provider.get("tree_sealed") is True
        and provider.get("root_deleted") is True
        and provider.get("provider_receipts") == []
    )
    for phase in ("before", "after", "final"):
        snapshot = cleanup.get(phase) if isinstance(cleanup, dict) else None
        valid = valid and (
            isinstance(snapshot, dict)
            and snapshot.get("root_exists") is True
            and isinstance(snapshot.get("tree_agent_ids"), list)
            and all(isinstance(value, str) for value in snapshot["tree_agent_ids"])
            and sorted(snapshot["tree_agent_ids"]) == sorted(tree)
            and snapshot.get("browser_sessions") == []
        )
    if not valid:
        raise SystemExit("invalid exact zero-browser-allocation ownership receipt")
    return set(task_map.get(agent_id, []))


def upload_run_json(run_json: Path, agent_id: str, *, forensic_archive_receipt: Path | None = None) -> str:
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.hub_upload import upload_run_bundle

    original = json.loads(run_json.read_text(encoding="utf-8"))
    if forensic_archive_receipt is not None:
        from benchmarks.archived_diagnostics import project_verified_diagnostics
        original = project_verified_diagnostics(original, run_json, forensic_archive_receipt)
    bundle = evidence_bundle_for_agent(original, agent_id)
    os.environ.setdefault("BENCHMARK_HUB_UPLOAD_URL", DEFAULT_HUB)
    if not (os.getenv("BENCHMARK_HUB_API_KEY") or os.getenv("BACKEND_API_KEY")):
        raise SystemExit(
            "BENCHMARK_HUB_API_KEY or BACKEND_API_KEY is required to upload to the durable Hub"
        )
    ok = upload_run_bundle(bundle, required=True)
    if not ok:
        raise SystemExit(f"hub upload failed for {run_json}")
    return str(bundle.get("run_id") or "")


def dual_write_claude_code_sessions(run_json: Path, agent_id: str) -> None:
    """Mirror Claude Code transcripts into prod so durable FE terminals render."""
    script = REPO_ROOT / "scripts" / "dual_write_claude_code_sessions.py"
    if not script.is_file():
        print(f"⚠ skip session dual-write — missing {script}")
        return
    cmd = [
        sys.executable,
        str(script),
        "--run-json",
        str(run_json),
        "--agent-id",
        agent_id,
    ]
    print(f"Dual-writing Claude Code sessions for {agent_id}…")
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT))

def _message_metadata(message: dict) -> dict:
    meta = message.get("metadata")
    if isinstance(meta, dict):
        return meta
    if isinstance(meta, str) and meta.strip():
        try:
            parsed = json.loads(meta)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _probe_recording_view_url(url: str, *, timeout: float = 20.0) -> bool:
    request = urllib.request.Request(url, method="GET")
    try:
        with _opener().open(request, timeout=timeout) as response:
            return int(response.status) < 400
    except (OSError, ValueError, http.client.HTTPException):
        return False


def _probe_recording_file_pointer(
    agent_id: str, pointer: dict, *, timeout: float = 30.0
) -> bool:
    file_id = pointer.get("id")
    storage_path = pointer.get("storage_path")
    if not isinstance(file_id, str) or not file_id:
        return False
    if not isinstance(storage_path, str) or not storage_path:
        return False
    quoted = urllib.parse.quote(storage_path, safe="")
    url = (
        f"{DEFAULT_HUB}/api/agents/{agent_id}/attachments/{file_id}"
        f"/url?storage_path={quoted}"
    )
    request = urllib.request.Request(url, headers=_auth_headers(), method="GET")
    try:
        with _opener().open(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
    except (OSError, ValueError, http.client.HTTPException):
        return False
    if not isinstance(payload, dict):
        return False
    signed = payload.get("signed_url") or payload.get("signedUrl") or payload.get("url")
    if not isinstance(signed, str) or not signed:
        return False
    return _probe_recording_view_url(signed, timeout=timeout)


def _recording_sources(meta: dict) -> list[tuple[str, object]]:
    """What the FE chip plays for one saved recording message (same precedence)."""
    pointer = meta.get("recording_file_pointer")
    if isinstance(pointer, dict) and str(pointer.get("mime_type") or "").startswith("video/"):
        return [("pointer", pointer)]
    view_urls = meta.get("recording_view_urls")
    if isinstance(view_urls, list):
        clean = [url.strip() for url in view_urls if isinstance(url, str) and url.strip()]
        if clean:
            return [("view", url) for url in clean]
    view_url = meta.get("recording_view_url")
    if isinstance(view_url, str) and view_url.strip():
        return [("view", view_url.strip())]
    if isinstance(pointer, dict):
        return [("pointer", pointer)]
    return []


def verified_preparation_cancelled_tasks(bundle: dict, agent_id: str) -> set[str]:
    """Bind positive pre-action phase evidence to terminal exact-provider cleanup."""
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.browser_zero_allocation import (
        preparation_cancelled_task_receipts,
        preparation_receipts_match_sessions,
    )
    projected = evidence_bundle_for_agent(bundle, agent_id)
    matches = []
    for task in projected.get("tasks", []):
        if not isinstance(task, dict):
            continue
        task_logs = task.get("logs")
        task_tree = task_logs.get("tree") if isinstance(task_logs, dict) else None
        if task.get("agent_id") == agent_id or (
            isinstance(task_tree, dict) and agent_id in task_tree
        ):
            matches.append(task)
    if len(matches) != 1:
        return set()
    invalid_receipt = "invalid exact pre-action browser cancellation receipt"
    logs = matches[0].get("logs")
    if logs is None:
        return set()
    if not isinstance(logs, dict):
        raise SystemExit(invalid_receipt)
    capture = logs.get("browser_preparation_cancellation_receipt")
    if capture is None:
        return set()
    cleanup = logs.get("cloud_cleanup_evidence", {})
    provider = logs.get("cloud_provider_cleanup", {})
    tree = logs.get("tree", {})
    if not all(isinstance(value, dict) for value in (cleanup, provider, tree)):
        raise SystemExit(invalid_receipt)
    if agent_id in tree:
        node = tree[agent_id]
        if not isinstance(node, dict):
            raise SystemExit(invalid_receipt)
        transcript = node.get("messages")
    else:
        transcript = logs.get("messages")
    if not isinstance(transcript, list):
        raise SystemExit(invalid_receipt)
    expected = preparation_cancelled_task_receipts(transcript, agent_id)
    receipts = capture.get("receipts") if isinstance(capture, dict) else None
    task_map = capture.get("task_ids_by_agent") if isinstance(capture, dict) else None
    ids = task_map.get(agent_id) if isinstance(task_map, dict) else None
    tree_ids = capture.get("tree_agent_ids") if isinstance(capture, dict) else None
    valid = (
        isinstance(receipts, dict) and bool(expected) and isinstance(ids, list)
        and all(isinstance(value, str) and value for value in ids)
        and set(ids) == set(expected) and len(ids) == len(set(ids))
        and all(receipts.get(task_id) == receipt for task_id, receipt in expected.items())
        and isinstance(tree_ids, list) and all(isinstance(value, str) for value in tree_ids)
        and agent_id in tree_ids and isinstance(capture.get("root_agent_id"), str)
        and capture.get("root_agent_id") in tree_ids
        and cleanup.get("errors") == []
        and provider.get("tree_sealed") is True and provider.get("root_deleted") is True
        and provider.get("root_agent_id") == capture.get("root_agent_id")
        and preparation_receipts_match_sessions(
            expected, {"browser_sessions": capture.get("archive_browser_sessions")}
        )
    )
    for phase in ("after", "final"):
        snapshot = cleanup.get(phase, {})
        if not isinstance(snapshot, dict):
            raise SystemExit(invalid_receipt)
        snapshot_ids = snapshot.get("tree_agent_ids", [])
        if not isinstance(snapshot_ids, list) or not all(
            isinstance(value, str) for value in snapshot_ids
        ):
            raise SystemExit(invalid_receipt)
        valid = valid and snapshot.get("root_exists") is True and snapshot.get("root_deleted") is True and (
            sorted(snapshot_ids) == sorted(tree_ids or [])
            and preparation_receipts_match_sessions(expected, snapshot)
        )
    native = provider.get("provider_receipts", [])
    if not isinstance(native, list):
        raise SystemExit(invalid_receipt)
    closed_handles = {
        (row["provider"], row["session_id"])
        for row in native
        if isinstance(row, dict)
        and isinstance(row.get("provider"), str) and isinstance(row.get("session_id"), str)
        and type(row.get("status")) is int
        and row.get("status") in {200, 201, 204, 404}
    }
    for receipt in expected.values():
        valid = valid and (receipt["provider"], receipt["session_id"]) in closed_handles
    if not valid:
        raise SystemExit(invalid_receipt)
    return set(expected)


def _recording_episode_identity(meta: dict) -> tuple | None:
    """Bind media to a task generation and an immutable provider session handle."""
    task, generation = meta.get("task_id"), meta.get("workflowGeneration")
    native = meta.get("browser_session_metadata")
    native = native if isinstance(native, dict) else {}
    provider = native.get("provider") or meta.get("provider")
    if any(value is not None and value != provider
           for value in (native.get("provider"), meta.get("provider"))):
        return None
    if not all(isinstance(value, str) and value for value in (task, generation, provider)):
        return None
    if provider not in {"tilion", "kernel", "steel", "browser-use"}:
        return None
    session = next((native.get(key) or meta.get(key) for key in
                    ("session_id", "browser_session_id", "kernel_session_id")
                    if native.get(key) or meta.get(key)), None)
    if provider == "tilion":
        if str(REPO_ROOT / "agents") not in sys.path:
            sys.path.insert(0, str(REPO_ROOT / "agents"))
        from domains.spawn_browser_agent_v3.cdp_urls import tilion_live_view_session_id

        # One native identity across explicit handles and persisted live views.
        # The local recording path is reused on resume and cannot identify it.
        handles = [source[key] for source in (native, meta)
                   for key in ("session_id", "browser_session_id", "kernel_session_id")
                   if key in source and source[key] is not None]
        if any(not isinstance(handle, str) or not handle or handle != session for handle in handles):
            return None
        url = meta.get("browser_url")
        if url is not None and url != "":
            url_session = tilion_live_view_session_id(url)
            if url_session is None or (session and session != url_session):
                return None
            session = url_session
    if isinstance(session, str) and session:
        return task, generation, provider, "session", session
    # Kernel's native live URL identifies the browser; a visited page or profile
    # does not. Other providers need an explicit session ID before deduplication.
    url = meta.get("browser_url")
    if provider != "kernel" or not isinstance(url, str):
        return None
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not (parsed.hostname or "").endswith(".kernel.sh")
            or not re.fullmatch(r"/browser/live/[A-Za-z0-9_-]+", parsed.path)):
        return None
    return task, generation, provider, "kernel-live", parsed.hostname, parsed.path


def _terminal_matches_recording_episode(meta: dict, identity: tuple) -> bool:
    """A task-only completion may close its current episode, never a foreign handle."""
    native = meta.get("browser_session_metadata")
    native = native if isinstance(native, dict) else {}
    declared_providers = (native.get("provider"), meta.get("provider"))
    if any(provider is not None and provider != identity[2] for provider in declared_providers):
        return False
    provider = native.get("provider") or meta.get("provider")
    handles = ("session_id", "browser_session_id", "kernel_session_id")
    url = meta.get("browser_url")
    if ((url is not None and url != "")
            or any(source.get(key) is not None for source in (native, meta) for key in handles)):
        return _recording_episode_identity({**meta, "provider": provider or identity[2]}) == identity
    return True


def _recorded_episode_diagnostics(messages: list) -> tuple[set[int], set[str]]:
    """Exclude only finalizer diagnostics for independently saved recording episodes.

    A deployment seal copies an IN_PROGRESS recording tool call. Its FINISHED
    error row is not a new saved part when the exact start already has media.
    Preserve every row and fail closed for an unrecorded or unknown episode.
    """
    rows = [(index, _message_metadata(row)) for index, row in enumerate(messages)
            if isinstance(row, dict)]
    starts = [(index, meta, _recording_episode_identity(meta)) for index, meta in rows
              if meta.get("action_type") == "recording" and meta.get("toolStatus") == "IN_PROGRESS"]
    covered, missing = set(), set()
    known_tasks = {identity[0] for _, _, identity in starts if identity is not None}
    for index, start, identity in starts:
        if identity is None:
            if start.get("task_id") in known_tasks:
                missing.add(start["task_id"])
            continue
        boundary = next((i for i, _, key in starts if i > index and key == identity), len(messages))
        saved = [(i, meta) for i, meta in rows if index < i < boundary
                 and meta.get("action_type") == "recording"
                 and meta.get("toolStatus") == "FINISHED" and not meta.get("error")
                 and _recording_episode_identity(meta) == identity and _recording_sources(meta)]
        terminal = any(i > index and meta.get("action_type") == "task_complete"
                       and meta.get("task_id") == identity[0]
                       and meta.get("workflowGeneration") == identity[1]
                       and meta.get("toolStatus") in {"FINISHED", "ERROR"}
                       and _terminal_matches_recording_episode(meta, identity)
                       for i, meta in rows)
        logical_terminal = any(i > index and meta.get("action_type") == "task_complete"
                               and meta.get("task_id") == identity[0]
                               and meta.get("workflowGeneration") == identity[1]
                               and meta.get("toolStatus") in {"FINISHED", "ERROR"}
                               for i, meta in rows)
        if not saved or not logical_terminal:
            missing.add(identity[0])
            continue
        # A pause/resume episode may save media without ending the logical task.
        # Its later task terminal is checked by the caller. Only suppress a
        # fenced diagnostic when this exact episode also has its own terminal.
        if not terminal:
            continue
        for i, meta in rows:
            if (i > saved[-1][0] and meta.get("action_type") == "recording"
                    and meta.get("toolStatus") == "FINISHED" and meta.get("error") is True
                    and meta.get("deploymentFenced") is True and meta.get("errorCode") == "DEPLOY_INTERRUPTED"
                    and _recording_episode_identity(meta) == identity
                    and isinstance(start.get("toolCallId"), str) and start["toolCallId"]
                    and meta.get("toolCallId") == start["toolCallId"]
                    and isinstance(start.get("recording_path"), str) and start["recording_path"]
                    and meta.get("recording_path") == start["recording_path"]
                    and not _recording_sources(meta)):
                covered.add(i)
    return covered, missing


def validate_browser_agents_terminated_with_recording(
    agent_id: str, messages: list, *, zero_session_task_ids: set[str] | None = None,
    preparation_cancelled_task_ids: set[str] | None = None,
) -> list[str]:
    """Return failure reasons when any browser task is still live or missing recording.

    A browser task is any ``task_id`` that emitted ``spawn_browser_agent`` progress
    (``action_type`` in browser/session/recording). Each such task must have:
      * ``action_type=task_complete`` (terminated for FE panels)
      * a FINISHED recording message with a reachable ``recording_view_url`` or a
        fetchable ``recording_file_pointer``
    Exact owned receipts permit cancellation before session allocation or task
    actions. A preparation receipt also requires terminal exact-provider closure;
    started and unknown-phase tasks require their existing recording.
    Agents with no browser tasks pass.
    Code agents share lifecycle action names with browsers. Explicit code
    identity exempts those tasks unless the same task also has browser evidence;
    lifecycle events with unknown identity retain the fail-closed checks.
    """
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.browser_zero_allocation import (
        cancelled_before_session_task_ids,
        preparation_cancelled_task_receipts,
    )

    verified_zero = (zero_session_task_ids or set()) & cancelled_before_session_task_ids(messages)
    verified_preparation = (preparation_cancelled_task_ids or set()) & set(
        preparation_cancelled_task_receipts(messages, agent_id)
    )
    tasks: dict[str, dict[str, bool]] = {}
    recording_candidates: dict[str, list[dict]] = {}
    covered_diagnostics, unrecorded_tasks = _recorded_episode_diagnostics(messages)
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue
        meta = _message_metadata(message)
        task_id = meta.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        action = str(meta.get("action_type") or "")
        tool_name = str(meta.get("toolName") or "")
        code_related = tool_name == "spawn_claude_code_agent" or meta.get("agentType") == "code"
        explicit_browser = tool_name == "spawn_browser_agent" or meta.get("agentType") == "browser" or action in {
            "browser", "recording", "network_recording",
        }
        browser_related = explicit_browser or (not tool_name and action in {
            "browser",
            "session_init",
            "session_started",
            "task_started",
            "recording",
            "network_recording",
            "task_complete",
        })
        if not browser_related and not code_related:
            continue
        state = tasks.setdefault(
            task_id, {
                "seen": False, "complete": False, "recording_ok": False,
                "code": False, "browser": False,
            }
        )
        state["code"] = state["code"] or code_related
        state["browser"] = state["browser"] or explicit_browser
        if explicit_browser or action in {
            "browser",
            "session_init",
            "session_started",
            "task_started",
            "recording",
            "network_recording",
        }:
            state["seen"] = True
        if action == "task_complete":
            state["complete"] = True
            state["seen"] = True
        if (action == "recording" and str(meta.get("toolStatus") or "") == "FINISHED"
                and index not in covered_diagnostics):
            recording_candidates.setdefault(task_id, []).append(meta)

    failures: list[str] = []
    for task_id, state in sorted(tasks.items()):
        if not state["seen"] or (state["code"] and not state["browser"]):
            continue
        if not state["complete"]:
            failures.append(
                f"browser task {task_id} has not terminated (missing action_type=task_complete)"
            )
        # A pause/resume splits one task into several saved recordings and the
        # chip plays every part, so every attached part must be playable.
        # A saved part without a source (its upload failed) is a missing part.
        parts = [_recording_sources(meta) for meta in recording_candidates.get(task_id, [])]
        sources = [source for part in parts for source in part]
        recording_ok = task_id not in unrecorded_tasks and bool(parts) and all(parts) and all(
            _probe_recording_view_url(value)
            if kind == "view"
            else _probe_recording_file_pointer(agent_id, value)
            for kind, value in sources
        )
        if not recording_ok and task_id not in verified_zero and task_id not in verified_preparation:
            failures.append(
                f"browser task {task_id} has no correctly attached recording "
                "(need reachable recording_view_url or fetchable recording_file_pointer)"
            )
        else:
            state["recording_ok"] = True
    return failures


def visible_transcript_snippets(messages: list[dict]) -> dict[str, list[str]]:
    """Extract short, rendered phrases from each visible transcript role."""
    markdown = None
    snippets: dict[str, list[str]] = {"user": [], "assistant": []}
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = str(message.get("text") or "")
        metadata = _message_metadata(message)
        if role not in ("USER", "ASSISTANT") or metadata.get("hidden"):
            continue
        # Match MessageList's root scope: nested browser reasoning is rendered
        # inside its browser panel, not in the root transcript being checked.
        # Explore progress and Claude Code lifecycle anchors remain root-visible.
        if (
            metadata.get("subAgentId") is not None
            and metadata.get("agentType") != "explore"
            and not (
                metadata.get("toolName") == "spawn_claude_code_agent"
                and metadata.get("action_type")
                in {"claude_code_started", "task_complete", "session_cancelled"}
            )
        ):
            continue
        if role == "USER" or message.get("file_pointer"):
            # UserBubble and AssistantAttachmentBubble render literal text.
            lines = content.splitlines()
        else:
            # Use the existing agents dependency rather than approximating
            # CommonMark: adjacent emphasis delimiters may remain literal text.
            if markdown is None:
                _ensure_agents_site_packages()
                from markdown_it import MarkdownIt

                markdown = MarkdownIt("commonmark", {"html": False}).enable(
                    ["strikethrough", "table"]
                )
            # Match the FE's normalizeMarkdownText before parsing. Keep block
            # and line boundaries; image alt/link destinations are not innerText.
            content = re.sub(
                r"\\([nt*_`#\[\]()])",
                lambda match: {"n": "\n", "t": "\t"}.get(match[1], match[1]),
                content,
            )
            lines: list[str] = []
            for token in markdown.parse(content):
                if token.type == "inline":
                    rendered = "".join(
                        child.content
                        if child.type in {"text", "code_inline"}
                        else "\n" if child.type in {"softbreak", "hardbreak"} else ""
                        for child in token.children or []
                    )
                    lines.extend(rendered.splitlines())
                elif token.type in {"fence", "code_block"}:
                    lines.extend(token.content.splitlines())
        for line in lines:
            visible_line = line.strip()
            if len(visible_line) >= 12:
                snippets[str(role).lower()].append(visible_line[:60])
                break
    return {role: values[:8] for role, values in snippets.items()}


def verify_agent_reachable(
    agent_id: str, token: str, *, timeout: float = 60.0,
    zero_session_task_ids: set[str] | None = None,
    preparation_cancelled_task_ids: set[str] | None = None,
) -> tuple[str, int]:
    """Probe archive-backed agent detail; return (status_label, message_count).

    Fails closed when any browser agent on the FE link is still live or missing
    a correctly attached recording.
    """
    url = f"{DEFAULT_HUB}/api/benchmarks/shared-agent/{agent_id}"
    request = urllib.request.Request(
        url, headers={"Authorization": f"BenchmarkShare {token}"}, method="GET"
    )
    try:
        for attempt in range(2):
            try:
                with _opener().open(request, timeout=timeout) as response:
                    payload = json.loads(response.read() or b"{}")
                break
            except TimeoutError:
                # This read-only request can safely start a fresh connection.
                # Preserve the per-attempt timeout and the caller's outer bound;
                # HTTP/auth, malformed JSON, and evidence failures never retry.
                if attempt:
                    raise
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"agent API HTTP {exc.code}: {body[:300]}") from exc
    except Exception as exc:
        raise SystemExit(f"agent API unreachable: {exc}") from exc
    messages = payload.get("messages") if isinstance(payload, dict) else None
    count = len(messages) if isinstance(messages, list) else 0
    if count <= 0:
        raise SystemExit(
            f"agent {agent_id} returned no messages — Hub archive not readable yet"
        )
    browser_failures = validate_browser_agents_terminated_with_recording(
        agent_id, messages, zero_session_task_ids=zero_session_task_ids,
        preparation_cancelled_task_ids=preparation_cancelled_task_ids,
    )
    if browser_failures:
        raise SystemExit(
            "FE link browser validation failed:\n- " + "\n- ".join(browser_failures)
        )
    run_id = token.split('.', 1)[0]
    fe = durable_fe_url(agent_id, run_id, token)
    fe_req = urllib.request.Request(fe, method="GET")
    try:
        with _opener().open(fe_req, timeout=20) as fe_resp:
            if int(fe_resp.status) >= 400:
                raise SystemExit(f"FE page returned HTTP {fe_resp.status}")
    except Exception as exc:
        raise SystemExit(f"FE page unreachable: {exc}") from exc
    snippets = visible_transcript_snippets(messages)
    if not snippets["user"]:
        raise SystemExit("FE browser verification has no visible transcript snippets")
    browser = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "verify_benchmark_share_link.cjs")],
        input=json.dumps({"url": fe, "agentId": agent_id, "snippets": snippets}),
        text=True,
        capture_output=True,
        check=False,
        timeout=90,
        cwd=str(REPO_ROOT),
    )
    if browser.returncode != 0:
        raise SystemExit(f"FE browser verification failed: {browser.stderr.strip()[:500]}")
    return "verified in fresh browser", count


def latest_dump_for_agent(agent_id: str, *, bundle: dict | None = None) -> Path:
    # Canonical logs.tree maps IDs to nodes; follow parent edges rather than
    # scanning unrelated dump directories or assuming a children array.
    owned = {agent_id}
    if bundle is not None:
        scoped = evidence_bundle_for_agent(bundle, agent_id)
        for task in scoped.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            logs = task.get("logs") or {}
            tree = logs.get("tree") if isinstance(logs, dict) else None
            if not isinstance(tree, dict) or agent_id not in tree:
                continue
            changed = True
            while changed:
                changed = False
                for child, node in tree.items():
                    if (isinstance(child, str) and _AGENT_ID_RE.fullmatch(child)
                            and isinstance(node, dict)
                            and node.get("parent_agent_id") in owned and child not in owned):
                        owned.add(child)
                        changed = True
    dumps = [path for owner in owned
             for path in (REPO_ROOT / ".llm-dumps" / owner).glob("*.json")]
    if dumps:
        return max(dumps, key=lambda path: (path.name, str(path)))

    # Production workers archive their calls instead of writing to this host.
    # Keep each recovery attempt, including partial failures, in its own directory.
    parent = ARTIFACTS_ROOT / agent_id
    parent.mkdir(parents=True, exist_ok=True)
    output_dir = Path(tempfile.mkdtemp(prefix="archive-", dir=parent)).resolve()
    result = subprocess.run(
        ["node", "--import", "tsx",
         str(REPO_ROOT / "back-end" / "scripts" / "fetch-agent-llm-dumps.ts"),
         agent_id, "--output-dir", str(output_dir), "--json"],
        cwd=str(REPO_ROOT / "back-end"), capture_output=True, text=True, check=False,
    )
    sys.stderr.write(result.stderr)
    if result.returncode:
        raise SystemExit(f"Archived LLM dump recovery failed for {agent_id}; see diagnostics above")
    try:
        recovered = json.loads(result.stdout)
        dump = Path(recovered["latest"]["path"]).resolve()
        if recovered["rootAgentId"] != agent_id or not dump.is_relative_to(output_dir):
            raise ValueError("archive recovery returned a foreign root or path")
        if hashlib.sha256(dump.read_bytes()).hexdigest() != recovered["latest"]["sha256"]:
            raise ValueError("archive recovery dump hash mismatch")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"Invalid archived LLM dump recovery: {exc}") from exc
    return dump


def publish_llm_dump(dump: Path, agent_id: str) -> tuple[Path, str]:
    """Render the dump; return the local HTML and the HTTPS URL ("" when not uploaded)."""
    out_dir = ARTIFACTS_ROOT / agent_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_html = out_dir / "last_llm_call.html"
    # Render separately, then publish the self-contained copy into this agent's
    # owned directory. The renderer's default shared root is not ours to write.
    render_html = out_dir / "rendered" / "last_llm_call.html"
    # The R2 HTTPS upload needs boto3, which lives in agents/venv rather than
    # the system python3 this script is documented to run under.
    python = AGENTS_VENV_PYTHON if AGENTS_VENV_PYTHON.is_file() else Path(sys.executable)
    cmd = [
        str(python),
        str(REPO_ROOT / "scripts" / "render_llm_dump.py"),
        str(dump),
        "-o",
        str(out_html),
        # Keep the renderer's published copy in this agent's directory too.
        # Its default artifact root shares the last_llm_call.html basename
        # across runs, which can overwrite another agent's file or fail on it.
        "--artifacts-dir",
        str(out_dir),
        "--no-open",
    ]
    try:
        result = subprocess.run(cmd, check=True, cwd=str(REPO_ROOT), capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        sys.stdout.write(exc.stdout or "")
        sys.stderr.write(exc.stderr or "")
        raise
    sys.stderr.write(result.stderr)
    https_url = next(
        (line.strip() for line in result.stdout.splitlines() if line.startswith("https://")),
        "",
    )
    # Copy source JSON alongside for greppability.
    shutil.copy2(dump, out_dir / dump.name)
    return out_html, https_url


def write_manifest(
    *,
    agent_id: str,
    run_id: str,
    token: str,
    fe_status: str,
    message_count: int,
    dump_html: Path,
    dump_https_url: str,
    source_dump: Path,
) -> Path:
    out_dir = ARTIFACTS_ROOT / agent_id
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "agent_id": agent_id,
        "run_id": run_id,
        "fe_url": durable_fe_url(agent_id, run_id, token),
        "fe_verified": fe_status,
        "message_count": message_count,
        "llm_dump_artifact": str(dump_html),
        "llm_dump_https_url": dump_https_url,
        "source_dump": str(source_dump),
        "call_site": source_dump.stem,
    }
    path = out_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--run-json", type=Path, help="Upload this run bundle to the durable Hub")
    parser.add_argument("--forensic-archive-receipt", type=Path,
                        help="Authenticate all forensic originals before projecting duplicated native diagnostics")
    parser.add_argument("--run-id", help="Existing Hub run ID when --run-json is unavailable")
    parser.add_argument("--dump", type=Path, help="Specific LLM dump JSON (default: latest)")
    parser.add_argument("--skip-hub-upload", action="store_true")
    parser.add_argument("--skip-fe-verify", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _load_cli_environment()
    agent_id = _normalize_agent_id(args.agent_id)
    # Resolve the evidence before uploading, so recovery failures cannot leave
    # a successful Hub upload followed by an unexplained local-dump failure.
    bundle = (
        json.loads(args.run_json.resolve().read_text(encoding="utf-8"))
        if args.run_json else None
    )
    dump = (args.dump or latest_dump_for_agent(agent_id, bundle=bundle)).resolve()
    if not dump.is_file():
        raise SystemExit(f"LLM dump does not exist: {dump}")
    run_id = args.run_id or ""
    zero_session_task_ids: set[str] = set()
    preparation_cancelled_task_ids: set[str] = set()
    if args.run_json:
        run_path = args.run_json.resolve()
        assert bundle is not None
        zero_session_task_ids = verified_zero_session_tasks(bundle, agent_id)
        preparation_cancelled_task_ids = verified_preparation_cancelled_tasks(bundle, agent_id)
        if args.skip_hub_upload:
            run_id = str(evidence_bundle_for_agent(bundle, agent_id).get("run_id") or "")
        else:
            run_id = upload_run_json(run_path, agent_id, forensic_archive_receipt=args.forensic_archive_receipt)
            dual_write_claude_code_sessions(run_path, agent_id)
    if not _AGENT_ID_RE.fullmatch(run_id):
        raise SystemExit("a UUID run_id from --run-json or --run-id is required for a share link")
    token = benchmark_share_token(run_id)
    dump_html, dump_https_url = publish_llm_dump(dump, agent_id)
    if args.skip_fe_verify:
        fe_status, message_count = "skipped", 0
    else:
        fe_status, message_count = verify_agent_reachable(
            agent_id, token, zero_session_task_ids=zero_session_task_ids,
            preparation_cancelled_task_ids=preparation_cancelled_task_ids,
        )
    manifest = write_manifest(
        agent_id=agent_id,
        run_id=run_id,
        token=token,
        fe_status=fe_status,
        message_count=message_count,
        dump_html=dump_html,
        dump_https_url=dump_https_url,
        source_dump=dump,
    )
    print(f"FE link: {durable_fe_url(agent_id, run_id, token)} — {fe_status} ({message_count} msgs)")
    print(f"LLM dump: {dump_https_url or f'{dump_html} (local only — not reviewable remotely)'}")
    print(f"manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
