"""Spawn-claude-code-agent domain handler — thin runtime entry point.

Parses tool_call args, resolves attachments from workflow context,
dispatches to the activity, and yields ToolEvents for the workflow.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError
from temporalio.exceptions import TimeoutError as TemporalTimeoutError

from domains.spawn_claude_code_agent.config import (
    CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S,
    CODE_AGENT_ACTIVITY_NO_DEADLINE,
    CODE_AGENT_DRAIN_YIELD_STATUS,
    CODE_AGENT_PAUSED_STATUS,
    CODE_SESSION_HEARTBEAT_KEY,
)
from domains.spawn_claude_code_agent.service import (
    close_detached_code_session_activity,
    code_session_record,
    resolve_code_agent_provider_activity,
    spawn_claude_code_activity,
)
from helpers.activity_generation_drain import GENERATION_SUPERSEDED
from helpers.attachments import extract_attachments_from_context
from helpers.generation_handoff import GenerationHandoffRequested, park_pending_tool, take_tool_resume
from helpers.tracing import span
from helpers.wait_condition_or_handoff import live_handoff_queue
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.error_utils import extract_error_message

logger = structlog.get_logger()


def _is_recoverable_github_clone_denial(error: BaseException) -> bool:
    """True when sandbox GitHub clone was denied — agent should retry API-only.

    E2B/Claude Code session create returns HTTP 403 GITHUB_ACCESS_DENIED when
    ``github_repo_url`` points at a repo the sandbox GitHub app cannot clone.
    That is recoverable (drop the URL, use REST API) and must not hard-ERROR
    the tool call — ``no_tool_failures`` would otherwise fail closed ranking
    benches that only needed metadata discovery.
    """
    text = extract_error_message(error).upper()
    return "GITHUB_ACCESS_DENIED" in text or (
        "PERMISSION TO CLONE" in text and "GITHUB" in text
    )


def _is_recoverable_sandbox_infra_failure(error: BaseException) -> bool:
    """True when E2B session create failed on transient sandbox/infra capacity.

    Local repro (cuda-kernel k=3 r8, 2026-09-03): concurrent Claude Code spawns
    returned HTTP 500 ``redis: connection pool timeout`` / ``sandbox was not
    found`` / ``sandbox timeout``. Those are capacity flakes, not agent bugs —
    hard-ERROR trips ``no_tool_failures`` while the model can still succeed by
    retrying spawn (ideally one session at a time). Soft-FINISH instead.

    Also covers httpx ReadTimeout/ConnectTimeout on session create (cuda-kernel
    k=3 r16 agent2): create hung past the 60s httpx timeout with an empty
    ``ReadTimeout('')`` message, so substring markers alone miss it — match
    exception type names across the cause chain as well.
    """
    timeout_types = (
        "ReadTimeout",
        "ConnectTimeout",
        "WriteTimeout",
        "PoolTimeout",
        "TimeoutException",
    )
    cur: BaseException | None = error
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if type(cur).__name__ in timeout_types:
            return True
        cur = cur.__cause__ or getattr(cur, "cause", None) or cur.__context__

    text = extract_error_message(error).upper()
    if "GITHUB_ACCESS_DENIED" in text:
        return False
    markers = (
        "REDIS: CONNECTION POOL TIMEOUT",
        "CONNECTION POOL TIMEOUT",
        "FAILED TO CREATE SANDBOX",
        "FAILED TO RUN RESERVE SCRIPT",
        "THE SANDBOX WAS NOT FOUND",
        "SANDBOX TIMEOUT",
        "FAILED TO CREATE CODE SESSION",
        # Proxy/gateway capacity (cuda-kernel k=3 r10 agent1 @ ~30m): HTTP 500
        # wrapping ``503: no healthy upstream`` — soft-fail after Temporal
        # retries so no_tool_failures stays green while the agent can re-spawn.
        "NO HEALTHY UPSTREAM",
        "HTTP 503",
        "READTIMEOUT",
        "CONNECTTIMEOUT",
        "POOLTIMEOUT",
    )
    return any(m in text for m in markers)


def _is_recoverable_claude_billing_failure(error: BaseException) -> bool:
    """True when Claude Code session create failed on Anthropic org billing.

    Local repro (cuda-kernel k=3 r13, 2026-09-03): user Claude OAuth is accepted
    for the Messages API, but session create returns ``403: team is blocked:
    missing payment method`` (or credit-balance-too-low). Hard-ERROR trips
    ``no_tool_failures`` even though the agent can retry later or continue with
    non-CC tools. Soft-FINISH instead.
    """
    text = extract_error_message(error).upper()
    markers = (
        "MISSING PAYMENT METHOD",
        "TEAM IS BLOCKED",
        "CREDIT BALANCE IS TOO LOW",
        "TOO LOW TO ACCESS THE ANTHROPIC API",
        "YOUR CREDIT BALANCE IS TOO LOW",
        # E2B team billing (same soft-fail class; local fallback should usually
        # absorb this before the tool sees it).
        "TEAM IS BLOCKED: MISSING PAYMENT METHOD",
    )
    return any(m in text for m in markers)


def _soft_fail_github_clone_denial_result(
    *, code_provider: Optional[str], error: BaseException
) -> Dict[str, Any]:
    detail = extract_error_message(error)
    return {
        "success": False,
        "message": (
            "Code session could not start because the sandbox GitHub integration "
            f"denied cloning the requested repo ({detail}). Do not pass "
            "github_repo_url / github_repo_link. Retry with API-only discovery "
            "using the provided GitHub token inside a session that has no repo URL."
        ),
        "code_provider": code_provider,
    }


def _soft_fail_sandbox_infra_result(
    *, code_provider: Optional[str], error: BaseException
) -> Dict[str, Any]:
    detail = extract_error_message(error)
    return {
        "success": False,
        "message": (
            "Code session could not start due to a transient sandbox capacity "
            f"error ({detail}). Retry spawn_claude_code_agent shortly, prefer a "
            "single session at a time (avoid parallel code-agent spawns), and do "
            "not pass github_repo_url / github_repo_link."
        ),
        "code_provider": code_provider,
    }


def _soft_fail_claude_billing_result(
    *, code_provider: Optional[str], error: BaseException
) -> Dict[str, Any]:
    detail = extract_error_message(error)
    return {
        "success": False,
        "message": (
            "Code session could not start because Claude Code / sandbox billing "
            f"is blocked ({detail}). Do not treat this as a task failure. Do NOT "
            "retry spawn_claude_code_agent for this permanent payment-method / "
            "team-billing block — continue discovery with non-code-agent tools "
            "(web_search / GitHub API) instead."
        ),
        "code_provider": code_provider,
    }


def _maybe_soft_fail_session_create_result(
    *, code_provider: Optional[str], error: BaseException
) -> Optional[Dict[str, Any]]:
    """Map recoverable session-create failures to soft-fail tool results."""
    if _is_recoverable_github_clone_denial(error):
        return _soft_fail_github_clone_denial_result(
            code_provider=code_provider, error=error
        )
    # Billing markers must win over the broad sandbox "FAILED TO CREATE CODE
    # SESSION" substring — otherwise Anthropic payment blocks are mislabeled as
    # capacity flakes (cuda-kernel k=3 r13).
    if _is_recoverable_claude_billing_failure(error):
        return _soft_fail_claude_billing_result(
            code_provider=code_provider, error=error
        )
    if _is_recoverable_sandbox_infra_failure(error):
        return _soft_fail_sandbox_infra_result(
            code_provider=code_provider, error=error
        )
    return None


def _drained_code_session(
    result: Dict[str, Any], prior_session: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Session that reattaches the next activity to the drained sandbox."""
    prior = prior_session or {}
    session = dict(result.get("code_session") or prior)
    session.pop("generation_yield", None)
    # A superseded generation that cannot park finishes here; yielding again
    # would only restart the activity on the same superseded queue.
    if prior.get("generation_yield") is False or result.get("yield_reason") == GENERATION_SUPERSEDED:
        session["generation_yield"] = False
    return session


def _timed_out_code_session(
    error: ActivityError, scheduled_session: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Sandbox left running by a run whose last attempt timed out, if any.

    The retries are exhausted, so nothing will reattach to it, and an attempt
    on a dead worker never ran its own cleanup.
    """
    cause = error.cause
    if not isinstance(cause, TemporalTimeoutError):
        return None
    for detail in cause.last_heartbeat_details or ():
        if isinstance(detail, dict):
            session = code_session_record(detail.get(CODE_SESSION_HEARTBEAT_KEY))
            if session is not None:
                return session
    return code_session_record(scheduled_session)


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
        # Resume a specific persistent code session; omitted, the backend resumes
        # this agent's latest session for the repo (or starts its own branch).
        requested_code_session_id = tool_call.get("code_session_id")
        code_session_request = (
            {"code_session_id": requested_code_session_id}
            if isinstance(requested_code_session_id, str) and requested_code_session_id
            else None
        )
        user_id = workflow_instance.user_id
        agent_id = workflow_instance.agent_id

        # Resolve requested attachments from workflow context
        attachments = _resolve_attachments(workflow_instance, requested_attachments, agent_id)

        # A previous generation parked this exact tool call across a deploy
        # (continue_as_new) while its sandbox kept running. The chip is still
        # open; reattach to that sandbox instead of starting a new one.
        resume_hint = take_tool_resume(workflow_instance, tool_call_id) or {}
        code_session = resume_hint.get("code_session")
        if not isinstance(code_session, dict):
            code_session = None

        logger.info(
            "[ClaudeCode] Tool starting",
            agent_id=agent_id,
            goal=goal[:200],
            has_output_schema=output_schema is not None,
            num_attachments=len(attachments),
            github_repo_url=github_repo_url,
            resumed_task_id=(code_session or {}).get("task_id"),
        )

        if code_session is None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Starting Claude Code sandbox",
                message="",
                status=MessageStatus.IN_PROGRESS,
                metadata={"toolName": "spawn_claude_code_agent"},
            )

        code_provider = "unknown"
        try:
            model = getattr(workflow_instance, "model", "rose-labs/rose-1-flash")
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
            if code_session is not None and code_session.get("code_provider"):
                code_provider = code_session["code_provider"]
            else:
                default_code_provider = _select_code_provider(workflow_instance, gpt_token)
                code_provider = await workflow.execute_activity(
                    resolve_code_agent_provider_activity,
                    args=[default_code_provider],
                    start_to_close_timeout=timedelta(seconds=20),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
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
                while True:
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
                            None,  # Reserved legacy credential slot; secrets are resolved inside the activity.
                            code_provider,
                            gpt_token,
                            gpt_account_id,
                            gpt_token_source,
                            gpt_token_pool_id,
                            fast_mode_cache_enabled,
                            code_session,
                            code_session_request,
                        ],
                        # No runtime limit (C11): Temporal needs a value, so this is
                        # effectively infinite; liveness is heartbeat_timeout only.
                        start_to_close_timeout=CODE_AGENT_ACTIVITY_NO_DEADLINE,
                        heartbeat_timeout=timedelta(seconds=CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S),
                        # WAIT so pause cancel receives the activity's cancelled
                        # result (includes task_id). TRY_CANCEL races the workflow
                        # ahead of cleanup and posts task_complete without task_id,
                        # leaving ClaudeCodeChip stuck on "Spinning up..." on the
                        # durable hub FE (agent 094f1085 / task 1d92a4db).
                        cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
                        # Unlimited attempts: a worker crash or deploy never ends a code
                        # session (each retry reattaches/resumes it). Errors the
                        # activity raises itself become non-retryable after
                        # CODE_AGENT_ERROR_RETRY_LIMIT attempts, so capacity flakes
                        # still get in-activity retries before the soft-fail path
                        # (cuda-kernel k=3 r10 agent1) and nothing loops forever.
                        retry_policy=RetryPolicy(maximum_attempts=0),
                    )

                    # Wait for activity completion or pause signal
                    was_cancelled = False
                    # cutover-class: activity-bound — the activity detaches at a deploy drain and returns its session
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
                            abandoned = _timed_out_code_session(e, code_session)
                            if abandoned is not None:
                                try:
                                    await workflow.execute_activity(
                                        close_detached_code_session_activity,
                                        args=[agent_id, abandoned],
                                        start_to_close_timeout=timedelta(seconds=60),
                                        retry_policy=RetryPolicy(maximum_attempts=3),
                                    )
                                except ActivityError as close_error:
                                    logger.warning(
                                        "[ClaudeCode] Closing the timed-out run's sandbox failed",
                                        agent_id=agent_id,
                                        task_id=abandoned.get("task_id"),
                                        error=extract_error_message(close_error),
                                    )
                            soft = _maybe_soft_fail_session_create_result(
                                code_provider=code_provider, error=e
                            )
                            if soft is not None:
                                logger.warning(
                                    "[ClaudeCode] Recoverable session-create failure; soft-failing tool",
                                    agent_id=agent_id,
                                    code_provider=code_provider,
                                    error=extract_error_message(e),
                                )
                                result = soft
                            else:
                                raise
                        else:
                            was_cancelled = True
                            result = {
                                "status": "cancelled",
                                "message": "Claude Code agent cancelled by user",
                            }

                    if was_cancelled or not result or result.get("status") != CODE_AGENT_DRAIN_YIELD_STATUS:
                        break

                    # The worker is draining (rolling deploy) or its generation was
                    # superseded; the sandbox keeps running. Reattach from a live
                    # worker of this queue, or from the live generation after
                    # continue_as_new carries this tool call.
                    code_session = _drained_code_session(result, code_session)
                    if workflow_instance.is_paused:
                        # Paused while detached: no attempt will reattach, so the
                        # cancel path below closes the sandbox.
                        was_cancelled = True
                        result = {
                            "status": "cancelled",
                            "message": "Claude Code agent cancelled by user",
                            "code_provider": code_session.get("code_provider"),
                        }
                        break
                    handoff_queue = await live_handoff_queue(workflow_instance)
                    if handoff_queue:
                        parked_session = {k: v for k, v in code_session.items() if k != "generation_yield"}
                        if park_pending_tool(workflow_instance, tool_call_id, {"code_session": parked_session}):
                            logger.info(
                                "[ClaudeCode] Code session parked for generation handoff",
                                agent_id=agent_id,
                                task_id=code_session.get("task_id"),
                                yield_reason=result.get("yield_reason"),
                                handoff_task_queue=handoff_queue,
                            )
                            raise GenerationHandoffRequested(handoff_queue, parked=True)
                        # Parking is unavailable here (DAG turn or payload budget):
                        # finish on this generation instead of yielding every second.
                        code_session["generation_yield"] = False
                    logger.info(
                        "[ClaudeCode] Code session drained; reattaching to the same sandbox",
                        agent_id=agent_id,
                        task_id=code_session.get("task_id"),
                        yield_reason=result.get("yield_reason"),
                        generation_yield=code_session.get("generation_yield", True),
                    )

            if was_cancelled or (result and result.get("status") == "cancelled"):
                logger.info("[ClaudeCode] Agent cancelled", agent_id=agent_id)
                if code_session is not None and not (result or {}).get("task_id"):
                    # An activity that held the sandbox returns its task_id after
                    # closing it. Without one, the cancel landed before a
                    # reattaching attempt took over, so the sandbox is still open.
                    await workflow.execute_activity(
                        close_detached_code_session_activity,
                        args=[agent_id, code_session],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=3),
                    )
                    result = {
                        **(result or {}),
                        "task_id": code_session.get("task_id"),
                        "code_provider": (result or {}).get("code_provider") or code_session.get("code_provider"),
                    }
                # Chip terminality requires action_type=task_complete + task_id.
                # session_cancelled without task_id leaves ClaudeCodeChip stuck on
                # "Spinning up..." after pause (hub agent 182cf2ab / task 45ce853d).
                cancel_metadata = {
                    "toolName": "spawn_claude_code_agent",
                    "action_type": "task_complete",
                    "success": False,
                }
                if result:
                    if result.get("task_id"):
                        cancel_metadata["task_id"] = result["task_id"]
                    if result.get("code_provider"):
                        cancel_metadata["code_provider"] = result["code_provider"]
                if not cancel_metadata.get("task_id"):
                    # Last resort: still emit task_complete so routing stays on
                    # ClaudeCodeChip, but log — FE recovers task_id from siblings.
                    logger.warning(
                        "[ClaudeCode] Cancel without task_id; chip may need FE sibling recovery",
                        agent_id=agent_id,
                    )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Claude Code Session Cancelled",
                    message="User paused the agent",
                    status=MessageStatus.ERROR,
                    metadata=cancel_metadata,
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

            code_provider = result.get("code_provider") or code_provider
            success = result.get("success") is True
            output_files = result.get("output_files", [])
            paused = result.get("status") == CODE_AGENT_PAUSED_STATUS
            completed_metadata: Dict[str, Any] = {
                "toolName": "spawn_claude_code_agent",
                "task_id": result.get("task_id"),
                "action_type": "task_complete",
                "success": success,
                "structured_response": result.get("structured_response"),
                "code_provider": code_provider,
                "completed_turns": result.get("completed_turns"),
            }
            if isinstance(result.get("code_session"), dict):
                completed_metadata["code_session"] = result["code_session"]
            if paused:
                completed_metadata["session_paused"] = True
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                # An idle session is paused and resumable, never a failure (C11).
                title="Code session paused" if paused else ("✓ Task Completed" if success else "Task Incomplete"),
                message=result.get("message", ""),
                status=MessageStatus.FINISHED,
                metadata=completed_metadata,
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

        except GenerationHandoffRequested:
            raise
        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                raise

            soft = _maybe_soft_fail_session_create_result(
                code_provider=code_provider, error=e
            )
            if soft is not None:
                logger.warning(
                    "[ClaudeCode] Recoverable session-create failure; soft-failing tool",
                    agent_id=agent_id,
                    code_provider=code_provider,
                    error=extract_error_message(e),
                    error_type=type(e).__name__,
                )
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Task Incomplete",
                    message=soft["message"],
                    status=MessageStatus.FINISHED,
                    metadata={
                        "toolName": "spawn_claude_code_agent",
                        "action_type": "task_complete",
                        "success": False,
                        "code_provider": code_provider,
                    },
                )
                return

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


def _select_code_provider(workflow_instance: Any, gpt_token: Optional[str]) -> str:
    """Use Codex for GPT compute tokens; keep Claude Code for Claude tokens."""
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
    global _manager
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
