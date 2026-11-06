"""Codex harness benchmark runner.

Runs a benchmark task by launching a Codex E2B session (GPT compute tokens) that
orchestrates Rose agents via the rose-bridge CLI. The scored trajectory is the
work agent Codex created (ROSE_WORK_AGENT_ID=...), not the anchor chat agent.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import aiohttp

from benchmarks.benchmark_tasks import BenchmarkTask
from benchmarks.results import TaskResult

CODEX_SESSION_PATH = "/api/codex-code-session"
WORK_AGENT_ID_PATTERN = re.compile(
    r"ROSE_WORK_AGENT_ID\s*=\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)
CODEX_POLL_INTERVAL_SECONDS = 2.0
CODEX_SILENCE_TIMEOUT_SECONDS = 120.0


@dataclass
class CodexRunnerDeps:
    """Primitives injected by run_benchmark."""

    api_headers: Callable[[], Any]
    # Code-session create/close are internal-only: they take the API key, never a user JWT.
    internal_api_headers: Callable[[str], dict[str, str]]
    benchmark_user_id: Callable[[], str]
    rose_api_url_for_harness: Callable[[str], str]
    is_local_base_url: Callable[[str], bool]
    poll_agent: Callable[..., Any]
    evaluate_task: Callable[..., Any]
    run_declared_evaluators: Callable[..., Any]
    get_settled_tool_usage: Callable[..., Any]


def parse_work_agent_id(output: str) -> Optional[str]:
    match = WORK_AGENT_ID_PATTERN.search(output or "")
    return match.group(1) if match else None


def build_codex_goal(task: BenchmarkTask, benchmark_goal: str) -> str:
    return (
        f"Benchmark task: {task.name}\n\n"
        f"{benchmark_goal}\n\n"
        "Complete this benchmark by creating a Rose execute-phase agent with the goal above, "
        "polling it to completion, and printing ROSE_WORK_AGENT_ID=<agent_id> as your final line."
    )


async def _create_codex_anchor_agent(
    session: aiohttp.ClientSession,
    base_url: str,
    headers: dict[str, str],
    task_name: str,
    price_limit_cents: int,
) -> str:
    body = {
        "goal": f"Codex harness anchor for benchmark {task_name}",
        "source": "WEB",
        "price_limit_cents": max(price_limit_cents, 50),
        "memory_enabled": False,
    }
    resp = await session.post(f"{base_url}/api/agents", headers=headers, json=body)
    if resp.status not in (200, 201):
        raise RuntimeError(f"Failed to create Codex anchor agent: {resp.status} - {resp.text[:300]}")
    data = await resp.json()
    agent_id = data.get("agent_id") or data.get("agentId")
    if not agent_id:
        raise RuntimeError("Codex anchor create response missing agent_id")
    return str(agent_id)


async def _create_codex_session(
    session: aiohttp.ClientSession,
    base_url: str,
    headers: dict[str, str],
    anchor_agent_id: str,
    user_id: str,
    goal: str,
    rose_api_url: str,
    fast_mode_cache_enabled: Optional[bool],
    memory_enabled: bool,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "agent_id": anchor_agent_id,
        "goal": goal,
        "user_id": user_id,
        "harness_mode": "rose",
        "rose_api_base_url": rose_api_url,
        "memory_enabled": memory_enabled,
    }
    if fast_mode_cache_enabled is not None:
        body["fast_mode_cache_enabled"] = fast_mode_cache_enabled
    resp = await session.post(f"{base_url}{CODEX_SESSION_PATH}/create", headers=headers, json=body)
    if resp.status not in (200, 201):
        raise RuntimeError(f"Failed to create Codex session: {resp.status} - {resp.text[:400]}")
    data = await resp.json()
    if not data.get("ws_url") or not data.get("task_id"):
        raise RuntimeError(f"Codex create response incomplete: {data}")
    return data


async def _poll_codex_ws_until_exit(ws_url: str, timeout_seconds: float) -> tuple[str, Optional[int]]:
    from helpers.claude_code_ws_client import ClaudeCodeWsClient

    output_buffer = ""
    exit_code: Optional[int] = None
    exited = asyncio.Event()

    async def on_output(data: str, is_buffer: bool) -> None:
        nonlocal output_buffer
        if is_buffer:
            output_buffer = data
        else:
            output_buffer += data

    async def on_exit(code: int) -> None:
        nonlocal exit_code
        exit_code = code
        exited.set()

    client = ClaudeCodeWsClient(ws_url, on_output=on_output, on_exit=on_exit)
    connected = await client.connect()
    if not connected:
        raise RuntimeError(f"Codex WebSocket connect failed: {ws_url[:120]}")

    listen_task = asyncio.create_task(client.listen())
    try:
        await asyncio.wait_for(exited.wait(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Codex session timed out after {timeout_seconds:.0f}s")
    finally:
        listen_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await listen_task
        await client.disconnect()

    return output_buffer, exit_code


async def _close_codex_session(
    session: aiohttp.ClientSession,
    base_url: str,
    headers: dict[str, str],
    task_id: str,
    anchor_agent_id: str,
    user_id: str,
) -> None:
    body = {"task_id": task_id, "agent_id": anchor_agent_id, "user_id": user_id}
    try:
        await session.post(f"{base_url}{CODEX_SESSION_PATH}/close", headers=headers, json=body)
    except Exception:
        pass


async def run_codex_task(
    base_url: str,
    task: BenchmarkTask,
    deps: CodexRunnerDeps,
    benchmark_goal: str,
    fast_mode_cache_enabled: Optional[bool] = None,
) -> TaskResult:
    started = time.monotonic()
    user_id = deps.benchmark_user_id()
    rose_api_url = deps.rose_api_url_for_harness(base_url)
    headers = await deps.api_headers()
    resolved_timeout = float(getattr(task, "_resolved_timeout_seconds", task.timeout_seconds))
    codex_goal = build_codex_goal(task, benchmark_goal)

    anchor_agent_id = ""
    codex_task_id = ""
    work_agent_id: Optional[str] = None
    codex_output = ""
    failure_reason: Optional[str] = None
    execution_error = False

    try:
        timeout = aiohttp.ClientTimeout(total=120)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            anchor_agent_id = await _create_codex_anchor_agent(
                session,
                base_url,
                headers,
                task.name,
                task.effective_price_limit_cents(),
            )
            print(f"    🧪 Codex anchor agent: {anchor_agent_id[:12]}...")
            internal_headers = deps.internal_api_headers(user_id)
            session_data = await _create_codex_session(
                session,
                base_url,
                internal_headers,
                anchor_agent_id,
                user_id,
                codex_goal,
                rose_api_url,
                fast_mode_cache_enabled,
                task.memory == "on",
            )
            codex_task_id = session_data["task_id"]
            ws_url = session_data["ws_url"]
            print(f"    🤖 Codex session: {codex_task_id[:12]}... rose_api={rose_api_url}")

            codex_output, exit_code = await _poll_codex_ws_until_exit(ws_url, resolved_timeout)
            work_agent_id = parse_work_agent_id(codex_output)
            if not work_agent_id:
                failure_reason = "Codex harness did not print ROSE_WORK_AGENT_ID=<uuid> in terminal output"
            elif exit_code not in (0, None):
                failure_reason = f"Codex process exited with code {exit_code}"

            await _close_codex_session(session, base_url, internal_headers, codex_task_id, anchor_agent_id, user_id)
    except Exception as exc:  # noqa: BLE001
        execution_error = True
        failure_reason = f"Codex runner error: {exc}"

    if not work_agent_id:
        duration = round(time.monotonic() - started, 1)
        return TaskResult(
            name=task.name,
            passed=False,
            agent_id=anchor_agent_id,
            status="FAILED",
            benchmark_status="ERROR" if execution_error else "FAILED",
            progress_score=0.0,
            duration_seconds=duration,
            cost_cents=0.0,
            message_count=0,
            failure_reason=failure_reason or "Codex harness produced no work agent id",
            stop_metadata={
                "runner": "codex",
                "harness": "codex",
                "anchor_agent_id": anchor_agent_id,
                "codex_task_id": codex_task_id,
                "codex_output_tail": codex_output[-4000:] if codex_output else "",
            },
        )

    print(f"    🔗 Codex work agent: {work_agent_id[:12]}...")
    data, approvals_triggered, approvals_resolved, early_fail_reason = await deps.poll_agent(
        base_url,
        work_agent_id,
        task,
        None,
    )

    passed, eval_failure = deps.evaluate_task(task, data, approvals_triggered)
    failure_reason = failure_reason or early_fail_reason or eval_failure
    evaluator_results: list[dict] = []
    if task.enforce_declared_evaluators:
        declared_passed, declared_reason, evaluator_results = await deps.run_declared_evaluators(
            task,
            data,
        )
        if not declared_passed:
            passed = False
            failure_reason = failure_reason or declared_reason

    agent = data.get("agent", {})
    messages = data.get("messages", [])
    duration = round(time.monotonic() - started, 1)
    cost_cents = 0.0
    try:
        usage = await deps.get_settled_tool_usage(base_url, work_agent_id)
        cost_cents = float(usage.get("total_cost_cents", 0) or 0)
    except Exception:
        cost_cents = float(agent.get("tree_cost_cents", 0) or agent.get("tool_cost_cents", 0) or 0)

    return TaskResult(
        name=task.name,
        passed=passed,
        agent_id=work_agent_id,
        status=agent.get("status", "FAILED"),
        benchmark_status="ERROR" if execution_error else "PASSED" if passed else "FAILED",
        progress_score=float(agent.get("progress", 0) or 0),
        duration_seconds=duration,
        cost_cents=cost_cents,
        message_count=len(messages),
        failure_reason=failure_reason if not passed else None,
        stop_metadata={
            "runner": "codex",
            "harness": "codex",
            "anchor_agent_id": anchor_agent_id,
            "codex_task_id": codex_task_id,
            "codex_output_tail": codex_output[-4000:] if codex_output else "",
            "declared_evaluators": evaluator_results,
        },
    )


def build_deps_from_module(module: Any) -> CodexRunnerDeps:
    return CodexRunnerDeps(
        api_headers=module._api_headers,
        internal_api_headers=module._internal_api_headers,
        benchmark_user_id=module._current_benchmark_user_id,
        rose_api_url_for_harness=module._rose_api_url_for_codex_harness,
        is_local_base_url=module._is_local_base_url,
        poll_agent=module.poll_agent,
        evaluate_task=module.evaluate_task,
        run_declared_evaluators=module._run_declared_evaluators,
        get_settled_tool_usage=module._get_settled_tool_usage,
    )
