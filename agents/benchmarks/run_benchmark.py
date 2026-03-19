#!/usr/bin/env python3
# Benchmark harness v2 — auto mode with Claude Code Review integration
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
    python benchmarks/run_benchmark.py --auto --task spawn-sub-agents

Auto mode (--auto --task <name>):
    Full automated debug-fix-deploy loop for a single benchmark task:
    1.  Run benchmark task on production resources
    2.  Wait for a non-transient error across the agent tree (or COMPLETED)
    3.  Pause root agent (propagates to all sub-agents)
    4.  Diagnose: collect tree-wide logs, print structured diagnostics
    5.  Propose fix — block on user approval
    6.  Delete root agent (cascades to descendants), apply approved solution
    7.  Create a PR via gh CLI
    8.  Code review loop (Claude Code Review GitHub Action):
        - Wait for review check to complete
        - If CHANGES_REQUESTED → fix critical issues, push, re-wait
        - Skip menial/P3+ comments
    9.  Merge the PR (squash)
    10. Wait for deployment Actions (deploy-agents, deploy-research) to pass;
        if any fail → new fix PR, review loop, merge, restart step 10
    11. Rerun benchmark — if fixed → back to step 2 (sees COMPLETED);
        if still broken → back to step 4
    12. On COMPLETED → CELEBRATE with cumulative cost & time stats

    Descendant log collection:
      Uses GET /api/agents/tree?busId=<root_id> to discover all agents in the
      tree (root + sub-agents + explore agents + browser agents). Collects
      worker logs (Fly.io), backend logs (Render), and message transcripts
      for every agent in the hierarchy, not just the root. Errors are surfaced
      per-agent with tool names and failure messages.
"""

import argparse
import asyncio
import json
import os

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
STALL_THRESHOLD = 60  # seconds without new messages → warning
TEST_ASSETS_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "front-end", "public", "test-assets"
)
_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
API_KEY = load_env_var("BACKEND_API_KEY", _AGENTS_ENV)
USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

# Terminal agent statuses
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}


# ============================================================
# API helpers
# ============================================================

async def _api_headers() -> dict:
    """Get auth headers — JWT for prod, API key fallback."""
    try:
        auth = await authenticate()
        return {
            "Authorization": f"Bearer {auth['access_token']}",
            "Content-Type": "application/json",
        }
    except Exception:
        # Fallback to API key auth
        if not API_KEY:
            raise RuntimeError("BACKEND_API_KEY env var is required when JWT auth is unavailable.")
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

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{base_url}/api/agents", headers=headers, json=body)
        if resp.status_code not in (200, 201):
            raise Exception(f"Failed to create agent: {resp.status_code} - {resp.text}")
        data = resp.json()
        return data["agent_id"]


async def get_agent(base_url: str, agent_id: str) -> dict:
    """GET /api/agents/:id"""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{base_url}/api/agents/{agent_id}", headers=headers)
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


async def pause_agent(base_url: str, agent_id: str) -> bool:
    """POST /api/agents/:id/pause — pause root agent (children discover via polling)."""
    headers = await _api_headers()
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{base_url}/api/agents/{agent_id}/pause", headers=headers)
        return resp.status_code in (200, 204)


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

async def poll_agent(
    base_url: str,
    agent_id: str,
    task: BenchmarkTask,
) -> Tuple[dict, int, int]:
    """
    Poll agent until terminal state or timeout.

    Returns: (final_agent_data, approvals_triggered, approvals_resolved)
    """
    start = time.time()
    last_message_time = start
    prev_message_count = 0
    approvals_triggered = 0
    approvals_resolved = 0

    while True:
        elapsed = time.time() - start
        if elapsed > task.timeout_seconds:
            print(f"    ⏰ Timeout after {elapsed:.0f}s")
            data = await get_agent(base_url, agent_id)
            return data, approvals_triggered, approvals_resolved

        try:
            data = await get_agent(base_url, agent_id)
        except Exception as e:
            print(f"    ⚠ Poll error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
            continue

        agent = data.get("agent", {})
        status = agent.get("status", "UNKNOWN")
        messages = data.get("messages", [])
        msg_count = len(messages)

        # Chat mode: done when we have ASSISTANT responses
        if task.is_chat_mode:
            assistant_msgs = [m for m in messages if m.get("role") == "ASSISTANT"]
            if len(assistant_msgs) >= 1:
                return data, approvals_triggered, approvals_resolved

        # Agent mode: done on terminal status
        if status in TERMINAL_STATUSES:
            return data, approvals_triggered, approvals_resolved

        # Stall detection
        if msg_count > prev_message_count:
            last_message_time = time.time()
            prev_message_count = msg_count
        elif time.time() - last_message_time > STALL_THRESHOLD:
            print(f"    ⚠ Stall detected ({time.time() - last_message_time:.0f}s since last message)")

        # Handle approval requests
        if task.approval_handling in ("auto_approve", "ignore", "prompt_user"):
            try:
                pending = await get_attention_requests(base_url)
                for req in pending:
                    req_agent_id = req.get("agentId") or req.get("agent_id", "")
                    if req_agent_id == agent_id and not req.get("response"):
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

        # Progress log
        progress = agent.get("progress", 0)
        if int(elapsed) % 15 == 0 and elapsed > 0:
            print(f"    ... {status} {progress:.0%} ({msg_count} msgs, {elapsed:.0f}s)")

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

    try:
        # Handle attachments: create agent first, then upload each file
        if all_attachments:
            agent_id = await create_agent(base_url, task)
            print(f"    Agent created: {agent_id[:12]}...")

            for attach_filename in all_attachments:
                filepath = os.path.join(TEST_ASSETS_DIR, attach_filename)
                if not os.path.exists(filepath):
                    raise FileNotFoundError(f"Test asset not found: {filepath}")

                print(f"    Uploading {attach_filename}...")
                fp = await upload_attachment(base_url, agent_id, filepath)
                if fp:
                    print(f"    ✅ Uploaded, FilePointer received")
                else:
                    print(f"    ⚠ Upload returned no FilePointer, continuing anyway")
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
        print(f"\n    ❌ {task.name}: ERROR - {e}")
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
# Auto mode — iterative debug loop
# ============================================================

async def _async_input(prompt: str) -> str:
    """Non-blocking input() that doesn't freeze the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, input, prompt)


AUTO_POLL_INTERVAL = 10  # seconds between polls in auto mode
AUTO_STATUS_INTERVAL = 30  # seconds between cost/time status prints
ERROR_STATUSES = {"FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}

# Deploy workflows to monitor after merging to main
DEPLOY_WORKFLOWS = ["deploy-agents.yml", "deploy-research.yml"]


# ── Shell / git / gh helpers ──────────────────────────────

async def _run_cmd(*args: str, timeout: int = 30) -> Tuple[int, str, str]:
    """Run a command async. Returns (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "", "timeout"
    return proc.returncode, stdout.decode(), stderr.decode()


_github_repo_cache: Optional[str] = None


def _get_github_repo() -> str:
    """Lazy-detect owner/repo from git remote. Cached after first call."""
    global _github_repo_cache
    if _github_repo_cache is not None:
        return _github_repo_cache
    import subprocess
    try:
        url = subprocess.check_output(
            ["git", "remote", "get-url", "origin"], text=True, timeout=5
        ).strip()
        for prefix in ("https://github.com/", "git@github.com:"):
            if url.startswith(prefix):
                _github_repo_cache = url[len(prefix):].removesuffix(".git")
                return _github_repo_cache
    except Exception:
        pass
    _github_repo_cache = "andyprevalsky/navi-whisper-lux"
    return _github_repo_cache


async def _git_current_branch() -> str:
    """Get current git branch name."""
    code, out, _ = await _run_cmd("git", "rev-parse", "--abbrev-ref", "HEAD")
    return out.strip() if code == 0 else ""


async def _git_push() -> bool:
    """Push current branch to origin."""
    branch = await _git_current_branch()
    if not branch:
        print("  [git] Could not determine current branch")
        return False
    code, out, err = await _run_cmd("git", "push", "-u", "origin", branch, timeout=60)
    if code != 0:
        print(f"  [git] Push failed: {err[:200]}")
        return False
    print(f"  [git] Pushed {branch}")
    return True


# ── GitHub CLI helpers (Claude Code Review + deployments) ──

async def _gh_create_pr(title: str, body: str) -> Optional[Tuple[str, int]]:
    """Create a PR targeting main. Returns (url, pr_number) or None."""
    code, out, err = await _run_cmd(
        "gh", "pr", "create",
        "--title", title,
        "--body", body,
        "--base", "main",
        timeout=30,
    )
    if code != 0:
        # Check if PR already exists
        if "already exists" in err.lower():
            print(f"  [gh] PR already exists, fetching...")
            code2, out2, _ = await _run_cmd(
                "gh", "pr", "view", "--json", "number,url", timeout=15
            )
            if code2 == 0:
                pr_data = json.loads(out2)
                return pr_data["url"], pr_data["number"]
        print(f"  [gh] PR create failed: {err[:200]}")
        return None

    # gh pr create outputs the URL
    pr_url = out.strip()
    # Extract PR number from URL
    try:
        pr_number = int(pr_url.rstrip("/").split("/")[-1])
    except (ValueError, IndexError):
        # Fallback: query the PR we just created
        code2, out2, _ = await _run_cmd(
            "gh", "pr", "view", "--json", "number", timeout=15
        )
        if code2 == 0:
            pr_number = json.loads(out2)["number"]
        else:
            print(f"  [gh] Created PR but couldn't parse number from: {pr_url}")
            return None

    print(f"  [gh] Created PR #{pr_number}: {pr_url}")
    return pr_url, pr_number


async def _gh_get_check_status(pr_number: int, check_name: str) -> Optional[str]:
    """
    Get conclusion of a specific check on a PR.
    Returns conclusion string ("success", "failure", etc.) or None if still pending.
    """
    code, out, _ = await _run_cmd(
        "gh", "pr", "checks", str(pr_number), "--json", "name,state,conclusion",
        timeout=15,
    )
    if code != 0:
        return None

    try:
        checks = json.loads(out)
    except (json.JSONDecodeError, TypeError):
        return None

    for check in checks:
        if check_name.lower() in check.get("name", "").lower():
            state = check.get("state", "").upper()
            if state == "COMPLETED":
                return check.get("conclusion", "unknown").lower()
            return None  # still in progress
    return None  # check not found yet


async def _gh_wait_for_check(pr_number: int, check_name: str, max_polls: int = 20) -> Optional[str]:
    """
    Poll until a specific PR check completes.
    Returns conclusion ("success", "failure") or None on timeout.
    Max wait: max_polls * 30s.
    """
    for i in range(1, max_polls + 1):
        conclusion = await _gh_get_check_status(pr_number, check_name)
        if conclusion is not None:
            print(f"  [check] {check_name}: {conclusion} (poll {i})")
            return conclusion
        print(f"  ⏳ Waiting for '{check_name}' ({i}/{max_polls}, 30s)...")
        await asyncio.sleep(30)
    print(f"  ❌ '{check_name}' did not complete within {max_polls * 30}s")
    return None


async def _gh_get_reviews(pr_number: int) -> List[dict]:
    """Get all reviews on a PR."""
    repo = _get_github_repo()
    code, out, _ = await _run_cmd(
        "gh", "api", f"repos/{repo}/pulls/{pr_number}/reviews",
        timeout=15,
    )
    if code != 0:
        return []
    try:
        return json.loads(out)
    except (json.JSONDecodeError, TypeError):
        return []


async def _gh_get_review_comments(pr_number: int) -> List[dict]:
    """Get inline review comments on a PR."""
    repo = _get_github_repo()
    code, out, _ = await _run_cmd(
        "gh", "api", f"repos/{repo}/pulls/{pr_number}/comments",
        timeout=15,
    )
    if code != 0:
        return []
    try:
        return json.loads(out)
    except (json.JSONDecodeError, TypeError):
        return []


async def _gh_merge_pr(pr_number: int) -> bool:
    """Merge a PR via squash. Returns True on success."""
    code, out, err = await _run_cmd(
        "gh", "pr", "merge", str(pr_number),
        "--squash", "--delete-branch",
        timeout=30,
    )
    if code != 0:
        print(f"  [gh] Merge failed: {err[:200]}")
        return False
    print(f"  [gh] PR #{pr_number} merged")
    return True


async def _gh_get_latest_workflow_run(workflow: str) -> Optional[dict]:
    """Get the latest run of a workflow on main. Returns {id, status, conclusion} or None."""
    code, out, _ = await _run_cmd(
        "gh", "run", "list",
        "--workflow", workflow,
        "--branch", "main",
        "--limit", "1",
        "--json", "databaseId,status,conclusion,createdAt",
        timeout=15,
    )
    if code != 0:
        return None
    try:
        runs = json.loads(out)
        return runs[0] if runs else None
    except (json.JSONDecodeError, TypeError, IndexError):
        return None


async def _gh_wait_for_deployments(max_polls: int = 20) -> Tuple[bool, List[str]]:
    """
    Wait for deployment workflows to complete after a merge to main.
    Returns (all_passed, list_of_failure_messages).
    Max wait: max_polls * 30s.
    """
    # Give GitHub Actions a moment to trigger
    await asyncio.sleep(5)

    failures: List[str] = []
    for workflow in DEPLOY_WORKFLOWS:
        print(f"\n  📡 Checking deployment: {workflow}")
        completed = False
        for i in range(1, max_polls + 1):
            run = await _gh_get_latest_workflow_run(workflow)
            if run is None:
                print(f"  ⏳ No runs found for {workflow} yet ({i}/{max_polls}, 30s)...")
                await asyncio.sleep(30)
                continue

            status = run.get("status", "").lower()
            conclusion = run.get("conclusion", "")

            if status == "completed":
                if conclusion == "success":
                    print(f"  ✅ {workflow}: deployed successfully")
                else:
                    msg = f"{workflow}: {conclusion}"
                    print(f"  ❌ {msg}")
                    failures.append(msg)
                completed = True
                break
            elif status in ("queued", "in_progress", "waiting"):
                print(f"  ⏳ {workflow}: {status} ({i}/{max_polls}, 30s)...")
                await asyncio.sleep(30)
            else:
                # No deployment triggered (no matching file changes)
                print(f"  ⏭ {workflow}: not triggered (no matching changes)")
                completed = True
                break

        if not completed:
            msg = f"{workflow}: timed out after {max_polls * 30}s"
            print(f"  ❌ {msg}")
            failures.append(msg)

    return len(failures) == 0, failures


# ── Claude Code Review loop ───────────────────────────────

def _is_claude_review_bot(login: str) -> bool:
    """Check if a review was posted by the Claude Code Review action."""
    # claude-code-action posts via OIDC as github-actions[bot]
    return login in ("github-actions[bot]",)


async def _code_review_loop(pr_number: int) -> None:
    """
    Wait for Claude Code Review to finish, show comments,
    loop until all critical issues are resolved.
    Skip menial issues — only block on substantive ones.

    The workflow has two jobs:
      - deep-review: runs on opened/reopened/ready_for_review
      - incremental-review: runs on synchronize (subsequent pushes)
    Round 1 waits for deep-review (PR was just created).
    Subsequent rounds wait for incremental-review (push triggered).
    """
    round_num = 0
    while True:
        round_num += 1
        # First round = PR just opened → deep-review; later rounds = push → incremental-review
        check_name = "deep-review" if round_num == 1 else "incremental-review"
        print(f"\n  🔍 Code review round {round_num} — PR #{pr_number} (waiting for {check_name})")

        conclusion = await _gh_wait_for_check(pr_number, check_name, max_polls=20)

        if conclusion is None:
            print(f"  ⚠ {check_name} didn't complete. Continuing anyway.")
            return

        # Get reviews and comments
        reviews = await _gh_get_reviews(pr_number)
        comments = await _gh_get_review_comments(pr_number)

        # Filter to Claude Code Review bot only (ignore Greptile and other bots)
        bot_reviews = [
            r for r in reviews
            if _is_claude_review_bot(r.get("user", {}).get("login", ""))
        ]
        latest_review = bot_reviews[-1] if bot_reviews else None

        review_state = (latest_review.get("state", "") if latest_review else "").upper()
        review_body = (latest_review.get("body", "") if latest_review else "")

        bot_comments = [
            c for c in comments
            if _is_claude_review_bot(c.get("user", {}).get("login", ""))
        ]

        print(f"\n  {'='*50}")
        print(f"  📝 CLAUDE CODE REVIEW — PR #{pr_number}")
        print(f"  Check ({check_name}): {conclusion}")
        print(f"  Review state: {review_state or 'N/A'}")
        print(f"  Review comments: {len(bot_comments)}")
        print(f"  {'='*50}")

        if review_body:
            print(f"\n{review_body[:2000]}\n")

        # Show inline comments
        if bot_comments:
            print(f"\n  📋 REVIEW COMMENTS ({len(bot_comments)}):")
            print(f"  {'─'*45}")
            for i, c in enumerate(bot_comments, 1):
                path = c.get("path", "?")
                line = c.get("line") or c.get("original_line", "?")
                body = c.get("body", "")
                print(f"\n  {i}. [{path}:{line}]")
                print(f"     {body[:300]}")
            print(f"  {'─'*45}")

        # Check if review passes
        if review_state == "APPROVED":
            print(f"  ✅ Claude Code Review APPROVED")
            return

        if review_state == "CHANGES_REQUESTED":
            print(f"\n  ❌ Changes requested. Fix critical issues and push.")
            print(f"     Skip menial/style issues — focus on substantive ones.")
            await _async_input("  Press Enter after pushing fixes → ")
            continue

        # COMMENTED or no review — check if there are any blocking comments
        if not bot_comments:
            print(f"  ✅ No review comments — passing")
            return

        print(f"\n  ℹ Review has {len(bot_comments)} comment(s) but no explicit approval/rejection.")
        choice = (await _async_input("  Fix comments and push, or skip? [f/s] → ")).strip().lower()
        if choice.startswith("s"):
            print(f"  ⏭ Skipping review comments")
            return

        # User chose to fix
        await _async_input("  Press Enter after pushing fixes → ")
        # Loop to wait for new review


def _check_tree_for_errors(tree_agents: List[dict]) -> Optional[dict]:
    """Return first agent in tree with a non-transient error status, or None."""
    for agent in tree_agents:
        if agent.get("status") in ERROR_STATUSES:
            return agent
    return None


# ── Agent tree monitoring ─────────────────────────────────

async def _run_and_monitor(
    base_url: str,
    task: BenchmarkTask,
    auto_start: float,
    cumulative_cost: float,
) -> Tuple[str, Optional[dict], Optional[dict]]:
    """
    Create an agent and monitor the tree until completion or error.

    Returns: (agent_id, final_data, error_agent_or_None)
    If error_agent is None and final_data shows COMPLETED, the task passed.
    """
    iter_start = time.time()
    start_time = datetime.now(timezone.utc)

    # Create agent
    agent_id = await create_agent(base_url, task)
    print(f"  Agent created: {agent_id[:12]}...")

    # Upload attachment if needed
    if task.attachment:
        filepath = os.path.join(TEST_ASSETS_DIR, task.attachment)
        if os.path.exists(filepath):
            try:
                print(f"  Uploading {task.attachment}...")
                await upload_attachment(base_url, agent_id, filepath)
            except Exception as e:
                print(f"  ⚠ Attachment upload failed: {e}")
                try:
                    await delete_agent(base_url, agent_id)
                except Exception:
                    pass
                raise

    # Monitor loop
    last_status_print = time.time()
    last_msg_count = 0
    tree_agents: List[dict] = []

    while True:
        elapsed = time.time() - iter_start
        if elapsed > task.timeout_seconds:
            print(f"  ⏰ Timeout after {elapsed:.0f}s")
            try:
                data = await get_agent(base_url, agent_id)
                return agent_id, data, {"agent_id": agent_id, "status": "TIMEOUT", "goal": task.prompt[:80]}
            except Exception:
                return agent_id, None, {"agent_id": agent_id, "status": "TIMEOUT", "goal": task.prompt[:80]}

        try:
            data = await get_agent(base_url, agent_id)
        except Exception as e:
            print(f"  ⚠ Poll error: {e}")
            await asyncio.sleep(AUTO_POLL_INTERVAL)
            continue

        agent = data.get("agent", {})
        status = agent.get("status", "UNKNOWN")
        messages = data.get("messages", [])
        msg_count = len(messages)
        progress = agent.get("progress", 0)
        cost = next((v for v in (agent.get("treeCostCents"), agent.get("tree_cost_cents")) if v is not None), 0)

        # Chat mode: done when ASSISTANT responds
        if task.is_chat_mode:
            if any(m.get("role") == "ASSISTANT" for m in messages):
                return agent_id, data, None

        # COMPLETED → success
        if status == "COMPLETED":
            return agent_id, data, None

        # Root agent error
        if status in ERROR_STATUSES:
            return agent_id, data, {"agent_id": agent_id, "status": status, "goal": task.prompt[:80]}

        # Check full tree for descendant errors
        try:
            tree_agents = await get_agent_tree(base_url, agent_id)
        except Exception:
            tree_agents = []
        if tree_agents:
            err = _check_tree_for_errors(tree_agents)
            if err:
                return agent_id, data, err

        # Handle approvals — always ask user, never auto-approve
        try:
            pending = await get_attention_requests(base_url)
            tree_ids = {a.get("agent_id") for a in tree_agents} if tree_agents else {agent_id}
            for req in pending:
                req_agent_id = req.get("agentId") or req.get("agent_id", "")
                if req_agent_id in tree_ids and not req.get("response"):
                    req_id = req.get("id")
                    if not req_id:
                        continue
                    print(f"\n  {'='*50}")
                    print(f"  🔔 APPROVAL REQUEST")
                    print(f"  {'='*50}")
                    print(f"  Agent:   {req_agent_id[:12]}")
                    print(f"  Type:    {req.get('type', '?')}")
                    print(f"  Title:   {req.get('title', '?')}")
                    print(f"  Message: {req.get('message', '?')}")
                    for k in ("channel", "recipient", "recipientName", "toolName"):
                        v = req.get(k)
                        if v:
                            print(f"  {k}: {v}")
                    print(f"  {'='*50}")
                    choice = (await _async_input("  Accept or Reject? [a/r] → ")).strip().lower()
                    response = "approved" if choice.startswith("a") else "rejected"
                    await respond_to_attention_request(base_url, req_id, response)
                    print(f"  → {response.upper()}")
        except Exception:
            pass

        # Periodic status
        now = time.time()
        if now - last_status_print >= AUTO_STATUS_INTERVAL or msg_count > last_msg_count:
            total_elapsed = now - auto_start
            tree_count = len(tree_agents) if tree_agents else 1
            print(
                f"  📊 [{status}] progress={progress:.0%} msgs={msg_count} "
                f"tree={tree_count} cost={cost:.1f}c | "
                f"iter={elapsed:.0f}s total={total_elapsed:.0f}s cumulative_cost={cumulative_cost + cost:.1f}c"
            )
            last_status_print = now
            last_msg_count = msg_count

        await asyncio.sleep(AUTO_POLL_INTERVAL)


def _get_iter_cost(final_data: Optional[dict]) -> float:
    """Extract cost from agent data."""
    if not final_data:
        return 0.0
    fa = final_data.get("agent", {})
    return next((v for v in (fa.get("treeCostCents"), fa.get("tree_cost_cents")) if v is not None), 0)


async def _collect_and_print_diagnostics(
    base_url: str, agent_id: str, task: BenchmarkTask, start_time: datetime,
) -> None:
    """Step 4: Collect tree logs, print diagnostics and detailed error logs."""
    print(f"  📋 Collecting tree logs for diagnostics...")
    tree_agents_for_diag = await get_agent_tree(base_url, agent_id)
    if not tree_agents_for_diag:
        tree_agents_for_diag = [{"agent_id": agent_id, "status": "UNKNOWN", "goal": task.prompt[:200]}]

    tree_logs = await collect_tree_logs(
        agent_id, tree_agents_for_diag, start_time,
        get_agent_fn=lambda aid: get_agent(base_url, aid),
    )
    diag = format_tree_diagnostics(tree_logs, agent_id)
    print(diag)

    # Detailed error logs
    print(f"\n  {'─'*40}")
    print(f"  DETAILED ERROR LOGS")
    print(f"  {'─'*40}")
    for aid, info in tree_logs.items():
        if info.get("status") not in ERROR_STATUSES:
            continue
        print(f"\n  Agent {aid[:12]} [{info['status']}] — {info.get('goal', '')[:60]}")
        logs = info.get("logs", {})
        for wl in logs.get("worker_logs", []):
            if any(kw in wl.lower() for kw in ("error", "traceback", "exception", "failed")):
                print(f"    WORKER: {wl[:200]}")
        for msg in logs.get("messages", []):
            meta = msg.get("metadata", {})
            if isinstance(meta, dict) and meta.get("toolStatus") == "ERROR":
                print(f"    TOOL [{meta.get('toolName', '?')}]: {(msg.get('message') or '')[:200]}")


def _celebrate(task: BenchmarkTask, iterations: int, cumulative_cost: float, total_elapsed: float, agent_id: str):
    """Step 12: CELEBRATE!"""
    print(f"\n{'🎉' * 20}")
    print(f"  🎉🎉🎉 BENCHMARK PASSED! 🎉🎉🎉")
    print(f"  Task:       {task.name}")
    print(f"  Iterations: {iterations}")
    print(f"  Total cost: {cumulative_cost:.1f}c")
    print(f"  Total time: {total_elapsed:.0f}s")
    print(f"  Agent:      {agent_id}")
    print(f"{'🎉' * 20}\n")


async def run_auto_mode(base_url: str, task: BenchmarkTask) -> None:
    """
    Auto-debug loop for a benchmark task (12 steps):

      1.  Run benchmark task on production
      2.  Wait for a non-transient error across any agent or descendant
      3.  Pause root agent (propagates to sub-agents)
      4.  Diagnose the issue (collect tree-wide logs + diagnostics)
      5.  Propose fix — block on user approval
      6.  Delete root agent (cascades) + apply the approved solution
      7.  Make a PR (gh pr create)
      8.  Code review loop (Claude Code Review via GitHub Actions)
          [wait for review → fix critical issues → push] repeat until resolved
      9.  Merge the PR (gh pr merge --squash)
      10. Wait for deployment workflows to complete
          If any deploy fails → new fix PR, review loop, merge, restart step 10
      11. Rerun the benchmark
          - If it passed → back to step 2 (which sees COMPLETED → celebrate)
          - If it failed → back to step 4 (diagnose again)
      12. CELEBRATE when the test fully completes!

    Guidelines:
      - No waits longer than 60 seconds (poll in 30s intervals)
      - Regularly output total cost & time elapsed
      - Never auto-approve approval requests
    """
    iteration = 0
    cumulative_cost = 0.0
    auto_start = time.time()

    print(f"\n{'='*60}")
    print(f"  🤖 AUTO MODE — {task.name}: {task.title}")
    print(f"  URL:   {base_url}")
    print(f"  timeout={task.timeout_seconds}s, price_limit={task.price_limit_cents}c")
    print(f"{'='*60}\n")

    # ── Step 1: Initial run ──
    iteration += 1
    print(f"\n{'─'*50}")
    print(f"  ▶ Iteration {iteration}")
    print(f"  ⏱ Total elapsed: 0s | Total cost: 0.0c")
    print(f"{'─'*50}")

    start_time = datetime.now(timezone.utc)
    try:
        agent_id, final_data, error_agent = await _run_and_monitor(
            base_url, task, auto_start, cumulative_cost,
        )
    except Exception as e:
        print(f"  ❌ Failed to start benchmark: {e}")
        return

    iter_cost = _get_iter_cost(final_data)
    cumulative_cost += iter_cost

    # ── Step 2: Check if already completed ──
    if error_agent is None:
        total_elapsed = time.time() - auto_start
        _celebrate(task, iteration, cumulative_cost, total_elapsed, agent_id)
        try:
            await delete_agent(base_url, agent_id)
        except Exception:
            pass
        return

    # ── Fix cycle (Steps 3–11) ──
    while True:
        total_elapsed = time.time() - auto_start
        err_id = error_agent.get("agent_id", "?")[:12]
        err_status = error_agent.get("status", "?")
        err_goal = error_agent.get("goal", "")[:80]
        print(f"\n  🚨 ERROR DETECTED in agent {err_id}")
        print(f"     Status: {err_status}")
        print(f"     Goal:   {err_goal}")
        print(f"  📊 Iteration {iteration} | Cost: {cumulative_cost:.1f}c | Elapsed: {total_elapsed:.0f}s")

        # ── Step 3: Pause root agent ──
        print(f"\n  ⏸ Step 3: Pausing root agent {agent_id[:12]}...")
        try:
            paused = await pause_agent(base_url, agent_id)
            print(f"  {'✅ Paused' if paused else '⚠ Pause failed (may already be terminal)'}")
        except Exception as e:
            print(f"  ⚠ Pause error: {e}")

        # ── Step 4: Diagnose ──
        print(f"\n  🔬 Step 4: Diagnosing...")
        await _collect_and_print_diagnostics(base_url, agent_id, task, start_time)

        # ── Step 5: Propose fix + block on approval ──
        print(f"\n  🔧 Step 5: Propose a fix and get user approval.")
        print(f"     Diagnose the issue above, write the fix, then press Enter.")
        await _async_input("  Press Enter once fix is approved and applied → ")

        # ── Step 6: Delete root agent ──
        print(f"\n  🗑 Step 6: Deleting root agent {agent_id[:12]}...")
        try:
            await delete_agent(base_url, agent_id)
            print(f"  ✅ Agent tree deleted")
        except Exception as e:
            print(f"  ⚠ Delete failed: {e}")
            choice = (await _async_input("  Continue anyway? [y/n] → ")).strip().lower()
            if not choice.startswith("y"):
                print(f"  Aborting. Manually delete: {agent_id}")
                return

        # ── Step 7: Make a PR ──
        print(f"\n  📝 Step 7: Creating PR...")
        await _git_push()
        pr_result = await _gh_create_pr(
            title=f"fix({task.name}): auto-mode iteration {iteration}",
            body=f"Auto-debug fix for benchmark task `{task.name}`.\n\n"
                 f"Error: {err_status} in agent {err_id}\n"
                 f"Iteration: {iteration}\n"
                 f"Cumulative cost: {cumulative_cost:.1f}c",
        )
        if pr_result is None:
            print(f"  ⚠ Could not create PR. Fix manually and press Enter.")
            await _async_input("  Press Enter after PR is created and merged → ")
        else:
            pr_url, pr_number = pr_result

            # ── Step 8: Code review loop ──
            print(f"\n  🔍 Step 8: Claude Code Review loop...")
            await _code_review_loop(pr_number)

            # ── Step 9: Merge PR ──
            print(f"\n  🔀 Step 9: Merging PR #{pr_number}...")
            merged = await _gh_merge_pr(pr_number)
            if not merged:
                print(f"  ⚠ Merge failed. Merge manually and press Enter.")
                await _async_input("  Press Enter after PR is merged → ")

        # ── Step 10: Wait for deployments ──
        print(f"\n  🚀 Step 10: Waiting for deployments...")
        deploy_ok, deploy_failures = await _gh_wait_for_deployments(max_polls=20)

        while not deploy_ok:
            print(f"\n  ❌ Deployment failures: {deploy_failures}")
            print(f"     Fix the deploy issue, create a new PR, and merge it.")
            await _async_input("  Press Enter after deploy fix is merged → ")
            print(f"  🔄 Re-checking deployments...")
            deploy_ok, deploy_failures = await _gh_wait_for_deployments(max_polls=20)

        print(f"  ✅ All deployments succeeded")

        # ── Step 11: Rerun benchmark ──
        total_elapsed = time.time() - auto_start
        print(f"\n  🔄 Step 11: Rerunning benchmark...")
        print(f"  📊 Cumulative: cost={cumulative_cost:.1f}c elapsed={total_elapsed:.0f}s")

        iteration += 1
        start_time = datetime.now(timezone.utc)
        print(f"\n{'─'*50}")
        print(f"  ▶ Iteration {iteration}")
        print(f"  ⏱ Total elapsed: {total_elapsed:.0f}s | Total cost: {cumulative_cost:.1f}c")
        print(f"{'─'*50}")

        try:
            agent_id, final_data, error_agent = await _run_and_monitor(
                base_url, task, auto_start, cumulative_cost,
            )
        except Exception as e:
            print(f"  ❌ Rerun failed: {e}")
            print(f"  Treating as error — looping back to diagnose.")
            error_agent = {"agent_id": "", "status": "ERROR", "goal": str(e)[:80]}
            continue

        iter_cost = _get_iter_cost(final_data)
        cumulative_cost += iter_cost

        if error_agent is None:
            # Fix worked → Step 12: CELEBRATE!
            total_elapsed = time.time() - auto_start
            _celebrate(task, iteration, cumulative_cost, total_elapsed, agent_id)
            try:
                await delete_agent(base_url, agent_id)
            except Exception:
                pass
            return

        # Fix didn't work → back to Step 3 (continue loop)


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

    # Validate args early — before starting the fly log collector
    if args.auto and not args.task:
        print("--auto requires --task <name>")
        sys.exit(1)

    # Resolve tasks early — before starting fly log collector to avoid leaking it
    if args.auto:
        try:
            auto_task = get_task_by_name(args.task)
        except (ValueError, KeyError):
            print(f"Unknown task: '{args.task}'. Use --list to see available tasks.")
            sys.exit(1)
    else:
        tasks = resolve_tasks(args)
        if not tasks:
            print("No tasks matched. Use --list to see available tasks.")
            sys.exit(1)

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

    # --- Auto mode ---
    if args.auto:
        try:
            await run_auto_mode(base_url, auto_task)
        finally:
            fly_total = await stop_fly_log_collector()
            print(f"\n  📡 Fly.io log stream stopped ({fly_total} lines captured)")
        return

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
        help="Run tasks matching a tag (basic, browser, claude-code, attachment, swarm, outreach, all)",
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
        "--auto",
        action="store_true",
        help="Auto-debug loop: run task, detect errors across agent tree, "
             "pause, collect tree logs, wait for fix, delete, rerun. Requires --task.",
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
    args = parser.parse_args()

    if not args.list and not args.compare and not args.task and not args.suite and not args.auto:
        parser.print_help()
        sys.exit(1)

    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
