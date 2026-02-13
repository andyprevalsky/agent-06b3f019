"""Claude Code agent tool using E2B Desktop Sandbox.

This tool spawns a Claude Code CLI in an E2B Desktop sandbox.
The sandbox has Claude Code pre-installed and auto-starts with the goal.
Our agent observes Claude Code's output via WebSocket and can send
follow-up prompts through stdin for a true agentic loop.
"""

from typing import Dict, Any, Optional, AsyncGenerator, List, Callable, Awaitable
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, CancelledError as TemporalCancelledError
from datetime import timedelta, datetime
import structlog
import httpx
import asyncio
import time
import uuid as uuid_module
from pydantic import BaseModel, Field

from tools.base import ToolManager, ToolEvent, AssistantEvent, EventType, MessageStatus
from config import load_config
from helpers.terminal_filter import TerminalFilter
from helpers.claude_code_ws_client import ClaudeCodeWsClient
from helpers.attachments import FilePointer, extract_attachments_from_context, get_file_from_pointer
from helpers.file_resolution import resolve_file_pointers_from_extracted, transform_schema_for_remote_session
from helpers.error_utils import extract_error_message
from helpers.e2b_log_collector import SandboxLogCollector

logger = structlog.get_logger()


# ========================================
# PYDANTIC MODEL FOR PARENT LLM RESPONSE
# ========================================

class ClaudeCodeParentResponse(BaseModel):
    """Response model for parent LLM interacting with Claude Code."""
    # IMPORTANT: attempt_completion must be FIRST field so streaming can exit early
    attempt_completion: bool = Field(
        description="Set to true if the task appears to be complete and should be verified. "
                    "Set to false if Claude Code is asking questions or needs more guidance."
    )
    response: str = Field(
        default="",
        description="Your response to send to Claude Code's stdin. "
                    "If Claude asks numbered questions you can respond with just a number to select "
                    "an option like multiple choice. Leave empty if attempting completion."
    )


# Silence timeout - if no output for this long, Claude Code is "done talking"
SILENCE_TIMEOUT_S = 1.0

# Maximum runtime before timeout
MAX_RUNTIME_S = 600  # 10 minutes


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox where time.time() is restricted."""
    try:
        return time.time()
    except Exception:
        return 0.0


# ========================================
# MESSAGE HELPERS
# ========================================

async def save_claude_code_message(
    agent_id: str,
    title: str,
    message: str,
    status: MessageStatus,
    task_id: str,
    action_type: str = "default",
    tool_call_id: str = None,
    is_init_message: bool = False,
    ws_url: str = None,
    output_schema: dict = None,
    structured_response: dict = None,
):
    """Save Claude Code sub-action message directly to DB."""
    config = load_config()
    unique_tool_call_id = tool_call_id or str(uuid_module.uuid4())

    metadata = {
        "toolCallId": unique_tool_call_id,
        "toolName": "spawn_claude_code_agent",
        "toolStatus": status.value,
        "title": title,
        "task_id": task_id,
        "action_type": action_type,
    }

    if ws_url:
        metadata["ws_url"] = ws_url

    # Include output schema in init message for FE display
    if output_schema:
        metadata["output_schema"] = output_schema

    # Include structured response in task_complete message for FE display
    if structured_response:
        metadata["structured_response"] = structured_response

    if not is_init_message:
        metadata["subAgentId"] = task_id

    if status == MessageStatus.ERROR:
        metadata["error"] = True

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/agents/{agent_id}/messages",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json={
                    "message": message,
                    "role": "TOOL",
                    "metadata": metadata
                }
            )
            logger.info(
                "[ClaudeCode] Saved message",
                agent_id=agent_id,
                task_id=task_id,
                title=title,
                status=status.value,
                response_status=response.status_code
            )
    except Exception as e:
        logger.error(
            "[ClaudeCode] Failed to save message",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e)
        )


# ========================================
# CONTEXT SUMMARY BUILDER
# ========================================

def build_context_summary(
    success: bool,
    close_reasoning: str,
    action_summary: list,
    error_context: str = None
) -> str:
    """Build detailed execution context summary for main agent."""
    summary_parts = []

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


# ========================================
# PARENT LLM INTERACTION
# ========================================

async def call_parent_llm(
    goal: str,
    filtered_output: str,
    conversation_history: List[Dict[str, str]],
    agent_id: str,
    on_chunk: Callable[[str, int], Awaitable[None]],
    model: str = "rose-labs/rose-1-lite",
) -> Dict[str, Any]:
    """
    Call the parent agent's LLM to decide whether to respond or complete.

    Claude Code's terminal output appears as USER messages.
    Parent LLM's responses are sent to Claude Code's stdin.

    Args:
        goal: Original task goal
        filtered_output: Terminal output filtered via pyte
        conversation_history: Previous back-and-forth messages
        agent_id: For cancellation checking
        on_chunk: Callback for streaming chunks

    Returns:
        {
            "attempt_completion": bool,
            "response": str|None,
            "usage": {"prompt_tokens": int, "completion_tokens": int}
        }
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

    current_time = datetime.now().strftime("%B %d, %Y at %I:%M %p")
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
    messages = [{"role": "system", "content": system_prompt}]

    # Add conversation history
    for msg in conversation_history:
        messages.append(msg)

    # Add current output as user message
    messages.append({"role": "user", "content": filtered_output})

    try:
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,  # Inherited from parent agent
            temperature=0.3,
            max_tokens=500,
            response_model=ClaudeCodeParentResponse,
            on_chunk=on_chunk,
            agent_id=agent_id,
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
            error=extract_error_message(e)
        )
        # Default to not completing and sending error response
        return {
            "attempt_completion": False,
            "response": "continue",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }


# ========================================
# TEMPORAL ACTIVITY
# ========================================

@activity.defn
async def spawn_claude_code_activity(
    user_id: str,
    agent_id: str,
    goal: str,
    tool_call_id: str,
    output_schema: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
    model: str = "rose-labs/rose-1-lite",
    github_repo_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Claude Code agent activity using E2B Desktop Sandbox.

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
    """
    from helpers.llm import check_progress
    from helpers.prompts import build_verifier_prompt
    from helpers.model_pricing import get_model_pricing_with_fallback
    from loop.activity_helper import call_temporal_activity_from_activity

    config = load_config()
    task_id = None
    sandbox_id = None
    ws_url = None
    start_time = _safe_time()
    log_collector: Optional[SandboxLogCollector] = None

    # Token tracking for usage
    total_input_tokens = 0
    total_output_tokens = 0

    # Execution tracking
    action_summary = []

    # Validate required output_schema from parent agent's tool call
    if not output_schema:
        raise ValueError("output_schema is required for Claude Code agent - parent agent must provide structured output schema in tool call")
    logger.info(
        "[ClaudeCode] Using response schema from tool call",
        agent_id=agent_id,
        fields=len(output_schema.get("fields", []))
    )

    try:
        activity.heartbeat("Creating E2B sandbox with Claude Code")

        # 1. Create E2B session via back-end API (with attachments)
        logger.info(
            "[ClaudeCode] Creating E2B session",
            agent_id=agent_id,
            goal=goal[:200],
            num_attachments=len(attachments) if attachments else 0
        )

        # Build request payload
        create_payload = {
            "agent_id": agent_id,
            "goal": goal,
            "user_id": user_id,  # Required for GitHub repo access check
        }
        if attachments:
            create_payload["attachments"] = attachments
        if github_repo_url:
            create_payload["github_repo_url"] = github_repo_url

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{config.backend.api_url}/api/claude-code-session/create",
                headers={
                    "x-api-key": config.backend.api_key or "",
                    "Content-Type": "application/json"
                },
                json=create_payload
            )

            if response.status_code not in [200, 201]:
                logger.error(
                    "[ClaudeCode] Failed to create session",
                    agent_id=agent_id,
                    status_code=response.status_code,
                    response_text=response.text[:500]
                )
                raise Exception(f"Failed to create Claude Code session: HTTP {response.status_code}")

            session_data = response.json()
            task_id = session_data["task_id"]
            sandbox_id = session_data["sandbox_id"]
            ws_url = session_data["ws_url"]
            uploaded_files = session_data.get("uploaded_files", [])

        logger.info(
            "[ClaudeCode] Session created",
            agent_id=agent_id,
            task_id=task_id,
            sandbox_id=sandbox_id,
            ws_url=ws_url[:100] if ws_url else None,
            uploaded_files=len(uploaded_files)
        )
        action_summary.append(f"Created E2B sandbox: {sandbox_id}")

        # Start E2B sandbox log collector for debugging visibility
        log_collector = SandboxLogCollector(sandbox_id, agent_id, task_id)
        await log_collector.start()
        if uploaded_files:
            action_summary.append(f"Uploaded {len(uploaded_files)} files to /home/user/attachments/")

        # 2. Post init message with ws_url (for WebSocket terminal streaming)
        await save_claude_code_message(
            agent_id=agent_id,
            title="Claude Code Started",
            task_id=task_id,
            message=f"Goal: {goal}",
            status=MessageStatus.FINISHED,
            action_type="claude_code_started",
            tool_call_id=tool_call_id,
            is_init_message=True,
            ws_url=ws_url,
            output_schema=output_schema,
        )

        await save_claude_code_message(
            agent_id=agent_id,
            title="Task Started",
            task_id=task_id,
            message=goal,
            status=MessageStatus.FINISHED,
            action_type="task_started",
        )
        action_summary.append(f"Started task: {goal[:100]}")

        # 3. WebSocket-based agentic loop
        activity.heartbeat("Connecting to Claude Code WebSocket")

        # Model pricing for usage tracking
        # Parent model pricing (for verifier calls)
        model_pricing = await get_model_pricing_with_fallback(model)
        # Claude Code LLM usage is not charged — users provide their own credentials
        # We only charge for the verifier agent and E2B sandbox time

        # Terminal filter (pyte) for processing ANSI codes like xterm.js
        terminal = TerminalFilter(cols=200, rows=500)
        last_output_time = _safe_time()
        exit_code: Optional[int] = None
        pending_output = False  # Track if we have new output since last LLM call
        conversation_history: List[Dict[str, str]] = []  # Track back-and-forth
        attempt_completion = False
        ws_connected = True  # Track WebSocket connection state

        async def on_output(data: str, is_buffer: bool):
            """Handle output from Claude Code WebSocket."""
            nonlocal last_output_time, pending_output
            if is_buffer:
                # Full buffer from reconnect - reset terminal state
                terminal.reset()
            terminal.feed(data)
            last_output_time = _safe_time()
            pending_output = True

        async def on_exit(code: int):
            """Handle Claude Code process exit."""
            nonlocal exit_code
            exit_code = code
            logger.info(
                "[ClaudeCode] Process exited",
                agent_id=agent_id,
                task_id=task_id,
                exit_code=code
            )

        async def on_connection_change(connected: bool):
            """Handle WebSocket connection state changes."""
            nonlocal ws_connected, last_output_time
            ws_connected = connected
            if connected:
                # Reset silence timer on reconnect to avoid false triggers
                last_output_time = _safe_time()
                logger.info(
                    "[ClaudeCode] WebSocket reconnected, silence timer reset",
                    agent_id=agent_id,
                    task_id=task_id
                )
            else:
                logger.info(
                    "[ClaudeCode] WebSocket disconnected, pausing silence detection",
                    agent_id=agent_id,
                    task_id=task_id
                )

        # Connect to WebSocket
        ws_client = ClaudeCodeWsClient(
            ws_url=ws_url,
            on_output=on_output,
            on_exit=on_exit,
            on_connection_change=on_connection_change,
            heartbeat_fn=lambda msg: activity.heartbeat(msg),
        )

        if not await ws_client.connect():
            raise Exception("Failed to connect to Claude Code WebSocket")

        # Start listening in background task
        listen_task = asyncio.create_task(ws_client.listen())
        action_summary.append("Connected to Claude Code WebSocket")

        # Agentic loop - monitor output and interact via stdin
        loop_start = _safe_time()
        last_status_update = loop_start
        interaction_count = 0

        # Chunk callback for streaming (no-op since we're not streaming to FE here)
        async def on_chunk(text: str, tokens: int):
            pass  # Parent LLM streaming not needed - we're just getting decisions

        try:
            while exit_code is None and not attempt_completion:
                elapsed = _safe_time() - loop_start
                activity.heartbeat(f"Monitoring Claude Code ({int(elapsed)}s)")

                # Check for max runtime
                if elapsed > MAX_RUNTIME_S:
                    logger.warning(
                        "[ClaudeCode] Max runtime exceeded",
                        agent_id=agent_id,
                        task_id=task_id,
                        elapsed=elapsed
                    )
                    action_summary.append(f"Max runtime exceeded ({int(elapsed)}s)")
                    break

                # Check if WebSocket reconnects exhausted - fail the activity
                if ws_client.reconnects_exhausted:
                    logger.error(
                        "[ClaudeCode] WebSocket connection lost after all reconnect attempts",
                        agent_id=agent_id,
                        task_id=task_id
                    )

                    # Check if E2B sandbox is still alive to determine root cause
                    sandbox_health = None
                    try:
                        async with httpx.AsyncClient(timeout=10.0) as client:
                            health_resp = await client.get(
                                f"{config.backend.api_url}/api/claude-code-session/{sandbox_id}/health",
                                headers={"x-api-key": config.backend.api_key or ""}
                            )
                            if health_resp.status_code == 200:
                                sandbox_health = health_resp.json()
                    except Exception as health_err:
                        logger.warning(
                            "[ClaudeCode] Failed to check sandbox health",
                            error=str(health_err)
                        )

                    # Log detailed diagnosis
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
                                diagnosis="ws-server.mjs or claude process crashed" if not ws_running else "WS connection issue"
                            )

                            # Log detailed diagnostics if available
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

                            action_summary.append(f"DIAGNOSIS: Sandbox alive (ws={ws_running}, claude={claude_running}) - internal crash")
                        else:
                            logger.error(
                                "[ClaudeCode] DIAGNOSIS: E2B sandbox is DEAD",
                                sandbox_id=sandbox_id,
                                error=sandbox_health.get("error"),
                                diagnosis="E2B infrastructure killed the sandbox"
                            )
                            action_summary.append(f"DIAGNOSIS: Sandbox DEAD - {sandbox_health.get('error', 'unknown')}")
                    else:
                        action_summary.append("DIAGNOSIS: Could not determine sandbox health")

                    raise Exception("WebSocket connection to Claude Code sandbox lost after all reconnect attempts")

                # Check for silence timeout with pending output
                # Only check if WebSocket is connected - pause silence detection during reconnects
                silence_duration = _safe_time() - last_output_time

                if silence_duration >= SILENCE_TIMEOUT_S and pending_output and ws_connected:
                    # Claude Code stopped talking - get filtered output
                    filtered_output = terminal.get_display()

                    if filtered_output:
                        logger.info(
                            "[ClaudeCode] Silence detected, calling parent LLM",
                            agent_id=agent_id,
                            task_id=task_id,
                            output_len=len(filtered_output),
                            silence_s=silence_duration
                        )

                        # Call parent LLM to decide what to do
                        llm_response = await call_parent_llm(
                            goal=goal,
                            filtered_output=filtered_output,
                            conversation_history=conversation_history,
                            agent_id=agent_id,
                            on_chunk=on_chunk,
                            model=model,
                        )

                        # Track usage
                        usage = llm_response.get("usage", {})
                        total_input_tokens += usage.get("prompt_tokens", 0)
                        total_output_tokens += usage.get("completion_tokens", 0)

                        if llm_response.get("attempt_completion"):
                            # Parent LLM says task is complete
                            attempt_completion = True
                            logger.info(
                                "[ClaudeCode] Parent LLM signaled completion",
                                agent_id=agent_id,
                                task_id=task_id
                            )
                            action_summary.append("Parent LLM signaled task completion")
                        elif llm_response.get("response"):
                            # Send response to Claude Code stdin
                            response_text = llm_response["response"]
                            await ws_client.send_stdin(response_text)
                            interaction_count += 1

                            # Track in conversation history
                            conversation_history.append({"role": "user", "content": filtered_output})
                            conversation_history.append({"role": "assistant", "content": response_text})

                            logger.info(
                                "[ClaudeCode] Sent stdin response",
                                agent_id=agent_id,
                                task_id=task_id,
                                response=response_text[:100],
                                interaction=interaction_count
                            )
                            action_summary.append(f"Interaction {interaction_count}: sent '{response_text[:50]}'")

                            # Save interaction message for FE visibility
                            await save_claude_code_message(
                                agent_id=agent_id,
                                title=f"Response #{interaction_count}",
                                task_id=task_id,
                                message=response_text,
                                status=MessageStatus.FINISHED,
                                action_type="agent_response",
                            )

                    pending_output = False  # Processed this batch

                # Periodic status updates (every 30s)
                if _safe_time() - last_status_update >= 30:
                    elapsed_int = int(elapsed)
                    await save_claude_code_message(
                        agent_id=agent_id,
                        title=f"Claude Code working ({elapsed_int}s)",
                        task_id=task_id,
                        message=f"Interactions: {interaction_count}",
                        status=MessageStatus.FINISHED,
                        action_type="agent_observation",
                    )
                    action_summary.append(f"Status update at {elapsed_int}s")
                    last_status_update = _safe_time()

                await asyncio.sleep(0.1)  # Fast poll for responsive interaction

        finally:
            # Cancel listen task but DON'T disconnect yet - keep WS open for FE
            # We'll disconnect after verifier completes
            listen_task.cancel()
            try:
                await listen_task
            except asyncio.CancelledError:
                pass

        logger.info(
            "[ClaudeCode] Agentic loop finished",
            agent_id=agent_id,
            task_id=task_id,
            exit_code=exit_code,
            attempt_completion=attempt_completion,
            interactions=interaction_count
        )
        action_summary.append(f"Agentic loop finished: {interaction_count} interactions")

        # 4. Run verifier to confirm completion
        verifier_call_id = str(uuid_module.uuid4())
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

            # Build verifier context with filtered terminal output
            final_output = terminal.get_display()

            # Build output files info for verifier (list files in /home/user/output/ via action_summary)
            output_files_info = ""
            if "output" in final_output.lower() or "/home/user/output" in final_output:
                output_files_info = "\n\nNote: Check if any files were created in /home/user/output/ based on terminal output."

            verifier_context = [
                {"role": "USER", "text": f"Goal: {goal}"},
                {"role": "TOOL", "text": f"Claude Code Terminal Output:\n\n{final_output[-5000:]}", "metadata": {"toolName": "claude_code_terminal", "toolStatus": "FINISHED"}},
                {"role": "TOOL", "text": f"Execution Summary:\n\n" + "\n".join(action_summary[-20:]) + output_files_info, "metadata": {"toolName": "claude_code_history", "toolStatus": "FINISHED"}}
            ]

            verifier_prompt = build_verifier_prompt("EXECUTE", f"Goal: {goal}\n\nVerify Claude Code task completion based on the terminal output.")

            # Use inherited model with 30s timeout and 1 retry for transient failures
            logger.info(
                "[ClaudeCode] Running verifier",
                agent_id=agent_id,
                task_id=task_id,
                model=model,
            )
            # Transform output_schema for remote session: file_pointer -> session_file_pointer
            # This ensures the verifier only extracts the file path, not full FilePointer metadata
            remote_session_schema = transform_schema_for_remote_session(output_schema)
            progress_result = await call_temporal_activity_from_activity(
                check_progress,
                args=[verifier_context, verifier_prompt, model, "EXECUTE", remote_session_schema],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            v_usage = progress_result.get("usage", {})
            total_input_tokens += v_usage.get("prompt_tokens", 0)
            total_output_tokens += v_usage.get("completion_tokens", 0)

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
                reasoning=v_reasoning[:200]
            )

        except Exception as verifier_error:
            logger.error(
                "[ClaudeCode] Verifier failed",
                agent_id=agent_id,
                task_id=task_id,
                error=str(verifier_error)
            )
            await save_claude_code_message(
                agent_id=agent_id,
                title="⚠️ Verification failed",
                task_id=task_id,
                message=f"Error: {str(verifier_error)[:200]}",
                status=MessageStatus.FINISHED,
                action_type="error",
                tool_call_id=verifier_call_id,
            )
            # Continue without verification result
            score = 0.5  # Assume partial completion
            v_reasoning = "Verification failed - assuming partial completion"
            structured_response = None

        # Now disconnect WebSocket - verifier is done, FE can show final state
        await ws_client.disconnect()

        # 5. Persist terminal output to DB (use filtered output - same as LLM context)
        try:
            filtered_output = terminal.get_display()
            async with httpx.AsyncClient(timeout=10.0) as client:
                output_response = await client.post(
                    f"{config.backend.api_url}/api/claude-code-session/{task_id}/output",
                    headers={"x-api-key": config.backend.api_key or ""},
                    json={"output": filtered_output}
                )
                logger.info(
                    "[ClaudeCode] Output persisted",
                    agent_id=agent_id,
                    task_id=task_id,
                    output_len=len(filtered_output),
                    response_status=output_response.status_code
                )
        except Exception as e:
            logger.warning(
                "[ClaudeCode] Failed to persist output",
                agent_id=agent_id,
                task_id=task_id,
                error=extract_error_message(e)
            )

        # 6. Close the session and extract output files
        # Extract file paths from verifier's structured_response to download specific files
        additional_paths = []
        if structured_response and output_schema:
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

        if additional_paths:
            logger.info(
                "[ClaudeCode] Extracted file paths from verifier response",
                agent_id=agent_id,
                task_id=task_id,
                paths=additional_paths
            )

        output_files = []
        claude_code_usage = None  # Usage extracted from JSONL logs
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                close_response = await client.post(
                    f"{config.backend.api_url}/api/claude-code-session/close",
                    headers={"x-api-key": config.backend.api_key or ""},
                    json={
                        "task_id": task_id,
                        "user_id": user_id,
                        "agent_id": agent_id,
                        "additional_paths": additional_paths if additional_paths else None,
                    }
                )
                if close_response.status_code == 200:
                    close_data = close_response.json()
                    output_files = close_data.get("output_files", [])
                    claude_code_usage = close_data.get("usage")
                logger.info(
                    "[ClaudeCode] Session closed",
                    agent_id=agent_id,
                    task_id=task_id,
                    response_status=close_response.status_code,
                    output_files=len(output_files),
                    claude_code_usage=claude_code_usage
                )
                if output_files:
                    action_summary.append(f"Extracted {len(output_files)} output files")
        except Exception as e:
            logger.warning(
                "[ClaudeCode] Failed to close session",
                agent_id=agent_id,
                task_id=task_id,
                error=extract_error_message(e)
            )

        # 7. Resolve file pointers in structured_response using extracted files
        if structured_response and output_files:
            structured_response = resolve_file_pointers_from_extracted(
                structured_response=structured_response,
                output_schema=output_schema,
                extracted_files=output_files,
            )
            logger.info(
                "[ClaudeCode] Resolved file pointers in structured response",
                agent_id=agent_id,
                task_id=task_id,
            )

        # Build context summary
        success = score >= 0.8
        context_message = build_context_summary(
            success=success,
            close_reasoning=v_reasoning,
            action_summary=action_summary
        )

        # NOTE: task_complete message is emitted via ToolEvent in ToolManager (not here)
        # to keep the original tool_call_id that ties to the UI

        # Calculate usage
        execution_time_ms = (_safe_time() - start_time) * 1000
        usage_items = []

        # 1. Claude Code LLM usage — not charged, users provide their own
        # Claude credentials via OAuth sync. We only charge for the wrapping
        # agent (verifier) and E2B sandbox time.
        if claude_code_usage:
            cc_input = claude_code_usage.get("inputTokens", 0)
            cc_output = claude_code_usage.get("outputTokens", 0)
            cc_cache_read = claude_code_usage.get("cacheReadInputTokens", 0)
            cc_cache_create = claude_code_usage.get("cacheCreationInputTokens", 0)
            logger.info(
                "[ClaudeCode] Claude Code LLM usage (not charged, user's plan)",
                input_tokens=cc_input,
                output_tokens=cc_output,
                cache_read=cc_cache_read,
                cache_create=cc_cache_create,
            )

        # 2. Verifier/parent LLM usage (using parent model pricing)
        if total_input_tokens > 0 or total_output_tokens > 0:
            verifier_cost = round(
                (total_input_tokens / 1000) * model_pricing["input_cents_per_1k"] +
                (total_output_tokens / 1000) * model_pricing["output_cents_per_1k"],
                4
            )
            usage_items.append({
                "type": "llm",
                "cost_cents": verifier_cost,
                "provider": f"Verifier ({model})",
                "model": model,
                "input_tokens": total_input_tokens,
                "output_tokens": total_output_tokens,
            })

        # 3. E2B service cost: $0.000028/second = 0.0028 cents/second
        e2b_cost_cents = round((execution_time_ms / 1000) * 0.0028, 4)
        usage_items.append({
            "type": "service",
            "cost_cents": e2b_cost_cents,
            "provider": "E2B Desktop Sandbox"
        })

        # Stop log collector before returning
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
        logger.info(
            "[ClaudeCode] Activity cancelled",
            agent_id=agent_id,
            task_id=task_id
        )

        # Stop log collector on cancel
        if log_collector:
            await log_collector.stop()

        if task_id:
            try:
                await save_claude_code_message(
                    agent_id=agent_id,
                    title="Session Cancelled",
                    task_id=task_id,
                    message="Agent paused by user",
                    status=MessageStatus.FINISHED,
                    action_type="task_complete",
                )

                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/claude-code-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"task_id": task_id}
                    )
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on cancel",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error)
                )

        return {
            "status": "cancelled",
            "task_id": task_id,
            "message": "Claude Code agent cancelled by user"
        }

    except Exception as e:
        logger.error(
            "[ClaudeCode] Automation failed",
            agent_id=agent_id,
            task_id=task_id,
            error=extract_error_message(e),
            error_type=type(e).__name__
        )

        # Stop log collector on error
        if log_collector:
            await log_collector.stop()

        error_context = f"Failed during: {action_summary[-1] if action_summary else 'initialization'}"
        error_message = build_context_summary(
            success=False,
            close_reasoning=extract_error_message(e),
            action_summary=action_summary,
            error_context=error_context
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
                )

                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{config.backend.api_url}/api/claude-code-session/close",
                        headers={"x-api-key": config.backend.api_key or ""},
                        json={"task_id": task_id}
                    )
            except Exception as cleanup_error:
                logger.warning(
                    "[ClaudeCode] Cleanup failed on error",
                    agent_id=agent_id,
                    task_id=task_id,
                    error=str(cleanup_error)
                )

        raise


# ========================================
# TOOL MANAGER
# ========================================

class SpawnClaudeCodeAgentManager(ToolManager):
    """Manager for spawn_claude_code_agent tool."""

    tool_name = "spawn_claude_code_agent"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn Claude Code agent in E2B sandbox."""
        goal = tool_call.get("goal", "")
        output_schema = tool_call.get("output_schema")  # Response schema from parent's tool call
        requested_attachments = tool_call.get("attachments")  # List of filenames from tool call
        github_repo_url = tool_call.get("github_repo_link")  # Optional GitHub repo to clone
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # Resolve requested attachments from workflow context
        attachments = []
        if requested_attachments and hasattr(workflow_instance, 'context'):
            # Extract all file_pointers from context and build filename lookup
            context_attachments = extract_attachments_from_context(workflow_instance.context)
            filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

            # Resolve requested filenames to FilePointer dicts
            for filename in requested_attachments:
                if filename in filename_to_pointer:
                    fp = filename_to_pointer[filename]
                    attachments.append({
                        "id": fp.id,
                        "storage_path": fp.storage_path,
                        "original_filename": fp.original_filename,
                        "mime_type": fp.mime_type,
                        "size_bytes": fp.size_bytes,
                        "created_at": fp.created_at,
                    })
                else:
                    logger.warning(
                        "[ClaudeCode] Attachment not found in context",
                        agent_id=agent_id,
                        filename=filename,
                        available_files=list(filename_to_pointer.keys())
                    )

        logger.info(
            "[ClaudeCode] Tool starting",
            agent_id=agent_id,
            goal=goal[:200],
            has_output_schema=output_schema is not None,
            num_attachments=len(attachments),
            github_repo_url=github_repo_url
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting Claude Code sandbox",
            message='',
            status=MessageStatus.IN_PROGRESS
        )

        try:
            # Get model from workflow instance (inherit parent's model)
            model = getattr(workflow_instance, 'model', 'rose-labs/rose-1-lite')

            # Start activity with limited retries (expensive/long-running)
            activity_handle = workflow.start_activity(
                spawn_claude_code_activity,
                args=[user_id, agent_id, goal, tool_call_id, output_schema, attachments if attachments else None, model, github_repo_url],
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(seconds=60),
                cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            # Poll for pause while activity runs
            was_cancelled = False
            while not activity_handle.done():
                await workflow_instance._check_parent_state()
                if workflow_instance.is_paused:
                    logger.info(
                        "[ClaudeCode] Cancelling due to pause",
                        agent_id=agent_id
                    )
                    activity_handle.cancel()
                    was_cancelled = True
                    break
                await workflow.sleep(1)

            # Get result
            result = None
            try:
                result = await activity_handle
            except (asyncio.CancelledError, ActivityError) as e:
                # Check if it's a cancellation (either direct or wrapped by Temporal)
                if isinstance(e, ActivityError):
                    if not isinstance(e.cause, (asyncio.CancelledError, TemporalCancelledError)):
                        raise  # Re-raise non-cancellation errors
                was_cancelled = True
                result = {"status": "cancelled", "message": "Claude Code agent cancelled by user"}

            # Handle cancelled
            if was_cancelled or (result and result.get("status") == "cancelled"):
                logger.info(
                    "[ClaudeCode] Agent cancelled",
                    agent_id=agent_id
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Claude Code Session Cancelled",
                    message="User paused the agent",
                    status=MessageStatus.FINISHED,
                    metadata={"action_type": "session_cancelled"}
                )
                return

            # Build standardized usage for workflow cost tracking
            tool_usage = {"llm": [], "service": []}
            if result.get("usage_items"):
                for item in result["usage_items"]:
                    if item.get("type") == "llm":
                        tool_usage["llm"].append({
                            "tokens_in": item.get("input_tokens", 0),
                            "tokens_out": item.get("output_tokens", 0),
                            "model": item.get("model"),
                            "provider": item.get("provider", ""),
                        })
                    else:
                        tool_usage["service"].append({
                            "cost_cents": item.get("cost_cents", 0),
                            "provider": item.get("provider", ""),
                        })

            # Post output files as separate ASSISTANT messages (OAI-style)
            output_files = result.get("output_files", [])
            if output_files:
                logger.info(
                    "[ClaudeCode] Posting output files as ASSISTANT messages",
                    agent_id=agent_id,
                    file_count=len(output_files),
                )
                for fp in output_files:
                    yield AssistantEvent(
                        message="",  # Empty text for file-only messages
                        file_pointer=fp,
                    )

            # Yield final result with task_id, structured_response, and usage for tracking
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✓ Task Completed" if result.get("success") else "Task Incomplete",
                message=result.get("message", ""),
                status=MessageStatus.FINISHED,
                metadata={
                    "task_id": result.get("task_id"),
                    "action_type": "task_complete",
                    "structured_response": result.get("structured_response"),
                },
                data={"usage": tool_usage}
            )

        except Exception as e:
            # Let CancelledError propagate - workflow handles it
            if isinstance(e, asyncio.CancelledError):
                raise

            logger.error(
                "[ClaudeCode] Tool failed",
                agent_id=agent_id,
                error=extract_error_message(e),
                error_type=type(e).__name__
            )

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Claude Code failed",
                message=extract_error_message(e),
                status=MessageStatus.ERROR
            )
            raise


# ========================================
# SINGLETON
# ========================================

_manager: Optional[SpawnClaudeCodeAgentManager] = None


def get_manager() -> SpawnClaudeCodeAgentManager:
    """Get or create spawn_claude_code_agent manager singleton."""
    global _manager
    if _manager is None:
        _manager = SpawnClaudeCodeAgentManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================

async def spawn_claude_code_agent(
    workflow_instance,
    tool_call: Dict[str, Any],
    tool_call_id: str
):
    """
    Workflow helper for spawn_claude_code_agent.

    Spawns Claude Code in an E2B sandbox to complete coding tasks.

    Args:
        workflow_instance: The workflow instance
        tool_call: Tool call dict with 'goal' and 'output_schema'
        tool_call_id: Unique ID for this tool call
    """
    manager = get_manager()

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_claude_code_agent")
        # Track usage from final event (included in data field)
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="spawn_claude_code_agent")
