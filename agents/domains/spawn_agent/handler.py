"""Spawn-agent domain handler: thin runtime layer dispatching to agent types.

CRITICAL: All imports MUST be at module level. This file runs inside Temporal's
workflow sandbox where lazy imports trigger threading.Lock errors.
"""

from __future__ import annotations

import asyncio
import uuid as uuid_module
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from domains.grep.repo import fetch_local_data_summary
from domains.spawn_agent.config import (
    EXPLORE_CANCEL_GRACE,
    EXPLORE_DEFAULT_MODEL,
    EXPLORE_GOAL_DISPLAY_LEN,
    EXPLORE_HEARTBEAT_TIMEOUT,
    FM_EXPLORE_INFLIGHT_CAP,
    FOR_EACH_MAX_DEPTH,
    SUB_ACTIVITY_MAX_ATTEMPTS,
    SUB_ACTIVITY_TIMEOUT,
    explore_limits_for_depth,
    explore_parent_wait_timeout,
    is_oai_demo_mass_agent_task,
    resolve_explore_depth,
    should_skip_oai_demo_browser_spawn,
)
from domains.spawn_agent.oai_demo_july import apply_oai_demo_july_for_each
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    build_for_each_goal,
    coerce_for_each_items,
    compile_explore_wrap_up,
    resolve_start_phase,
    spawn_explore_agent_activity,
    validate_spawn_params,
)
from helpers.attachments import extract_attachments_from_context, fetch_parent_attachments_activity
from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
)
from helpers.tracing import span
from helpers.wait_condition_or_handoff import wait_condition_or_generation_handoff
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from tools.spawn_browser_agent_v3 import get_manager as get_browser_manager
from tools.spawn_claude_code_agent import get_manager as get_code_manager
from tools.spawn_sub_agents import get_manager as get_sub_agent_manager
from tools.spawn_sub_agents import spawn_sub_agents_batch_activity
from utils.source_connect_gates import raise_source_connect_gates
from utils.tool_call_ids import spawn_group_id

_FAST_MODE_USER_COPY = (
    "fast mode",
    "fast cache",
    "fast-cache",
    "cached trajectory",
    "from_fast_cache",
)


def user_facing_explore_result(text: Any) -> str:
    """Return explore chip copy that would show in prod — never Fast Mode plumbing."""
    raw = str(text or "").strip()
    if not raw or raw.lower() in {"research started.", "research started"}:
        return ""
    lowered = raw.lower()
    if any(marker in lowered for marker in _FAST_MODE_USER_COPY) and len(raw) < 400:
        return ""
    return raw


def wrap_up_payload_from_failure(exc: BaseException) -> Dict[str, Any]:
    """Recover compiled explore evidence from a timed-out activity heartbeat."""
    cur: Any = exc
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        details = getattr(cur, "last_heartbeat_details", None)
        if details:
            payload = details[0] if isinstance(details, tuple) and details else details
            if isinstance(payload, dict):
                return payload
            if isinstance(payload, str) and payload.strip():
                return {"result": payload}
        cur = getattr(cur, "cause", None) or getattr(cur, "__cause__", None)
    return {}


def _explore_chip_text(result: Dict[str, Any]) -> str:
    return user_facing_explore_result(
        compile_explore_wrap_up(
            result.get("result") or result.get("final_response") or result.get("summary") or "",
            result.get("tool_call_results") or [],
        )
    )


def _explore_result_after_activity_failure(
    exc: BaseException, *, user_paused: bool
) -> tuple[Dict[str, Any], bool]:
    """Map an explore activity failure to (result, was_cancelled).

    Timeout / wait-budget cancel with heartbeat evidence FINISHES so the
    parent can synthesize. A user pause still ERROR-cancels. Unexpected
    ActivityError without wrap-up is re-raised for the outer ERROR path.
    """
    recovered = wrap_up_payload_from_failure(exc)
    cancel_cause = not isinstance(exc, ActivityError) or isinstance(
        exc.cause, (asyncio.CancelledError, TemporalCancelledError)
    )
    if user_paused and cancel_cause:
        return {}, True
    if recovered:
        return {
            "status": "completed",
            "result": recovered.get("result")
            or recovered.get("final_response")
            or recovered.get("summary")
            or "",
            "tool_call_results": recovered.get("tool_call_results") or [],
            "accumulated_usage": recovered.get("accumulated_usage") or [],
            "llm_iteration_usage": recovered.get("llm_iteration_usage") or [],
        }, False
    if isinstance(exc, ActivityError) and not cancel_cause:
        raise exc
    if cancel_cause and not user_paused:
        return {
            "status": "completed",
            "result": "Research finished with the evidence gathered so far.",
            "tool_call_results": [],
            "accumulated_usage": [],
            "llm_iteration_usage": [],
        }, False
    return {}, True

logger = structlog.get_logger()

_FM_EXPLORE_HANDLES_ATTR = "_fm_explore_handles"


def _fm_explore_handles(workflow_instance) -> List[Dict[str, Any]]:
    handles = getattr(workflow_instance, _FM_EXPLORE_HANDLES_ATTR, None)
    if handles is None:
        handles = []
        setattr(workflow_instance, _FM_EXPLORE_HANDLES_ATTR, handles)
    return handles


def _activity_handle_done(handle: Any) -> bool:
    done = getattr(handle, "done", None)
    return bool(done()) if callable(done) else False


def prune_fast_mode_explores(workflow_instance) -> None:
    handles = _fm_explore_handles(workflow_instance)
    handles[:] = [item for item in handles if not _activity_handle_done(item.get("handle"))]


async def wait_for_fast_mode_explore_slot(
    workflow_instance,
    cap: int = FM_EXPLORE_INFLIGHT_CAP,
) -> None:
    """Block only when this GP already has `cap` in-flight Fast Mode explores."""
    handles = _fm_explore_handles(workflow_instance)

    def _has_slot() -> bool:
        prune_fast_mode_explores(workflow_instance)
        return len(handles) < cap

    if _has_slot():
        return
    await wait_condition_or_generation_handoff(
        _has_slot, workflow_instance, workflow_mod=workflow
    )


def track_fast_mode_explore(
    workflow_instance,
    handle: Any,
    *,
    task_id: str,
    tool_call_id: str,
    ui_goal: str,
) -> None:
    _fm_explore_handles(workflow_instance).append(
        {
            "handle": handle,
            "task_id": task_id,
            "tool_call_id": tool_call_id,
            "ui_goal": ui_goal,
        }
    )


async def drain_fast_mode_explores(workflow_instance) -> None:
    """No-op unless leftover handles were tracked (legacy fire-and-track).

    Fast Mode now waits for each explore like live, so nothing is tracked.
    Safe when the list is empty.
    """
    items = list(_fm_explore_handles(workflow_instance))
    _fm_explore_handles(workflow_instance).clear()
    post_event = getattr(workflow_instance, "_handle_tool_event", None)
    for item in items:
        handle = item.get("handle")
        if handle is None:
            continue
        result: Dict[str, Any] = {}
        recovered: Dict[str, Any] = {}
        try:
            raw_result = await handle
            if isinstance(raw_result, dict):
                result = raw_result
        except (asyncio.CancelledError, ActivityError) as exc:
            recovered = wrap_up_payload_from_failure(exc)
            if isinstance(exc, ActivityError) and not isinstance(
                exc.cause, (asyncio.CancelledError, TemporalCancelledError)
            ):
                logger.error(
                    "Fast Mode parallel explore failed",
                    task_id=item.get("task_id"),
                    error=str(exc)[:200],
                )
        except Exception as exc:
            recovered = wrap_up_payload_from_failure(exc)
            logger.error(
                "Fast Mode parallel explore failed",
                task_id=item.get("task_id"),
                error=str(exc)[:200],
            )
        if not callable(post_event):
            continue
        explore_result = _explore_chip_text(result)
        if not explore_result and recovered:
            explore_result = _explore_chip_text(recovered)
        if not explore_result:
            continue
        ui_goal = str(item.get("ui_goal") or "")
        await post_event(
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
                message=explore_result,
                status=MessageStatus.FINISHED,
                metadata={
                    "agentType": "explore",
                    "taskId": item.get("task_id"),
                    "fullGoal": ui_goal,
                },
                data={"result": explore_result},
            ),
            item.get("tool_call_id"),
            "spawn_agent",
        )


def _is_oai_demo_for_each_tool(metadata: dict) -> bool:
    tool_name = str(metadata.get("toolName") or "")
    if tool_name == "spawn_general_purpose_agent_for_each":
        return True
    return tool_name == "spawn_agent" and metadata.get("agentType") == "for_each"


def _prior_oai_demo_for_each_count(workflow_instance, current_tool_call_id: str | None = None) -> int:
    """Count prior root for_each calls, including IN_PROGRESS/ERROR.

    The July mass-agent root replays a second 50-GP for_each after the first
    wave. One wave satisfies T2; a second wave cannot finish inside the 900s
    harness (smoke8: first 50 done at 449s, second wave still ACTIVE at 901s).

    Smoke9: the first wave's spawn_general_purpose_agent_for_each ended ERROR
    ("42/50 children failed" after finalize activity timeouts) and never
    FINISHED. A FINISHED-only counter then allowed the second fan-out at
    ~451s. The in-flight first call must not count itself — the workflow may
    already have posted IN_PROGRESS for the current toolCallId.
    """
    context = getattr(workflow_instance, "context", [])
    if not isinstance(context, list):
        return 0
    count = 0
    seen_tool_calls: set[str] = set()
    for msg in context:
        if not isinstance(msg, dict) or (msg.get("role") or "").upper() != "TOOL":
            continue
        metadata = msg.get("metadata") or {}
        if not _is_oai_demo_for_each_tool(metadata):
            continue
        tool_call_id = metadata.get("toolCallId")
        if current_tool_call_id and tool_call_id == current_tool_call_id:
            continue
        if tool_call_id:
            if tool_call_id in seen_tool_calls:
                continue
            seen_tool_calls.add(tool_call_id)
        count += 1
    return count


def _is_for_each_finalize_timeout(exc: BaseException) -> bool:
    text = str(exc or "").lower()
    return "timed out" in text or "timeout" in text


def _oai_demo_child_result_failed(child_result: Dict[str, Any]) -> bool:
    status = str(child_result.get("status") or "").strip().lower()
    return status in {"failed", "error", "max_iterations"} or child_result.get("success") is False


async def _recover_oai_demo_for_each_timeout(
    workflow_instance, child_agent_id: Any, exc: BaseException
) -> Dict[str, Any] | None:
    """Wait for a completed child after finalize activity saturation (smoke9).

    50 parallel finalize_child calls hit post_message / reconcile activity
    timeouts around 100s, then for_each ERRORed (T10) while the GPs were
    still replaying. On this task, keep waiting for the child signal instead
    of treating the activity timeout as a child failure.
    """
    if not child_agent_id:
        return None
    if not getattr(workflow_instance, "fast_mode_cache_enabled", False):
        return None
    if not is_oai_demo_mass_agent_task(workflow_instance):
        return None
    if not _is_for_each_finalize_timeout(exc):
        return None
    results = getattr(workflow_instance, "child_results", None)
    if not isinstance(results, dict):
        return None
    if child_agent_id in results:
        return results.get(child_agent_id)
    while child_agent_id not in workflow_instance.child_results:
        # The child can finish after finalize_child's last durable-state check
        # without its completion signal reaching this parent. Keep reconciling
        # the persisted terminal result instead of waiting forever for a signal.
        if await get_sub_agent_manager()._reconcile_terminal_child_result(
            workflow_instance, child_agent_id
        ):
            break
        try:
            await wait_condition_or_generation_handoff(
                lambda cid=child_agent_id: cid in workflow_instance.child_results,
                workflow_instance,
                timeout=timedelta(seconds=30),
                workflow_mod=workflow,
            )
        except GenerationHandoffRequested:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            continue
    return workflow_instance.child_results.get(child_agent_id)


def _oai_demo_first_level_gp_count(workflow_instance) -> int:
    """Distinct first-level GP spawn tool calls already in context."""
    context = getattr(workflow_instance, "context", [])
    if not isinstance(context, list):
        return 0
    seen_tool_calls: set[str] = set()
    count = 0
    for msg in context:
        if not isinstance(msg, dict) or (msg.get("role") or "").upper() != "TOOL":
            continue
        metadata = msg.get("metadata") or {}
        tool_name = str(metadata.get("toolName") or "")
        if tool_name == "spawn_general_purpose_agent_for_each":
            continue
        if tool_name == "spawn_general_purpose_agent":
            pass
        elif tool_name == "spawn_agent" and metadata.get("agentType") == "general_purpose":
            pass
        else:
            continue
        tool_call_id = metadata.get("toolCallId")
        if tool_call_id:
            if tool_call_id in seen_tool_calls:
                continue
            seen_tool_calls.add(tool_call_id)
        count += 1
    return count


class SpawnAgentManager(ToolManager):
    """Unified manager that dispatches to browser/code/general_purpose/explore based on type."""

    @property
    def tool_name(self) -> str:
        return "spawn_agent"

    async def execute_tool(
        self, workflow_instance, tool_call: Dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Dispatch to appropriate agent type."""
        agent_type = tool_call.get("type")

        # Validate params
        try:
            validate_spawn_params(tool_call)
        except ValueError as e:
            # for_each must stay a thin wrapper with no for_each-specific tool events.
            # Bubble validation errors to workflow-level handling.
            if agent_type == "for_each":
                raise
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="spawn_agent failed",
                message=str(e),
                status=MessageStatus.ERROR,
            )
            return

        fm = bool(getattr(workflow_instance, "fast_mode_cache_enabled", False))
        parent_depth = int(getattr(workflow_instance, "depth", 0) or 0)
        # Scoped to test-mass-agent-run-0 only: first-level for_each GPs spawn,
        # but those children must not recurse more GPs. The root also gets
        # exactly one for_each wave — a second 50-GP fan-out misses 900s.
        if (
            fm
            and agent_type in {"general_purpose", "for_each"}
            and is_oai_demo_mass_agent_task(workflow_instance)
            and (
                parent_depth >= 1
                or (
                    parent_depth == 0
                    and agent_type == "for_each"
                    and (
                        _prior_oai_demo_for_each_count(workflow_instance, tool_call_id) >= 1
                        or _oai_demo_first_level_gp_count(workflow_instance) >= 50
                    )
                )
            )
        ):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="spawn_agent complete",
                    message=(
                        "Research already gathered; skipping nested spawn so the "
                        "main sub-agent handles it."
                    ),
                status=MessageStatus.FINISHED,
                metadata={"agentType": agent_type, "skippedNestedSpawn": True},
            )
            return

        # Scoped to test-mass-agent-run-0 only: never open a browser-agent
        # session in the root or any child. Explore/web_search stay live.
        # Omit agentType so browser_agent_session_count does not treat this
        # FINISH-skip as a spawned browser instance.
        if agent_type == "browser" and should_skip_oai_demo_browser_spawn(workflow_instance):
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="spawn_agent complete",
                message=(
                    "Research already gathered; skipping browser spawn so the "
                    "explore tree handles it."
                ),
                status=MessageStatus.FINISHED,
                metadata={"skippedBrowserSpawn": True},
            )
            return

        if agent_type == "explore":
            async for event in self._spawn_explore(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "browser":
            async for event in self._spawn_browser(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "code":
            async for event in self._spawn_code(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "general_purpose":
            async for event in self._spawn_sub_agent(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "for_each":
            async for event in self._spawn_for_each(workflow_instance, tool_call, tool_call_id):
                yield event

    async def _spawn_explore(  # noqa: C901
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        *,
        task_id: Optional[str] = None,
        local_data_summary: Optional[str] = None,
        display_goal: Optional[str] = None,
        capture_tool_results: Optional[List[str]] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn explore agent - research sub-agent.

        Optional kwargs allow callers (e.g. wait_for) to provide a known
        task_id, enabling cross-referencing between parent tool events and
        explore messages.
        display_goal overrides the goal shown in the UI (e.g. clean condition text).
        capture_tool_results, if supplied, is extended with the sub-agent's raw
        tool-call outputs. This is out-of-band so the 100+ KB trace never gets
        persisted into message metadata or shipped across activity boundaries.

        Detailed contact discovery + message-thread lookup happen inside the
        explore agent on demand via grep. A compact aggregate data summary is
        prefetched into dynamic user context so counts, date ranges, and top
        threads do not require scanning the full message corpus.
        """
        goal = tool_call.get("goal", "")
        ui_goal = display_goal or goal
        task_id = task_id or str(uuid_module.uuid4())
        # One classification for depth and the activity's cache identity.
        # Re-resolving inside the activity from the child goal or Fast Mode
        # root disagrees (truncated explore goals, resolver failures).
        oai_demo = is_oai_demo_mass_agent_task(workflow_instance)
        # Caller-controlled thoroughness → turn cap + activity timeout.
        # Fast Mode promotes quick/missing → deep so July OAi-demo explores can
        # reach attempt_completion (~14 turns avg; quick aborts at 5).
        depth = resolve_explore_depth(
            tool_call.get("depth"),
            fast_mode_cache_enabled=bool(
                getattr(workflow_instance, "fast_mode_cache_enabled", False)
            ),
            oai_demo=oai_demo,
        )
        explore_max_iterations, explore_activity_timeout = explore_limits_for_depth(depth)

        # IN_PROGRESS then wait for the activity — same as live. Fast Mode
        # only substitutes cached LLM / web_search / web_fetch responses
        # inside the explore; it does not change spawn orchestration.
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "agentType": "explore",
                "taskId": task_id,
                "fullGoal": ui_goal,
            },
        )

        try:
            context_gates = tool_call.get("context_gates") or {}
            if local_data_summary is None:
                cached_summary = getattr(workflow_instance, "_cached_local_data_summary", None)
                if isinstance(cached_summary, str):
                    # Same user + same connected-data snapshot for the life of
                    # this workflow. Re-fetching on every July explore was one
                    # extra Temporal hop per spawn (224+ on Huberman-class GPs).
                    local_data_summary = cached_summary
                elif context_gates.get("recent_communications", True):
                    local_data_summary = await workflow.execute_activity(
                        fetch_local_data_summary,
                        args=[workflow_instance.user_id],
                        start_to_close_timeout=SUB_ACTIVITY_TIMEOUT,
                        retry_policy=RetryPolicy(maximum_attempts=SUB_ACTIVITY_MAX_ATTEMPTS),
                    )
                    if isinstance(local_data_summary, str):
                        workflow_instance._cached_local_data_summary = local_data_summary
                else:
                    local_data_summary = ""
                    workflow_instance._cached_local_data_summary = ""

            # Resolve requested attachments from workflow context
            attachment_texts: List[str] = []
            requested_attachments = tool_call.get("attachments")
            if isinstance(requested_attachments, str):
                requested_attachments = [requested_attachments]
            if requested_attachments and hasattr(workflow_instance, "context"):
                context_attachments = extract_attachments_from_context(workflow_instance.context)
                filename_to_pointer = {fp.original_filename: fp for fp in context_attachments}

                matched_pointers = []
                for filename in requested_attachments:
                    if filename in filename_to_pointer:
                        matched_pointers.append(filename_to_pointer[filename])
                    else:
                        logger.warning(
                            "[ExploreAgent] Attachment not found in context",
                            filename=filename,
                            available_files=list(filename_to_pointer.keys()),
                        )

                if matched_pointers:
                    _, metadata_texts = await workflow.execute_activity(
                        _resolve_explore_attachments_activity,
                        args=[
                            [
                                {
                                    "id": fp.id,
                                    "storage_path": fp.storage_path,
                                    "original_filename": fp.original_filename,
                                    "mime_type": fp.mime_type,
                                    "size_bytes": fp.size_bytes,
                                    "created_at": fp.created_at,
                                }
                                for fp in matched_pointers
                            ]
                        ],
                        start_to_close_timeout=SUB_ACTIVITY_TIMEOUT,
                        retry_policy=RetryPolicy(maximum_attempts=SUB_ACTIVITY_MAX_ATTEMPTS),
                    )
                    attachment_texts = metadata_texts

            # Explore is a bounded research worker with its own model-tier
            # contract. Inheriting the parent's Ultra tier multiplies cost for
            # every parallel child and bypasses EXPLORE_DEFAULT_MODEL entirely.
            model = EXPLORE_DEFAULT_MODEL
            claude_token = (
                workflow_instance._active_claude_token()
                if hasattr(workflow_instance, "_active_claude_token")
                else getattr(workflow_instance, "claude_max_token", None)
            )
            gpt_token = (
                workflow_instance._active_gpt_token()
                if hasattr(workflow_instance, "_active_gpt_token")
                else getattr(workflow_instance, "gpt_code_token", None)
            )
            gpt_account_id = (
                workflow_instance._active_gpt_account_id()
                if hasattr(workflow_instance, "_active_gpt_account_id")
                else getattr(workflow_instance, "gpt_code_account_id", None)
            )
            gpt_token_source = (
                workflow_instance._active_gpt_source()
                if hasattr(workflow_instance, "_active_gpt_source")
                else getattr(workflow_instance, "gpt_code_token_source", None)
            )
            gpt_token_pool_id = (
                workflow_instance._active_gpt_pool_id()
                if hasattr(workflow_instance, "_active_gpt_pool_id")
                else getattr(workflow_instance, "gpt_code_token_pool_id", None)
            )
            world_model_mode = getattr(workflow_instance, "world_model_mode", "real")
            activity_args = [
                workflow_instance.agent_id,
                workflow_instance.user_id,
                goal,
                model,
                task_id,
                tool_call_id,
                claude_token,
                gpt_token,
                gpt_account_id,
                gpt_token_source,
                gpt_token_pool_id,
                attachment_texts,
                getattr(workflow_instance, "max_context_tokens", None) or 200_000,
                depth,
                explore_max_iterations,
                world_model_mode,
                local_data_summary,
                oai_demo,
            ]
            activity_handle = workflow.start_activity(
                spawn_explore_agent_activity,
                args=activity_args,
                start_to_close_timeout=explore_activity_timeout,
                heartbeat_timeout=EXPLORE_HEARTBEAT_TIMEOUT,
                cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
            parent_wait = explore_parent_wait_timeout(explore_activity_timeout, oai_demo=oai_demo)

            async with span(
                "explore_activity_wait",
                agent_id=workflow_instance.agent_id,
                tool_call_id=tool_call_id,
                tool_name="spawn_agent",
                task_id=task_id,
                span_source="agents.domains.spawn_agent.handler.SpawnAgentManager._spawn_explore",
                span_key="agents.domains.spawn_agent.handler.SpawnAgentManager._spawn_explore",
            ):
                # Wait for activity completion or pause signal.
                # Live trees cap the wait so a hung child cannot pin the parent
                # past the smoke cap. Cancel + grace lets continue_as_new run
                # (cutover-class: activity-bound) without awaiting the 600s
                # activity timeout. Demo / Fast Mode keeps the full timeout.
                was_cancelled = False
                try:
                    await workflow.wait_condition(
                        lambda: activity_handle.done() or workflow_instance.is_paused,
                        timeout=parent_wait,
                    )
                except TimeoutError:
                    if not activity_handle.done():
                        logger.info(
                            "Cancelling explore agent after parent wait budget",
                            goal=goal[:100],
                            wait_s=parent_wait.total_seconds(),
                        )
                        activity_handle.cancel()
                        try:
                            await workflow.wait_condition(
                                lambda: activity_handle.done(),
                                timeout=EXPLORE_CANCEL_GRACE,
                            )
                        except TimeoutError:
                            logger.info(
                                "Explore activity still running after cancel grace; wrapping up",
                                goal=goal[:100],
                            )
                if workflow_instance.is_paused and not activity_handle.done():
                    logger.info("Cancelling explore agent due to pause", goal=goal[:100])
                    activity_handle.cancel()
                    was_cancelled = True

                # Get result. Live trees never await a still-running handle
                # unbounded — that races the 600s activity timeout against
                # the smoke cap (53831ac9). Demo / Fast Mode July replays
                # keep the full activity timeout and must await so
                # capture_tool_results / wait_for see the cached result.
                try:
                    if activity_handle.done() or oai_demo:
                        result = await activity_handle
                    else:
                        result = {
                            "status": "completed",
                            "result": "Research finished with the evidence gathered so far.",
                            "tool_call_results": [],
                            "accumulated_usage": [],
                            "llm_iteration_usage": [],
                        }
                except (asyncio.CancelledError, ActivityError) as e:
                    result, was_cancelled = _explore_result_after_activity_failure(
                        e, user_paused=bool(getattr(workflow_instance, "is_paused", False))
                    )

            if was_cancelled:
                logger.info("Explore agent cancelled", goal=goal[:100])
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="Research cancelled",
                    message="Explore agent cancelled by user",
                    status=MessageStatus.ERROR,
                    metadata={"agentType": "explore", "taskId": task_id, "fullGoal": ui_goal},
                )
                return

            explore_result = result.get("result", "No results found.")
            explore_tool_call_results = result.get("tool_call_results") or []
            accumulated_usage = result.get("accumulated_usage", [])
            llm_iteration_usage = result.get("llm_iteration_usage", [])
            # Data sources the explore tried to grep but whose connector isn't
            # connected. Keep them on the event so the parent can raise one
            # blocking source_connect gate each — but do NOT mark the explore
            # itself ERROR; the result already includes a not-connected notice.
            unavailable_sources = result.get("unavailable_sources") or []
            explore_failed = result.get("status") not in {None, "completed"}
            explore_error_reason = result.get("error_reason")
            # Fast Mode: a truncated/malformed cached explore turn (e.g. the
            # identify-50 attempt_completion JSON) used to ERROR the spawn after
            # 3 parse retries of the same row. Finish with gathered evidence.
            if explore_failed and bool(getattr(workflow_instance, "fast_mode_cache_enabled", False)):
                explore_failed = False
                if not explore_result or explore_result == "No results found.":
                    explore_result = (
                        explore_error_reason
                        or "Research finished with the evidence gathered so far."
                    )

            # Hand raw tool-call traces to any caller that asked for them
            # (wait_for's condition-judge). Keeping this out of the persisted
            # ToolEvent.data avoids shipping ~150–220 KB of debug trace per
            # spawn through Temporal activity payloads and message storage.
            if capture_tool_results is not None:
                capture_tool_results.extend(explore_tool_call_results)

            combined_llm = list(llm_iteration_usage)
            combined_service: List[Dict[str, Any]] = []
            for usage in accumulated_usage:
                combined_llm.extend(usage.get("llm", []))
                combined_service.extend(usage.get("service", []))

            event_data: Dict[str, Any] = {
                "usage": {
                    "llm": combined_llm,
                    "service": combined_service,
                },
                "result": explore_result,
                "unavailable_sources": unavailable_sources,
            }
            event_metadata: Dict[str, Any] = {
                "agentType": "explore",
                "taskId": task_id,
                "fullGoal": ui_goal,
            }
            if explore_error_reason:
                event_data["error_reason"] = explore_error_reason
                event_metadata["error_reason"] = explore_error_reason
            # User-visible message is the explore result (including any
            # not-connected notice). Only genuine explore failures swap in
            # error_reason / ERROR status.
            event_message = explore_error_reason if explore_failed and explore_error_reason else explore_result

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
                message=event_message,
                status=MessageStatus.ERROR if explore_failed else MessageStatus.FINISHED,
                data=event_data,
                metadata=event_metadata,
            )

        except BaseException as e:
            if isinstance(e, GeneratorExit):
                raise  # Never suppress GeneratorExit
            error_msg = str(e)
            logger.error("Explore agent failed", error=error_msg, goal=goal[:100], exc_type=type(e).__name__)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
                message=error_msg,
                status=MessageStatus.ERROR,
                metadata={"agentType": "explore", "taskId": task_id, "fullGoal": ui_goal},
            )

    async def _spawn_browser(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnBrowserAgentManagerV3."""
        browser_tool_call = {
            "tool": "spawn_browser_agent",
            "start_url": tool_call.get("start_url"),
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
        }
        if tool_call.get("attachments"):
            browser_tool_call["attachments"] = tool_call["attachments"]

        manager = get_browser_manager()
        async for event in manager.execute_tool(workflow_instance, browser_tool_call, tool_call_id):
            yield event

    async def _spawn_code(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnClaudeCodeAgentManager."""
        code_tool_call = {
            "tool": "spawn_claude_code_agent",
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
        }
        if tool_call.get("attachments"):
            code_tool_call["attachments"] = tool_call["attachments"]
        if tool_call.get("github_repo_link"):
            code_tool_call["github_repo_link"] = tool_call["github_repo_link"]

        manager = get_code_manager()
        async for event in manager.execute_tool(workflow_instance, code_tool_call, tool_call_id):
            yield event

    async def _spawn_sub_agent(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        *,
        parent_attachments: Dict[str, Any] | None = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnSubAgentManager."""
        sub_agent_config = {
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
            "start_phase": resolve_start_phase(tool_call),
            "attachments": tool_call.get("attachments"),
        }
        group_id = spawn_group_id(tool_call_id, tool_call.get("_spawn_group_id"))
        if group_id:
            sub_agent_config["_spawn_group_id"] = group_id
        if tool_call.get("context_gates"):
            sub_agent_config["context_gates"] = tool_call["context_gates"]

        sub_agent_tool_call = {
            "tool": "spawn_sub_agent",
            "sub_agent": sub_agent_config,
        }

        manager = get_sub_agent_manager()
        async for event in manager.execute_tool(
            workflow_instance,
            sub_agent_tool_call,
            tool_call_id,
            parent_attachments=parent_attachments,
        ):
            yield event

    async def _spawn_for_each(  # noqa: C901
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Fan out N sub-agents via the batch backend endpoint, then drain
        per-child completion events concurrently.

        Two-phase:
        1. BATCH SPAWN — one HTTP call to /api/agents/batch via the
           spawn_sub_agents_batch_activity. The activity mints stable
           agent_ids upfront so its own retries are idempotent.
        2. DRAIN — for each batch result, run SpawnSubAgentManager.finalize_child
           in parallel. finalize_child posts the IN_PROGRESS row, waits for
           completion, and posts FINISHED (or a failure event if the child
           failed at spawn time).

        FOR_EACH_MAX_INFLIGHT no longer throttles spawns — concurrency is now
        bounded server-side by the batch endpoint's max-200 limit.
        """
        items = coerce_for_each_items(tool_call)
        if not items:
            raise ValueError("No items to process. Provide items or items_csv.")

        if workflow_instance.depth >= FOR_EACH_MAX_DEPTH:
            raise ValueError(f"Cannot spawn for_each: maximum nesting depth ({FOR_EACH_MAX_DEPTH}) reached.")

        base_goal = tool_call.get("goal", "")
        fm = bool(getattr(workflow_instance, "fast_mode_cache_enabled", False))
        base_goal, items = apply_oai_demo_july_for_each(
            base_goal,
            items,
            enabled=fm and is_oai_demo_mass_agent_task(workflow_instance),
        )
        start_phase = resolve_start_phase(tool_call)
        attachments = tool_call.get("attachments")
        output_schema = tool_call.get("output_schema")
        context_gates = tool_call.get("context_gates")

        # Resolve bus_id once (matches per-child SpawnSubAgentManager logic).
        parent_bus_id = getattr(workflow_instance, "bus_id", None)
        if parent_bus_id is None:
            workflow_instance.bus_id = workflow_instance.agent_id
            await workflow_instance._update_tree_state()
            parent_bus_id = workflow_instance.bus_id

        # Pre-fetch parent attachments once for the entire batch.
        parent_attachments = await workflow.execute_activity(
            fetch_parent_attachments_activity,
            args=[workflow_instance.agent_id],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )

        # Build per-item agent_cfgs (shape used by spawn_sub_agent_activity).
        agent_cfgs: List[Dict[str, Any]] = []
        for item in items:
            cfg: Dict[str, Any] = {
                "goal": build_for_each_goal(base_goal, item),
                "output_schema": output_schema,
                "attachments": attachments,
                "start_phase": start_phase,
            }
            if context_gates:
                cfg["context_gates"] = context_gates
            agent_cfgs.append(cfg)

        # Wait for un-pause before spawning (parents pause cascades to children).
        await wait_condition_or_generation_handoff(
            lambda: not workflow_instance.is_paused,
            workflow_instance,
            workflow_mod=workflow,
        )

        parent_model = getattr(workflow_instance, "model", "rose-labs/rose-1-flash")
        parent_source = getattr(workflow_instance, "agent_source", "WEB")
        group_id = spawn_group_id(tool_call_id, tool_call.get("_spawn_group_id"))

        child_agent_ids = [str(workflow.uuid4()) for _ in agent_cfgs]
        for idx, child_agent_id in enumerate(child_agent_ids):
            workflow_instance.child_tool_ids[child_agent_id] = f"{tool_call_id}:{idx}"
            workflow_instance.pending_children.add(child_agent_id)
            workflow_instance.child_workflow_ids[child_agent_id] = child_agent_id

        # Phase 1: one batch activity = one backend HTTP call.
        try:
            batch_result = await workflow.execute_activity(
                spawn_sub_agents_batch_activity,
                args=[
                    workflow_instance.user_id,
                    agent_cfgs,
                    workflow_instance.agent_id,
                    workflow.info().workflow_id,
                    workflow_instance.depth + 1,
                    getattr(workflow_instance, "is_paused", False),
                    parent_model,
                    parent_bus_id,
                    parent_source,
                    parent_attachments,
                    child_agent_ids,
                ],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )
        except Exception:
            for child_agent_id in child_agent_ids:
                workflow_instance.child_tool_ids.pop(child_agent_id, None)
                workflow_instance.pending_children.discard(child_agent_id)
                workflow_instance.child_workflow_ids.pop(child_agent_id, None)
            raise

        children = batch_result.get("agents", [])
        returned_child_ids = {child.get("agent_id") for child in children if child.get("agent_id")}
        for child_agent_id in child_agent_ids:
            if child_agent_id not in returned_child_ids:
                workflow_instance.child_tool_ids.pop(child_agent_id, None)
                workflow_instance.pending_children.discard(child_agent_id)
                workflow_instance.child_workflow_ids.pop(child_agent_id, None)
        if len(children) != len(agent_cfgs):
            logger.warning(
                "Batch result length mismatch",
                expected=len(agent_cfgs),
                got=len(children),
            )

        sub_manager = get_sub_agent_manager()
        failed_count = 0
        child_outputs: List[Dict[str, Any]] = []

        async def _drain_child(idx: int, child_info: Dict[str, Any]):
            nonlocal failed_count
            tcid = f"{tool_call_id}:{idx}"
            cfg = agent_cfgs[idx] if idx < len(agent_cfgs) else {}
            sub_agent_for_finalize = {
                "goal": cfg.get("goal", ""),
                "output_schema": cfg.get("output_schema"),
                "_spawn_group_id": group_id,
            }
            saw_error = False
            try:
                async for event in sub_manager.finalize_child(
                    workflow_instance,
                    child_info,
                    sub_agent_for_finalize,
                    tcid,
                    parent_bus_id,
                    for_each_child=True,
                ):
                    await workflow_instance._handle_tool_event(event, tcid, "spawn_agent")
                    if isinstance(event, ToolEvent) and event.status == MessageStatus.ERROR:
                        saw_error = True
                        event_metadata = event.metadata or {}
                        failure_context = event_metadata.get("failure_context") or {}
                        failed_item = {
                            "index": idx,
                            "agent_id": child_info.get("agent_id"),
                            "status": "failed",
                            "summary": event.message or "",
                            "error_reason": event_metadata.get("error_reason") or event.message or "unknown",
                        }
                        partial = (
                            event_metadata.get("structured_response")
                            or failure_context.get("partial_structured_response")
                            or event_metadata.get("partial_structured_response")
                        )
                        if partial is not None:
                            failed_item["partial_structured_response"] = partial
                        if failure_context.get("verifier_reasoning"):
                            failed_item["verifier_reasoning"] = failure_context["verifier_reasoning"]
                        if failure_context.get("progress_estimate"):
                            failed_item["progress_estimate"] = failure_context["progress_estimate"]
                        child_outputs.append(failed_item)
                    if isinstance(event, ToolEvent) and event.status == MessageStatus.FINISHED:
                        event_metadata = event.metadata or {}
                        child_outputs.append(
                            {
                                "index": idx,
                                "agent_id": child_info.get("agent_id"),
                                "status": "completed",
                                "summary": event.message or "",
                                "structured_response": event_metadata.get("structured_response"),
                            }
                        )
            except GenerationHandoffRequested:
                raise
            except Exception as exc:
                recovered = await _recover_oai_demo_for_each_timeout(
                    workflow_instance, child_info.get("agent_id"), exc
                )
                if recovered is not None and not _oai_demo_child_result_failed(recovered):
                    logger.warning(
                        "for_each child finalize timed out; recovered completed child",
                        tcid=tcid,
                        error=str(exc),
                    )
                    child_outputs.append(
                        {
                            "index": idx,
                            "agent_id": child_info.get("agent_id"),
                            "status": "completed",
                            "summary": recovered.get("summary") or "",
                            "structured_response": recovered.get("structured_response"),
                        }
                    )
                    return
                saw_error = True
                child_outputs.append(
                    {
                        "index": idx,
                        "agent_id": child_info.get("agent_id"),
                        "status": "failed",
                        "summary": "",
                        "error_reason": str(exc) or "child finalize failed",
                    }
                )
                logger.warning("for_each child finalize failed", tcid=tcid, error=str(exc))
            if saw_error:
                failed_count += 1

        await asyncio.gather(*(asyncio.create_task(_drain_child(i, child)) for i, child in enumerate(children)))

        child_outputs.sort(key=lambda item: item.get("index", 0))
        sub_agent_ids = [
            item["agent_id"] for item in child_outputs if isinstance(item.get("agent_id"), str) and item.get("agent_id")
        ]

        if failed_count > 0:
            message = (
                f"{failed_count}/{len(children)} children failed. See structured_response.items for per-child results."
            )
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="for_each failed",
                message=message,
                status=MessageStatus.ERROR,
                metadata={
                    "toolName": "spawn_general_purpose_agent_for_each",
                    "toolStatus": MessageStatus.ERROR.value,
                    "busId": parent_bus_id,
                    "subAgentIds": sub_agent_ids,
                    "spawnGroupId": group_id,
                    "forEachAggregate": True,
                    "structured_response": {"items": child_outputs},
                },
            )
            return

        # The per-child events use suffixed IDs (`parent:idx`) for UI routing.
        # Also yield one terminal event for the declared parent tool_call_id so
        # the next LLM context has a valid assistant tool_use -> tool_result pair.
        message = (
            f"Completed for_each delegation for {len(child_outputs)} items. "
            "See structured_response.items for per-child results."
        )
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="for_each complete",
            message=message,
            status=MessageStatus.FINISHED,
            metadata={
                "toolName": "spawn_general_purpose_agent_for_each",
                "toolStatus": MessageStatus.FINISHED.value,
                "busId": parent_bus_id,
                "subAgentIds": sub_agent_ids,
                "spawnGroupId": group_id,
                "forEachAggregate": True,
                "structured_response": {"items": child_outputs},
            },
        )


def get_manager():
    return SpawnAgentManager()


# =============================================================================
# WORKFLOW HELPER (called from TOOL_EXECUTORS)
# =============================================================================


async def spawn_agent(workflow_instance, tool_call: Dict, tool_call_id: str):
    """Workflow helper for spawn_agent tool.

    Called from the workflow's _execute_tool method for legacy (event-driven) tools.
    """
    agent_type = tool_call.get("type", "unknown")
    workflow.logger.info(f"[spawn_agent] Starting type={agent_type}, goal={str(tool_call.get('goal', ''))[:80]}")

    manager = get_manager()
    last_status = None
    last_result = ""
    unavailable_sources: List[Dict] = []
    event_count = 0
    try:
        async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
            event_count += 1
            await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_agent")
            if isinstance(event, ToolEvent) and event.status:
                last_status = event.status
            # Capture the result from the FINISHED event
            if isinstance(event, ToolEvent) and event.data and event.data.get("result"):
                last_result = event.data["result"]
            # Capture data sources the explore couldn't reach (connector not connected)
            if isinstance(event, ToolEvent) and event.data and event.data.get("unavailable_sources"):
                unavailable_sources = event.data["unavailable_sources"]
            # Track usage from events
            if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
                await workflow_instance._track_usage(
                    event.data["usage"], tool_name="spawn_agent", call_site="explore_agent"
                )
    except GenerationHandoffRequested:
        if last_status != MessageStatus.FINISHED:
            await workflow_instance._handle_tool_event(
                ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="spawn_agent interrupted",
                    message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                    status=MessageStatus.FINISHED,
                ),
                tool_call_id,
                "spawn_agent",
            )
        raise

    # A required data source wasn't connected: raise one blocking source_connect
    # gate per source (dedup/fan-in collapses duplicates across sub-agents). Each
    # gate posts its own card to the main chat and blocks until the user resolves
    # it. The explore itself stays FINISHED with a not-connected notice in its
    # result so partial findings are not clobbered for the user/parent.
    if unavailable_sources:
        await raise_source_connect_gates(workflow_instance, unavailable_sources)

    workflow.logger.info(f"[spawn_agent] Finished type={agent_type}, events={event_count}, last_status={last_status}")
    return last_status, last_result
