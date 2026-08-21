"""Live cutover e2e: a deploy must CLOSE a running sub-agent, not clobber its steps.

What this proves that no blackbox can
-------------------------------------
A browser/explore sub-agent is an ACTIVITY of the root Temporal workflow, sharing
the parent's ``agent_id``. It owns no Agent row, so descendant cleanup cannot see
it. Temporal ``terminate()`` closes a workflow WITHOUT cancelling its in-flight
activities, and the browser activity has no cancellation poll. An orphaned
activity therefore leaves no DB artifact of its own — the only way to observe it
is to watch a live worker keep writing after the cutover.

Observed in prod on agent 219dd80e-c2ed-4dc1-a40e-b2b9ea7e0a87: one replacement
produced 105 "Tool interrupted by deployment" chips while the browser agent kept
running and ultimately succeeded.

Shape
-----
1. start a long browser task and wait until it is genuinely mid-flight
2. snapshot the live generation + the browser session
3. POST /api/agents/:id/restart — the same prepare+start pair
   ``migrate-open-agent-workflows.ts`` runs during a deploy
4. assert the OLD sub-agent is closed: its rented browser is released and its
   task_id stops writing
5. assert a NEW generation took over

Run it (isolated stack, never the shared one)::

    cd agents && TEST_BASE_URL=http://localhost:55240 \\
      E2E_TASK_QUEUE=navi-agent-tasks-reykjavik \\
      python tests/e2e/run_e2e_tests.py --test browser-cutover --timeout 900

NOTE: ``requires_browser_agent=True`` excludes this from ``--basic``; reach it
with ``--test browser-cutover`` / ``--test explore-cutover`` or ``--all``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List, Optional

import httpx

from test_helpers import (  # type: ignore[import-not-found]
    BASE_URL,
    cleanup_agent,
    get_agent_status,
    get_auth_headers,
    spawn_agent,
)

# How long to wait for the sub-agent to actually be mid-flight before cutting over.
SUBAGENT_START_TIMEOUT = 240
# How long to watch for late writes from the sealed generation after the cutover.
POST_CUTOVER_QUIET_WINDOW = 90
POLL_INTERVAL = 5


def _metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    meta = message.get("metadata")
    return meta if isinstance(meta, dict) else {}


def _tool_messages(messages: List[Dict[str, Any]], tool_name: str) -> List[Dict[str, Any]]:
    return [m for m in messages if _metadata(m).get("toolName") == tool_name]


def _live_subagent_ids(messages: List[Dict[str, Any]], tool_name: str) -> set[str]:
    """sub-agent/task ids that have started but not reached a terminal status.

    Liveness is tracked across EVERY message the sub-agent writes, not just the
    ones tagged with the spawning tool. An explore agent's own `spawn_agent`
    lifecycle row reaches FINISHED early while its inner web_search/web_fetch
    steps keep running under the same subAgentId — filtering on toolName alone
    made a very-much-alive sub-agent look terminal.
    """
    owned: set[str] = set()
    for message in messages:
        meta = _metadata(message)
        if meta.get("toolName") == tool_name:
            sub_id = meta.get("subAgentId") or meta.get("task_id")
            if isinstance(sub_id, str):
                owned.add(sub_id)

    latest: Dict[str, str] = {}
    for message in messages:
        meta = _metadata(message)
        sub_id = meta.get("subAgentId") or meta.get("task_id")
        status = meta.get("toolStatus")
        if isinstance(sub_id, str) and sub_id in owned and isinstance(status, str):
            latest[sub_id] = status.upper()
    return {sub_id for sub_id, status in latest.items() if status == "IN_PROGRESS"}


def _live_tool_calls(messages: List[Dict[str, Any]], tool_name: str) -> set[str]:
    """toolCallId of every `tool_name` call whose LATEST lifecycle row is IN_PROGRESS.

    This is the identity that actually matters. The row that STARTS a sub-agent
    carries no subAgentId (only intermediate rows do), so subAgentId-based
    tracking silently misses the parent chip — which is exactly how a dangling
    "Browser Agent In Progress" chip escaped the previous version of this test.
    """
    latest: Dict[str, str] = {}
    for message in messages:
        meta = _metadata(message)
        if meta.get("toolName") != tool_name:
            continue
        call_id = meta.get("toolCallId")
        status = meta.get("toolStatus")
        if isinstance(call_id, str) and isinstance(status, str):
            latest[call_id] = status.upper()
    return {call_id for call_id, status in latest.items() if status == "IN_PROGRESS"}


def _deploy_killed_calls(messages: List[Dict[str, Any]], tool_name: str) -> set[str]:
    """toolCallIds whose terminal row says a DEPLOYMENT ended them.

    Terminality alone proves nothing: a sub-agent that simply FINISHED its work
    before the cutover landed is terminal too. Only `errorCode:
    DEPLOY_INTERRUPTED` proves the deploy is what stopped it.
    """
    killed: set[str] = set()
    for message in messages:
        meta = _metadata(message)
        if meta.get("toolName") != tool_name:
            continue
        call_id = meta.get("toolCallId")
        if isinstance(call_id, str) and meta.get("errorCode") == "DEPLOY_INTERRUPTED":
            killed.add(call_id)
    return killed


async def _wait_for_live_subagent(
    agent_id: str, tool_name: str, timeout: int
) -> tuple[set[str], set[str], str]:
    """Block until the sub-agent is genuinely mid-flight. Returns (subIds, callIds, generation)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = await get_agent_status(agent_id)
        agent = data.get("agent", data)
        messages = data.get("messages", [])
        live = _live_subagent_ids(messages, tool_name)
        live_calls = _live_tool_calls(messages, tool_name)
        generation = agent.get("temporal_workflow_id") or ""
        status = agent.get("status")
        # Require BOTH: a live inner sub-agent AND its parent tool call still
        # open. Either alone can be true while the work is already finishing.
        if live and live_calls and generation:
            return live, live_calls, generation
        if status in {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}:
            raise AssertionError(
                f"agent reached {status} before a {tool_name} sub-agent was in flight — "
                f"cannot exercise a cutover"
            )
        await asyncio.sleep(POLL_INTERVAL)
    raise AssertionError(f"no in-flight {tool_name} sub-agent within {timeout}s")


async def _task_browser_is_live(task_id: str) -> bool:
    """Ask the backend whether this browser task's remote session is still live.

    `GET /api/browser-session/task/:taskId?validateLive=true` probes the provider;
    `same_session_available` is false once the session is gone or released.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{BASE_URL}/api/browser-session/task/{task_id}",
            headers=get_auth_headers(),
            params={"validateLive": "true"},
        )
        if response.status_code == 404:
            return False
        if response.status_code != 200:
            # An inconclusive read must not be reported as "released".
            raise AssertionError(
                f"browser task liveness probe failed for {task_id}: "
                f"{response.status_code} - {response.text}"
            )
        payload = response.json()
        return bool(payload.get("same_session_available"))


async def _trigger_cutover(agent_id: str) -> str:
    """Run the exact prepare+start pair a deploy runs. Returns the new workflow id."""
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{BASE_URL}/api/agents/{agent_id}/restart", headers=get_auth_headers()
        )
        if response.status_code != 200:
            raise AssertionError(f"cutover failed: {response.status_code} - {response.text}")
        return str(response.json().get("workflow_id") or "")


async def _run_cutover_case(goal: str, tool_name: str, timeout: int) -> tuple[bool, str]:
    agent_id: Optional[str] = None
    try:
        agent_id = await spawn_agent(goal, start_phase="execute", timeout=timeout)
        live_before, calls_before, generation_before = await _wait_for_live_subagent(
            agent_id, tool_name, SUBAGENT_START_TIMEOUT
        )
        live_browsers_before = set()
        if tool_name == "spawn_browser_agent":
            for task_id in live_before:
                if await _task_browser_is_live(task_id):
                    live_browsers_before.add(task_id)

        generation_after = await _trigger_cutover(agent_id)
        cutover_at = time.time()

        if not generation_after or generation_after == generation_before:
            return (
                False,
                f"cutover did not start a new generation "
                f"(before={generation_before!r} after={generation_after!r})",
            )

        # Give the sealed generation every chance to prove it is still alive.
        await asyncio.sleep(POST_CUTOVER_QUIET_WINDOW)

        data = await get_agent_status(agent_id)
        messages = data.get("messages", [])

        # 1a. THE REQUIREMENT: every call that was mid-flight at cutover must be
        # sealed BY THE DEPLOY. A call that merely FINISHED naturally proves
        # nothing — the previous version of this test passed exactly that way,
        # because the browser agent completed ~30s before the cutover landed.
        killed = _deploy_killed_calls(messages, tool_name)
        not_killed = calls_before - killed
        if not_killed:
            still_open = _live_tool_calls(messages, tool_name) & not_killed
            return (
                False,
                f"WRONG: {tool_name} call(s) {sorted(not_killed)} were mid-flight at the cutover "
                f"but carry no DEPLOY_INTERRUPTED terminal row"
                + (
                    f" and {sorted(still_open)} are STILL IN_PROGRESS — dangling chip"
                    if still_open
                    else " (they finished on their own; the deploy never killed them)"
                ),
            )

        # 1b. the OLD sub-agent must be closed, not still stepping
        still_live = _live_subagent_ids(messages, tool_name) & live_before
        if still_live:
            return (
                False,
                f"WRONG (the reported bug): {tool_name} sub-agent(s) {sorted(still_live)} are STILL "
                f"IN_PROGRESS {POST_CUTOVER_QUIET_WINDOW}s after the cutover — the sub-agent was "
                f"never closed, its steps just got clobbered",
            )

        # 2. the sealed generation must stop writing
        late = [
            m
            for m in _tool_messages(messages, tool_name)
            if _metadata(m).get("subAgentId") in live_before
            and _metadata(m).get("workflowGeneration") == generation_before
            and _message_epoch(m) > cutover_at + 15
        ]
        if late:
            return (
                False,
                f"WRONG: {len(late)} write(s) from the sealed generation "
                f"{generation_before!r} landed after the cutover — the old activity is still running",
            )

        # 3. its rented browser must be released
        leaked = {task_id for task_id in live_browsers_before if await _task_browser_is_live(task_id)}
        if leaked:
            return (
                False,
                f"WRONG: browser session(s) for task(s) {sorted(leaked)} are still live after the "
                f"cutover — the rented browser is orphaned and still billing",
            )

        # 4. nothing may be left rendering as in-flight once the agent settles
        final = await get_agent_status(agent_id)
        final_agent = final.get("agent", final)
        if final_agent.get("status") in {"COMPLETED", "FAILED"}:
            dangling = _live_tool_calls(final.get("messages", []), tool_name)
            if dangling:
                return (
                    False,
                    f"WRONG: agent reported {final_agent.get('status')} while {tool_name} call(s) "
                    f"{sorted(dangling)} are still IN_PROGRESS — a task cannot complete with live "
                    f"sub-agents",
                )

        return (
            True,
            f"deploy killed {len(calls_before)} mid-flight {tool_name} call(s) "
            f"{sorted(calls_before)} (DEPLOY_INTERRUPTED), released their browsers, and moved "
            f"{generation_before} -> {generation_after}",
        )
    finally:
        if agent_id:
            await cleanup_agent(agent_id)


def _message_epoch(message: Dict[str, Any]) -> float:
    raw = message.get("timestamp") or message.get("created_at") or ""
    try:
        from datetime import datetime

        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


async def run_browser_cutover_test(test: Any, timeout_override: int | None = None) -> tuple[bool, str, float]:
    started = time.time()
    try:
        passed, detail = await _run_cutover_case(
            test.prompt, "spawn_browser_agent", timeout_override or test.timeout
        )
    except AssertionError as exc:
        return (False, str(exc), time.time() - started)
    except Exception as exc:  # surface infra failures, never mask them
        return (False, f"{type(exc).__name__}: {exc}", time.time() - started)
    return (passed, detail, time.time() - started)


async def run_explore_cutover_test(test: Any, timeout_override: int | None = None) -> tuple[bool, str, float]:
    started = time.time()
    try:
        passed, detail = await _run_cutover_case(
            test.prompt, "spawn_agent", timeout_override or test.timeout
        )
    except AssertionError as exc:
        return (False, str(exc), time.time() - started)
    except Exception as exc:
        return (False, f"{type(exc).__name__}: {exc}", time.time() - started)
    return (passed, detail, time.time() - started)
