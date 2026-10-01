#!/usr/bin/env python3
"""Publish durable FE + LLM-dump evidence for /RCA and approval requests.

Local ``scripts/run-bench --local`` stacks tear down after the run. Evidence
cited in approvals must outlive that stack:

  * FE  → ``https://www.roselabs.ai/?agent-id=…`` after the run
    bundle is on the always-on Benchmark Hub (dual-write or explicit upload)
    (``/open-agent?agent-id=…`` is an alias that redirects to the same URL).
    Verification fails closed unless every browser agent on that FE link has
    terminated (``task_complete``) with a correctly attached recording.
  * LLM dump → HTML under ``/opt/cursor/artifacts/rca_evidence/<agent_id>/``
    (Cursor uploads these for multi-day reachability in the agent UI)

Usage:

  python3 scripts/publish_evidence_links.py \\
    --run-json agents/benchmarks/runs/<run>.json \\
    --agent-id <uuid>

  python3 scripts/publish_evidence_links.py \\
    --agent-id <uuid> \\
    --dump .llm-dumps/<agent_id>/<last>.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HUB = "https://navi-j9a9.onrender.com"
DURABLE_ORIGIN = "https://www.roselabs.ai"
ARTIFACTS_ROOT = Path(
    os.getenv("RCA_EVIDENCE_ARTIFACTS_ROOT", "/opt/cursor/artifacts/rca_evidence")
)
_AGENT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _normalize_agent_id(raw: str) -> str:
    agent_id = raw.strip()
    if not _AGENT_ID_RE.fullmatch(agent_id):
        raise SystemExit(f"invalid agent_id (expected UUID): {raw!r}")
    return agent_id.lower()


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


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


def durable_fe_url(agent_id: str) -> str:
    return f"{DURABLE_ORIGIN}/?agent-id={agent_id}"


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
        "run_id": f"{run_id}.evidence.{agent_id}",
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


def upload_run_json(run_json: Path, agent_id: str) -> str:
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.hub_upload import upload_run_bundle  # type: ignore

    bundle = evidence_bundle_for_agent(
        json.loads(run_json.read_text(encoding="utf-8")), agent_id
    )
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
    except Exception:
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
    except Exception:
        return False
    signed = payload.get("signed_url") or payload.get("signedUrl") or payload.get("url")
    if not isinstance(signed, str) or not signed:
        return False
    return _probe_recording_view_url(signed, timeout=timeout)


def validate_browser_agents_terminated_with_recording(
    agent_id: str, messages: list, *, zero_session_task_ids: set[str] | None = None,
) -> list[str]:
    """Return failure reasons when any browser task is still live or missing recording.

    A browser task is any ``task_id`` that emitted ``spawn_browser_agent`` progress
    (``action_type`` in browser/session/recording). Each such task must have:
      * ``action_type=task_complete`` (terminated for FE panels)
      * a FINISHED recording message with a reachable ``recording_view_url`` or a
        fetchable ``recording_file_pointer``
    An exact owned zero-session receipt permits a task cancelled before its
    session was allocated; an allocated browser still requires a recording.
    Agents with no browser tasks pass.
    Code agents share lifecycle action names with browsers. Explicit code
    identity exempts those tasks unless the same task also has browser evidence;
    lifecycle events with unknown identity retain the fail-closed checks.
    """
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.browser_zero_allocation import cancelled_before_session_task_ids

    verified_zero = (zero_session_task_ids or set()) & cancelled_before_session_task_ids(messages)
    tasks: dict[str, dict[str, bool]] = {}
    recording_candidates: dict[str, list[dict]] = {}
    for message in messages:
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
        browser_related = explicit_browser or action in {
            "browser",
            "session_init",
            "session_started",
            "task_started",
            "recording",
            "network_recording",
            "task_complete",
        }
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
        if action == "recording" and str(meta.get("toolStatus") or "") == "FINISHED":
            recording_candidates.setdefault(task_id, []).append(meta)

    failures: list[str] = []
    for task_id, state in sorted(tasks.items()):
        if not state["seen"] or (state["code"] and not state["browser"]):
            continue
        if not state["complete"]:
            failures.append(
                f"browser task {task_id} has not terminated (missing action_type=task_complete)"
            )
        recording_ok = False
        for meta in recording_candidates.get(task_id, []):
            view_url = meta.get("recording_view_url")
            if isinstance(view_url, str) and view_url.strip():
                if _probe_recording_view_url(view_url.strip()):
                    recording_ok = True
                    break
            pointer = meta.get("recording_file_pointer")
            if isinstance(pointer, dict) and _probe_recording_file_pointer(
                agent_id, pointer
            ):
                recording_ok = True
                break
        if not recording_ok and task_id not in verified_zero:
            failures.append(
                f"browser task {task_id} has no correctly attached recording "
                "(need reachable recording_view_url or fetchable recording_file_pointer)"
            )
        else:
            state["recording_ok"] = True
    return failures


def verify_agent_reachable(
    agent_id: str, *, timeout: float = 60.0, zero_session_task_ids: set[str] | None = None,
) -> tuple[str, int]:
    """Probe archive-backed agent detail; return (status_label, message_count).

    Fails closed when any browser agent on the FE link is still live or missing
    a correctly attached recording.
    """
    url = f"{DEFAULT_HUB}/api/agents/{agent_id}"
    request = urllib.request.Request(url, headers=_auth_headers(), method="GET")
    try:
        with _opener().open(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
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
    )
    if browser_failures:
        raise SystemExit(
            "FE link browser validation failed:\n- " + "\n- ".join(browser_failures)
        )
    fe = durable_fe_url(agent_id)
    fe_req = urllib.request.Request(fe, method="GET")
    try:
        with _opener().open(fe_req, timeout=20) as fe_resp:
            if int(fe_resp.status) >= 400:
                return "verified reachable", count
    except Exception:
        return "verified reachable", count
    return "verified reachable", count


def latest_dump_for_agent(agent_id: str) -> Path:
    dump_dir = REPO_ROOT / ".llm-dumps" / agent_id
    if not dump_dir.is_dir():
        raise SystemExit(f"no .llm-dumps directory for {agent_id}: {dump_dir}")
    dumps = sorted(dump_dir.glob("*.json"))
    if not dumps:
        raise SystemExit(f"no LLM dumps under {dump_dir}")
    return dumps[-1]


def publish_llm_dump(dump: Path, agent_id: str) -> Path:
    out_dir = ARTIFACTS_ROOT / agent_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_html = out_dir / "last_llm_call.html"
    cmd = [
        sys.executable,
        str(REPO_ROOT / "scripts" / "render_llm_dump.py"),
        str(dump),
        "-o",
        str(out_html),
        "--no-open",
    ]
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT))
    # Copy source JSON alongside for greppability.
    shutil.copy2(dump, out_dir / dump.name)
    return out_html


def write_manifest(
    *,
    agent_id: str,
    run_id: str,
    fe_status: str,
    message_count: int,
    dump_html: Path,
    source_dump: Path,
) -> Path:
    out_dir = ARTIFACTS_ROOT / agent_id
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "agent_id": agent_id,
        "run_id": run_id,
        "fe_url": durable_fe_url(agent_id),
        "fe_verified": fe_status,
        "message_count": message_count,
        "llm_dump_artifact": str(dump_html),
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
    parser.add_argument("--dump", type=Path, help="Specific LLM dump JSON (default: latest)")
    parser.add_argument("--skip-hub-upload", action="store_true")
    parser.add_argument("--skip-fe-verify", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    agent_id = _normalize_agent_id(args.agent_id)
    run_id = ""
    zero_session_task_ids: set[str] = set()
    if args.run_json:
        zero_session_task_ids = verified_zero_session_tasks(
            json.loads(args.run_json.read_text(encoding="utf-8")), agent_id,
        )
    if args.run_json and not args.skip_hub_upload:
        run_path = args.run_json.resolve()
        run_id = upload_run_json(run_path, agent_id)
        dual_write_claude_code_sessions(run_path, agent_id)
    dump = (args.dump or latest_dump_for_agent(agent_id)).resolve()
    dump_html = publish_llm_dump(dump, agent_id)
    if args.skip_fe_verify:
        fe_status, message_count = "skipped", 0
    else:
        fe_status, message_count = verify_agent_reachable(
            agent_id, zero_session_task_ids=zero_session_task_ids,
        )
    manifest = write_manifest(
        agent_id=agent_id,
        run_id=run_id,
        fe_status=fe_status,
        message_count=message_count,
        dump_html=dump_html,
        source_dump=dump,
    )
    print(f"FE link: {durable_fe_url(agent_id)} — {fe_status} ({message_count} msgs)")
    print(f"LLM dump: {dump_html}")
    print(f"manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
