"""Spawn-claude-code-agent domain service — business logic and Temporal activity."""

from __future__ import annotations

import asyncio
import contextlib
import time
import uuid as uuid_module
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, List, Optional

import structlog
import structlog.contextvars
from temporalio import activity
from temporalio.common import RetryPolicy

from domains.spawn_claude_code_agent.config import (
    E2B_COST_CENTS_PER_SECOND,
    ECHO_SUPPRESS_S,
    FATAL_ERROR_PATTERNS,
    MAX_RUNTIME_S,
    MAX_UNCHANGED_OUTPUTS,
    SILENCE_TIMEOUT_S,
)
from domains.spawn_claude_code_agent.repo import (
    check_sandbox_health,
    close_e2b_session,
    create_e2b_session,
    persist_terminal_output,
    save_claude_code_message,
)
from domains.spawn_claude_code_agent.types import ClaudeCodeParentResponse
from helpers.claude_code_ws_client import ClaudeCodeWsClient
from helpers.e2b_log_collector import SandboxLogCollector
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from tools.base import MessageStatus
from utils.error_utils import extract_error_message
from utils.terminal_filter import TerminalFilter

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def check_fatal_errors(output: str) -> Optional[str]:
    """Check terminal output for fatal errors that should immediately abort the session.

    Returns an error message if a fatal error is detected, None otherwise.
    """
    for pattern, message in FATAL_ERROR_PATTERNS:
        if pattern in output:
            return message
    return None


def safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


def build_context_summary(
    success: bool,
    close_reasoning: str,
    action_summary: list[str],
    error_context: Optional[str] = None,
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts: list[str] = []

    status = "✅ SUCCESS" if success else "❌ FAILED"
    summary_parts.append(f"**Status**: {status}")

    if close_reasoning:
        summary_parts.append(f"\n**Outcome**: {close_reasoning}")

    if error_context:
        summary_parts.append(f"\n**Error**: {error_context}")

    if action_summary:
        last_actions = action_summary[-10:]
        summary_parts.append(f"\n**Actions Taken** ({len(action_summary)} total, showing last {len(last_actions)}):")
        for action in last_actions:
            summary_parts.append(f"  • {action}")

    return "\n".join(summary_parts)


# ---------------------------------------------------------------------------
# Parent LLM interaction
# ---------------------------------------------------------------------------


async def call_parent_llm(
    goal: str,
    filtered_output: str,
    conversation_history: List[Dict[str, str]],
    agent_id: str,
    on_chunk: Callable[[str, int], Awaitable[None]],
    model: str = "rose-labs/rose-1-lite",
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Call the parent agent's LLM to decide whether to respond or complete.

    Claude Code's terminal output appears as USER messages.
    Parent LLM's responses are sent to Claude Code's stdin.

    Returns
    -------
    Dict with ``attempt_completion`` (bool), ``response`` (str|None),
    ``usage`` (dict).
    """
    from helpers.llm import call_llm_structured_streaming

    # Build file info for system prompt
    file_info = ""
    if conversation_history and any("attachments" in str(h) for h in conversation_history):
        file_info = """

## Available Files
User attachments are available in /home/user/attachments/
Claude Code can read and process these files as needed.

## Output Files
When Claude Code creates files the user needs, it should copy them to /home/user/output/
Files in this directory will be automatically uploaded and returned to the user."""

    current_time = datetime.now().strftime("%B %d, %Y at %I %p")
    system_prompt = f"""You are interacting with Claude Code, a terminal-based coding agent working on a task.

Current time: {current_time}

ORIGINAL GOAL: {goal}

Claude Code's terminal output appears as USER messages. Your responses will be sent to Claude Code's stdin.

## Your Role
- Monitor Claude Code's progress on the task
- Answer questions Claude Code asks (numbered options can be answered with just the number)
- Provide guidance when Claude Code seems stuck
- Determine when the task is complete

## Decision Making
Set attempt_completion=true ONLY when:
- Claude Code has explicitly stated the task is done
- The output shows clear completion (tests passing, task finished, etc.)
- Claude Code is asking "Is there anything else?" or similar

Set attempt_completion=false when:
- Claude Code is asking questions or requesting input
- Claude Code is still working (you see active tool calls, file operations)
- Claude Code encountered an error that needs addressing

## Response Guidelines
- Be concise - Claude Code is a terminal agent
- If Claude asks numbered options (like 1, 2, 3), respond with just the number
- If unsure about a question, let Claude Code decide (respond with "your choice" or similar)
- Don't repeat the goal - Claude Code already knows it{file_info}"""

    # Build messages for LLM
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]

    # Add conversation history
    for msg in conversation_history:
        messages.append(msg)

    # Add current output as user message
    messages.append({"role": "user", "content": filtered_output})

    try:
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.3,
            max_tokens=500,
            response_model=ClaudeCodeParentResponse,
            on_chunk=on_chunk,
            agent_id=agent_id,
            claude_token=claude_token,
            call_site="claude_code_agent",
        )

        return {
            "attempt_completion": result.attempt_completion,
            "response": result.response if not result.attempt_completion else None,
            "usage": usage,
        }

    except Exception as e:
        logger.error(
            "[ClaudeCode] Parent LLM call failed",
            agent_id=agent_id,
            error=extract_error_message(e),
        )
        # Return empty response so the loop doesn't send anything to stdin.
        # Previously this returned "continue" which created infinite loops:
        # the error kept firing, "continue" was sent to stdin each time,
        # and the same unchanged terminal output triggered another failed LLM call.
        return {
            "attempt_completion": False,
            "response": "",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }


# ---------------------------------------------------------------------------
# Agentic WebSocket loop
# ---------------------------------------------------------------------------


async def _run_agentic_loop(  # noqa: C901
    *,
    agent_id: str,
    task_id: str,
    sandbox_id: str,
    goal: str,
    ws_url: str,
    terminal: TerminalFilter,
    model: str,
    claude_token: Optional[str],
    action_summary: list[str],
    tool_call_id: str,
) -> tuple[int, bool, list[Dict[str, str]], int, int]:
    """Run the WebSocket-based agentic loop monitoring Claude Code output.

    Returns (exit_code, attempt_completion, conversation_history,
             total_input_tokens, total_output_tokens).
    exit_code is -1 if the process has not exited.
    """
    last_output_time = safe_time()
    exit_code: Optional[int] = None
    pending_output = False
    conversation_history: List[Dict[str, str]] = []
    attempt_completion = False
    ws_connected = True
    last_filtered_output = ""
    unchanged_output_count = 0
    last_stdin_send_time: float = 0.0
    interaction_count = 0
    total_input_tokens = 0
    total_output_tokens = 0

    async def on_output(data: str, is_buffer: bool) -> None:
        nonlocal last_output_time, pending_output
        if is_buffer:
            terminal.reset()
        terminal.feed(data)
        last_output_time = safe_time()
        if last_stdin_send_time and (safe_time() - last_stdin_send_time) < ECHO_SUPPRESS_S:
            return
        pending_output = True

    async def on_exit(code: int) -> None:
        nonlocal exit_code
        exit_code = code
        logger.info("[ClaudeCode] Process exited", agent_id=agent_id, task_id=task_id, exit_code=code)

    async def on_connection_change(connected: bool) -> None:
        nonlocal ws_connected, last_output_time
        ws_connected = connected
        if connected:
            last_output_time = safe_time()
            logger.info("[ClaudeCode] WebSocket reconnected, silence timer reset", agent_id=agent_id, task_id=task_id)
        else:
            logger.info(
                "[ClaudeCode] WebSocket disconnected, pausing silence detection", agent_id=agent_id, task_id=task_id
            )

    async def on_stdin_error(error_msg: str) -> None:
        nonlocal pending_output
        logger.error(
            "[ClaudeCode] Server reported stdin error — re-enabling silence detection for retry",
            agent_id=agent_id,
            task_id=task_id,
            error=error_msg,
        )
        pending_output = True

    ws_client = ClaudeCodeWsClient(
        ws_url=ws_url,
        on_output=on_output,
        on_exit=on_exit,
        on_connection_change=on_connection_change,
        on_stdin_error=on_stdin_error,
        heartbeat_fn=lambda msg: activity.heartbeat(msg),
    )

    if not await ws_client.connect():
        raise Exception("Failed to connect to Claude Code WebSocket")

    listen_task = asyncio.create_task(ws_client.listen())
    action_summary.append("Connected to Claude Code WebSocket")

    loop_start = safe_time()
    last_status_update = loop_start

    async def on_chunk(text: str, tokens: int) -> None:
        pass  # Parent LLM streaming not needed

    try:
        while exit_code is None and not attempt_completion:
            elapsed = safe_time() - loop_start
            activity.heartbeat(f"Monitoring Claude Code ({int(elapsed)}s)")

            if elapsed > MAX_RUNTIME_S:
                logger.warning("[ClaudeCode] Max runtime exceeded", agent_id=agent_id, task_id=task_id, elapsed=elapsed)
                action_summary.append(f"Max runtime exceeded ({int(elapsed)}s)")
                break

            if ws_client.reconnects_exhausted:
                await _handle_reconnect_exhausted(sandbox_id, agent_id, task_id, action_summary)

            silence_duration = safe_time() - last_output_time

            if silence_duration >= SILENCE_TIMEOUT_S and pending_output and ws_connected:
                filtered_output = terminal.get_display()
                pending_output = False

                if filtered_output:
                    if filtered_output == last_filtered_output:
                        unchanged_output_count += 1
                        if unchanged_output_count >= MAX_UNCHANGED_OUTPUTS:
                            logger.info(
                                "[ClaudeCode] Terminal output unchanged for %d checks, skipping LLM call",
                                unchanged_output_count,
                                agent_id=agent_id,
                                task_id=task_id,
                            )
                            continue
                    else:
                        unchanged_output_count = 0
                        last_filtered_output = filtered_output

                    fatal_error = check_fatal_errors(filtered_output)
                    if fatal_error:
                        logger.error(
                            "[ClaudeCode] Fatal error detected in output, aborting",
                            agent_id=agent_id,
                            task_id=task_id,
                            error=fatal_error,
                        )
                        action_summary.append(f"FATAL: {fatal_error}")
                        await save_claude_code_message(
                            agent_id=agent_id,
                            title="Authentication Error",
                            task_id=task_id,
                            message=fatal_error,
                            status=MessageStatus.ERROR,
                            action_type="system",
                            tool_call_id=tool_call_id,
                        )
                        raise Exception(fatal_error)

                    logger.info(
                        "[ClaudeCode] Silence detected, calling parent LLM",
                        agent_id=agent_id,
                        task_id=task_id,
                        output_len=len(filtered_output),
                        silence_s=silence_duration,
                    )

                    llm_response = await call_parent_llm(
                        goal=goal,
                        filtered_output=filtered_output,
                        conversation_history=conversation_history,
                        agent_id=agent_id,
                        on_chunk=on_chunk,
                        model=model,
                        claude_token=claude_token,
                    )

                    usage = llm_response.get("usage", {})
                    total_input_tokens += usage.get("prompt_tokens", 0)
                    total_output_tokens += usage.get("completion_tokens", 0)

                    if llm_response.get("attempt_completion"):
                        attempt_completion = True
                        logger.info("[ClaudeCode] Parent LLM signaled completion", agent_id=agent_id, task_id=task_id)
                        action_summary.append("Parent LLM signaled task completion")
                    elif llm_response.get("response"):
                        response_text = llm_response["response"]
                        last_stdin_send_time = safe_time()
                        sent_ok = await ws_client.send_stdin(response_text)

                        if not sent_ok:
                            last_stdin_send_time = 0.0
                            logger.error(
                                "[ClaudeCode] stdin send FAILED — message did not reach terminal",
                                agent_id=agent_id,
                                task_id=task_id,
                                response=response_text[:100],
                            )
                            action_summary.append(f"STDIN SEND FAILED: '{response_text[:50]}'")
                            pending_output = True
                            continue

                        interaction_count += 1
                        conversation_history.append({"role": "user", "content": filtered_output})
                        conversation_history.append({"role": "assistant", "content": response_text})

                        logger.info(
                            "[ClaudeCode] Sent stdin response",
                            agent_id=agent_id,
                            task_id=task_id,
                            response=response_text[:100],
                            interaction=interaction_count,
                        )
                        action_summary.append(f"Interaction {interaction_count}: sent '{response_text[:50]}'")

                        await save_claude_code_message(
                            agent_id=agent_id,
                            title=f"Response #{interaction_count}",
                            task_id=task_id,
                            message=response_text,
                            status=MessageStatus.FINISHED,
                            action_type="agent_response",
                            tool_call_id=tool_call_id,
                        )

            if safe_time() - last_status_update >= 30:
                elapsed_int = int(elapsed)
                await save_claude_code_message(
                    agent_id=agent_id,
                    title=f"Claude Code working ({elapsed_int}s)",
                    task_id=task_id,
                    message=f"Elapsed: {elapsed_int}s, Interactions: {interaction_count}",
                    status=MessageStatus.FINISHED,
                    action_type="agent_observation",
                    tool_call_id=tool_call_id,
                )
                action_summary.append(f"Status update at {elapsed_int}s")
                last_status_update = safe_time()

            await asyncio.sleep(0.1)

    finally:
        listen_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await listen_task

    logger.info(
        "[ClaudeCode] Agentic loop finished",
        agent_id=agent_id,
        task_id=task_id,
        exit_code=exit_code,
        attempt_completion=attempt_completion,
        interactions=interaction_count,
    )
    action_summary.append(f"Agentic loop finished: {interaction_count} interactions")

    return (
        exit_code if exit_code is not None else -1,
        attempt_completion,
        conversation_history,
        total_input_tokens,
        total_output_tokens,
    )


async def _handle_reconnect_exhausted(
    sandbox_id: str,
    agent_id: str,
    task_id: str,
    action_summary: list[str],
) -> None:
    """Handle WebSocket reconnection exhaustion by diagnosing sandbox state."""
    logger.error(
        "[ClaudeCode] WebSocket connection lost after all reconnect attempts",
        agent_id=agent_id,
        task_id=task_id,
    )

    sandbox_health = await check_sandbox_health(sandbox_id, agent_id)

    if sandbox_health:
        if sandbox_health.get("alive"):
            ws_running = sandbox_health.get("ws_server_running", False)
            claude_running = sandbox_health.get("claude_running", False)
            diagnostics = sandbox_health.get("diagnostics", {})

            logger.error(
                "[ClaudeCode] DIAGNOSIS: E2B sandbox is ALIVE but WS disconnected",
                sandbox_id=sandbox_id,
                ws_server_running=ws_running,
                claude_running=claude_running,
                diagnosis="ws-server.mjs or claude process crashed" if not ws_running else "WS connection issue",
            )

            if diagnostics:
                logger.error(
                    "[ClaudeCode] DIAGNOSTICS extracted from sandbox",
                    sandbox_id=sandbox_id,
                    oom_check=diagnostics.get("oom_check", "N/A")[:500],
                    memory=diagnostics.get("memory", "N/A")[:500],
                    processes=diagnostics.get("processes", "N/A")[:1000],
                    crash_files=diagnostics.get("crash_files", "N/A")[:200],
                    ws_log=diagnostics.get("ws_log", "N/A")[:1000],
                )

            action_summary.append(
                f"DIAGNOSIS: Sandbox alive (ws={ws_running}, claude={claude_running}) - internal crash"
            )
        else:
            logger.error(
                "[ClaudeCode] DIAGNOSIS: E2B sandbox is DEAD",
                sandbox_id=sandbox_id,
                error=sandbox_health.get("error"),
                diagnosis="E2B infrastructure killed the sandbox",
            )
            action_summary.append(f"DIAGNOSIS: Sandbox DEAD - {sandbox_health.get('error', 'unknown')}")
    else:
        action_summary.append("DIAGNOSIS: Could not determine sandbox health")

    raise Exception("WebSocket connection to Claude Code sandbox lost after all reconnect attempts")


# ---------------------------------------------------------------------------
# Verifier
# ---------------------------------------------------------------------------


async def _run_verifier(
    *,
    agent_id: str,
    task_id: str,
    goal: str,
    model: str,
    terminal: TerminalFilter,
    action_summary: list[str],
    output_schema: Dict[str, Any],
    claude_token: Optional[str],
) -> tuple[float, str, Optional[Dict[str, Any]], int, int]:
    """Run the verifier to confirm completion.

    Returns (score, reasoning, structured_response, input_tokens, output_tokens).
    """
    from helpers.llm import check_progress
    from loop.activity_helper import call_temporal_activity_from_activity
    from utils.prompts import build_verifier_prompt

    verifier_call_id = str(uuid_module.uuid4())
    input_tokens = 0
    output_tokens = 0

    try:
        await save_claude_code_message(
            agent_id=agent_id,
            title="⚖️ Verifying completion",
            task_id=task_id,
            message="",
            status=MessageStatus.IN_PROGRESS,
            action_type="system",
            tool_call_id=verifier_call_id,
        )

        final_output = terminal.get_display()

        output_files_info = ""
        if "output" in final_output.lower() or "/home/user/output" in final_output:
            output_files_info = (
                "\n\nNote: Check if any files were created in /home/user/output/ based on terminal output."
            )

        verifier_context = [
            {"role": "USER", "text": f"Goal: {goal}"},
            {
                "role": "TOOL",
                "text": f"Claude Code Terminal Output:\n\n{final_output[-5000:]}",
                "metadata": {"toolName": "claude_code_terminal", "toolStatus": "FINISHED"},
            },
            {
                "role": "TOOL",
                "text": "Execution Summary:\n\n" + "\n".join(action_summary[-20:]) + output_files_info,
                "metadata": {"toolName": "claude_code_history", "toolStatus": "FINISHED"},
            },
        ]

        verifier_prompt = build_verifier_prompt(
            "EXECUTE", f"Goal: {goal}\n\nVerify Claude Code task completion based on the terminal output."
        )

        logger.info("[ClaudeCode] Running verifier", agent_id=agent_id, task_id=task_id, model=model)
        remote_session_schema = transform_schema_for_remote_session(output_schema)
        progress_result = await call_temporal_activity_from_activity(
            check_progress,
            args=[verifier_context, verifier_prompt, model, "EXECUTE", remote_session_schema, claude_token],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        v_usage = progress_result.get("usage", {})
        input_tokens = v_usage.get("prompt_tokens", 0)
        output_tokens = v_usage.get("completion_tokens", 0)

        score = progress_result.get("score", 0.0)
        v_reasoning = progress_result.get("reasoning", "")
        structured_response = progress_result.get("structured_response")

        await save_claude_code_message(
            agent_id=agent_id,
            title=f"⚖️ Progress: {score * 100:.0f}%",
            task_id=task_id,
            message=v_reasoning,
            status=MessageStatus.FINISHED,
            action_type="system",
            tool_call_id=verifier_call_id,
        )

        logger.info(
            "[ClaudeCode] Verifier result",
            agent_id=agent_id,
            task_id=task_id,
            score=score,
            reasoning=v_reasoning[:200],
        )

        return score, v_reasoning, structured_response, input_tokens, output_tokens

    except Exception as verifier_error:
        logger.error("[ClaudeCode] Verifier failed", agent_id=agent_id, task_id=task_id, error=str(verifier_error))
        await save_claude_code_message(
            agent_id=agent_id,
            title="⚠️ Verification failed",
            task_id=task_id,
            message=f"Error: {str(verifier_error)[:200]}",
            status=MessageStatus.FINISHED,
            action_type="error",
            tool_call_id=verifier_call_id,
        )
        return 0.5, "Verification failed - assuming partial completion", None, input_tokens, output_tokens


# ---------------------------------------------------------------------------
# File extraction helpers
# ---------------------------------------------------------------------------


def extract_additional_paths(
    structured_response: Optional[Dict[str, Any]],
    output_schema: Optional[Dict[str, Any]],
) -> list[str]:
    """Extract file paths from verifier's structured response to download specific files."""
    additional_paths: list[str] = []
    if not structured_response or not output_schema:
        return additional_paths

    for field in output_schema.get("fields", []):
        field_name = field.get("name")
        field_type = field.get("type")
        if not field_name or field_name not in structured_response:
            continue
        value = structured_response[field_name]
        if field_type == "file_pointer" and isinstance(value, dict):
            path = value.get("path")
            if path and path.startswith("/"):
                additional_paths.append(path)
        elif field_type == "list[file_pointer]" and isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    path = item.get("path")
                    if path and path.startswith("/"):
                        additional_paths.append(path)

    return additional_paths


def build_usage_items(
    total_input_tokens: int,
    total_output_tokens: int,
    model: str,
    model_pricing: Dict[str, Any],
    execution_time_ms: float,
) -> list[Dict[str, Any]]:
    """Build standardized usage items for cost tracking."""
    usage_items: list[Dict[str, Any]] = []

    if total_input_tokens > 0 or total_output_tokens > 0:
        verifier_cost = round(
            (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"]
            + (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
            4,
        )
        usage_items.append(
            {
                "type": "llm",
                "cost_cents": verifier_cost,
                "provider": f"Verifier ({model})",
                "model": model,
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
            }
        )

    e2b_cost_cents = round((execution_time_ms / 1000) * E2B_COST_CENTS_PER_SECOND, 4)
    usage_items.append(
        {
            "type": "service",
            "cost_cents": e2b_cost_cents,
            "provider": "E2B Desktop Sandbox",
        }
    )

    return usage_items


# ---------------------------------------------------------------------------
# Temporal activity
# ---------------------------------------------------------------------------


@activity.defn
async def spawn_claude_code_activity(  # noqa: C901
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    model: str = "rose-labs/rose-1-lite",
    github_repo_url: Optional[str] = None,
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Claude Code agent activity using E2B Desktop Sandbox.

    Flow:
    1. Call back-end API to create E2B session (with file attachments, optional GitHub repo)
    2. Post init message with stream_url
    3. Monitor Claude Code output via polling
    4. Run verifier to confirm completion
    5. On completion, close session and extract output files

    Args:
        output_schema: Response schema from parent agent's tool call (required for structured responses)
        attachments: File attachments from context to upload to sandbox
        model: Model to use for verifier (inherited from parent agent)
        github_repo_url: Optional GitHub repo URL to clone before starting Claude Code
        claude_token: Optional Claude OAuth token for direct Anthropic calls
    """
    structlog.contextvars.bind_contextvars(agent_id=agent_id)

    from helpers.model_pricing import get_model_pricing_with_fallback

    task_id = None
    sandbox_id = None
    ws_url = None
    start_time = safe_time()
    log_collector: Optional[SandboxLogCollector] = None

    total_input_tokens = 0
    total_output_tokens = 0
    action_summary: list[str] = []

    if not output_schema:
        raise ValueError(
            "output_schema is required for Claude Code agent - parent agent must provide structured output schema in tool call"
        )
    logger.info(
        "[ClaudeCode] Using response schema from tool call",
        agent_id=agent_id,
        fields=len(output_schema.get("fields", [])),
    )

    terminal = TerminalFilter(cols=200, rows=500)

    try:
        activity.heartbeat("Creating E2B sandbox with Claude Code")

        # 1. Create E2B session via back-end API
        logger.info(
            "[ClaudeCode] Creating E2B session",
            agent_id=agent_id,
            goal=goal[:200],
            num_attachments=len(attachments) if attachments else 0,
        )

        session_data = await create_e2b_session(
            agent_id=agent_id,
            goal=goal,
            user_id=user_id,
            attachments=attachments,
            github_repo_url=github_repo_url,
        )
        task_id = session_data["task_id"]
        sandbox_id = session_data["sandbox_id"]
        ws_url = session_data["ws_url"]
        uploaded_files = session_data.get("uploaded_files", [])
        actual_github_repo_url = session_data.get("github_repo_url")

        logger.info(
            "[ClaudeCode] Session created",
            agent_id=agent_id,
            task_id=task_id,
            sandbox_id=sandbox_id,
            ws_url=ws_url[:100] if ws_url else None,
            uploaded_files=len(uploaded_files),
        )
        action_summary.append(f"Created E2B sandbox: {sandbox_id}")

        log_collector = SandboxLogCollector(sandbox_id, agent_id, task_id)
        await log_collector.start()
        if uploaded_files:
            action_summary.append(f"Uploaded {len(uploaded_files)} files to /home/user/attachments/")

        # 2. Post init message
        await save_claude_code_message(
            agent_id=agent_id,
            title="Claude Code Started",
            task_id=task_id,
            message=f"Goal: {goal}",
            status=MessageStatus.IN_PROGRESS,
            action_type="claude_code_started",
            tool_call_id=tool_call_id,
            is_init_message=True,
            ws_url=ws_url,
            output_schema=output_schema,
            github_repo_url=actual_github_repo_url,
        )

        await save_claude_code_message(
            agent_id=agent_id,
            title="Task Started",
            task_id=task_id,
            message=goal,
            status=MessageStatus.FINISHED,
            action_type="task_started",
            tool_call_id=tool_call_id,
        )
        action_summary.append(f"Started task: {goal[:100]}")

        # 3. WebSocket-based agentic loop
        activity.heartbeat("Connecting to Claude Code WebSocket")

        model_pricing = await get_model_pricing_with_fallback(model)

        (
            exit_code,
            attempt_completion,
            conversation_history,
            loop_input_tokens,
            loop_output_tokens,
        ) = await _run_agentic_loop(
            agent_id=agent_id,
            task_id=task_id,
            sandbox_id=sandbox_id,
            goal=goal,
            ws_url=ws_url,
            terminal=terminal,
            model=model,
            claude_token=claude_token,
            action_summary=action_summary,
            tool_call_id=tool_call_id,
        )
        total_input_tokens += loop_input_tokens
        total_output_tokens += loop_output_tokens

        # 4. Run verifier
        score, v_reasoning, structured_response, v_input, v_output = await _run_verifier(
            agent_id=agent_id,
            task_id=task_id,
            goal=goal,
            model=model,
            terminal=terminal,
            action_summary=action_summary,
            output_schema=output_schema,
            claude_token=claude_token,
        )
        total_input_tokens += v_input
        total_output_tokens += v_output

        # 5. Persist terminal output
        filtered_output = terminal.get_display()
        await persist_terminal_output(task_id, filtered_output, agent_id)

        # 6. Close session and extract output files
        additional_paths = extract_additional_paths(structured_response, output_schema)
        if additional_paths:
            logger.info(
                "[ClaudeCode] Extracted file paths from verifier response",
                agent_id=agent_id,
                task_id=task_id,
                paths=additional_paths,
            )

        close_data = await close_e2b_session(
            task_id=task_id,
            user_id=user_id,
            agent_id=agent_id,
            additional_paths=additional_paths,
        )
        output_files = close_data.get("output_files", [])
        claude_code_usage = close_data.get("usage")

        logger.info(
            "[ClaudeCode] Session closed",
            agent_id=agent_id,
            task_id=task_id,
            output_files=len(output_files),
            claude_code_usage=claude_code_usage,
        )
        if output_files:
            action_summary.append(f"Extracted {len(output_files)} output files")

        # 7. Resolve file pointers
        if structured_response and output_files:
            structured_response = resolve_file_pointers_from_extracted(
                structured_response=structured_response,
                output_schema=output_schema,
                extracted_files=output_files,
            )
            logger.info(
                "[ClaudeCode] Resolved file pointers in structured response", agent_id=agent_id, task_id=task_id
            )

        # Build result
        success = score >= 0.8
        context_message = build_context_summary(
            success=success,
            close_reasoning=v_reasoning,
            action_summary=action_summary,
        )

        # Log Claude Code LLM usage (not charged)
        if claude_code_usage:
            logger.info(
                "[ClaudeCode] Claude Code LLM usage (not charged, user's plan)",
                input_tokens=claude_code_usage.get("inputTokens", 0),
                output_tokens=claude_code_usage.get("outputTokens", 0),
                cache_read=claude_code_usage.get("cacheReadInputTokens", 0),
                cache_create=claude_code_usage.get("cacheCreationInputTokens", 0),
            )

        execution_time_ms = (safe_time() - start_time) * 1000
        usage_items = build_usage_items(
            total_input_tokens, total_output_tokens, model, model_pricing, execution_time_ms
        )

        if log_collector:
            await log_collector.stop()

        return {
            "status": "completed",
            "success": success,
            "message": context_message,
            "task_id": task_id,
            "ws_url": ws_url,
            "execution_time_ms": execution_time_ms,
            "usage_items": usage_items,
            "structured_response": structured_response,
            "output_files": output_files,
        }

    except asyncio.CancelledError:
        logger.info("[ClaudeCode] Activity cancelled", agent_id=agent_id, task_id=task_id)

        if log_collector:
            await log_collector.stop()

        if task_id:
            try:
                # Persist terminal output before closing
                try:
                    cancelled_output = terminal.get_display()
                    if cancelled_output:
                        await persist_terminal_output(task_id, cancelled_output, agent_id)
                        logger.info(
                            "[ClaudeCode] Persisted terminal output on cancel",
                            agent_id=agent_id,
                            task_id=task_id,
                            output_len=len(cancelled_output),
                        )
                except Exception as output_error:
                    logger.warning(
                        "[ClaudeCode] Failed to persist output on cancel",
                        agent_id=agent_id,
                        error=str(output_error),
                    )

                await save_claude_code_message(
                    agent_id=agent_id,
                    title="Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                )

                await close_e2b_session(task_id=task_id)
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on cancel",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error),
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "message": "Claude Code agent cancelled by user",
        }

    except Exception as e:
        logger.error(
            "[ClaudeCode] Automation failed",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e),
            error_type=type(e).__name__,
        )

        if log_collector:
            await log_collector.stop()

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            action_summary=action_summary,
            error_context=error_context,
        )

        if task_id:
            try:
                await save_claude_code_message(
                    agent_id=agent_id,
                    title="Task Failed",
                    task_id=task_id,
                    message=error_message,
                    status=MessageStatus.ERROR,
                    action_type="task_complete",
                    tool_call_id=tool_call_id,
                )

                await close_e2b_session(task_id=task_id)
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on error",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error),
                )

        raise
