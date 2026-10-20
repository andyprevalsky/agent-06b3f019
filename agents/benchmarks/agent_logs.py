#!/usr/bin/env python3
"""
Fetch all prod logs for an agent or agent tree.

Usage:
    # All logs for a single agent
    python benchmarks/agent_logs.py <agent_id>

    # All logs for agent tree (root + all descendants)
    python benchmarks/agent_logs.py <agent_id> --tree

    # Filter by source
    python benchmarks/agent_logs.py <agent_id> --tree --source worker
    python benchmarks/agent_logs.py <agent_id> --tree --source backend
    python benchmarks/agent_logs.py <agent_id> --tree --source research
    python benchmarks/agent_logs.py <agent_id> --tree --source messages

    # Multiple sources
    python benchmarks/agent_logs.py <agent_id> --source worker --source backend

    # Diagnostics view (formatted tree with errors highlighted)
    python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchmarks.logs import (
    collect_logs,
    collect_tree_logs,
    format_tree_diagnostics,
    load_env_var,
)

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
PROD_BASE_URL = "https://navi-j9a9.onrender.com"

VALID_SOURCES = {"worker", "backend", "research", "realtime", "messages"}


async def _api_headers() -> dict:
    if not API_KEY:
        raise RuntimeError("BACKEND_API_KEY not set in agents/.env")
    return {
        "X-API-Key": API_KEY,
        "X-User-Id": USER_ID,
        "Content-Type": "application/json",
    }


async def get_agent(base_url: str, agent_id: str) -> dict:
    import httpx

    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
        if resp.status_code != 200:
            raise Exception(f"GET agent failed: {resp.status_code} {resp.text[:200]}")
        return resp.json()


async def get_agent_tree(base_url: str, bus_id: str) -> list:
    import httpx

    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/tree", headers=headers, params={"busId": bus_id})
        if resp.status_code != 200:
            raise Exception(f"GET tree failed: {resp.status_code} {resp.text[:200]}")
        return resp.json().get("agents", [])


def _print_logs(label: str, logs: list, agent_id: str = ""):
    prefix = f"[{agent_id[:12]}] " if agent_id else ""
    print(f"\n{'─' * 60}")
    print(f"  {prefix}{label} ({len(logs)} entries)")
    print(f"{'─' * 60}")
    for entry in logs:
        if isinstance(entry, dict):
            # Message transcript entry
            role = entry.get("role", "?")
            text = entry.get("message", "")
            ts = entry.get("created_at", "")
            meta = entry.get("metadata", {})
            fp = entry.get("file_pointer")
            tool_info = ""
            extra = ""
            if isinstance(meta, dict):
                tool = meta.get("toolName", "")
                status = meta.get("toolStatus", "")
                if tool:
                    tool_info = f" [{tool}/{status}]" if status else f" [{tool}]"
                # Show error flag
                if meta.get("error"):
                    tool_info += " ⚠ERROR"
                # Show sub-agent ID if present (for spawn_agent, browser, claude_code)
                sub_id = meta.get("subAgentId", "")
                if sub_id:
                    extra += f" sub={sub_id[:12]}"
                # Show action_type for browser/claude_code
                action = meta.get("action_type", "")
                if action:
                    extra += f" action={action}"
                # Show isWaitingForUser
                if meta.get("isWaitingForUser") or (
                    isinstance(meta.get("sendMessageToUser"), dict)
                    and meta["sendMessageToUser"].get("isWaitingForUser")
                ):
                    extra += " 🔔WAITING_FOR_USER"
            if fp:
                fname = fp.get("original_filename", "file")
                extra += f" 📎{fname}"
            # Truncate very long messages but not aggressively
            if text and len(text) > 500:
                text = text[:500] + f"... (+{len(text) - 500} chars)"
            time_str = f" ({ts[11:19]})" if ts and len(ts) > 19 else ""
            print(f"  {role}{tool_info}{extra}{time_str}: {text}")
        else:
            print(f"  {entry}")


async def run(args):
    base_url = args.url.rstrip("/")
    agent_id = args.agent_id
    sources = set(args.source) if args.source else VALID_SOURCES

    # Default time window: 24h ago to now
    start_time = datetime.now(timezone.utc) - timedelta(hours=args.hours)

    if args.tree:
        # Tree mode: get all agents, collect logs for each
        print(f"Fetching agent tree for {agent_id[:12]}...")
        tree_agents = await get_agent_tree(base_url, agent_id)
        print(f"Found {len(tree_agents)} agents in tree")

        tree_logs = await collect_tree_logs(
            agent_id,
            tree_agents,
            start_time,
            get_agent_fn=lambda aid: get_agent(base_url, aid),
            backend_url=base_url,
        )

        if args.diagnostics:
            # Diagnostics mode: use format_tree_diagnostics
            print(format_tree_diagnostics(tree_logs, agent_id))
            return

        # Collect and print per-agent
        for agent_info in tree_agents:
            aid = agent_info["agent_id"]
            status = agent_info.get("status", "?")
            goal = (agent_info.get("goal") or "")[:80]
            parent = agent_info.get("parent_agent_id")
            role = "ROOT" if not parent else f"child of {parent[:12]}"

            print(f"\n{'=' * 60}")
            print(f"  Agent: {aid[:12]}  [{status}]  ({role})")
            print(f"  Goal: {goal}")
            print(f"{'=' * 60}")

            logs = tree_logs.get(aid, {}).get(
                "logs",
                {
                    "messages": [],
                    "worker_logs": [],
                    "backend_logs": [],
                    "research_logs": [],
                    "realtime_logs": [],
                },
            )

            if "messages" in sources:
                _print_logs("MESSAGES", logs["messages"], aid)
            if "worker" in sources:
                _print_logs("WORKER (Fly.io)", logs["worker_logs"], aid)
            if "backend" in sources:
                _print_logs("BACKEND (Render)", logs["backend_logs"], aid)
            if "research" in sources:
                _print_logs("RESEARCH (Supabase)", logs["research_logs"], aid)
            if "realtime" in sources:
                _print_logs("REALTIME (Supabase)", logs["realtime_logs"], aid)

    else:
        # Single agent mode
        print(f"Fetching logs for agent {agent_id[:12]}...")
        agent_data = await get_agent(base_url, agent_id)
        agent = agent_data.get("agent", {})
        print(f"Status: {agent.get('status', '?')}  Messages: {agent.get('message_count', 0)}")

        logs = await collect_logs(agent_id, agent_data, start_time, backend_url=base_url)

        if "messages" in sources:
            _print_logs("MESSAGES", logs["messages"])
        if "worker" in sources:
            _print_logs("WORKER (Fly.io)", logs["worker_logs"])
        if "backend" in sources:
            _print_logs("BACKEND (Render)", logs["backend_logs"])
        if "research" in sources:
            _print_logs("RESEARCH (Supabase)", logs["research_logs"])
        if "realtime" in sources:
            _print_logs("REALTIME (Supabase)", logs["realtime_logs"])


def main():
    parser = argparse.ArgumentParser(description="Fetch all prod logs for an agent or agent tree")
    parser.add_argument("agent_id", help="Agent ID (also used as busId for --tree)")
    parser.add_argument("--tree", action="store_true", help="Fetch logs for entire agent tree")
    parser.add_argument(
        "--source",
        action="append",
        choices=sorted(VALID_SOURCES),
        help="Filter by log source (repeatable). Default: all sources",
    )
    parser.add_argument("--diagnostics", action="store_true", help="Show formatted tree diagnostics")
    parser.add_argument(
        "--url",
        default=None,
        help=f"Base API URL of the backend that served the agent (default: {PROD_BASE_URL})",
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=24,
        help="Look back N hours for time-windowed logs (default: 24)",
    )
    target_group = parser.add_mutually_exclusive_group()
    target_group.add_argument(
        "--prod",
        action="store_true",
        help=f"Use production URL ({PROD_BASE_URL})",
    )
    target_group.add_argument(
        "--local",
        action="store_true",
        help="Use localhost:$CONDUCTOR_PORT (local stack logs only; no prod log APIs)",
    )
    args = parser.parse_args()

    # Resolve URL: --url > --local > --prod/default. The URL also decides
    # whether production log APIs can contain the agent at all.
    if args.url is None:
        if args.local:
            args.url = f"http://localhost:{os.environ.get('CONDUCTOR_PORT', '3001')}"
        else:
            args.url = PROD_BASE_URL

    if args.diagnostics and not args.tree:
        print("--diagnostics requires --tree")
        sys.exit(1)

    asyncio.run(run(args))


if __name__ == "__main__":
    main()
