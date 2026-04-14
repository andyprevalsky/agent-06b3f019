"""Spawn-agent domain handler: thin runtime layer dispatching to agent types.

CRITICAL: All imports MUST be at module level. This file runs inside Temporal's
workflow sandbox where lazy imports trigger threading.Lock errors.
"""

from __future__ import annotations

import asyncio
import uuid as uuid_module
from typing import Any, AsyncGenerator, Dict, List, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError
from temporalio.exceptions import CancelledError as TemporalCancelledError

from domains.spawn_agent.config import (
    EXPLORE_ACTIVITY_TIMEOUT,
    EXPLORE_DEFAULT_MODEL,
    EXPLORE_GOAL_DISPLAY_LEN,
    EXPLORE_HEARTBEAT_TIMEOUT,
    FOR_EACH_MAX_DEPTH,
    FOR_EACH_MAX_INFLIGHT,
    SUB_ACTIVITY_MAX_ATTEMPTS,
    SUB_ACTIVITY_TIMEOUT,
)
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    build_for_each_goal,
    coerce_for_each_items,
    fetch_full_network_metadata,
    resolve_start_phase,
    spawn_explore_agent_activity,
    validate_spawn_params,
)
from helpers.attachments import extract_attachments_from_context
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from tools.grep import fetch_local_data_summary
from tools.spawn_browser_agent_v3 import get_manager as get_browser_manager
from tools.spawn_claude_code_agent import get_manager as get_code_manager
from tools.spawn_sub_agents import get_manager as get_sub_agent_manager

logger = structlog.get_logger()


class SpawnAgentManager(ToolManager):
    """Unified manager that dispatches to browser/code/sub_agent/explore based on type."""

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

        if agent_type == "explore":
            async for event in self._spawn_explore(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "browser":
            async for event in self._spawn_browser(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "code":
            async for event in self._spawn_code(workflow_instance, tool_call, tool_call_id):
                yield event
        elif agent_type == "sub_agent":
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
        network_metadata: Optional[str] = None,
        local_data_summary: Optional[str] = None,
        display_goal: Optional[str] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Spawn explore agent - research sub-agent.

        Optional kwargs allow callers (e.g. wait_for) to provide pre-fetched
        data and a known task_id, avoiding redundant fetches and enabling
        cross-referencing between parent tool events and explore messages.
        display_goal overrides the goal shown in the UI (e.g. clean condition text).
        """
        goal = tool_call.get("goal", "")
        ui_goal = display_goal or goal
        task_id = task_id or str(uuid_module.uuid4())
        context_gates = tool_call.get("context_gates") or {}

        # IN_PROGRESS
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message=ui_goal[:EXPLORE_GOAL_DISPLAY_LEN],
            status=MessageStatus.IN_PROGRESS,
            metadata={"agentType": "explore", "taskId": task_id, "fullGoal": ui_goal},
        )

        try:
            # Fetch network metadata and local data summary if not provided.
            if network_metadata is None:
                if context_gates.get("network", True):
                    network_metadata = await workflow.execute_activity(
                        fetch_full_network_metadata,
                        args=[workflow_instance.user_id],
                        start_to_close_timeout=SUB_ACTIVITY_TIMEOUT,
                        retry_policy=RetryPolicy(maximum_attempts=SUB_ACTIVITY_MAX_ATTEMPTS),
                    )
                else:
                    network_metadata = ""

            if local_data_summary is None:
                if context_gates.get("recent_communications", True):
                    local_data_summary = await workflow.execute_activity(
                        fetch_local_data_summary,
                        args=[workflow_instance.user_id],
                        start_to_close_timeout=SUB_ACTIVITY_TIMEOUT,
                        retry_policy=RetryPolicy(maximum_attempts=SUB_ACTIVITY_MAX_ATTEMPTS),
                    )
                else:
                    local_data_summary = ""

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

            # Run explore agent activity with pause polling
            model = getattr(workflow_instance, "model", EXPLORE_DEFAULT_MODEL)
            claude_token = None  # Explore uses cheap lite waterfall, no claudeAuth
            activity_handle = workflow.start_activity(
                spawn_explore_agent_activity,
                args=[
                    workflow_instance.agent_id,
                    workflow_instance.user_id,
                    goal,
                    model,
                    network_metadata,
                    local_data_summary,
                    task_id,
                    tool_call_id,
                    claude_token,
                    attachment_texts,
                ],
                start_to_close_timeout=EXPLORE_ACTIVITY_TIMEOUT,
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
            explore_tool_call_results = result.get("tool_call_results", [])
            accumulated_usage = result.get("accumulated_usage", [])
            llm_iteration_usage = result.get("llm_iteration_usage", [])

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
                    "tool_call_results": explore_tool_call_results,
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
    ) -> AsyncGenerator[ToolEvent, None]:
        """Delegate to existing SpawnSubAgentManager."""
        sub_agent_config = {
            "goal": tool_call.get("goal"),
            "output_schema": tool_call.get("output_schema"),
            "read_only": tool_call.get("read_only", False),
            "start_phase": resolve_start_phase(tool_call),
            "attachments": tool_call.get("attachments"),
        }
        if tool_call.get("context_gates"):
            sub_agent_config["context_gates"] = tool_call["context_gates"]
        if tool_call.get("verifier"):
            sub_agent_config["verifier"] = tool_call["verifier"]
        else:
            sub_agent_config["verifier"] = {
                "type": "FLOAT_LLM_JUDGE",
                "llm_judge_prompt": f"Evaluate whether the agent successfully completed: {tool_call.get('goal', '')}",
            }

        sub_agent_tool_call = {
            "tool": "spawn_sub_agent",
            "sub_agent": sub_agent_config,
        }

        manager = get_sub_agent_manager()
        async for event in manager.execute_tool(workflow_instance, sub_agent_tool_call, tool_call_id):
            yield event

    async def _spawn_for_each(  # noqa: C901
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Thin wrapper: calls _spawn_sub_agent for each item in items/items_csv.

        Two-phase approach:
        1. SPAWN phase -- create all children as fast as possible (MAX_INFLIGHT
           concurrent spawns).
        2. DRAIN phase -- resume all generators concurrently.
        """
        items = coerce_for_each_items(tool_call)
        if not items:
            raise ValueError("No items to process. Provide items or items_csv.")

        if workflow_instance.depth >= FOR_EACH_MAX_DEPTH:
            raise ValueError(f"Cannot spawn for_each: maximum nesting depth ({FOR_EACH_MAX_DEPTH}) reached.")

        base_goal = tool_call.get("goal", "")
        start_phase = resolve_start_phase(tool_call)
        verifier = tool_call.get("verifier") or {
            "type": "FLOAT_LLM_JUDGE",
            "llm_judge_prompt": f"Evaluate whether the agent successfully completed: {base_goal}",
        }
        attachments = tool_call.get("attachments")
        output_schema = tool_call.get("output_schema")
        context_gates = tool_call.get("context_gates")

        # Build per-item tool_calls shaped as spawn_agent(type=sub_agent)
        per_item_calls: List[tuple] = []
        for i, item in enumerate(items):
            row_goal = build_for_each_goal(base_goal, item)
            item_tool_call: Dict[str, Any] = {
                "type": "sub_agent",
                "goal": row_goal,
                "output_schema": output_schema,
                "verifier": verifier,
                "attachments": attachments,
                "read_only": tool_call.get("read_only", False),
                "start_phase": start_phase,
            }
            if context_gates:
                item_tool_call["context_gates"] = context_gates
            per_item_calls.append((item_tool_call, f"{tool_call_id}:{i}"))

        failed_count = 0
        spawn_semaphore = asyncio.Semaphore(FOR_EACH_MAX_INFLIGHT)

        async def _spawn_one(tc: Dict, tcid: str):
            """Spawn one child. Returns (generator, tcid) to drain later, or None on failure."""
            nonlocal failed_count
            async with spawn_semaphore:
                # Hold off spawning while parent is paused
                await workflow.wait_condition(lambda: not workflow_instance.is_paused)
                gen = self._spawn_sub_agent(workflow_instance, tc, tcid)
                try:
                    event = await gen.__anext__()
                    await workflow_instance._handle_tool_event(event, tcid, "spawn_agent")
                    if isinstance(event, ToolEvent) and event.status == MessageStatus.ERROR:
                        failed_count += 1
                        return None
                    return (gen, tcid)
                except StopAsyncIteration:
                    return None
                except Exception as exc:
                    failed_count += 1
                    logger.warning("for_each child spawn failed", tcid=tcid, error=str(exc))
                    return None

        async def _drain_one(gen, tcid: str):
            """Drain remaining events."""
            nonlocal failed_count
            last_status = None
            try:
                async for event in gen:
                    await workflow_instance._handle_tool_event(event, tcid, "spawn_agent")
                    if isinstance(event, ToolEvent) and event.status:
                        last_status = event.status
                if last_status == MessageStatus.ERROR:
                    failed_count += 1
            except Exception as exc:
                failed_count += 1
                logger.warning("for_each child drain failed", tcid=tcid, error=str(exc))

        # Phase 1: Spawn all children
        spawn_tasks = [asyncio.create_task(_spawn_one(tc, tcid)) for tc, tcid in per_item_calls]
        spawn_results = await asyncio.gather(*spawn_tasks)
        pending_gens = [r for r in spawn_results if r is not None]

        # Phase 2: Wait for ALL spawned children to complete
        if pending_gens:
            drain_tasks = [asyncio.create_task(_drain_one(gen, tcid)) for gen, tcid in pending_gens]
            await asyncio.gather(*drain_tasks)

        # Propagate failure so DAG executor sees it
        if failed_count > 0:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="for_each failed",
                message=f"{failed_count}/{len(per_item_calls)} children failed",
                status=MessageStatus.ERROR,
            )
            return

        # All succeeded -- no events to yield (already posted directly)
        return
        yield  # make this an async generator


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
