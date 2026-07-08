"""Spawn-claude-code-agent domain handler — thin runtime entry point.

Parses tool_call args, resolves attachments from workflow context,
dispatches to the activity, and yields ToolEvents for the workflow.
"""

from __future__ import annotations

import asyncio
import os
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from domains.spawn_claude_code_agent.service import spawn_claude_code_activity
from helpers.attachments import extract_attachments_from_context
from helpers.tracing import span
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.error_utils import extract_error_message

logger = structlog.get_logger()


class SpawnClaudeCodeAgentManager(ToolManager):
    """Manager for spawn_claude_code_agent tool."""

    tool_name = "spawn_claude_code_agent"

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn Claude Code agent in E2B sandbox."""
        goal = tool_call.get("goal", "")
        output_schema = tool_call.get("output_schema")
        requested_attachments = tool_call.get("attachments")
        github_repo_url = tool_call.get("github_repo_link")
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # Resolve requested attachments from workflow context
        attachments = _resolve_attachments(workflow_instance, requested_attachments, agent_id)

        logger.info(
            "[ClaudeCode] Tool starting",
            agent_id=agent_id,
            goal=goal[:200],
            has_output_schema=output_schema is not None,
            num_attachments=len(attachments),
            github_repo_url=github_repo_url,
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Starting Claude Code sandbox",
            message="",
            status=MessageStatus.IN_PROGRESS,
            metadata={"toolName": "spawn_claude_code_agent"},
        )

        code_provider = "unknown"
        try:
            model = getattr(workflow_instance, "model", "rose-labs/rose-1-lite")
            active_claude_token = getattr(workflow_instance, "_active_claude_token", None)
            claude_token = (
                active_claude_token()
                if callable(active_claude_token)
                else getattr(workflow_instance, "claude_max_token", None)
            )
            active_gpt_token = getattr(workflow_instance, "_active_gpt_token", None)
            gpt_token = (
                active_gpt_token()
                if callable(active_gpt_token)
                else getattr(workflow_instance, "gpt_code_token", None)
            )
            active_gpt_account_id = getattr(workflow_instance, "_active_gpt_account_id", None)
            gpt_account_id = (
                active_gpt_account_id()
                if callable(active_gpt_account_id)
                else getattr(workflow_instance, "gpt_code_account_id", None)
            )
            active_gpt_source = getattr(workflow_instance, "_active_gpt_source", None)
            gpt_token_source = (
                active_gpt_source()
                if callable(active_gpt_source)
                else getattr(workflow_instance, "gpt_code_token_source", None)
            )
            active_gpt_pool_id = getattr(workflow_instance, "_active_gpt_pool_id", None)
            gpt_token_pool_id = (
                active_gpt_pool_id()
                if callable(active_gpt_pool_id)
                else getattr(workflow_instance, "gpt_code_token_pool_id", None)
            )
            fast_mode_cache_enabled = bool(getattr(workflow_instance, "fast_mode_cache_enabled", False))
            code_provider = _select_code_provider(workflow_instance, gpt_token)
            logger.info(
                "[ClaudeCode] Selected code sandbox provider",
                agent_id=agent_id,
                code_provider=code_provider,
                compute_token_provider=getattr(workflow_instance, "compute_token_provider", None),
            )

            async with span(
                "claude_code_activity_wait",
                agent_id=agent_id,
                tool_call_id=tool_call_id,
                tool_name="spawn_claude_code_agent",
                code_provider=code_provider,
                span_source="agents.domains.spawn_claude_code_agent.handler.SpawnClaudeCodeAgentManager.execute",
                span_key="agents.domains.spawn_claude_code_agent.handler.SpawnClaudeCodeAgentManager.execute",
            ):
                activity_handle = workflow.start_activity(
                    spawn_claude_code_activity,
                    args=[
                        user_id,
                        agent_id,
                        goal,
                        tool_call_id,
                        output_schema,
                        attachments if attachments else None,
                        model,
                        github_repo_url,
                        claude_token,
                        code_provider,
                        gpt_token,
                        gpt_account_id,
                        gpt_token_source,
                        gpt_token_pool_id,
                        fast_mode_cache_enabled,
                    ],
                    start_to_close_timeout=timedelta(minutes=50),
                    heartbeat_timeout=timedelta(minutes=5),
                    cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )

                # Wait for activity completion or pause signal
                was_cancelled = False
                await workflow.wait_condition(lambda: activity_handle.done() or workflow_instance.is_paused)
                if workflow_instance.is_paused and not activity_handle.done():
                    logger.info("[ClaudeCode] Cancelling due to pause", agent_id=agent_id)
                    activity_handle.cancel()
                    was_cancelled = True

                result = None
                try:
                    result = await activity_handle
                except (asyncio.CancelledError, ActivityError) as e:
                    if isinstance(e, ActivityError) and not isinstance(
                        e.cause, (asyncio.CancelledError, TemporalCancelledError)
                    ):
                        raise
                    was_cancelled = True
                    result = {"status": "cancelled", "message": "Claude Code agent cancelled by user"}

            if was_cancelled or (result and result.get("status") == "cancelled"):
                logger.info("[ClaudeCode] Agent cancelled", agent_id=agent_id)
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Claude Code Session Cancelled",
                    message="User paused the agent",
                    status=MessageStatus.ERROR,
                    metadata={"action_type": "session_cancelled", "toolName": "spawn_claude_code_agent"},
                )
                return

            # Build standardized usage for workflow cost tracking
            tool_usage: Dict[str, list] = {"llm": [], "service": []}
            if result.get("usage_items"):
                for item in result["usage_items"]:
                    if item.get("type") == "llm":
                        tool_usage["llm"].append(
                            {
                                "tokens_in": item.get("input_tokens", 0),
                                "tokens_out": item.get("output_tokens", 0),
                                "model": item.get("model"),
                                "provider": item.get("provider", ""),
                            }
                        )
                    else:
                        tool_usage["service"].append(
                            {
                                "cost_cents": item.get("cost_cents", 0),
                                "provider": item.get("provider", ""),
                            }
                        )

            output_files = result.get("output_files", [])
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="✓ Task Completed" if result.get("success") else "Task Incomplete",
                message=result.get("message", ""),
                status=MessageStatus.FINISHED,
                metadata={
                    "toolName": "spawn_claude_code_agent",
                    "task_id": result.get("task_id"),
                    "action_type": "task_complete",
                    "structured_response": result.get("structured_response"),
                    "code_provider": code_provider,
                    "completed_turns": result.get("completed_turns"),
                },
                data={"usage": tool_usage},
            )

            # Post output files only after the parent tool call has a terminal
            # TOOL result. Realtime consumers require assistant messages to
            # follow resolved tool calls, not appear between IN_PROGRESS and
            # FINISHED states for the same tool_call_id.
            if output_files:
                logger.info(
                    "[ClaudeCode] Posting output files as ASSISTANT messages",
                    agent_id=agent_id,
                    file_count=len(output_files),
                )
                for fp in output_files:
                    yield AssistantEvent(message="", file_pointer=fp)

        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                raise

            logger.error(
                "[ClaudeCode] Tool failed",
                agent_id=agent_id,
                code_provider=code_provider,
                error=extract_error_message(e),
                error_type=type(e).__name__,
            )

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Code session failed",
                message=extract_error_message(e),
                status=MessageStatus.ERROR,
                metadata={"toolName": "spawn_claude_code_agent", "code_provider": code_provider},
            )


# ---------------------------------------------------------------------------
# Attachment resolution
# ---------------------------------------------------------------------------


def _resolve_attachments(
    workflow_instance: Any,
    requested_attachments: Optional[list[str]],
    agent_id: str,
) -> list[Dict[str, Any]]:
    """Resolve requested attachment filenames from workflow context."""
    attachments: list[Dict[str, Any]] = []

    if not hasattr(workflow_instance, "context"):
        return attachments

    context_attachments = extract_attachments_from_context(workflow_instance.context)
    filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

    if requested_attachments:
        id_to_pointer = {fp.id: fp for fp in context_attachments}
        for filename in requested_attachments:
            fp = filename_to_pointer.get(filename) or id_to_pointer.get(filename)
            if fp:
                attachments.append(_fp_to_dict(fp))
            else:
                logger.warning(
                    "[ClaudeCode] Attachment not found in context",
                    agent_id=agent_id,
                    filename=filename,
                    available_files=list(filename_to_pointer.keys()),
                )

    # If explicit resolution found nothing, auto-forward all
    if requested_attachments and not attachments and context_attachments:
        logger.info(
            "[ClaudeCode] Explicit attachment resolution failed, auto-forwarding all parent attachments",
            agent_id=agent_id,
            requested=requested_attachments,
            num_files=len(context_attachments),
            filenames=list(filename_to_pointer.keys()),
        )
        attachments = [_fp_to_dict(fp) for fp in context_attachments]
    elif not requested_attachments and context_attachments:
        # Auto-forward all parent attachments when none explicitly requested
        logger.info(
            "[ClaudeCode] Auto-forwarding parent attachments (none explicitly requested)",
            agent_id=agent_id,
            num_files=len(context_attachments),
            filenames=list(filename_to_pointer.keys()),
        )
        attachments = [_fp_to_dict(fp) for fp in context_attachments]

    return attachments


def _forced_code_provider() -> Optional[str]:
    value = os.getenv("ROSE_CODE_AGENT_PROVIDER", "").strip().lower()
    return value if value in {"claude", "codex"} else None


def _select_code_provider(workflow_instance: Any, gpt_token: Optional[str]) -> str:
    """Use Codex for GPT compute tokens; keep Claude Code for Claude tokens."""
    forced = _forced_code_provider()
    if forced is not None:
        return forced
    provider = getattr(workflow_instance, "compute_token_provider", None)
    if provider == "gpt" and gpt_token:
        return "codex"
    return "claude"


def _fp_to_dict(fp: Any) -> Dict[str, Any]:
    """Convert a FilePointer to a serializable dict."""
    return {
        "id": fp.id,
        "storage_path": fp.storage_path,
        "original_filename": fp.original_filename,
        "mime_type": fp.mime_type,
        "size_bytes": fp.size_bytes,
        "created_at": fp.created_at,
    }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_manager: Optional[SpawnClaudeCodeAgentManager] = None


def get_manager() -> SpawnClaudeCodeAgentManager:
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = SpawnClaudeCodeAgentManager()
    return _manager


# ---------------------------------------------------------------------------
# Workflow helper (called from TOOL_EXECUTORS — legacy signature)
# ---------------------------------------------------------------------------


async def spawn_claude_code_agent(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> Optional[MessageStatus]:
    """Workflow helper for spawn_claude_code_agent.

    Spawns Claude Code in an E2B sandbox to complete coding tasks.
    """
    manager = get_manager()
    last_status = None

    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_claude_code_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(
                event.data["usage"], tool_name="spawn_claude_code_agent", call_site="claude_code_agent"
            )

    return last_status
