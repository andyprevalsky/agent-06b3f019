#!/usr/bin/env python3
"""
Benchmark monitor — polls an agent until a stop condition is reached.

Replaces agent-driven polling with efficient code-driven polling.
The calling agent (Claude) invokes this as a blocking bash call and only
resumes when the script exits.

Exit codes:
    0 — COMPLETED (agent finished successfully)
    1 — ACTION REQUIRED (error, stall, terminal failure)
    2 — APPROVAL NEEDED (agent is waiting for user input)

Usage:
    python benchmarks/benchmark_monitor.py <agent_id> --url <base_url> [--interval 60]
"""

import argparse
import asyncio
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchmarks.logs import _detect_anomalies, extract_message_transcript, load_env_var

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

# ---------------------------------------------------------------------------
# ANSI colors (disabled — plain text output)
# ---------------------------------------------------------------------------
DIM = ""
BOLD = ""
RESET = ""
GREEN = ""
RED = ""
YELLOW = ""
CYAN = ""
MAGENTA = ""

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "COST_LIMIT_REACHED", "OUT_OF_CREDITS"}


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _headers() -> dict:
    if not API_KEY:
        raise RuntimeError("BACKEND_API_KEY not set in agents/.env or back-end/.env")
    return {
        "X-API-Key": API_KEY,
        "X-User-Id": USER_ID,
        "Content-Type": "application/json",
    }


async def fetch_agent(base_url: str, agent_id: str) -> dict:
    import httpx
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=_headers())
        if resp.status_code != 200:
            raise Exception(f"GET agent failed: {resp.status_code} {resp.text[:200]}")
        return resp.json()


async def fetch_tree(base_url: str, bus_id: str) -> list:
    import httpx
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{base_url}/api/agents/tree", headers=_headers(), params={"busId": bus_id}
        )
        if resp.status_code != 200:
            raise Exception(f"GET tree failed: {resp.status_code} {resp.text[:200]}")
        return resp.json().get("agents", [])


async def fetch_approvals(base_url: str) -> list:
    import httpx
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{base_url}/api/attention-requests", headers=_headers())
        if resp.status_code != 200:
            return []
        return [r for r in resp.json().get("requests", []) if not r.get("answered")]


# ---------------------------------------------------------------------------
# Per-agent state extraction
# ---------------------------------------------------------------------------

def _last_message_time(msgs: List[dict]) -> Optional[datetime]:
    """Return the timestamp of the most recent message."""
    for m in reversed(msgs):
        ts = m.get("created_at", "")
        if ts:
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                continue
    return None


def _tool_errors(msgs: List[dict]) -> List[str]:
    """Extract tool error summaries from messages."""
    errors = []
    for m in msgs:
        meta = m.get("metadata", {})
        if isinstance(meta, dict) and meta.get("toolStatus") == "ERROR":
            tool = meta.get("toolName", "?")
            text = (m.get("message") or "")[:120]
            errors.append(f"{tool} — \"{text}\"")
    return errors


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def _elapsed_str(start: float) -> str:
    """Format seconds-since-start as MM:SS."""
    s = int(time.time() - start)
    return f"{s // 60:02d}:{s % 60:02d}"


def _idle_str(last_msg_time: Optional[datetime]) -> str:
    """Format idle duration from a datetime."""
    if not last_msg_time:
        return "idle ?"
    delta = datetime.now(timezone.utc) - last_msg_time
    secs = int(delta.total_seconds())
    if secs < 0:
        secs = 0
    if secs >= 60:
        return f"idle {secs // 60}m{secs % 60:02d}s"
    return f"idle {secs}s"


def _status_colored(status: str) -> str:
    if status == "COMPLETED":
        return f"{GREEN}✅ COMPLETED{RESET}"
    elif status == "FAILED":
        return f"{RED}❌ FAILED{RESET}"
    elif status in ("COST_LIMIT_REACHED", "OUT_OF_CREDITS"):
        return f"{RED}💸 {status}{RESET}"
    elif status == "PAUSED":
        return f"{YELLOW}⏸ PAUSED{RESET}"
    else:
        return f"{YELLOW}{status}{RESET}"


def _format_cell(
    elapsed: str,
    verdict: str,
    verdict_color: str,
    root_id: str,
    root_status: str,
    root_msg_count: int,
    root_cost: float,
    root_idle: str,
    root_goal: str,
    sub_agents: List[dict],
    anomalies_by_agent: Dict[str, List[str]],
    errors_by_agent: Dict[str, List[str]],
    approvals: List[dict],
    stall_warning: Optional[str] = None,
    total_elapsed: Optional[str] = None,
) -> str:
    """Build a complete poll cell with colors and box drawing."""
    lines = []

    # Header
    lines.append(f"{verdict_color}── {elapsed} {verdict} {'─' * max(0, 52 - len(verdict) - len(elapsed))}{RESET}")
    lines.append("│")

    # Root agent
    status_str = _status_colored(root_status)
    stall_str = f"  {YELLOW}{stall_warning}{RESET}" if stall_warning else ""
    elapsed_str = f"  elapsed {total_elapsed}" if total_elapsed else ""
    lines.append(f"│  {BOLD}{root_id[:12]}{RESET}  {status_str}   {root_msg_count} msgs  cost={root_cost:.1f}¢  {root_idle}{stall_str}{elapsed_str}")
    lines.append(f"│    └─ \"{root_goal[:70]}\"")

    # Root anomalies
    for a in anomalies_by_agent.get(root_id, []):
        lines.append(f"│    {RED}🚨 {a}{RESET}")
    for e in errors_by_agent.get(root_id, []):
        lines.append(f"│    {RED}❌ tool error: {e}{RESET}")

    # Sub-agents
    for sa in sub_agents:
        lines.append("│")
        sa_status = _status_colored(sa["status"])
        sa_idle = ""
        if sa["status"] not in TERMINAL_STATUSES:
            sa_idle = f"  {_idle_str(sa.get('last_msg_time'))}"
        lines.append(f"│  ┌ {CYAN}SUB-AGENT{RESET} {'─' * 49}")
        lines.append(f"│  │ {BOLD}{sa['id'][:12]}{RESET}  {sa_status}  {sa['msg_count']} msgs  cost={sa['cost']:.1f}¢{sa_idle}")
        lines.append(f"│  │ \"{sa['goal'][:70]}\"")

        # Sub-agent anomalies & errors
        sa_anomalies = anomalies_by_agent.get(sa["id"], [])
        sa_errors = errors_by_agent.get(sa["id"], [])
        if sa_anomalies or sa_errors:
            lines.append("│  │")
            for a in sa_anomalies:
                lines.append(f"│  │ {RED}🚨 {a}{RESET}")
            for e in sa_errors:
                lines.append(f"│  │ {RED}❌ tool error: {e}{RESET}")

        lines.append(f"│  └{'─' * 60}")

    # Approvals
    for req in approvals:
        lines.append("│")
        q = (req.get("question") or "")[:120]
        rid = req.get("id", "?")
        lines.append(f"│  ┌ {MAGENTA}APPROVAL{RESET} {'─' * 50}")
        lines.append(f"│  │ \"{q}\"")
        lines.append(f"│  │ request_id={rid}")
        lines.append(f"│  └{'─' * 60}")

    lines.append("│")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main monitor loop
# ---------------------------------------------------------------------------

async def monitor(agent_id: str, base_url: str, interval: int = 60, count_only_approvals: Optional[int] = None) -> int:
    start = time.time()
    prev_total_msgs = -1
    seen_approval_ids: set = set()

    print(f"{DIM}── {_elapsed_str(start)} {'─' * 56}{RESET}")
    print(f"  Monitoring agent {BOLD}{agent_id[:12]}{RESET}")
    print(f"  Polling every {interval}s. Will exit on: COMPLETED, error, or stall.")
    print()

    while True:
        await asyncio.sleep(interval)

        try:
            tree_agents = await fetch_tree(base_url, agent_id)
        except Exception as e:
            print(f"{RED}── {_elapsed_str(start)} 🔴 FETCH ERROR {'─' * 40}{RESET}")
            print(f"│  Failed to fetch agent tree: {e}")
            print("│")
            return 1

        # Find root agent and sub-agents
        root_info = None
        sub_infos = []
        for a in tree_agents:
            if a["agent_id"] == agent_id:
                root_info = a
            else:
                sub_infos.append(a)

        if not root_info:
            print(f"{RED}── {_elapsed_str(start)} 🔴 AGENT NOT FOUND {'─' * 36}{RESET}")
            print(f"│  Agent {agent_id[:12]} not in tree response")
            print("│")
            return 1

        root_status = root_info.get("status", "UNKNOWN")

        # Fetch full agent data for message transcripts
        try:
            agent_details = await asyncio.gather(
                *[fetch_agent(base_url, a["agent_id"]) for a in tree_agents],
                return_exceptions=True,
            )
        except Exception:
            agent_details = []

        # Build per-agent data
        details_map: Dict[str, dict] = {}
        for a, detail in zip(tree_agents, agent_details):
            if isinstance(detail, BaseException):
                details_map[a["agent_id"]] = {"messages": []}
            else:
                msgs = extract_message_transcript(detail)
                details_map[a["agent_id"]] = {"messages": msgs}

        # Root metrics
        root_msgs = details_map.get(agent_id, {}).get("messages", [])
        root_msg_count = len(root_msgs)
        root_cost = root_info.get("tree_cost_cents", 0) / 1.0
        root_last_msg = _last_message_time(root_msgs)
        root_idle = _idle_str(root_last_msg)
        root_goal = (root_info.get("goal") or "")[:80]

        # Total message count across entire tree
        total_msgs = sum(len(details_map.get(a["agent_id"], {}).get("messages", [])) for a in tree_agents)

        # Sub-agent data
        sub_agents = []
        for sa in sub_infos:
            sa_msgs = details_map.get(sa["agent_id"], {}).get("messages", [])
            sub_agents.append({
                "id": sa["agent_id"],
                "status": sa.get("status", "UNKNOWN"),
                "goal": (sa.get("goal") or "")[:80],
                "msg_count": len(sa_msgs),
                "cost": sa.get("tree_cost_cents", 0) / 1.0,
                "last_msg_time": _last_message_time(sa_msgs),
            })

        # Anomalies & errors per agent
        anomalies_by_agent: Dict[str, List[str]] = {}
        errors_by_agent: Dict[str, List[str]] = {}
        for a in tree_agents:
            aid = a["agent_id"]
            msgs = details_map.get(aid, {}).get("messages", [])
            anomalies_by_agent[aid] = _detect_anomalies(msgs)
            errors_by_agent[aid] = _tool_errors(msgs)

        # Check for approvals
        try:
            approvals = await fetch_approvals(base_url)
            # Filter to approvals from agents in this tree
            tree_ids = {a["agent_id"] for a in tree_agents}
            approvals = [r for r in approvals if r.get("agent_id") in tree_ids]
        except Exception:
            approvals = []

        # Stall detection: total message count unchanged since last poll
        stall_warning = None
        if prev_total_msgs >= 0 and total_msgs == prev_total_msgs:
            stall_warning = f"⚠ STALL (0 new msgs in {interval}s)"
        prev_total_msgs = total_msgs

        # Determine verdict
        has_anomalies = any(anomalies_by_agent.values())
        has_errors = any(errors_by_agent.values())
        has_terminal_failure = any(
            a.get("status") in ("FAILED", "COST_LIMIT_REACHED", "OUT_OF_CREDITS")
            for a in tree_agents
        )
        has_approvals = len(approvals) > 0

        if root_status == "COMPLETED":
            cell = _format_cell(
                elapsed=_elapsed_str(start),
                verdict="🎉 COMPLETED",
                verdict_color=GREEN,
                root_id=agent_id,
                root_status=root_status,
                root_msg_count=root_msg_count,
                root_cost=root_cost,
                root_idle=root_idle,
                root_goal=root_goal,
                sub_agents=sub_agents,
                anomalies_by_agent=anomalies_by_agent,
                errors_by_agent=errors_by_agent,
                approvals=[],
                total_elapsed=_elapsed_str(start),
            )
            print(cell)
            return 0

        elif has_approvals:
            # Track unique approval IDs
            for req in approvals:
                seen_approval_ids.add(req.get("id"))

            if count_only_approvals is not None:
                # count_only mode: don't exit, just count approvals
                target = count_only_approvals
                current = len(seen_approval_ids)
                verdict = f"🔔 COUNTING APPROVALS ({current}/{target})"
                if current >= target:
                    cell = _format_cell(
                        elapsed=_elapsed_str(start),
                        verdict=f"🎉 ALL APPROVALS RECEIVED ({current}/{target})",
                        verdict_color=GREEN,
                        root_id=agent_id,
                        root_status=root_status,
                        root_msg_count=root_msg_count,
                        root_cost=root_cost,
                        root_idle=root_idle,
                        root_goal=root_goal,
                        sub_agents=sub_agents,
                        anomalies_by_agent=anomalies_by_agent,
                        errors_by_agent=errors_by_agent,
                        approvals=approvals,
                        total_elapsed=_elapsed_str(start),
                    )
                    print(cell)
                    return 0
                else:
                    cell = _format_cell(
                        elapsed=_elapsed_str(start),
                        verdict=verdict,
                        verdict_color=MAGENTA,
                        root_id=agent_id,
                        root_status=root_status,
                        root_msg_count=root_msg_count,
                        root_cost=root_cost,
                        root_idle=root_idle,
                        root_goal=root_goal,
                        sub_agents=sub_agents,
                        anomalies_by_agent=anomalies_by_agent,
                        errors_by_agent=errors_by_agent,
                        approvals=approvals,
                    )
                    print(cell)
                    # Don't return — keep polling
            else:
                cell = _format_cell(
                    elapsed=_elapsed_str(start),
                    verdict="🔔 APPROVAL NEEDED",
                    verdict_color=MAGENTA,
                    root_id=agent_id,
                    root_status=root_status,
                    root_msg_count=root_msg_count,
                    root_cost=root_cost,
                    root_idle=root_idle,
                    root_goal=root_goal,
                    sub_agents=sub_agents,
                    anomalies_by_agent=anomalies_by_agent,
                    errors_by_agent=errors_by_agent,
                    approvals=approvals,
                )
                print(cell)
                return 2

        elif has_terminal_failure or has_anomalies or has_errors or stall_warning:
            # In count_only mode, only exit on ROOT terminal failure — sub-agent anomalies,
            # stuck tools, and stalls are expected with many concurrent agents.
            if count_only_approvals is not None:
                root_failed = root_status in ("FAILED", "COST_LIMIT_REACHED", "OUT_OF_CREDITS")
                if root_failed:
                    cell = _format_cell(
                        elapsed=_elapsed_str(start),
                        verdict="🔴 ROOT AGENT FAILED",
                        verdict_color=RED,
                        root_id=agent_id,
                        root_status=root_status,
                        root_msg_count=root_msg_count,
                        root_cost=root_cost,
                        root_idle=root_idle,
                        root_goal=root_goal,
                        sub_agents=sub_agents,
                        anomalies_by_agent=anomalies_by_agent,
                        errors_by_agent=errors_by_agent,
                        approvals=[],
                        stall_warning=stall_warning,
                    )
                    print(cell)
                    return 1
                else:
                    # Show warnings but keep polling
                    approvals_count = len(seen_approval_ids)
                    verdict = f"⚠ WARNINGS ({approvals_count}/{count_only_approvals} approvals)"
                    cell = _format_cell(
                        elapsed=_elapsed_str(start),
                        verdict=verdict,
                        verdict_color=YELLOW,
                        root_id=agent_id,
                        root_status=root_status,
                        root_msg_count=root_msg_count,
                        root_cost=root_cost,
                        root_idle=root_idle,
                        root_goal=root_goal,
                        sub_agents=sub_agents,
                        anomalies_by_agent=anomalies_by_agent,
                        errors_by_agent=errors_by_agent,
                        approvals=[],
                        stall_warning=stall_warning,
                    )
                    print(cell)
                    # Keep polling — don't return
            else:
                cell = _format_cell(
                    elapsed=_elapsed_str(start),
                    verdict="🔴 ACTION REQUIRED",
                    verdict_color=RED,
                    root_id=agent_id,
                    root_status=root_status,
                    root_msg_count=root_msg_count,
                    root_cost=root_cost,
                    root_idle=root_idle,
                    root_goal=root_goal,
                    sub_agents=sub_agents,
                    anomalies_by_agent=anomalies_by_agent,
                    errors_by_agent=errors_by_agent,
                    approvals=[],
                    stall_warning=stall_warning,
                )
                print(cell)
                return 1

        else:
            # Healthy — print status and keep polling
            cell = _format_cell(
                elapsed=_elapsed_str(start),
                verdict="🟢 HEALTHY",
                verdict_color=GREEN,
                root_id=agent_id,
                root_status=root_status,
                root_msg_count=root_msg_count,
                root_cost=root_cost,
                root_idle=root_idle,
                root_goal=root_goal,
                sub_agents=sub_agents,
                anomalies_by_agent=anomalies_by_agent,
                errors_by_agent=errors_by_agent,
                approvals=[],
            )
            print(cell)


def main():
    parser = argparse.ArgumentParser(description="Monitor a benchmark agent until stop condition")
    parser.add_argument("agent_id", help="Root agent ID to monitor")
    parser.add_argument("--url", required=True, help="Base API URL (e.g. http://localhost:3001)")
    parser.add_argument("--interval", type=int, default=60, help="Poll interval in seconds (default: 60)")
    parser.add_argument("--count-only-approvals", type=int, default=None, help="Count approvals without responding; exit 0 when N reached")
    args = parser.parse_args()

    exit_code = asyncio.run(monitor(args.agent_id, args.url, args.interval, args.count_only_approvals))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
