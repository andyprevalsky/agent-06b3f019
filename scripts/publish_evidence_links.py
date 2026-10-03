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
import hashlib
import hmac
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS_VENV_PYTHON = REPO_ROOT / "agents" / "venv" / "bin" / "python"
DEFAULT_HUB = "https://navi-j9a9.onrender.com"
DURABLE_ORIGIN = "https://www.roselabs.ai"
ARTIFACTS_ROOT = Path(
    os.getenv("RCA_EVIDENCE_ARTIFACTS_ROOT")
    or Path(os.getenv("CURSOR_ARTIFACTS_DIR", "/opt/cursor/artifacts")) / "rca_evidence"
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


def upload_run_json(run_json: Path) -> str:
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.hub_upload import upload_run_bundle

    bundle = json.loads(run_json.read_text(encoding="utf-8"))
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


def validate_browser_agents_terminated_with_recording(
    agent_id: str, messages: list
) -> list[str]:
    """Return failure reasons when any browser task is still live or missing recording.

    A browser task is any ``task_id`` that emitted ``spawn_browser_agent`` progress
    (``action_type`` in browser/session/recording). Each such task must have:
      * ``action_type=task_complete`` (terminated for FE panels)
      * a FINISHED recording message with a reachable ``recording_view_url`` or a
        fetchable ``recording_file_pointer``
    Agents with no browser tasks pass.
    """
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
        browser_related = tool_name == "spawn_browser_agent" or action in {
            "browser",
            "session_init",
            "session_started",
            "task_started",
            "recording",
            "network_recording",
            "task_complete",
        }
        if not browser_related:
            continue
        state = tasks.setdefault(
            task_id, {"seen": False, "complete": False, "recording_ok": False}
        )
        if action in {
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
        if not state["seen"]:
            continue
        if not state["complete"]:
            failures.append(
                f"browser task {task_id} has not terminated (missing action_type=task_complete)"
            )
        recording_ok = False
        for meta in recording_candidates.get(task_id, []):
            view_url = meta.get("recording_view_url")
            if (
                isinstance(view_url, str)
                and view_url.strip()
                and _probe_recording_view_url(view_url.strip())
            ):
                recording_ok = True
                break
            pointer = meta.get("recording_file_pointer")
            if isinstance(pointer, dict) and _probe_recording_file_pointer(
                agent_id, pointer
            ):
                recording_ok = True
                break
        if not recording_ok:
            failures.append(
                f"browser task {task_id} has no correctly attached recording "
                "(need reachable recording_view_url or fetchable recording_file_pointer)"
            )
        else:
            state["recording_ok"] = True
    return failures


def visible_transcript_snippets(messages: list[dict]) -> dict[str, list[str]]:
    """Extract short, rendered phrases from each visible transcript role."""
    snippets: dict[str, list[str]] = {"user": [], "assistant": []}
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = str(message.get("text") or "")
        metadata = _message_metadata(message)
        # Sub-agent rows render inside the collapsed sub-agent panel, not the
        # root transcript a fresh share-link visitor sees.
        if (
            role not in ("USER", "ASSISTANT")
            or metadata.get("hidden")
            or metadata.get("subAgentId")
        ):
            continue
        for line in content.splitlines():
            # React renders Markdown markers as formatting, so match the text
            # the signed-out visitor sees instead of the raw Markdown source.
            visible_line = re.sub(
                r"^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", line
            )
            visible_line = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", visible_line)
            visible_line = re.sub(r"`([^`]+)`", r"\1", visible_line)
            visible_line = re.sub(
                r"\*\*([^*]+)\*\*|__([^_]+)__", lambda m: m[1] or m[2], visible_line
            )
            visible_line = re.sub(
                r"(?<!\w)\*([^*]+)\*(?!\w)|(?<!\w)_([^_]+)_(?!\w)",
                lambda m: m[1] or m[2],
                visible_line,
            )
            visible_line = re.sub(r"~~([^~]+)~~", r"\1", visible_line).strip()
            if len(visible_line) >= 12:
                snippets[str(role).lower()].append(visible_line[:60])
                break
    return {role: values[:8] for role, values in snippets.items()}


def verify_agent_reachable(
    agent_id: str, token: str, *, timeout: float = 60.0
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
        agent_id, messages
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


def latest_dump_for_agent(agent_id: str) -> Path:
    dump_dir = REPO_ROOT / ".llm-dumps" / agent_id
    if not dump_dir.is_dir():
        raise SystemExit(f"no .llm-dumps directory for {agent_id}: {dump_dir}")
    dumps = sorted(dump_dir.glob("*.json"))
    if not dumps:
        raise SystemExit(f"no LLM dumps under {dump_dir}")
    return dumps[-1]


def publish_llm_dump(dump: Path, agent_id: str) -> tuple[Path, str]:
    """Render the dump; return the local HTML and the HTTPS URL ("" when not uploaded)."""
    out_dir = ARTIFACTS_ROOT / agent_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_html = out_dir / "last_llm_call.html"
    # The R2 HTTPS upload needs boto3, which lives in agents/venv rather than
    # the system python3 this script is documented to run under.
    python = AGENTS_VENV_PYTHON if AGENTS_VENV_PYTHON.is_file() else Path(sys.executable)
    cmd = [
        str(python),
        str(REPO_ROOT / "scripts" / "render_llm_dump.py"),
        str(dump),
        "-o",
        str(out_html),
        "--no-open",
    ]
    result = subprocess.run(cmd, check=True, cwd=str(REPO_ROOT), capture_output=True, text=True)
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
    parser.add_argument("--run-id", help="Existing Hub run ID when --run-json is unavailable")
    parser.add_argument("--dump", type=Path, help="Specific LLM dump JSON (default: latest)")
    parser.add_argument("--skip-hub-upload", action="store_true")
    parser.add_argument("--skip-fe-verify", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    agent_id = _normalize_agent_id(args.agent_id)
    run_id = args.run_id or ""
    if args.run_json:
        run_path = args.run_json.resolve()
        if args.skip_hub_upload:
            run_id = str(json.loads(run_path.read_text(encoding="utf-8")).get("run_id") or "")
        else:
            run_id = upload_run_json(run_path)
            dual_write_claude_code_sessions(run_path, agent_id)
    if not re.fullmatch(_AGENT_ID_RE, run_id):
        raise SystemExit("a UUID run_id from --run-json or --run-id is required for a share link")
    token = benchmark_share_token(run_id)
    dump = (args.dump or latest_dump_for_agent(agent_id)).resolve()
    dump_html, dump_https_url = publish_llm_dump(dump, agent_id)
    if args.skip_fe_verify:
        fe_status, message_count = "skipped", 0
    else:
        fe_status, message_count = verify_agent_reachable(agent_id, token)
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
