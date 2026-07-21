#!/usr/bin/env python3
"""Serve a saved benchmark run through the normal frontend agent APIs.

This is intentionally an archive adapter, not a replacement UI: it lets the
existing Vite frontend render `/?agent-id=...` after the benchmark stack has
been torn down by adapting `run.json` to `/api/agents/*` responses.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, quote, unquote, urlparse


@dataclass(frozen=True)
class ArchivedAgent:
    agent: dict[str, Any]
    messages: list[dict[str, Any]]
    attachments: dict[str, dict[str, Any]]


def _attachment_pointers(messages: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index file pointers embedded anywhere in archived message metadata.

    Recordings use ``metadata.recording_file_pointer`` while ordinary message
    attachments use ``file_pointer``. Walking the already-bounded transcript
    handles both without coupling the archive adapter to every metadata key.
    """
    attachments: dict[str, dict[str, Any]] = {}
    pending: list[Any] = list(messages)
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            file_id = value.get("id")
            storage_path = value.get("storage_path")
            if isinstance(file_id, str) and file_id and isinstance(storage_path, str) and storage_path:
                attachments.setdefault(file_id, dict(value))
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return attachments


def _load_env_value(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    repo_root = Path(__file__).resolve().parents[2]
    for env_path in (repo_root / "agents" / ".env", repo_root / "back-end" / ".env"):
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, raw_value = stripped.split("=", 1)
            if key.strip() != name:
                continue
            parsed = raw_value.strip().strip('"').strip("'")
            if " #" in parsed:
                parsed = parsed.split(" #", 1)[0].rstrip()
            if parsed:
                return parsed
    return ""


def _create_attachment_signed_url(storage_path: str, expires_in: int = 3600) -> str:
    """Create a Supabase Storage URL without exposing the service-role key."""
    supabase_url = _load_env_value("SUPABASE_URL").rstrip("/")
    service_key = _load_env_value("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        raise RuntimeError("Supabase archive attachment credentials are unavailable")

    encoded_path = quote(storage_path, safe="/")
    request = urllib.request.Request(
        f"{supabase_url}/storage/v1/object/sign/attachments/{encoded_path}",
        data=json.dumps({"expiresIn": expires_in}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    signed_url = payload.get("signedURL") or payload.get("signedUrl")
    if not isinstance(signed_url, str) or not signed_url:
        raise RuntimeError("Supabase did not return a signed attachment URL")
    if signed_url.startswith("/"):
        # Supabase Storage returns paths relative to its ``/storage/v1`` API
        # (for example ``/object/sign/...``), not necessarily to the host root.
        storage_prefix = "" if signed_url.startswith("/storage/v1/") else "/storage/v1"
        return f"{supabase_url}{storage_prefix}{signed_url}"
    return signed_url


def _first_user_message(messages: list[dict[str, Any]], fallback: str) -> str:
    for message in messages:
        if str(message.get("role", "")).upper() == "USER" and message.get("message"):
            return str(message["message"])
    return fallback


def _message_id(agent_id: str, index: int) -> str:
    return f"{agent_id}-archive-message-{index:04d}"


def _frontend_message(agent_id: str, index: int, raw: dict[str, Any]) -> dict[str, Any]:
    created_at = raw.get("created_at") or raw.get("timestamp") or ""
    return {
        "message_id": raw.get("message_id") or _message_id(agent_id, index),
        "timestamp": created_at,
        "text": raw.get("message") if raw.get("message") is not None else raw.get("text", ""),
        "role": str(raw.get("role") or "ASSISTANT").upper(),
        "metadata": raw.get("metadata") or {},
        "file_pointer": raw.get("file_pointer"),
    }


def _agent_summary(task: dict[str, Any], messages: list[dict[str, Any]], run_timestamp: str) -> dict[str, Any]:
    agent_id = str(task.get("agent_id") or "")
    duration = float(task.get("duration_seconds") or 0)
    status = "COMPLETED" if task.get("passed") else "FAILED"
    updated_at = messages[-1]["timestamp"] if messages and messages[-1].get("timestamp") else run_timestamp
    return {
        "agent_id": agent_id,
        "parent_agent_id": None,
        "parent_goal": None,
        "busId": agent_id,  # root is its own bus; sub-agents carry this root id
        "goal": _first_user_message(task.get("logs", {}).get("messages") or [], str(task.get("name") or "benchmark task")),
        "model": "benchmark-archive",
        "source": "WEB",
        "reasoning_effort": "off",
        "reasoning_max_tokens": None,
        "progress": 100 if task.get("passed") else int(float(task.get("progress_score") or 0) * 100),
        "status": status,
        "status_message": f"Archived benchmark task: {task.get('name')}",
        "temporal_workflow_id": f"benchmark-archive-{agent_id}",
        "token_count": int(task.get("tokens_in") or 0) + int(task.get("tokens_out") or 0),
        "tokens_in": int(task.get("tokens_in") or 0)
        or int(task.get("cache_read_input_tokens") or 0)
        + int(task.get("cache_creation_input_tokens") or 0),
        "tokens_out": int(task.get("tokens_out") or 0),
        "tool_tokens_in": 0,
        "tool_tokens_out": 0,
        "tool_cost_cents": 0,
        "context_size": 0,
        "message_count": len(messages),
        "price_limit_cents": 0,
        "tree_cost_cents": float(task.get("cost_cents") or 0),
        "fast_mode_cache_enabled": bool(task.get("fast_mode_cache_enabled")),
        "token_in_price_microdollars": None,
        "token_out_price_microdollars": None,
        "created_at": run_timestamp,
        "updated_at": updated_at,
        "write_lock_enabled": True,
        "structured_output": None,
        "failure_context": None,
        "verifier": None,
        "tools": [],
        "tools_in_use": [],
        "response_schema": None,
        "benchmark_task": task.get("name"),
        "benchmark_duration_seconds": duration,
        "benchmark_world_model_mode": task.get("world_model_mode"),
    }


def _subagent_summary(
    agent_id: str, info: dict[str, Any], root_id: str, task: dict[str, Any], run_timestamp: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """Summary for a spawned sub-agent, from ``logs.tree[agent_id]`` (parent link,
    goal, status). Mirrors ``_agent_summary`` but keyed on the child's own state so
    the frontend can render the full fan-out tree (parent_agent_id + busId)."""
    status = str(info.get("status") or "COMPLETED").upper()
    updated_at = messages[-1]["timestamp"] if messages and messages[-1].get("timestamp") else run_timestamp
    return {
        "agent_id": agent_id,
        "parent_agent_id": info.get("parent_agent_id"),
        "parent_goal": None,
        "busId": root_id,
        "goal": info.get("goal") or _first_user_message(
            [{"role": "user", "message": m.get("text", "")} for m in messages], "sub-agent"
        ),
        "model": "benchmark-archive",
        "source": "AGENT",
        "reasoning_effort": "off",
        "reasoning_max_tokens": None,
        "progress": 100 if status in ("COMPLETED", "FINISHED") else 0,
        "status": status,
        "status_message": f"Sub-agent of {root_id[:12]}",
        "temporal_workflow_id": f"benchmark-archive-{agent_id}",
        "token_count": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "tool_tokens_in": 0,
        "tool_tokens_out": 0,
        "tool_cost_cents": 0,
        "context_size": 0,
        "message_count": len(messages),
        "price_limit_cents": 0,
        "tree_cost_cents": 0,
        "fast_mode_cache_enabled": bool(task.get("fast_mode_cache_enabled")),
        "token_in_price_microdollars": None,
        "token_out_price_microdollars": None,
        "created_at": run_timestamp,
        "updated_at": updated_at,
        "write_lock_enabled": True,
        "structured_output": None,
        "failure_context": None,
        "verifier": None,
        "tools": [],
        "tools_in_use": [],
        "response_schema": None,
        "benchmark_task": task.get("name"),
        "benchmark_duration_seconds": 0,
        "benchmark_world_model_mode": task.get("world_model_mode"),
    }


def load_archive(run_path: Path) -> dict[str, ArchivedAgent]:
    run = json.loads(run_path.read_text())
    run_timestamp = str(run.get("timestamp") or "")
    agents: dict[str, ArchivedAgent] = {}
    for task in run.get("tasks", []):
        agent_id = str(task.get("agent_id") or "")
        if not agent_id:
            continue
        raw_messages = (task.get("logs") or {}).get("messages") or []
        messages = [_frontend_message(agent_id, i, raw) for i, raw in enumerate(raw_messages)]
        agent = _agent_summary(task, messages, run_timestamp)
        agents[agent_id] = ArchivedAgent(
            agent=agent,
            messages=messages,
            attachments=_attachment_pointers(messages),
        )
        # Index every spawned sub-agent in the tree so the archive renders the full
        # fan-out (not just the root). Each carries busId=<root> + parent_agent_id so
        # GET /api/agents/tree?busId=<root> returns the whole tree.
        tree = (task.get("logs") or {}).get("tree") or {}
        for sub_id, info in tree.items():
            sub_id = str(sub_id)
            if not sub_id or sub_id == agent_id:
                continue  # root already indexed above from the task record
            raw = info.get("messages") or []
            sub_messages = [_frontend_message(sub_id, i, r) for i, r in enumerate(raw)]
            sub_agent = _subagent_summary(sub_id, info, agent_id, task, run_timestamp, sub_messages)
            agents[sub_id] = ArchivedAgent(
                agent=sub_agent,
                messages=sub_messages,
                attachments=_attachment_pointers(sub_messages),
            )
    return agents


def load_archive_safe(run_path: Optional[Path]) -> dict[str, ArchivedAgent]:
    """Load an archive without raising — a missing/partial run.json is empty, not fatal.

    During a live run the run.json does not exist yet; the upstream proxy serves
    live agent state and this returns {} so the static path is simply a no-op.
    """
    if run_path is None or not run_path.exists():
        return {}
    try:
        return load_archive(run_path)
    except Exception:
        return {}


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Benchmark-Archive")
    handler.end_headers()
    handler.wfile.write(data)


class ArchiveHandler(BaseHTTPRequestHandler):
    agents: dict[str, ArchivedAgent] = {}
    # Live-proxy config. When ``upstream_url`` is set, agent reads are forwarded
    # to the running box backend with ``upstream_headers`` (API-key + X-User-Id),
    # which bypasses RLS so benchmark agents owned by the runner user are visible.
    # Empty ``upstream_url`` = pure static archive (post-run, box torn down).
    upstream_url: str = ""
    upstream_headers: dict[str, str] = {}
    # Robust live fallback: when the local flyctl proxy is flaky/dead (a known Fly
    # issue — it resets while the machine is healthy), SSH into the box and curl its
    # backend directly. No persistent proxy to die; slower (~1-2s/req) but reliable.
    ssh_machine: str = ""
    ssh_app: str = ""
    # When set, the static archive is hot-reloaded whenever run.json changes, so a
    # single long-lived server transparently promotes from live → final snapshot.
    run_path: Optional[Path] = None
    _run_mtime: float = -1.0

    # Endpoints served from local stubs regardless of upstream (the archive
    # frontend needs them to render, and they carry no per-agent state).
    _STATIC_STUBS = {
        "/api/models": {"models": []},
        "/api/tools": {"tools": []},
        "/api/attention-requests": {"requests": []},
        "/api/benchmarks/test-prompts": {"prompts": []},
    }

    @classmethod
    def _reload_if_changed(cls) -> None:
        path = cls.run_path
        if path is None:
            return
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return
        if mtime == cls._run_mtime:
            return
        cls._run_mtime = mtime
        cls.agents = load_archive_safe(path)

    # A direct opener with proxies disabled: the upstream is always a localhost
    # fly-proxy port, which must NEVER be routed through an ambient HTTP(S) proxy
    # (e.g. the fast-mode proxy) — that turns a local connection refusal into a
    # bogus 500 and would mask the box entirely.
    _direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _try_proxy(self, body: bytes | None = None) -> bool:
        """Forward the current request to the box backend. Return True if a real
        upstream response (any status) was relayed; False on connection failure so
        the caller can fall back to the static archive."""
        if not self.upstream_url:
            return False
        url = self.upstream_url.rstrip("/") + self.path
        headers = dict(self.upstream_headers)
        if body is not None and "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with self._direct_opener.open(request, timeout=15) as resp:
                self._relay_upstream(resp.status, resp.read(), resp.headers.get("Content-Type"))
                return True
        except urllib.error.HTTPError as err:  # real upstream response (4xx/5xx)
            self._relay_upstream(err.code, err.read(), err.headers.get("Content-Type"))
            return True
        except Exception:  # connection reset / timeout / DNS — fall back to static
            return False

    def _try_ssh_pull(self, body: bytes | None = None) -> bool:
        """Robust live fallback: `flyctl ssh console` into the box and curl its
        backend directly (bypasses the flaky local proxy). Return True iff a JSON
        body was recovered and relayed. GET-only (a read view needs no writes)."""
        if not (self.ssh_machine and self.ssh_app) or self.command != "GET":
            return False
        hdr_args = []
        for k, v in self.upstream_headers.items():
            hdr_args += ["-H", f"{k}: {v}"]
        remote = "curl -s " + " ".join(shlex.quote(a) for a in hdr_args) + " " + shlex.quote(
            "http://localhost:3001" + self.path
        )
        try:
            proc = subprocess.run(
                ["flyctl", "ssh", "console", "--machine", self.ssh_machine, "-a", self.ssh_app,
                 "-C", "bash -lc " + shlex.quote(remote)],
                capture_output=True, timeout=30,
            )
        except Exception:
            return False
        out = proc.stdout or b""
        # flyctl prepends a "Connecting to ..." preamble; the JSON body starts at
        # the first '{' or '['. Slice to it so the frontend gets clean JSON.
        start = min([i for i in (out.find(b"{"), out.find(b"[")) if i != -1] or [-1])
        if start < 0:
            return False
        self._relay_upstream(200, out[start:], "application/json")
        return True

    def _relay_upstream(self, status: int, data: bytes, content_type: str | None) -> None:
        self.send_response(int(status))
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Benchmark-Archive")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else None

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Benchmark-Archive")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path == "/health":
            _json_response(self, 200, {"ok": True, "agents": len(self.agents), "live": bool(self.upstream_url)})
            return
        if path in self._STATIC_STUBS:
            _json_response(self, 200, self._STATIC_STUBS[path])
            return

        self._reload_if_changed()

        # Live agent/tool-usage state: prefer the running box (bypasses RLS via the
        # API key), fall back to the static archive if the box is unreachable.
        if path.startswith("/api/agents") or path.startswith("/api/tool-usage"):
            if self._try_proxy() or self._try_ssh_pull():
                return

        if path == "/api/agents":
            _json_response(self, 200, {"agents": [entry.agent for entry in self.agents.values()]})
            return
        if path == "/api/agents/tree":
            bus_id = (parse_qs(parsed.query).get("busId") or [""])[0]
            # Return EVERY agent in this bus's tree (root + all sub-agents) so the
            # frontend renders the full fan-out. Falls back to the single agent if
            # the run predates tree capture (no sub-agents indexed).
            tree_agents = [
                e.agent for e in self.agents.values() if e.agent.get("busId") == bus_id
            ]
            if not tree_agents and bus_id in self.agents:
                tree_agents = [self.agents[bus_id].agent]
            _json_response(self, 200, {"agents": tree_agents})
            return
        if path.startswith("/api/agents/"):
            self._handle_agent_path(path, parsed.query)
            return
        _json_response(self, 404, {"error": "not found"})

    def _handle_agent_path(self, path: str, query: str) -> None:
        rest = path.removeprefix("/api/agents/")
        parts = rest.split("/")
        agent_id = unquote(parts[0])
        entry = self.agents.get(agent_id)
        if entry is None:
            _json_response(self, 404, {"error": "Agent not found"})
            return
        suffix = parts[1:] if len(parts) > 1 else []
        if suffix == ["status"]:
            _json_response(self, 200, {"agent_id": agent_id, "status": entry.agent["status"]})
            return
        if suffix == ["ancestors"]:
            _json_response(self, 200, {"ancestors": []})
            return
        if len(suffix) == 3 and suffix[0] == "attachments" and suffix[2] == "url":
            file_id = unquote(suffix[1])
            storage_path = (parse_qs(query).get("storage_path") or [""])[0]
            pointer = entry.attachments.get(file_id)
            if pointer is None or pointer.get("storage_path") != storage_path:
                _json_response(self, 404, {"error": "Archived attachment not found"})
                return
            try:
                signed_url = _create_attachment_signed_url(storage_path)
            except Exception:
                _json_response(self, 502, {"error": "Could not sign archived attachment"})
                return
            _json_response(self, 200, {"signed_url": signed_url, "expires_in": 3600})
            return
        if suffix:
            _json_response(self, 404, {"error": "not found"})
            return
        _json_response(
            self,
            200,
            {
                "agent": entry.agent,
                "messages": entry.messages,
                "pagination": {"has_more": False, "oldest_timestamp": None},
            },
        )

    def do_POST(self) -> None:
        body = self._read_body()
        if urlparse(self.path).path.rstrip("/") == "/api/dev/log":
            _json_response(self, 200, {"ok": True})
            return
        # Live mode: forward mutations (pause/resume/etc.) to the running box.
        if self.upstream_url and self._try_proxy(body):
            return
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def do_PATCH(self) -> None:
        body = self._read_body()
        if self.upstream_url and self._try_proxy(body):
            return
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def do_DELETE(self) -> None:
        body = self._read_body()
        if self.upstream_url and self._try_proxy(body):
            return
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def log_message(self, format_str: str, *args: object) -> None:
        return


def configure_archive_handler(
    run_path: Optional[Path],
    *,
    upstream_url: str = "",
    upstream_api_key: str = "",
    upstream_user_id: str = "",
    ssh_machine: str = "",
    ssh_app: str = "",
) -> None:
    """Point ArchiveHandler at a run.json and/or a live box backend upstream."""
    ArchiveHandler.run_path = run_path
    ArchiveHandler._run_mtime = -1.0
    ArchiveHandler.agents = load_archive_safe(run_path)
    ArchiveHandler.upstream_url = (upstream_url or "").rstrip("/")
    headers: dict[str, str] = {}
    if upstream_api_key:
        headers["X-API-Key"] = upstream_api_key
    if upstream_user_id:
        headers["X-User-Id"] = upstream_user_id
    ArchiveHandler.upstream_headers = headers
    ArchiveHandler.ssh_machine = ssh_machine or ""
    ArchiveHandler.ssh_app = ssh_app or ""


def serve(
    run_path: Optional[Path],
    host: str,
    port: int,
    *,
    upstream_url: str = "",
    upstream_api_key: str = "",
    upstream_user_id: str = "",
    ssh_machine: str = "",
    ssh_app: str = "",
) -> None:
    configure_archive_handler(
        run_path,
        upstream_url=upstream_url,
        upstream_api_key=upstream_api_key,
        upstream_user_id=upstream_user_id,
        ssh_machine=ssh_machine,
        ssh_app=ssh_app,
    )
    server = ThreadingHTTPServer((host, port), ArchiveHandler)
    mode = "live+archive" if ArchiveHandler.upstream_url else "archive"
    print(
        f"benchmark {mode} api listening on http://{host}:{port} "
        f"({len(ArchiveHandler.agents)} archived agents)"
    )
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_json", type=Path, nargs="?", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--upstream-url", default="")
    parser.add_argument("--upstream-api-key", default="")
    parser.add_argument("--upstream-user-id", default="")
    parser.add_argument("--ssh-machine", default="")
    parser.add_argument("--ssh-app", default="")
    args = parser.parse_args()
    serve(
        args.run_json,
        args.host,
        args.port,
        upstream_url=args.upstream_url,
        upstream_api_key=args.upstream_api_key,
        upstream_user_id=args.upstream_user_id,
        ssh_machine=args.ssh_machine,
        ssh_app=args.ssh_app,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
