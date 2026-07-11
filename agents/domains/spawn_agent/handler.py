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

from domains.spawn_agent.config import (
    EXPLORE_DEFAULT_DEPTH,
    EXPLORE_DEFAULT_MODEL,
    EXPLORE_GOAL_DISPLAY_LEN,
    EXPLORE_HEARTBEAT_TIMEOUT,
    FOR_EACH_MAX_DEPTH,
    SUB_ACTIVITY_MAX_ATTEMPTS,
    SUB_ACTIVITY_TIMEOUT,
    explore_limits_for_depth,
)
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    build_for_each_goal,
    coerce_for_each_items,
    resolve_start_phase,
    spawn_explore_agent_activity,
    validate_spawn_params,
)
from helpers.attachments import extract_attachments_from_context, fetch_parent_attachments_activity
from helpers.tracing import span
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from tools.spawn_browser_agent_v3 import get_manager as get_browser_manager
from tools.spawn_claude_code_agent import get_manager as get_code_manager
from tools.spawn_sub_agents import get_manager as get_sub_agent_manager
from tools.spawn_sub_agents import spawn_sub_agents_batch_activity
from utils.tool_call_ids import spawn_group_id

logger = structlog.get_logger()


def _combined_goal_text(workflow_instance, tool_call: Dict[str, Any]) -> str:
    return " ".join(
        str(part or "")
        for part in (
            getattr(workflow_instance, "goal", ""),
            tool_call.get("goal", ""),
        )
    ).lower()


def _current_tool_goal_text(tool_call: Dict[str, Any]) -> str:
    return str(tool_call.get("goal") or "").lower()


def _explicit_general_purpose_requested(goal_text: str) -> bool:
    return (
        "spawn_general_purpose_agent" in goal_text
        or "general-purpose agent" in goal_text
        or "general purpose agent" in goal_text
    )


def _explore_only_research_instruction(workflow_instance, tool_call: Dict[str, Any]) -> bool:
    """Detect explicit instructions that this task should research via explore only."""
    goal_text = _combined_goal_text(workflow_instance, tool_call)
    current_goal_text = _current_tool_goal_text(tool_call)
    explicit_general_purpose_request = _explicit_general_purpose_requested(current_goal_text) or (
        getattr(workflow_instance, "depth", 0) == 0 and _explicit_general_purpose_requested(goal_text)
    )

    asks_for_explore = (
        "explore-agent" in goal_text
        or "explore agent" in goal_text
        or "explore sub-agent" in goal_text
        or "explore subagent" in goal_text
        or "explore sub-agents" in goal_text
        or "explore subagents" in goal_text
        or "explore/web-search" in goal_text
        or "web-search/explore" in goal_text
    )
    forbids_heavy_agents = (
        "must not use browser" in goal_text
        or "must not use a browser" in goal_text
        or "must not use browser agent" in goal_text
        or "must not use a browser agent" in goal_text
        or "must not use claude code" in goal_text
        or "must not use code sandbox" in goal_text
        or "do not use browser" in goal_text
        or "do not use a browser" in goal_text
        or "do not use browser agent" in goal_text
        or "do not use a browser agent" in goal_text
        or "do not use claude code" in goal_text
        or "do not use code sandbox" in goal_text
        or "no browser/code/sandbox" in goal_text
        or "no browser agent" in goal_text
        or "no code sandbox" in goal_text
    )
    return asks_for_explore and forbids_heavy_agents and not explicit_general_purpose_request


def _expected_explore_agents_for_city_task(goal_text: str) -> int | None:
    if "one explore sub-agent per city" not in goal_text and "spawn one explore sub-agent per city" not in goal_text:
        return None
    if "three cities" in goal_text or "3 cities" in goal_text:
        return 3
    return None


def _prior_explore_agent_count(workflow_instance) -> int:
    context = getattr(workflow_instance, "context", [])
    if not isinstance(context, list):
        return 0

    count = 0
    seen_tool_calls: set[str] = set()
    for msg in context:
        if not isinstance(msg, dict) or (msg.get("role") or "").upper() != "TOOL":
            continue
        metadata = msg.get("metadata") or {}
        if metadata.get("toolName") != "spawn_agent":
            continue
        if metadata.get("agentType") != "explore":
            continue
        if metadata.get("toolStatus") not in {"IN_PROGRESS", "FINISHED"}:
            continue
        tool_call_id = metadata.get("toolCallId")
        if tool_call_id:
            if tool_call_id in seen_tool_calls:
                continue
            seen_tool_calls.add(tool_call_id)
        count += 1
    return count


def _blocked_research_only_agent_type(workflow_instance, tool_call: Dict[str, Any]) -> str | None:
    """Return an explanatory error when an explore-only task tries to delegate incorrectly."""
    if not _explore_only_research_instruction(workflow_instance, tool_call):
        return None

    agent_type = tool_call.get("type")
    if agent_type in {"browser", "code", "general_purpose", "for_each"}:
        return (
            "This task requires explore-agent web research only; do not spawn "
            f"a {agent_type} agent here. Use spawn_agent(type='explore') or answer "
            "from the research already gathered."
        )
    goal_text = _combined_goal_text(workflow_instance, tool_call)
    expected_explore_agents = _expected_explore_agents_for_city_task(goal_text)
    if (
        agent_type == "explore"
        and expected_explore_agents is not None
        and _prior_explore_agent_count(workflow_instance) >= expected_explore_agents
    ):
        return (
            f"This task asked for one explore sub-agent per city and already has {expected_explore_agents} "
            "explore agents. Use the gathered research and finish the answer instead of spawning more."
        )
    return None


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

        blocked_reason = _blocked_research_only_agent_type(workflow_instance, tool_call)
        if blocked_reason:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="spawn_agent failed",
                message=blocked_reason,
                status=MessageStatus.ERROR,
                metadata={"agentType": agent_type},
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

        Contact discovery + message-thread lookup happen inside the explore
        agent on demand via the grep tool's network / agent_network_* /
        messages source modes — we no longer prefetch network_metadata or
        local_data_summary before spawning.
        """
        goal = tool_call.get("goal", "")
        ui_goal = display_goal or goal
        task_id = task_id or str(uuid_module.uuid4())
        # Caller-controlled thoroughness → turn cap + activity timeout. Default quick.
        depth = tool_call.get("depth") or EXPLORE_DEFAULT_DEPTH
        explore_max_iterations, explore_activity_timeout = explore_limits_for_depth(depth)

        # IN_PROGRESS
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
            status=MessageStatus.IN_PROGRESS,
            metadata={"agentType": "explore", "taskId": task_id, "fullGoal": ui_goal},
        )

        try:
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
            async with span(
                "explore_activity_wait",
                agent_id=workflow_instance.agent_id,
                tool_call_id=tool_call_id,
                tool_name="spawn_agent",
                task_id=task_id,
                span_source="agents.domains.spawn_agent.handler.SpawnAgentManager._spawn_explore",
                span_key="agents.domains.spawn_agent.handler.SpawnAgentManager._spawn_explore",
            ):
                activity_handle = workflow.start_activity(
                    spawn_explore_agent_activity,
                    args=[
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
                    ],
                    start_to_close_timeout=explore_activity_timeout,
                    heartbeat_timeout=EXPLORE_HEARTBEAT_TIMEOUT,
                    cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL,
                    retry_policy=RetryPolicy(maximum_attempts=1),
                )

                # Wait for activity completion or pause signal
                was_cancelled = False
                await workflow.wait_condition(lambda: activity_handle.done() or workflow_instance.is_paused)
                if workflow_instance.is_paused and not activity_handle.done():
                    logger.info("Cancelling explore agent due to pause", goal=goal[:100])
                    activity_handle.cancel()
                    was_cancelled = True

                # Get result
                try:
                    result = await activity_handle
                except (asyncio.CancelledError, ActivityError) as e:
                    if isinstance(e, ActivityError) and not isinstance(
                        e.cause, (asyncio.CancelledError, TemporalCancelledError)
                    ):
                        raise  # Re-raise non-cancellation errors
                    was_cancelled = True
                    result = {}

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

            # FINISHED with result and usage
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
                message=explore_result,
                status=MessageStatus.FINISHED,
                data={
                    "usage": {
                        "llm": combined_llm,
                        "service": combined_service,
                    },
                    "result": explore_result,
                },
                metadata={"agentType": "explore", "taskId": task_id, "fullGoal": ui_goal},
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
        await workflow.wait_condition(lambda: not workflow_instance.is_paused)

        parent_model = getattr(workflow_instance, "model", "rose-labs/rose-1-lite")
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
                    workflow_instance, child_info, sub_agent_for_finalize, tcid, parent_bus_id
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
            except Exception as exc:
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
    event_count = 0
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        event_count += 1
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Capture the result from the FINISHED event
        if isinstance(event, ToolEvent) and event.data and event.data.get("result"):
            last_result = event.data["result"]
        # Track usage from events
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(
                event.data["usage"], tool_name="spawn_agent", call_site="explore_agent"
            )

    workflow.logger.info(f"[spawn_agent] Finished type={agent_type}, events={event_count}, last_status={last_status}")
    return last_status, last_result
