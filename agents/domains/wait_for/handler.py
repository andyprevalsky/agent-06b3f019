"""Wait-for domain handler: runtime entry point.

Thin orchestration layer -- parses tool_call input, delegates to service
functions, and yields ToolEvent objects for the workflow.

Uses legacy (event-driven) pattern like spawn_agent since it needs
workflow_instance for pause/cost-limit state and workflow.start_activity.
"""

from __future__ import annotations

import uuid as uuid_module
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.wait_for.config import (
    DEFAULT_CHECK_INTERVAL_SECONDS,
    DEFAULT_MAX_CHECKS,
    DEFAULT_MODEL,
    MAX_CHECK_INTERVAL_SECONDS,
    MAX_CHECKS,
    MAX_WAIT_SECONDS,
    MIN_CHECK_INTERVAL_SECONDS,
    MIN_CHECKS,
)
from domains.wait_for.service import cap_evidence, evaluate_condition_activity, format_duration
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager

# =============================================================================
# WAIT_FOR MANAGER
# =============================================================================


class WaitForManager(ToolManager):
    """Manager for wait-for operations (timestamp or condition polling)."""

    tool_name = "wait_for"

    async def execute_tool(
        self, workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Dispatch to timestamp or condition mode."""
        until_timestamp = tool_call.get("until_timestamp")
        condition = tool_call.get("condition")

        if until_timestamp:
            async for event in self._timestamp_mode(workflow_instance, until_timestamp, tool_call_id):
                yield event
        elif condition:
            check_interval = tool_call.get("check_interval_seconds", DEFAULT_CHECK_INTERVAL_SECONDS)
            max_checks = tool_call.get("max_checks", DEFAULT_MAX_CHECKS)
            context_gates = getattr(workflow_instance, "context_gates", None) or {}
            async for event in self._condition_mode(
                workflow_instance, condition, check_interval, max_checks, tool_call_id, context_gates
            ):
                yield event
        else:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message="Must provide either 'until_timestamp' or 'condition'.",
                status=MessageStatus.ERROR,
            )

    async def _timestamp_mode(
        self,
        workflow_instance: Any,
        until_timestamp: str,
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Wait until a specific timestamp."""
        try:
            target = datetime.fromisoformat(until_timestamp.replace("Z", "+00:00"))
            if target.tzinfo is None:
                target = target.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError) as e:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message=f"Invalid timestamp '{until_timestamp}': {e}",
                status=MessageStatus.ERROR,
            )
            return

        now = workflow.now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)

        delta_seconds = int((target - now).total_seconds())
        if delta_seconds <= 0:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message=f"Timestamp {until_timestamp} is in the past.",
                status=MessageStatus.ERROR,
            )
            return

        if delta_seconds > MAX_WAIT_SECONDS:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="wait_for failed",
                message="Cannot wait more than 31 days.",
                status=MessageStatus.ERROR,
            )
            return

        duration = format_duration(delta_seconds)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Waiting until {until_timestamp}",
            message=f"Sleeping for {duration}",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "waitForMode": "timestamp",
                "untilTimestamp": until_timestamp,
                "durationSeconds": delta_seconds,
            },
        )

        # Fast Mode: a recorded run already waited out the real time, so on replay
        # the wait is pure dead wall-clock — skip it and resolve instantly.
        if not getattr(workflow_instance, "fast_mode_cache_enabled", False):
            await workflow.sleep(delta_seconds)

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Wait complete",
            message=f"Reached {until_timestamp}",
            status=MessageStatus.FINISHED,
            metadata={"waitForMode": "timestamp"},
        )

    async def _condition_mode(  # noqa: C901
        self,
        workflow_instance: Any,
        condition: str,
        check_interval_seconds: int,
        max_checks_param: int,
        tool_call_id: str,
        context_gates: Optional[dict[str, bool]] = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Poll with explore agents until condition is satisfied.

        Delegates explore agent lifecycle to SpawnAgentManager._spawn_explore(),
        routing explore events as spawn_agent messages so the FE groups them
        correctly. wait_for events reference the explore via exploreTaskId.
        """
        from tools.spawn_agent import SpawnAgentManager

        # Validate
        check_interval_seconds = max(
            MIN_CHECK_INTERVAL_SECONDS, min(MAX_CHECK_INTERVAL_SECONDS, check_interval_seconds)
        )
        max_checks_param = max(MIN_CHECKS, min(MAX_CHECKS, max_checks_param))

        interval_str = format_duration(check_interval_seconds)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Waiting for {condition[:80]}",
            message=f"Checking every {interval_str}, up to {max_checks_param} checks",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "waitForMode": "condition",
                "condition": condition,
                "checkIntervalSeconds": check_interval_seconds,
                "maxChecks": max_checks_param,
            },
        )

        # Contact + message-thread context is now fetched on-demand by the
        # explore agent via the grep tool's network / agent_network_* /
        # messages source modes — no need to prefetch.
        context_gates = context_gates or {}

        model = getattr(workflow_instance, "model", DEFAULT_MODEL)
        claude_token = None  # wait_for uses cheap lite waterfall, no claudeAuth
        spawn_mgr = SpawnAgentManager()
        all_usage: dict[str, list[Any]] = {"llm": [], "service": []}

        for check_num in range(1, max_checks_param + 1):
            # Sleep between checks (skip before the first check - check immediately).
            # Fast Mode skips the inter-check wait entirely on replay — the recorded
            # condition evaluations already replay from cache, so polling is instant.
            if check_num > 1 and not getattr(workflow_instance, "fast_mode_cache_enabled", False):
                await workflow.sleep(check_interval_seconds)

            # Check pause / cost limit
            await workflow_instance._check_parent_state()
            if workflow_instance.is_paused or getattr(workflow_instance, "_cost_limit_reached", False):
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling paused (check {check_num}/{max_checks_param})",
                    message="Agent paused or cost limit reached",
                    status=MessageStatus.ERROR,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                    },
                    data={"condition_met": False, "checks_completed": check_num - 1},
                )
                return

            # Spawn explore agent via SpawnAgentManager
            task_id = str(uuid_module.uuid4())
            explore_tool_call_id = str(uuid_module.uuid4())
            explore_goal = (
                f'Gather evidence for whether this is currently true: "{condition}". '
                f"Try to complete your task in as few tool calls as possible."
            )

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Check {check_num}/{max_checks_param}: checking...",
                message="Verifying condition",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "waitForMode": "condition",
                    "condition": condition,
                    "checkNum": check_num,
                    "maxChecks": max_checks_param,
                    "checkIntervalSeconds": check_interval_seconds,
                    "exploreTaskId": task_id,
                },
            )

            # Delegate to _spawn_explore. Pass a local list for raw tool results
            # so the ~150 KB sub-agent trace stays in-process and never gets
            # persisted into ToolEvent.data / shipped across activity boundaries.
            explore_tool_call_results: list[str] = []
            explore_usage: dict[str, list[Any]] = {}

            async for event in spawn_mgr._spawn_explore(
                workflow_instance,
                {"type": "explore", "goal": explore_goal},
                explore_tool_call_id,
                task_id=task_id,
                display_goal=condition,
                capture_tool_results=explore_tool_call_results,
            ):
                # Route explore events as spawn_agent messages (correct toolName for FE grouping)
                await workflow_instance._handle_tool_event(event, explore_tool_call_id, "spawn_agent")

                # Capture usage from the FINISHED event (raw tool results come via the collector)
                if event.status == MessageStatus.FINISHED and event.data:
                    explore_usage = event.data.get("usage", {})

            # Check if explore was cancelled (paused during explore)
            if workflow_instance.is_paused:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling cancelled (check {check_num}/{max_checks_param})",
                    message="Explore agent cancelled due to pause",
                    status=MessageStatus.ERROR,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                        "exploreTaskId": task_id,
                    },
                    data={"condition_met": False, "checks_completed": check_num - 1},
                )
                return

            # Aggregate usage from explore agent
            all_usage["llm"].extend(explore_usage.get("llm", []))
            all_usage["service"].extend(explore_usage.get("service", []))

            # Use raw tool call results as evidence (not the explore agent's summary)
            # to prevent the explore agent from influencing the condition verdict
            evidence = "\n\n".join(explore_tool_call_results) if explore_tool_call_results else "No evidence gathered."
            evidence = cap_evidence(evidence)

            # Evaluate condition with cheap LLM judge
            try:
                eval_result = await workflow.execute_activity(
                    evaluate_condition_activity,
                    args=[condition, evidence, model, claude_token],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.error(f"[wait_for] Condition eval failed: {e}")
                eval_result = {"satisfied": False, "reasoning": f"Evaluation error: {e}"}

            satisfied = eval_result.get("satisfied", False)
            reasoning = eval_result.get("reasoning", "")

            if satisfied:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Condition met (check {check_num}/{max_checks_param})",
                    message=f"Condition: {condition}\n\nEvidence: {evidence}\n\n{reasoning}",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks_param,
                        "exploreTaskId": task_id,
                        "conditionMet": True,
                    },
                    data={
                        "condition_met": True,
                        "checks_completed": check_num,
                        "evidence": evidence,
                        "usage": all_usage,
                    },
                )
                return

            # Post check result (FINISHED = this individual check is done)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Check {check_num}/{max_checks_param}: not yet met",
                message=reasoning,
                status=MessageStatus.FINISHED,
                metadata={
                    "waitForMode": "condition",
                    "condition": condition,
                    "checkNum": check_num,
                    "maxChecks": max_checks_param,
                    "checkIntervalSeconds": check_interval_seconds,
                    "exploreTaskId": task_id,
                    "conditionMet": False,
                },
            )

            # Re-establish overall IN_PROGRESS so the representative message
            # reflects the actual state (still waiting, sleeping until next check)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Waiting for {condition[:80]}",
                message=f"Next check in {interval_str}",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "waitForMode": "condition",
                    "condition": condition,
                    "checkIntervalSeconds": check_interval_seconds,
                    "maxChecks": max_checks_param,
                    "checkNum": check_num,
                    "exploreTaskId": task_id,
                    "conditionMet": False,
                },
            )

        # Exhausted all checks -- signal failure so DAG exits
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Condition not met after {max_checks_param} checks",
            message=(
                f"Checked every {interval_str} for {format_duration(check_interval_seconds * max_checks_param)}. "
                f'Condition "{condition}" was never satisfied.'
            ),
            status=MessageStatus.ERROR,
            metadata={
                "waitForMode": "condition",
                "condition": condition,
                "maxChecks": max_checks_param,
            },
            data={
                "condition_met": False,
                "checks_completed": max_checks_param,
                "usage": all_usage,
            },
        )


# =============================================================================
# SINGLETON
# =============================================================================

_manager: WaitForManager | None = None


def get_manager() -> WaitForManager:
    """Return the singleton WaitForManager instance."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        _manager = WaitForManager()
    return _manager


# =============================================================================
# WORKFLOW HELPER (called from TOOL_EXECUTORS - legacy signature)
# =============================================================================


async def wait_for(workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str) -> tuple[Any, str]:
    """Workflow helper for wait_for tool.

    Legacy event-driven pattern (like spawn_agent). Returns (last_status, result_text).
    """
    manager = get_manager()
    last_status = None
    last_result = ""
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "wait_for")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
        # Track usage from condition polling
        if isinstance(event, ToolEvent) and event.data and event.data.get("usage"):
            await workflow_instance._track_usage(event.data["usage"], tool_name="wait_for", call_site="wait_for")
        # Capture result for context
        if isinstance(event, ToolEvent) and event.data and event.data.get("condition_met") is not None:
            met = event.data["condition_met"]
            checks = event.data.get("checks_completed", 0)
            evidence = event.data.get("evidence", "")
            last_result = f"condition_met={met}, checks_completed={checks}"
            if evidence:
                last_result += f", evidence={evidence}"
    return last_status, last_result
