#!/usr/bin/env python3
"""Publish durable FE + LLM-dump evidence for /RCA and approval requests.

Local ``scripts/run-bench --local`` stacks tear down after the run. Evidence
cited in approvals must outlive that stack:

  * FE  → ``https://www.roselabs.ai/?agent-id=…`` after the run
    bundle is on the always-on Benchmark Hub (dual-write or explicit upload)
    (``/open-agent?agent-id=…`` is an alias that redirects to the same URL)
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
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HUB = "https://navi-j9a9.onrender.com"
DURABLE_ORIGIN = "https://www.roselabs.ai"
ARTIFACTS_ROOT = Path("/opt/cursor/artifacts/rca_evidence")


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


def upload_run_json(run_json: Path) -> str:
    sys.path.insert(0, str(REPO_ROOT / "agents"))
    from benchmarks.hub_upload import upload_run_bundle  # type: ignore

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


def verify_agent_reachable(agent_id: str, *, timeout: float = 60.0) -> tuple[str, int]:
    """Probe archive-backed agent detail; return (status_label, message_count)."""
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
    agent_id = args.agent_id.strip()
    run_id = ""
    if args.run_json and not args.skip_hub_upload:
        run_id = upload_run_json(args.run_json.resolve())
    dump = (args.dump or latest_dump_for_agent(agent_id)).resolve()
    dump_html = publish_llm_dump(dump, agent_id)
    if args.skip_fe_verify:
        fe_status, message_count = "skipped", 0
    else:
        fe_status, message_count = verify_agent_reachable(agent_id)
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
