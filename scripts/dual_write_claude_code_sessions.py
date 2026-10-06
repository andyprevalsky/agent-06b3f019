#!/usr/bin/env python3
"""Dual-write Claude Code session transcripts to the durable (prod) database.

Local ``run-bench --local`` stacks store ``ClaudeCodeSession.output`` in an
ephemeral Postgres that is dropped on teardown. The durable FE on
www.roselabs.ai fetches transcripts from prod via
``GET /api/claude-code-session/:taskId``, so archived hub agents show empty
terminals unless those rows also exist in prod.

This script upserts sessions from a run JSON (``logs.claude_code_sessions``)
into the DATABASE_URL / DIRECT_URL from ``back-end/.env``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "back-end"
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def load_backend_env() -> dict[str, str]:
    env_path = BACKEND_DIR / ".env"
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip('"').strip("'")
    return values


def sessions_from_run(run_json: Path, agent_id: str | None) -> list[dict]:
    bundle = json.loads(run_json.read_text(encoding="utf-8"))
    sessions: list[dict] = []
    for task in bundle.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        if agent_id:
            task_agent = str(task.get("agent_id") or "").strip().lower()
            if task_agent and task_agent != agent_id.lower():
                continue
        logs = task.get("logs") if isinstance(task.get("logs"), dict) else {}
        raw = logs.get("claude_code_sessions") or []
        if not isinstance(raw, list):
            continue
        for session in raw:
            if isinstance(session, dict):
                sessions.append(session)
    return sessions


def normalize_session(raw: dict, *, fallback_agent_id: str | None) -> dict | None:
    session_id = str(raw.get("id") or raw.get("task_id") or raw.get("taskId") or "").strip()
    if not _UUID_RE.fullmatch(session_id):
        return None
    output = raw.get("output")
    if not isinstance(output, str) or not output.strip():
        return None
    agent_id = str(raw.get("agentId") or raw.get("agent_id") or fallback_agent_id or "").strip()
    if not _UUID_RE.fullmatch(agent_id):
        return None
    sandbox_id = str(raw.get("sandboxId") or raw.get("sandbox_id") or "").strip()
    if not sandbox_id:
        sandbox_id = f"hub-mirror-{session_id}"
    goal = str(raw.get("goal") or "benchmark hub mirror").strip() or "benchmark hub mirror"
    status = str(raw.get("status") or "COMPLETED").strip().upper()
    if status in {"FAILED", "ERROR"}:
        status = "ERROR"
    elif status in {"CLOSED", "CANCELLED", "CANCELED"}:
        status = "CLOSED"
    elif status not in {"ACTIVE", "COMPLETED"}:
        status = "COMPLETED"
    stream_url = raw.get("streamUrl") or raw.get("stream_url") or raw.get("ws_url")
    return {
        "id": session_id.lower(),
        "agentId": agent_id.lower(),
        "sandboxId": sandbox_id[:200],
        "streamUrl": stream_url if isinstance(stream_url, str) else None,
        "goal": goal[:4000],
        "status": status,
        "output": output,
    }


def resolve_database_url() -> str:
    backend_env = load_backend_env()
    database_url = (
        os.environ.get("DIRECT_DATABASE_URL")
        or os.environ.get("DIRECT_URL")
        or backend_env.get("DIRECT_DATABASE_URL")
        or backend_env.get("DIRECT_URL")
        or os.environ.get("DATABASE_URL")
        or backend_env.get("DATABASE_URL")
    )
    if not database_url:
        raise SystemExit("DATABASE_URL / DIRECT_URL missing — cannot dual-write sessions")
    return database_url


def dual_write_sessions(sessions: list[dict]) -> dict:
    """Upsert sessions into prod via Prisma. Returns a summary dict."""
    if not sessions:
        return {"upserted": 0, "ids": []}

    database_url = resolve_database_url()
    fd, tmp_name = tempfile.mkstemp(prefix="claude-sessions-", suffix=".json")
    os.close(fd)
    payload_path = Path(tmp_name)
    payload_path.write_text(json.dumps(sessions), encoding="utf-8")

    script = """
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const sessions = JSON.parse(fs.readFileSync(process.env.DUAL_WRITE_PAYLOAD, 'utf8'));
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DUAL_WRITE_DATABASE_URL } },
});
const TERMINAL = new Set(['CLOSED', 'COMPLETED', 'ERROR']);
(async () => {
  const ids = [];
  for (const s of sessions) {
    const existing = await prisma.claudeCodeSession.findUnique({ where: { id: s.id } });
    const incomingTerminal = TERMINAL.has(s.status);
    const existingTerminal = existing && TERMINAL.has(existing.status);
    const output =
      existing &&
      typeof existing.output === 'string' &&
      existing.output.length > (s.output || '').length
        ? existing.output
        : s.output;
    const closedAt = existingTerminal
      ? existing.closedAt
      : incomingTerminal
        ? new Date()
        : null;
    await prisma.claudeCodeSession.upsert({
      where: { id: s.id },
      create: {
        id: s.id,
        agentId: s.agentId,
        sandboxId: s.sandboxId,
        streamUrl: s.streamUrl,
        goal: s.goal,
        status: s.status,
        output,
        closedAt,
      },
      update: {
        agentId: s.agentId,
        output,
        status: s.status,
        closedAt: closedAt,
        streamUrl: s.streamUrl ?? undefined,
        goal: s.goal,
      },
    });
    ids.push(s.id);
  }
  console.log(JSON.stringify({ upserted: ids.length, ids }));
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err && err.stack ? err.stack : String(err));
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
"""
    env = os.environ.copy()
    env["DUAL_WRITE_DATABASE_URL"] = database_url
    env["DUAL_WRITE_PAYLOAD"] = str(payload_path)
    try:
        proc = subprocess.run(
            ["node", "-e", script],
            cwd=str(BACKEND_DIR),
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        line = (proc.stdout or "").strip().splitlines()[-1]
        return json.loads(line)
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or "") + (exc.stdout or "")
        raise SystemExit(f"prisma dual-write failed:\n{err}") from exc
    finally:
        payload_path.unlink(missing_ok=True)


class _LoopbackProxyHandler(urllib.request.ProxyHandler):
    def proxy_open(self, request, proxy, proxy_type):
        if urllib.parse.urlsplit(request.full_url).hostname in {"localhost", "127.0.0.1", "::1"}:
            return None
        return super().proxy_open(request, proxy, proxy_type)


def verify_session_on_hub(session_id: str) -> int:
    """Return output length from durable hub API, or -1 on failure."""
    backend_env = load_backend_env()
    key = (
        os.getenv("BENCHMARK_HUB_API_KEY")
        or os.getenv("BACKEND_API_KEY")
        or backend_env.get("BACKEND_API_KEY")
        or backend_env.get("API_KEY")
        or ""
    )
    user = (
        os.getenv("BENCHMARK_HUB_USER_ID")
        or backend_env.get("BENCHMARK_HUB_USER_ID")
        or "1f85ff25-6e29-4c1b-8739-f917bd101a30"
    )
    if not key:
        return -1
    hub = (
        os.getenv("BENCHMARK_HUB_UPLOAD_URL")
        or backend_env.get("BENCHMARK_HUB_UPLOAD_URL")
        or "https://navi-j9a9.onrender.com"
    )
    req = urllib.request.Request(
        f"{hub.rstrip('/')}/api/claude-code-session/{session_id}",
        headers={"X-API-Key": key, "X-User-Id": user},
        method="GET",
    )
    try:
        with urllib.request.build_opener(_LoopbackProxyHandler()).open(req, timeout=30) as resp:
            payload = json.loads(resp.read() or b"{}")
    except Exception:
        return -1
    output = payload.get("output") if isinstance(payload, dict) else None
    return len(output) if isinstance(output, str) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-json", type=Path, required=True)
    parser.add_argument("--agent-id", default=None)
    parser.add_argument("--skip-verify", action="store_true")
    args = parser.parse_args()
    agent_id = args.agent_id.lower() if args.agent_id else None

    raw_sessions = sessions_from_run(args.run_json.resolve(), agent_id)
    by_id: dict[str, dict] = {}
    skipped = 0
    for raw in raw_sessions:
        item = normalize_session(raw, fallback_agent_id=agent_id)
        if item is None:
            skipped += 1
            continue
        prior = by_id.get(item["id"])
        if prior is None or len(item["output"]) >= len(prior["output"]):
            by_id[item["id"]] = item

    summary = dual_write_sessions(list(by_id.values()))
    print(
        f"dual-wrote {summary.get('upserted', 0)} ClaudeCodeSession row(s) "
        f"(skipped_invalid={skipped})"
    )
    if not args.skip_verify:
        for sid in summary.get("ids") or []:
            out_len = verify_session_on_hub(sid)
            print(f"  verify {sid}: output_len={out_len}")
            if out_len < 32:
                raise SystemExit(f"durable session {sid} missing usable output (len={out_len})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
