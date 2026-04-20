#!/usr/bin/env python3
# Benchmark harness v2
"""
Agent Benchmark Harness

Spawns real agents against prod (or localhost), polls for completion,
evaluates pass/fail, handles approvals, and stores results for comparison.

Usage:
    python benchmarks/run_benchmark.py --list
    python benchmarks/run_benchmark.py --task chat-mode
    python benchmarks/run_benchmark.py --suite basic
    python benchmarks/run_benchmark.py --suite smoke --parallel --ci   # PR smoke test
    python benchmarks/run_benchmark.py --suite all --url https://navi-j9a9.onrender.com
    python benchmarks/run_benchmark.py --compare runs/A.json runs/B.json

Auto-debug mode:
    Use the `/benchmark <task-name>` skill in Claude Code. It contains the full
    12-step auto-debug loop with monitoring, diagnosis, fix, PR, deploy, and rerun.

    Log inspection CLI (run both summaries in parallel — they answer different questions):
      python benchmarks/agent_latency.py <agent_id>           # span waterfall + slowest paths/LLMs/HTTP
      python benchmarks/agent_logs.py <agent_id> --tree --diagnostics  # event-timeline tree w/ errors
      # Expand whichever summary found the issue:
      python benchmarks/agent_latency.py <agent_id> -v
      python benchmarks/agent_logs.py <agent_id> --tree --source worker|backend|research|messages
"""

import argparse
import asyncio
import csv
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import httpx

# Add parent dir to path so we can import from agents/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from benchmarks.benchmark_tasks import (
    BenchmarkTask,
    all_tasks,
    get_smoke_cap,
    get_task_by_name,
    get_tasks_by_tag,
    list_all_tasks,
)
from benchmarks.context_validator import validate_context
from benchmarks.logs import (
    collect_logs,
    load_env_var,
    start_fly_log_collector,
    stop_fly_log_collector,
)
from benchmarks.results import BenchmarkRun, TaskResult, compare_runs
from benchmarks.timeout_history import (
    InsufficientHistoryError,
)
from benchmarks.timeout_history import (
    get_timeout as _history_get_timeout,
)
from benchmarks.timeout_history import (
    summary as _history_summary,
)
from tests.e2e.test_helpers import (
    authenticate,
)

# Defaults — benchmarks run against PROD by default (no local services needed)
DEFAULT_BASE_URL = os.environ.get(
    "BENCHMARK_BASE_URL", "https://navi-j9a9.onrender.com"
)
PROD_BASE_URL = "https://navi-j9a9.onrender.com"
POLL_INTERVAL = 5  # seconds
STALL_THRESHOLD = 120  # seconds without new messages/agents across ENTIRE tree → warning
# Per-agent early-fail threshold: if a single agent emits no new messages for
# this many seconds, fail fast instead of burning the full task timeout on a
# silent worker. Kept at ~1 min so stalled/errored agents surface quickly; real
# activities (LLM calls, tool executions) are expected to emit at least one
# message per minute. See poll_agent.
AGENT_STALL_SECONDS = 60
TREE_POLL_INTERVAL = 15  # seconds between tree-level polls (more expensive than root-only)
TEST_ASSETS_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "front-end", "public", "test-assets"
)
_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV, _BACKEND_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

class AgentNotFoundError(Exception):
    """Raised when an agent returns 404 (deleted or expired)."""
    pass

# Terminal agent statuses
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}


# ============================================================
# API helpers
# ============================================================

_cached_headers: Optional[dict] = None
_auth_mode: Optional[str] = None  # "jwt" or "api_key"

async def _api_headers() -> dict:
    """Get auth headers — JWT for prod, API key fallback. Caches after first success."""
    global _cached_headers, _auth_mode

    # If we already know API key is the only option, skip JWT attempts
    if _auth_mode == "api_key":
        return {
            "X-API-Key": API_KEY,
            "X-User-Id": USER_ID,
            "Content-Type": "application/json",
        }

    if _cached_headers and _auth_mode == "jwt":
        return dict(_cached_headers)

    try:
        auth = await authenticate()
        _cached_headers = {
            "Authorization": f"Bearer {auth['access_token']}",
            "Content-Type": "application/json",
        }
        _auth_mode = "jwt"
        return dict(_cached_headers)
    except Exception:
        # Fallback to API key auth — cache this decision
        if not API_KEY:
            raise RuntimeError("BACKEND_API_KEY env var is required when JWT auth is unavailable.")
        _auth_mode = "api_key"
        return {
            "X-API-Key": API_KEY,
            "X-User-Id": USER_ID,
            "Content-Type": "application/json",
        }


async def create_agent(
    base_url: str,
    task: BenchmarkTask,
) -> str:
    """Create a benchmark agent. Returns agent_id."""
    headers = await _api_headers()

    body: dict = {
        "goal": task.prompt,
        "model": "rose-labs/rose-1-lite",
        "source": "WEB",
        "price_limit_cents": task.price_limit_cents,
        "verifier": {
            "type": "FLOAT_LLM_JUDGE",
            "llm_judge_prompt": task.eval_prompt,
        },
    }

    if task.start_phase:
        body["start_phase"] = task.start_phase

    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(f"{base_url}/api/agents", headers=headers, json=body)
        if resp.status_code not in (200, 201):
            raise Exception(f"Failed to create agent: {resp.status_code} - {resp.text}")
        data = resp.json()
        return data["agent_id"]


async def get_agent(base_url: str, agent_id: str) -> dict:
    """GET /api/agents/:id. Raises AgentNotFoundError on 404."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
        if resp.status_code == 404:
            raise AgentNotFoundError(f"Agent {agent_id[:12]} not found (404)")
        if resp.status_code != 200:
            raise Exception(f"Failed to get agent: {resp.status_code}")
        return resp.json()


async def delete_agent(base_url: str, agent_id: str) -> None:
    """DELETE /api/agents/:id"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        await client.delete(f"{base_url}/api/agents/{agent_id}", headers=headers)


async def get_tool_usage(base_url: str, agent_id: str) -> dict:
    """GET /api/tool-usage/:id"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{base_url}/api/tool-usage/{agent_id}", headers=headers
        )
        if resp.status_code == 200:
            return resp.json()
        return {}


async def get_attention_requests(base_url: str) -> list:
    """GET /api/attention-requests — returns pending requests for current user."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{base_url}/api/attention-requests", headers=headers
        )
        if resp.status_code == 200:
            return resp.json()
        return []


async def respond_to_attention_request(
    base_url: str, request_id: str, response: str
) -> None:
    """POST /api/attention-requests/:id/respond"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        await client.post(
            f"{base_url}/api/attention-requests/{request_id}/respond",
            headers=headers,
            json={"response": response},
        )


async def get_agent_tree(base_url: str, bus_id: str) -> List[dict]:
    """GET /api/agents/tree?busId=X — all agents sharing a bus (root + descendants)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{base_url}/api/agents/tree", headers=headers, params={"busId": bus_id}
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        return data.get("agents", [])


async def post_message(base_url: str, agent_id: str, message: str) -> bool:
    """POST /api/agents/:id/messages — send a user message (unblocks send_message_to_user waits)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/agents/{agent_id}/messages",
            headers=headers,
            json={"message": message, "role": "USER"},
        )
        return resp.status_code in (200, 201)


async def pause_agent(base_url: str, agent_id: str) -> bool:
    """POST /api/agents/:id/pause — pause root agent (children discover via polling)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{base_url}/api/agents/{agent_id}/pause", headers=headers)
        return resp.status_code in (200, 204)


async def post_attachment_message(
    base_url: str, agent_id: str, file_pointers: List[dict]
) -> bool:
    """POST /api/agents/:id/messages with file attachments so the agent can see them."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/agents/{agent_id}/messages",
            headers=headers,
            json={"message": "", "role": "USER", "attachments": file_pointers},
        )
        return resp.status_code in (200, 201)


async def upload_attachment(
    base_url: str, agent_id: str, filepath: str
) -> Optional[dict]:
    """Upload a file attachment for an agent. Returns FilePointer or None."""
    headers = await _api_headers()
    # Remove Content-Type — httpx sets multipart boundary automatically
    headers.pop("Content-Type", None)

    filename = os.path.basename(filepath)
    async with httpx.AsyncClient(timeout=60) as client:
        with open(filepath, "rb") as f:
            resp = await client.post(
                f"{base_url}/api/agents/{agent_id}/attachments",
                headers=headers,
                files={"file": (filename, f)},
            )
        if resp.status_code in (200, 201):
            data = resp.json()
            return data.get("file_pointer") or data.get("filePointer")
        else:
            print(f"    ⚠ Attachment upload failed: {resp.status_code} - {resp.text[:200]}")
            return None


# ============================================================
# Polling loop
# ============================================================

async def _fetch_tree_stats(base_url: str, agent_id: str) -> dict:
    """
    Fetch tree-level aggregate stats for stall detection and progress reporting.

    Returns dict with:
        agent_count, total_messages, total_cost_cents, active_count, failed_count,
        error_agents (list of dicts with agent_id, status, error details),
        all_agents (list of raw agent dicts from tree API)
    """
    try:
        agents = await get_agent_tree(base_url, agent_id)
        if not agents:
            return {"agent_count": 0, "total_messages": 0, "total_cost_cents": 0,
                    "active_count": 0, "failed_count": 0, "error_agents": [], "all_agents": []}

        total_msgs = sum(a.get("message_count", 0) for a in agents)
        total_cost = sum(a.get("tree_cost_cents", 0) for a in agents)
        active = [a for a in agents if a.get("status") == "ACTIVE"]
        failed = [a for a in agents if a.get("status") in ("FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED")]

        return {
            "agent_count": len(agents),
            "total_messages": total_msgs,
            "total_cost_cents": total_cost,
            "active_count": len(active),
            "failed_count": len(failed),
            "error_agents": [{"agent_id": a.get("agent_id", "")[:12], "status": a.get("status")}
                             for a in failed],
            "all_agents": agents,
        }
    except Exception:
        return {"agent_count": 0, "total_messages": 0, "total_cost_cents": 0,
                "active_count": 0, "failed_count": 0, "error_agents": [], "all_agents": []}


def suite_name_for_error(args) -> str:
    """Best-effort suite label for error messages — mirrors what the user ran."""
    if args.suite:
        return args.suite
    if args.task:
        return f"--task {args.task}"
    return "smoke"


def _detect_infra_errors_from_fly(agent_ids: List[str]) -> List[str]:
    """
    Scan Fly.io streaming logs for infrastructure-level errors across all agents.
    Returns list of error descriptions.
    """
    from benchmarks.logs import _fly_collector
    if not _fly_collector:
        return []

    errors = []
    for aid in agent_ids:
        logs = _fly_collector.get_logs_for_agent(aid)
        for log_line in logs:
            ll = log_line.lower()
            if any(kw in ll for kw in (
                "session limit reached", "429", "too many requests",
                "connection refused", "all reconnection attempts failed",
                "oom", "out of memory", "killed",
            )):
                errors.append(log_line[:200])
    return errors


async def poll_agent(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
) -> Tuple[dict, int, int, Optional[str]]:
    """
    Poll agent until terminal state, timeout, or early-failure.
    Monitors the ENTIRE agent tree for stall detection, not just the root.

    Returns: (final_agent_data, approvals_triggered, approvals_resolved, early_fail_reason)
    early_fail_reason is non-None when a fail-fast condition tripped (per-agent
    stall, context validation error, dynamic timeout). The caller overrides
    pass→fail based on this.
    """
    start = time.time()
    last_activity_time = start  # tracks ANY activity across the entire tree
    prev_tree_message_count = 0
    prev_tree_agent_count = 0
    prev_tree_cost = 0
    prev_root_message_count = 0
    approvals_triggered = 0
    approvals_resolved = 0
    replied_waiting_msgs: set = set()  # track isWaitingForUser messages we've already replied to
    last_tree_poll = 0.0  # timestamp of last tree-level poll
    last_progress_print = 0.0  # timestamp of last progress log
    last_tree_stats: dict = {}  # cached tree stats
    last_violation_count = 0  # track violations to only print new ones
    # Per-agent stall tracking: agent_id → {count, last_change_time, status}.
    # Includes the root plus every descendant appearing in the tree endpoint.
    per_agent_state: Dict[str, dict] = {}

    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)

    while True:
        elapsed = time.time() - start
        if elapsed > resolved_timeout:
            reason = (
                f"Timeout after {elapsed:.0f}s (dynamic cap={resolved_timeout}s)"
                f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}"
            )
            print(f"    ⏰ {reason}")
            data = await get_agent(base_url, agent_id)
            return data, approvals_triggered, approvals_resolved, reason

        # Hot-path HTTP — fetch root agent and (if the task handles approvals)
        # attention-requests in parallel. Saves ~150ms per poll.
        fetch_approvals_now = task.approval_handling in ("auto_approve", "ignore", "prompt_user")
        try:
            if fetch_approvals_now:
                data, _pending_attention = await asyncio.gather(
                    get_agent(base_url, agent_id),
                    get_attention_requests(base_url),
                    return_exceptions=False,
                )
            else:
                data = await get_agent(base_url, agent_id)
                _pending_attention = []
        except AgentNotFoundError:
            print(f"    ⚠ Agent {agent_id[:12]} returned 404 — deleted or expired")
            return (
                {"agent": {"status": "DELETED"}, "messages": []},
                approvals_triggered, approvals_resolved,
                "Agent returned 404",
            )
        except Exception as e:
            print(f"    ⚠ Poll error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
            continue

        agent = data.get("agent", {})
        status = agent.get("status", "UNKNOWN")
        messages = data.get("messages", [])
        root_msg_count = len(messages)

        # Validate context well-formedness. Any error-severity violation is an
        # instant fail — don't keep polling, the agent will not recover.
        # Skip tool_result_pairing during polling — tools may still be executing.
        violations = validate_context(messages)
        poll_violations = [v for v in violations if v.rule != "tool_result_pairing"]
        if len(poll_violations) > last_violation_count:
            new_violations = poll_violations[last_violation_count:]
            errors = [v for v in new_violations if v.severity == "error"]
            warnings = [v for v in new_violations if v.severity == "warning"]
            if errors:
                print(f"    🚨 CONTEXT ERRORS ({len(errors)}):")
                for v in errors:
                    print(f"       [{v.rule}] {v.message}")
            if warnings:
                for v in warnings[:3]:
                    print(f"    ⚠ [{v.rule}] {v.message}")
            last_violation_count = len(poll_violations)
            if errors:
                reason = f"Context validation error: [{errors[0].rule}] {errors[0].message}"
                return data, approvals_triggered, approvals_resolved, reason

        # Chat mode: done when we have ASSISTANT responses
        if task.is_chat_mode:
            assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
            if len(assistant_msgs) >= 1:
                return data, approvals_triggered, approvals_resolved, None

        # Agent mode: done on terminal status
        if status in TERMINAL_STATUSES:
            return data, approvals_triggered, approvals_resolved, None

        # ── Tree-level stall detection ──────────────────────────────
        # Periodically fetch tree stats (every TREE_POLL_INTERVAL seconds)
        now = time.time()
        if now - last_tree_poll >= TREE_POLL_INTERVAL:
            last_tree_poll = now
            tree_stats = await _fetch_tree_stats(base_url, agent_id)
            last_tree_stats = tree_stats

            tree_total_msgs = tree_stats["total_messages"]
            tree_agent_count = tree_stats["agent_count"]
            tree_cost = tree_stats["total_cost_cents"]

            # Activity check: tree API message_count lags behind reality,
            # so we use MULTIPLE signals: tree message count, root real message count,
            # tree agent count (new agents appearing), and tree cost (LLM calls happening)
            activity_detected = False
            if tree_total_msgs > prev_tree_message_count:
                activity_detected = True
                prev_tree_message_count = tree_total_msgs
            if root_msg_count > prev_root_message_count:
                activity_detected = True
            if tree_agent_count > prev_tree_agent_count:
                activity_detected = True
                prev_tree_agent_count = tree_agent_count
            if tree_cost > prev_tree_cost:
                activity_detected = True
                prev_tree_cost = tree_cost

            if activity_detected:
                last_activity_time = now
            prev_root_message_count = root_msg_count

            stall_seconds = now - last_activity_time
            if stall_seconds > STALL_THRESHOLD:
                print(f"    ⚠ TREE STALL: {stall_seconds:.0f}s since last message across "
                      f"{tree_stats['agent_count']} agents ({tree_total_msgs} total msgs)")

            # ── Per-agent stall detection (early fail) ────────────────
            # For each non-terminal agent in the tree: if its message_count
            # hasn't advanced in AGENT_STALL_SECONDS, fail now and name the
            # stuck agent. Finished sub-agents (terminal status) are skipped —
            # they naturally stop producing messages.
            # For the ROOT agent, the tree API's message_count lags the detail
            # API (e.g. in-process browser/claude-code sub-agents emit messages
            # into root's list but don't increment the tree counter). Use the
            # detail-API root_msg_count for root tracking so legitimate
            # progress isn't flagged as a stall.
            for a in tree_stats.get("all_agents", []):
                aid = a.get("agent_id", "")
                if not aid:
                    continue
                mc = root_msg_count if aid == agent_id else int(a.get("message_count", 0) or 0)
                st = a.get("status", "UNKNOWN")
                cur = per_agent_state.get(aid)
                if cur is None:
                    per_agent_state[aid] = {"count": mc, "last_change_time": now, "status": st}
                    continue
                if mc > cur["count"]:
                    cur["count"] = mc
                    cur["last_change_time"] = now
                cur["status"] = st

            # Build parent→children map from the tree. An agent with active
            # descendants that are still advancing is NOT stalled — it's
            # legitimately idle awaiting its sub-agent's tool result.
            children_of: Dict[str, List[str]] = {}
            for a in tree_stats.get("all_agents", []):
                pid = a.get("parent_agent_id")
                cid = a.get("agent_id")
                if pid and cid:
                    children_of.setdefault(pid, []).append(cid)

            def _subtree_last_change(aid: str, seen: set) -> float:
                if aid in seen:
                    return 0.0
                seen.add(aid)
                st_local = per_agent_state.get(aid)
                best = st_local["last_change_time"] if st_local else 0.0
                for cid in children_of.get(aid, []):
                    child_st = per_agent_state.get(cid)
                    if child_st and child_st["status"] in TERMINAL_STATUSES:
                        continue
                    best = max(best, _subtree_last_change(cid, seen))
                return best

            stuck: List[Tuple[str, float, dict]] = []
            for aid, st in per_agent_state.items():
                if st["status"] in TERMINAL_STATUSES:
                    continue
                effective = _subtree_last_change(aid, set())
                idle = now - effective
                if idle > AGENT_STALL_SECONDS:
                    stuck.append((aid, idle, st))
            if stuck:
                aid, idle, st = stuck[0]
                role = "root" if aid == agent_id else "sub-agent"
                reason = (
                    f"{role} {aid[:12]} stalled: no new messages for {idle:.0f}s "
                    f"(threshold={AGENT_STALL_SECONDS}s, status={st['status']}, "
                    f"messages={st['count']})"
                    f" | Investigate: python agents/benchmarks/agent_latency.py {aid}"
                )
                print(f"    🛑 AGENT STALL — {reason}")
                return data, approvals_triggered, approvals_resolved, reason

            # Check for infrastructure errors in Fly.io logs
            all_agent_ids = [a.get("agent_id", "") for a in tree_stats.get("all_agents", [])]
            if all_agent_ids:
                infra_errors = _detect_infra_errors_from_fly(all_agent_ids)
                if infra_errors:
                    unique_errors = list(set(infra_errors))[:5]
                    print(f"    🔥 INFRA ERRORS ({len(infra_errors)} total across tree):")
                    for err in unique_errors:
                        print(f"       {err}")

            # Report failed agents
            if tree_stats["failed_count"] > 0:
                for ea in tree_stats["error_agents"][:3]:
                    print(f"    ❌ Agent {ea['agent_id']} → {ea['status']}")
        else:
            # Between tree polls, still track root message activity
            if root_msg_count > prev_root_message_count:
                last_activity_time = now
                prev_root_message_count = root_msg_count

        # Auto-reply to send_message_to_user questions (isWaitingForUser)
        # These block the workflow until a user message is posted back.
        # The flag can be at metadata.isWaitingForUser OR metadata.sendMessageToUser.isWaitingForUser
        for m in messages:
            meta = m.get("metadata", {})
            if not isinstance(meta, dict):
                continue
            msg_id = m.get("message_id") or m.get("id", "")
            is_waiting = (
                meta.get("isWaitingForUser")
                or (isinstance(meta.get("sendMessageToUser"), dict)
                    and meta["sendMessageToUser"].get("isWaitingForUser"))
            )
            if is_waiting and msg_id and msg_id not in replied_waiting_msgs:
                replied_waiting_msgs.add(msg_id)
                question = (m.get("text") or m.get("message") or "")[:200]
                print(f"    💬 Agent asked a question: {question}")
                print("    → Auto-replying to unblock workflow")
                try:
                    await post_message(
                        base_url, agent_id,
                        "Please do not ask me anymore questions. I trust your judgment, intuition, "
                        "and ability to make reasonable assumptions. Please proceed with the task. "
                        "All files have been uploaded as attachments and should be available in your context."
                    )
                except Exception as e:
                    print(f"    ⚠ Auto-reply failed: {e}")

        # Handle approval requests (check entire agent tree, not just root)
        tree_agent_ids = {agent_id}  # always include root
        if last_tree_stats.get("all_agents"):
            tree_agent_ids.update(
                a.get("agent_id", "") for a in last_tree_stats["all_agents"] if a.get("agent_id")
            )
        if fetch_approvals_now:
            try:
                pending = _pending_attention
                for req in pending:
                    req_agent_id = req.get("agentId") or req.get("agent_id", "")
                    if req_agent_id in tree_agent_ids and not req.get("response"):
                        approvals_triggered += 1
                        req_id = req.get("id")
                        if task.approval_handling == "auto_approve":
                            if req_id:
                                await respond_to_attention_request(
                                    base_url, req_id, "approved"
                                )
                                approvals_resolved += 1
                                print(f"    ✅ Auto-approved attention request {req_id[:8]}")
                        elif task.approval_handling == "prompt_user":
                            if req_id:
                                question = req.get("question", req.get("message", "(no details)"))
                                print(f"\n    🔔 APPROVAL REQUIRED: {question[:200]}")
                                if not sys.stdin.isatty():
                                    print(f"    ⚠ Non-interactive environment — auto-denying {req_id[:8]}")
                                    await respond_to_attention_request(
                                        base_url, req_id, "denied"
                                    )
                                    continue
                                loop = asyncio.get_event_loop()
                                answer = (await loop.run_in_executor(None, input, "    Approve? [y/n]: ")).strip().lower()
                                if answer in ("y", "yes"):
                                    await respond_to_attention_request(
                                        base_url, req_id, "approved"
                                    )
                                    approvals_resolved += 1
                                    print(f"    ✅ User approved {req_id[:8]}")
                                else:
                                    await respond_to_attention_request(
                                        base_url, req_id, "denied"
                                    )
                                    print(f"    ❌ User denied {req_id[:8]}")
            except Exception as e:
                print(f"    ⚠ Approval check error: {e}")

        # Progress log — show tree-level stats every 30s
        if now - last_progress_print >= 30:
            last_progress_print = now
            ts = last_tree_stats
            if ts:
                tree_cost = ts.get("total_cost_cents", 0)
                tree_agents = ts.get("agent_count", 0)
                tree_active = ts.get("active_count", 0)
                tree_failed = ts.get("failed_count", 0)
                print(f"    ... {status} | {tree_agents} agents ({tree_active} active, {tree_failed} failed) | "
                      f"{root_msg_count} root msgs | {tree_cost}c | {elapsed:.0f}s")
            else:
                print(f"    ... {status} ({root_msg_count} root msgs, {elapsed:.0f}s)")

        await asyncio.sleep(POLL_INTERVAL)


# ============================================================
# Evaluation
# ============================================================

def evaluate_task(
    task: BenchmarkTask,
    data: dict,
    approvals_triggered: int,
) -> Tuple[bool, Optional[str]]:
    """
    Evaluate whether a task passed based on agent data.
    Returns: (passed, failure_reason)
    """
    agent = data.get("agent", {})
    status = agent.get("status", "UNKNOWN")
    messages = data.get("messages", [])
    progress = agent.get("progress", 0)

    # Chat mode: just needs ASSISTANT response
    if task.is_chat_mode:
        assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
        if len(assistant_msgs) == 0:
            return False, "No assistant response received"
        return True, None

    # Ignore-mode: agent will stall waiting for approval — we only check
    # that the approval was actually triggered (the agent won't complete).
    if task.approval_handling == "ignore":
        if approvals_triggered == 0:
            return False, "Expected approval request (to ignore) but none were triggered"
        return True, None

    # Agent mode: must complete
    if status != "COMPLETED":
        return False, f"Agent status: {status} (expected COMPLETED)"

    # Check expected tools were called
    all_metadata = " ".join(
        json.dumps(m.get("metadata", {})) for m in messages if m.get("metadata")
    ).lower()

    for tool in task.expected_tools:
        if tool.lower() not in all_metadata:
            return False, f"Expected tool '{tool}' not found in messages"

    # Check approval expectations
    if task.approval_handling in ("auto_approve", "prompt_user") and approvals_triggered == 0:
        return False, "Expected approval requests but none were triggered"

    # Progress score check (verifier gave a score)
    if progress < 0.5:
        return False, f"Low progress score: {progress:.2f}"

    return True, None


# ============================================================
# CSV row slicing
# ============================================================

def slice_csv(filepath: str, row_start: int, row_end: int) -> str:
    """
    Slice a CSV file to only include data rows [row_start, row_end] (1-indexed, inclusive).
    Returns path to a temp CSV file with the header + sliced rows.
    """
    with open(filepath, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        rows = list(reader)

    # Convert to 0-indexed
    start_idx = row_start - 1
    end_idx = row_end  # inclusive, so don't subtract 1
    sliced = rows[start_idx:end_idx]

    if not sliced:
        raise ValueError(f"No rows in range [{row_start}, {row_end}] (CSV has {len(rows)} data rows)")

    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".csv", prefix="benchmark-slice-", delete=False, newline=""
    )
    writer = csv.writer(tmp)
    writer.writerow(header)
    writer.writerows(sliced)
    tmp.close()
    print(f"    ✂ Sliced CSV rows {row_start}-{row_end} ({len(sliced)} rows) → {os.path.basename(tmp.name)}")
    return tmp.name


# ============================================================
# Run a single task
# ============================================================

async def run_single_task(
    base_url: str,
    task: BenchmarkTask,
) -> TaskResult:
    """Run a single benchmark task. Returns TaskResult."""
    resolved_timeout = getattr(task, "_resolved_timeout_seconds", task.timeout_seconds)
    print(f"\n  {'='*50}")
    print(f"  📋 {task.name}: {task.title}")
    print(f"     timeout={resolved_timeout}s, price_limit={task.price_limit_cents}c")
    all_attachments = task.attachments or ([task.attachment] if task.attachment else [])
    if all_attachments:
        print(f"     attachments={all_attachments}")
    if task.approval_handling:
        print(f"     approval={task.approval_handling}")
    print(f"  {'='*50}")

    start = time.time()
    start_time = datetime.now(timezone.utc)
    agent_id = ""

    temp_csv_paths: list = []  # track temp files for cleanup

    try:
        # Handle attachments: create agent first, upload files, then post file messages
        if all_attachments:
            agent_id = await create_agent(base_url, task)
            print(f"    Agent created: {agent_id[:12]}...")

            file_pointers = []
            for attach_filename in all_attachments:
                filepath = os.path.join(TEST_ASSETS_DIR, attach_filename)
                if not os.path.exists(filepath):
                    raise FileNotFoundError(f"Test asset not found: {filepath}")

                # Slice CSV if row_start/row_end are set
                if filepath.endswith(".csv") and task.row_start is not None and task.row_end is not None:
                    filepath = slice_csv(filepath, task.row_start, task.row_end)
                    temp_csv_paths.append(filepath)

                print(f"    Uploading {attach_filename}...")
                fp = await upload_attachment(base_url, agent_id, filepath)
                if fp:
                    file_pointers.append(fp)
                    print("    ✅ Uploaded, FilePointer received")
                else:
                    print("    ⚠ Upload returned no FilePointer, continuing anyway")

            # Post a message with all file pointers so the agent can see them
            if file_pointers:
                await post_attachment_message(base_url, agent_id, file_pointers)
                print(f"    📎 Posted {len(file_pointers)} file(s) as agent message")
        else:
            agent_id = await create_agent(base_url, task)
            print(f"    Agent created: {agent_id[:12]}...")

        # Poll until done (or early-fail)
        data, approvals_triggered, approvals_resolved, early_fail_reason = await poll_agent(
            base_url, agent_id, task
        )

        # Get final agent data
        agent = data.get("agent", {})
        messages = data.get("messages", [])
        duration = time.time() - start

        # Get cost from tool usage
        cost_cents = 0.0
        try:
            usage = await get_tool_usage(base_url, agent_id)
            cost_cents = usage.get("total_cost_cents", 0)
        except Exception:
            # Fallback to agent-level cost fields
            cost_cents = agent.get("tree_cost_cents", 0) or agent.get("tool_cost_cents", 0)

        # Evaluate — early-fail reasons (per-agent stall, context error, timeout)
        # override a pass. evaluate_task still runs so post-completion checks
        # (expected tools, progress score) can provide additional diagnostics.
        passed, failure_reason = evaluate_task(task, data, approvals_triggered)
        if early_fail_reason:
            passed = False
            if not failure_reason:
                failure_reason = early_fail_reason
            else:
                failure_reason = f"{early_fail_reason} | {failure_reason}"

        # Final context well-formedness check
        final_violations = validate_context(messages)
        context_violation_dicts = [v.to_dict() for v in final_violations]
        context_errors = [v for v in final_violations if v.severity == "error"]
        if context_errors and passed:
            # Override pass → fail if context has well-formedness errors
            passed = False
            failure_reason = f"Context well-formedness errors: {context_errors[0].message}"
        if final_violations:
            error_count = len(context_errors)
            warn_count = len(final_violations) - error_count
            print(f"    Context validation: {error_count} errors, {warn_count} warnings")

        # Collect prod logs for diagnostics
        print("    Collecting prod logs...")
        logs = await collect_logs(agent_id, data, start_time)
        log_summary = []
        for key, label in [("backend_logs", "backend"), ("worker_logs", "worker"), ("research_logs", "research")]:
            entries = logs.get(key, [])
            log_summary.append(f"{label}={len(entries)}")
        log_summary.append(f"messages={len(logs.get('messages', []))}")
        print(f"    Logs collected: {', '.join(log_summary)}")

        result = TaskResult(
            name=task.name,
            passed=passed,
            agent_id=agent_id,
            status=agent.get("status", "UNKNOWN"),
            progress_score=agent.get("progress", 0),
            duration_seconds=round(duration, 1),
            cost_cents=round(cost_cents, 2),
            message_count=len(messages),
            failure_reason=failure_reason,
            approvals_triggered=approvals_triggered,
            approvals_resolved=approvals_resolved,
            context_violations=context_violation_dicts,
            logs=logs,
        )

        icon = "✅" if passed else "❌"
        print(f"\n    {icon} {task.name}: {'PASS' if passed else 'FAIL'}")
        if failure_reason:
            print(f"       Reason: {failure_reason}")
        print(f"       Duration: {duration:.1f}s | Cost: {cost_cents:.1f}c | Messages: {len(messages)}")

        # Clean up: delete the agent now that we've collected all data
        try:
            await delete_agent(base_url, agent_id)
            print(f"    🗑  Deleted agent {agent_id[:12]}")
        except Exception:
            print(f"    ⚠ Failed to delete agent {agent_id[:12]}")

        return result

    except Exception as e:
        duration = time.time() - start
        print(f"\n    ❌ {task.name}: ERROR - {type(e).__name__}: {e}")
        # Best-effort log collection — errors are when logs matter most
        logs = None
        if agent_id:
            try:
                logs = await collect_logs(agent_id, {}, start_time)
            except Exception:
                pass
            try:
                await delete_agent(base_url, agent_id)
                print(f"    🗑  Deleted orphaned agent {agent_id[:12]}")
            except Exception:
                print(f"    ⚠ Failed to delete orphaned agent {agent_id[:12]}")
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id=agent_id,
            status="ERROR",
            progress_score=0,
            duration_seconds=round(duration, 1),
            cost_cents=0,
            message_count=0,
            failure_reason=(
                f"{e}"
                + (f" | Investigate: python agents/benchmarks/agent_latency.py {agent_id}" if agent_id else "")
            ),
            logs=logs,
        )
    finally:
        for tmp in temp_csv_paths:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ============================================================
# Main
# ============================================================

def resolve_tasks(args) -> List[BenchmarkTask]:
    """Resolve which tasks to run from CLI args."""
    if args.task:
        return [get_task_by_name(args.task)]
    elif args.suite:
        if args.suite == "all":
            return all_tasks()
        return get_tasks_by_tag(args.suite)
    else:
        return all_tasks()


async def _warmup_edge_functions(base_url: str):
    """Send a small completion request to warm up the local Supabase edge function.

    The Deno runtime in local Supabase needs to resolve external DNS (OpenRouter,
    Anthropic, etc.) on the first request. This often fails with 503 "name resolution
    failed" for the first few seconds. A warmup ensures DNS is cached before
    benchmarks start — particularly important for chat-mode which has no Temporal
    activity retries.
    """
    # Derive research port from backend port (CONDUCTOR_PORT + 3)
    research_port = os.environ.get("RESEARCH_PORT")
    if not research_port:
        try:
            backend_port = int(base_url.rsplit(":", 1)[1].split("/")[0])
            research_port = str(backend_port + 3)
        except (ValueError, IndexError):
            return

    completions_url = f"http://localhost:{research_port}/functions/v1/completions"
    anon_key = os.environ.get("SUPABASE_ANON_KEY", os.environ.get("VITE_SUPABASE_ANON_KEY", ""))
    api_key = os.environ.get("ROSE_API_KEY", "")
    if not anon_key:
        print("  ⚠ Skipping edge function warmup (no SUPABASE_ANON_KEY)")
        return

    payload = {
        "model": "rose-labs/rose-1-lite",
        "messages": [{"role": "user", "content": "Say hi"}],
        "max_tokens": 5,
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {anon_key}",
        "x-api-key": api_key,
    }

    print("  🔥 Warming up edge functions (DNS resolution)...", end="", flush=True)
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
        for attempt in range(1, 11):
            try:
                resp = await client.post(completions_url, json=payload, headers=headers)
                if 200 <= resp.status_code < 300:
                    print(f" ready ({attempt} attempt(s))", flush=True)
                    return
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout, Exception) as e:
                if attempt == 1:
                    print(f" (attempt {attempt}: {type(e).__name__})", end="", flush=True)
            await asyncio.sleep(2)
    print(" ⚠ warmup did not succeed after 10 attempts (continuing anyway)", flush=True)


async def _terminate_stale_workflows():
    """Terminate all running Temporal workflows on the local task queue.

    Stale workflows from previous benchmark runs continue dispatching activities
    to the new worker, flooding the backend with 404s for deleted agents and
    consuming DB connections + LLM quota. Clearing them before a new run
    prevents cascading resource exhaustion.
    """
    try:
        from temporalio.client import Client, TLSConfig

        from config import load_config

        config = load_config()

        # Safety check: terminate workflows only when we can prove the queue is
        # worktree-scoped. Local Temporal, a worktree-derived queue (via
        # CONDUCTOR_WORKSPACE_NAME), or explicit ALLOW_TEMPORAL_CLEANUP=true all
        # qualify. Cloud Temporal with a shared queue does not — that could
        # nuke another worktree's live runs.
        temporal_addr = config.temporal.address
        is_local = any(h in temporal_addr for h in ("localhost", "127.0.0.1"))
        allow_cleanup = os.environ.get("ALLOW_TEMPORAL_CLEANUP", "").lower() == "true"
        is_worktree_scoped = bool(os.environ.get("CONDUCTOR_WORKSPACE_NAME"))
        if not is_local and not allow_cleanup and not is_worktree_scoped:
            print(f"  ⚠ Skipping workflow cleanup — Temporal address ({temporal_addr}) is not local, queue is not worktree-scoped, and ALLOW_TEMPORAL_CLEANUP is not set")
            return

        # Inside Conductor, run.sh overrides TEMPORAL_TASK_QUEUE to
        # navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME for the worker. The default
        # TEMPORAL_TASK_QUEUE from .env (e.g. navi-agent-tasks-test) is shared
        # across worktrees and is NOT what the local worker polls. Prefer the
        # workspace-derived queue so cleanup targets the same queue the worker
        # is actually polling.
        workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
        derived = f"navi-agent-tasks-{workspace}" if workspace else None
        task_queue = (
            derived
            or os.environ.get("TEMPORAL_TASK_QUEUE")
            or config.temporal.task_queue
        )

        client = await Client.connect(
            config.temporal.address,
            namespace=config.temporal.namespace,
            tls=TLSConfig(client_cert=None, client_private_key=None),
            rpc_metadata={
                "temporal-namespace": config.temporal.namespace,
                "Authorization": f"Bearer {config.temporal.api_key}",
            },
        )

        query = f'TaskQueue = "{task_queue}" AND ExecutionStatus = "Running"'
        count = (await client.count_workflows(query)).count
        if count == 0:
            print(f"  ✅ No stale workflows on {task_queue}")
            return

        print(f"  🧹 Terminating {count} stale workflow(s) on {task_queue}...")
        terminated = 0
        async for wf in client.list_workflows(query):
            try:
                handle = client.get_workflow_handle(wf.id, run_id=wf.run_id)
                await handle.terminate(reason="Pre-benchmark cleanup of stale workflows")
                terminated += 1
            except Exception:
                pass  # Already completed/terminated — safe to ignore
        print(f"  ✅ Terminated {terminated} stale workflow(s)")
    except Exception as e:
        print(f"  ⚠ Could not clean stale workflows: {e}")


async def _fail_stale_active_agents():
    """Mark any Agent rows stuck in ACTIVE for >30 min as FAILED.

    These are orphans from aborted prior runs — their workflow was terminated
    (or never finished) but the DB row was left ACTIVE. Without this cleanup,
    the backend's agent-scoped polling + realtime listeners keep firing on
    ghosts and the next smoke run sees confusing stats.

    Runs via `docker exec psql` against the worktree's DB container so no
    psycopg/asyncpg dependency is introduced. Skipped silently if the
    container isn't running (run.sh will start a fresh one).
    """
    import subprocess

    workspace = os.environ.get("CONDUCTOR_WORKSPACE_NAME")
    if not workspace:
        return
    container = f"victoria-db-{workspace}"
    ps = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{container}$", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if container not in ps.stdout:
        return

    sql = (
        'UPDATE "Agent" SET status = \'FAILED\', "updatedAt" = NOW() '
        'WHERE status = \'ACTIVE\' AND "createdAt" < NOW() - INTERVAL \'30 minutes\' '
        "RETURNING id;"
    )
    try:
        result = subprocess.run(
            ["docker", "exec", container, "psql", "-U", "postgres", "-d", "victoria",
             "-t", "-A", "-c", sql],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            ids = [line for line in result.stdout.splitlines() if line.strip() and line[0].isalnum()]
            if ids:
                print(f"  🧹 Marked {len(ids)} stale ACTIVE agent(s) as FAILED")
            else:
                print("  ✅ No stale ACTIVE agents")
        else:
            print(f"  ⚠ Stale-agent SQL failed: {result.stderr.strip()}")
    except Exception as e:
        print(f"  ⚠ Could not run stale-agent cleanup: {e}")


async def _check_claude_code_credentials(base_url: str) -> bool:
    """Check if Claude Code OAuth credentials are available for the benchmark user.

    Returns True if valid credentials exist, False otherwise.
    """
    try:
        headers = await _api_headers()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{base_url}/api/integrations/claude-code/credentials/token",
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                return bool(data.get("accessToken") or data.get("token"))
            return False
    except Exception:
        return False


async def main_async(args):
    if args.list:
        print("\nBenchmark Tasks:")
        print(f"  {'Name':<25} {'Title':<35} {'Tags'}")
        print(f"  {'-'*80}")
        list_all_tasks()
        return

    if args.compare:
        if len(args.compare) != 2:
            print("--compare requires exactly 2 file paths")
            sys.exit(1)
        compare_runs(args.compare[0], args.compare[1])
        return

    # Resolve base URL: --url > --prod > --port > error
    if args.url != DEFAULT_BASE_URL:
        # User explicitly passed --url — it takes priority
        base_url = args.url.rstrip("/")
        if args.prod:
            print("  ⚠ --prod and --url both set. Using --url value.")
    elif args.prod:
        base_url = PROD_BASE_URL
    elif args.port:
        base_url = f"http://localhost:{args.port}"
    else:
        print("ERROR: --port N is required for local runs.")
        print("Example: python benchmarks/run_benchmark.py --suite smoke --port 3001")
        sys.exit(1)

    tasks = resolve_tasks(args)
    if not tasks:
        print("No tasks matched. Use --list to see available tasks.")
        sys.exit(1)

    # Apply CLI row overrides to all tasks
    if args.row_start is not None or args.row_end is not None:
        for t in tasks:
            if args.row_start is not None:
                t.row_start = args.row_start
            if args.row_end is not None:
                t.row_end = args.row_end

    # Authenticate
    print("\n  Authenticating...")
    try:
        await authenticate()
        print("  ✅ Authenticated")
    except Exception as e:
        print(f"  ⚠ Auth failed ({e}), falling back to API key")

    # Pre-flight for local runs: clean stale workflows + DB agents, warm up edge functions.
    # Cleanup invariant: at most 1 of each service per worktree; no ACTIVE agent orphans
    # on the task queue this run will use. Belt-and-braces with scripts/pre-smoke-cleanup.sh
    # (which handles the process/container side); this block handles the Temporal + DB side.
    if not args.prod and base_url.startswith("http://localhost"):
        await _terminate_stale_workflows()
        await _fail_stale_active_agents()
        await _warmup_edge_functions(base_url)

    # Pre-flight: check Claude Code credentials for tests that need them
    skipped_claude_tasks: List[BenchmarkTask] = []
    claude_code_tasks = [t for t in tasks if t.requires_claude_code]
    if claude_code_tasks:
        has_claude_creds = await _check_claude_code_credentials(base_url)
        if not has_claude_creds:
            skipped_names = [t.name for t in claude_code_tasks]
            print(f"  ⚠ Claude Code credentials unavailable — skipping: {', '.join(skipped_names)}")
            skipped_claude_tasks = claude_code_tasks
            tasks = [t for t in tasks if not t.requires_claude_code]

    # Pre-flight: resolve per-task timeout from history corpus.
    # In bootstrap mode, always use tasks.json timeout_seconds as the ceiling — passes
    # recorded this run seed/extend the corpus for future dynamic caps. This lets
    # bootstrap widen the cap when infra slowdown has pushed real durations past the
    # existing p95 (otherwise the tight dynamic cap kills every run before it can pass).
    # In non-bootstrap mode, any task lacking history is a hard error.
    missing_history: List[str] = []
    for t in tasks:
        if args.bootstrap:
            t._resolved_timeout_seconds = t.timeout_seconds
            s = _history_summary(t.name, max_seconds=get_smoke_cap(t.name))
            print(f"  🔧 bootstrap: {t.name} → {t.timeout_seconds}s "
                  f"(history n={s['count']}, recent_max={s['recent_max']}s)")
            continue
        cap = get_smoke_cap(t.name)
        try:
            t._resolved_timeout_seconds = _history_get_timeout(t.name, max_seconds=cap)
        except InsufficientHistoryError as e:
            missing_history.append(f"{t.name} ({e.have}/{e.need})")
        else:
            s = _history_summary(t.name, max_seconds=cap)
            cap_note = f", cap={cap}s" if cap else ""
            print(f"  ⏱  {t.name} → {t._resolved_timeout_seconds}s "
                  f"(recent_max={s['recent_max']}s, n={s['count']}{cap_note})")
    if missing_history:
        print("\n  ❌ Timeout history is insufficient for the following tasks:")
        for m in missing_history:
            print(f"      - {m}")
        print("\n  Bootstrap the corpus by running smoke with --bootstrap until")
        print("  every task has ≥5 passed runs, e.g.:")
        print("    cd agents && for i in 1 2 3 4 5; do \\")
        print(f"      python benchmarks/run_benchmark.py --suite {suite_name_for_error(args)} \\")
        print("          --port $CONDUCTOR_PORT --ci --parallel --bootstrap; \\")
        print("    done")
        print("  Then commit agents/benchmarks/history/task_durations.jsonl.")
        sys.exit(1)

    # Start Fly.io log streaming
    fly_status = await start_fly_log_collector()
    print(f"  📡 {fly_status}")

    suite_name = args.suite or args.task or "all"
    print(f"\n{'='*60}")
    print("  Agent Benchmark Harness")
    print(f"  URL:   {base_url}")
    print(f"  Suite: {suite_name}")
    print(f"  Tasks: {len(tasks)}{f' (+{len(skipped_claude_tasks)} skipped)' if skipped_claude_tasks else ''}")
    print(f"{'='*60}")

    # Run tasks — finally block ensures flyctl cleanup + results are always saved
    run = BenchmarkRun(suite=suite_name, base_url=base_url)

    # Record skipped Claude Code tasks in results
    for t in skipped_claude_tasks:
        run.task_results.append(TaskResult(
            name=t.name,
            passed=False,
            agent_id="",
            status="SKIPPED",
            progress_score=0,
            duration_seconds=0,
            cost_cents=0,
            message_count=0,
            failure_reason="Claude Code credentials unavailable (user needs to re-authenticate)",
        ))

    try:
        if args.parallel:
            # Run all tasks concurrently
            print(f"\n  Running {len(tasks)} tasks in parallel...")
            results = await asyncio.gather(
                *(run_single_task(base_url, task) for task in tasks),
                return_exceptions=True,
            )
            for task, result in zip(tasks, results):
                if isinstance(result, BaseException):
                    run.task_results.append(TaskResult(
                        name=task.name,
                        passed=False,
                        agent_id="",
                        status="ERROR",
                        progress_score=0,
                        duration_seconds=0,
                        cost_cents=0,
                        message_count=0,
                        failure_reason=str(result),
                    ))
                else:
                    run.task_results.append(result)
        else:
            for task in tasks:
                result = await run_single_task(base_url, task)
                run.task_results.append(result)
    finally:
        fly_total = await stop_fly_log_collector()
        print(f"\n  📡 Fly.io log stream stopped ({fly_total} lines captured)")

        # Always save results — even partial results from interrupted runs are valuable
        if run.task_results:
            path = run.save()
            print(f"\n  Results saved: {path}")

    # Print summary
    s = run.summary
    skipped_str = f", {s['skipped']} skipped" if s.get('skipped') else ""
    print(f"\n{'='*60}")
    print(f"  RESULTS: {s['passed']}/{s['total']} passed ({s['pass_rate']:.0%}{skipped_str})")
    print(f"  Cost: {s['total_cost_cents']:.1f}c | Duration: {s['total_duration_seconds']:.0f}s")
    print(f"{'='*60}")

    # CI mode: exit non-zero if any task failed
    if args.ci and s["failed"] > 0:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Agent Benchmark Harness")
    parser.add_argument("--list", action="store_true", help="List all benchmark tasks")
    parser.add_argument("--task", type=str, help="Run a single task by name")
    parser.add_argument(
        "--suite",
        type=str,
        help="Run tasks matching a tag (basic, browser, claude-code, attachment, for-each, outreach, all)",
    )
    parser.add_argument(
        "--url",
        type=str,
        default=DEFAULT_BASE_URL,
        help=f"Base API URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar="FILE",
        help="Compare two result files",
    )
    parser.add_argument(
        "--parallel",
        action="store_true",
        help="Run tasks concurrently instead of sequentially",
    )
    parser.add_argument(
        "--ci",
        action="store_true",
        help="CI mode: exit with non-zero status if any task fails",
    )
    parser.add_argument(
        "--bootstrap",
        action="store_true",
        help="Bootstrap timeout history: use tasks.json timeout_seconds as the "
             "per-task ceiling even without history. Passed runs still record "
             "to the corpus. Use until every task has ≥5 passes, then drop this flag.",
    )
    parser.add_argument(
        "--row-start",
        type=int,
        default=None,
        help="Override task row_start — slice CSV attachments starting at this 1-indexed data row",
    )
    parser.add_argument(
        "--row-end",
        type=int,
        default=None,
        help="Override task row_end — slice CSV attachments ending at this 1-indexed data row (inclusive)",
    )
    target_group = parser.add_mutually_exclusive_group()
    target_group.add_argument(
        "--prod",
        action="store_true",
        help=f"Run against production ({PROD_BASE_URL})",
    )
    target_group.add_argument(
        "--port",
        type=int,
        default=None,
        help="Run against localhost on this port (e.g. --port 3001)",
    )
    args = parser.parse_args()

    if not args.list and not args.compare and not args.task and not args.suite:
        parser.print_help()
        sys.exit(1)

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
