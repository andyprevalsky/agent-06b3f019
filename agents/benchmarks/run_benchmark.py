#!/usr/bin/env python3
# Benchmark harness v2
"""
Agent Benchmark Harness

Spawns real agents against prod (or localhost), polls for completion,
evaluates pass/fail, handles approvals, retries transient failures,
and stores results for comparison.

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

    Log inspection CLI:
      python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
      python benchmarks/agent_logs.py <agent_id> --tree --source worker|backend|research|messages
      See benchmarks/agent_logs.py for full usage.
"""

import argparse
import asyncio
import csv
import json
import os
import tempfile

import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import httpx

# Add parent dir to path so we can import from agents/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tests.e2e.test_helpers import (
    authenticate,
    get_auth_headers,
    _auth_state,
)

from benchmarks.benchmark_tasks import (
    BenchmarkTask,
    all_tasks,
    get_task_by_name,
    get_tasks_by_tag,
    list_all_tasks,
)
from benchmarks.results import BenchmarkRun, TaskResult, compare_runs
from benchmarks.logs import (
    collect_logs, collect_tree_logs, format_tree_diagnostics,
    load_env_var, start_fly_log_collector, stop_fly_log_collector,
)

# Defaults — benchmarks run against PROD by default (no local services needed)
DEFAULT_BASE_URL = os.environ.get(
    "BENCHMARK_BASE_URL", "https://navi-j9a9.onrender.com"
)
POLL_INTERVAL = 5  # seconds
STALL_THRESHOLD = 180  # seconds without new messages/agents across ENTIRE tree → warning
# Note: Activities (set_plan, spawn_browser_agent, LLM calls) can take 30-120s without
# producing messages. Only flag stalls after 3 minutes of zero activity across ALL agents.
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
        "source": "MAC_APP",
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
) -> Tuple[dict, int, int]:
    """
    Poll agent until terminal state or timeout.
    Monitors the ENTIRE agent tree for stall detection, not just the root.

    Returns: (final_agent_data, approvals_triggered, approvals_resolved)
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

    while True:
        elapsed = time.time() - start
        if elapsed > task.timeout_seconds:
            print(f"    ⏰ Timeout after {elapsed:.0f}s")
            data = await get_agent(base_url, agent_id)
            return data, approvals_triggered, approvals_resolved

        try:
            data = await get_agent(base_url, agent_id)
        except AgentNotFoundError:
            print(f"    ⚠ Agent {agent_id[:12]} returned 404 — deleted or expired")
            return {"agent": {"status": "DELETED"}, "messages": []}, approvals_triggered, approvals_resolved
        except Exception as e:
            print(f"    ⚠ Poll error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
            continue

        agent = data.get("agent", {})
        status = agent.get("status", "UNKNOWN")
        messages = data.get("messages", [])
        root_msg_count = len(messages)

        # Chat mode: done when we have ASSISTANT responses
        if task.is_chat_mode:
            assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
            if len(assistant_msgs) >= 1:
                return data, approvals_triggered, approvals_resolved

        # Agent mode: done on terminal status
        if status in TERMINAL_STATUSES:
            return data, approvals_triggered, approvals_resolved

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
                print(f"    → Auto-replying to unblock workflow")
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
        if task.approval_handling in ("auto_approve", "ignore", "prompt_user"):
            try:
                pending = await get_attention_requests(base_url)
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

    # Check for tool errors
    tool_errors = [
        m for m in messages
        if isinstance(m.get("metadata"), dict)
        and m["metadata"].get("toolStatus") == "ERROR"
    ]
    if tool_errors:
        tool_names = [m["metadata"].get("toolName", "unknown") for m in tool_errors]
        return False, f"Tool errors detected: {', '.join(tool_names)}"

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
    print(f"\n  {'='*50}")
    print(f"  📋 {task.name}: {task.title}")
    print(f"     timeout={task.timeout_seconds}s, price_limit={task.price_limit_cents}c")
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
                    print(f"    ✅ Uploaded, FilePointer received")
                else:
                    print(f"    ⚠ Upload returned no FilePointer, continuing anyway")

            # Post a message with all file pointers so the agent can see them
            if file_pointers:
                await post_attachment_message(base_url, agent_id, file_pointers)
                print(f"    📎 Posted {len(file_pointers)} file(s) as agent message")
        else:
            agent_id = await create_agent(base_url, task)
            print(f"    Agent created: {agent_id[:12]}...")

        # Poll until done
        data, approvals_triggered, approvals_resolved = await poll_agent(
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

        # Evaluate
        passed, failure_reason = evaluate_task(task, data, approvals_triggered)

        # Collect prod logs for diagnostics
        print(f"    Collecting prod logs...")
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
            failure_reason=str(e),
            logs=logs,
        )
    finally:
        for tmp in temp_csv_paths:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ============================================================
# Transient retry
# ============================================================

async def run_with_retry(base_url: str, task: BenchmarkTask) -> TaskResult:
    """Run task, retry once on failure. Mark as transient if retry passes."""
    result = await run_single_task(base_url, task)

    if result.passed:
        return result

    # Retry once
    print(f"\n    🔄 Retrying {task.name} (first attempt failed)...")
    retry_result = await run_single_task(base_url, task)

    if retry_result.passed:
        # Transient failure — passed on retry
        retry_result.is_transient = True
        retry_result.retry_agent_id = result.agent_id
        print(f"    ⚡ {task.name}: TRANSIENT (failed then passed)")
        return retry_result
    else:
        # Persistent failure
        retry_result.retry_agent_id = result.agent_id
        print(f"    ❌ {task.name}: PERSISTENT FAILURE (failed twice)")
        return retry_result


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

    base_url = args.url.rstrip("/")

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
        print(f"  ✅ Authenticated")
    except Exception as e:
        print(f"  ⚠ Auth failed ({e}), falling back to API key")

    # Start Fly.io log streaming
    fly_status = await start_fly_log_collector()
    print(f"  📡 {fly_status}")

    suite_name = args.suite or args.task or "all"
    print(f"\n{'='*60}")
    print(f"  Agent Benchmark Harness")
    print(f"  URL:   {base_url}")
    print(f"  Suite: {suite_name}")
    print(f"  Tasks: {len(tasks)}")
    print(f"{'='*60}")

    # Run tasks — finally block ensures flyctl cleanup + results are always saved
    run = BenchmarkRun(suite=suite_name, base_url=base_url)
    try:
        if args.parallel:
            # Run all tasks concurrently
            print(f"\n  Running {len(tasks)} tasks in parallel...")
            runner = run_single_task if args.no_retry else run_with_retry
            results = await asyncio.gather(
                *(runner(base_url, task) for task in tasks),
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
                if args.no_retry:
                    result = await run_single_task(base_url, task)
                else:
                    result = await run_with_retry(base_url, task)
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
    print(f"\n{'='*60}")
    print(f"  RESULTS: {s['passed']}/{s['total']} passed ({s['pass_rate']:.0%})")
    print(f"  Cost: {s['total_cost_cents']:.1f}c | Duration: {s['total_duration_seconds']:.0f}s")
    if s["transient_failures"] > 0:
        print(f"  Transient failures: {s['transient_failures']}")
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
        "--no-retry",
        action="store_true",
        help="Don't retry failed tasks",
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
    args = parser.parse_args()

    if not args.list and not args.compare and not args.task and not args.suite:
        parser.print_help()
        sys.exit(1)

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
