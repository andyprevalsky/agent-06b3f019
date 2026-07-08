#!/usr/bin/env python3
"""Serve a saved benchmark run through the normal frontend agent APIs.

This is intentionally an archive adapter, not a replacement UI: it lets the
existing Vite frontend render `/?agent-id=...` after the benchmark stack has
been torn down by adapting `run.json` to `/api/agents/*` responses.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


@dataclass(frozen=True)
class ArchivedAgent:
    agent: dict[str, Any]
    messages: list[dict[str, Any]]


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
        "goal": _first_user_message(task.get("logs", {}).get("messages") or [], str(task.get("name") or "benchmark task")),
        "model": "benchmark-archive",
        "source": "WEB",
        "reasoning_effort": "off",
        "reasoning_max_tokens": None,
        "progress": 100 if task.get("passed") else int(float(task.get("progress_score") or 0) * 100),
        "status": status,
        "status_message": f"Archived benchmark task: {task.get('name')}",
        "temporal_workflow_id": f"benchmark-archive-{agent_id}",
        "token_count": 0,
        "tokens_in": int(task.get("cache_read_input_tokens") or 0)
        + int(task.get("cache_creation_input_tokens") or 0),
        "tokens_out": 0,
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
        "response_schema": None,
        "benchmark_task": task.get("name"),
        "benchmark_duration_seconds": duration,
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
        agents[agent_id] = ArchivedAgent(agent=agent, messages=messages)
    return agents


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
            _json_response(self, 200, {"ok": True, "agents": len(self.agents)})
            return
        if path == "/api/models":
            _json_response(self, 200, {"models": []})
            return
        if path == "/api/tools":
            _json_response(self, 200, {"tools": []})
            return
        if path == "/api/attention-requests":
            _json_response(self, 200, {"requests": []})
            return
        if path == "/api/benchmarks/test-prompts":
            _json_response(self, 200, {"prompts": []})
            return
        if path == "/api/agents":
            _json_response(self, 200, {"agents": [entry.agent for entry in self.agents.values()]})
            return
        if path == "/api/agents/tree":
            bus_id = (parse_qs(parsed.query).get("busId") or [""])[0]
            entry = self.agents.get(bus_id)
            agents = [entry.agent] if entry else []
            _json_response(self, 200, {"agents": agents})
            return
        if path.startswith("/api/agents/"):
            self._handle_agent_path(path)
            return
        _json_response(self, 404, {"error": "not found"})

    def _handle_agent_path(self, path: str) -> None:
        rest = path.removeprefix("/api/agents/")
        parts = rest.split("/")
        agent_id = parts[0]
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
        if urlparse(self.path).path.rstrip("/") == "/api/dev/log":
            _json_response(self, 200, {"ok": True})
            return
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def do_PATCH(self) -> None:
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def do_DELETE(self) -> None:
        _json_response(self, 409, {"error": "Benchmark archive is read-only"})

    def log_message(self, format_str: str, *args: object) -> None:
        return


def serve(run_path: Path, host: str, port: int) -> None:
    ArchiveHandler.agents = load_archive(run_path)
    server = ThreadingHTTPServer((host, port), ArchiveHandler)
    print(f"benchmark archive api listening on http://{host}:{port} ({len(ArchiveHandler.agents)} agents)")
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_json", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    serve(args.run_json, args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
