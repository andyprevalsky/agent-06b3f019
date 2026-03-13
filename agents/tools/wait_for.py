"""Wait-for tool - waits until a timestamp or condition is satisfied.

Replaces wait_seconds. Two modes:
  1. Timestamp: sleep until an ISO 8601 datetime
  2. Condition: poll with explore agents until a natural-language condition is met

Uses legacy (event-driven) pattern like spawn_agent since it needs
workflow_instance for pause/cost-limit state and workflow.start_activity.
"""

import json
import uuid as uuid_module
from typing import Dict, Any, Optional, AsyncGenerator
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
import structlog

from tools.base import ToolManager, ToolEvent, EventType, MessageStatus

logger = structlog.get_logger()


# =============================================================================
# HELPERS
# =============================================================================

# ~80k tokens ≈ 320k chars — liberal budget that fits comfortably in the
# evaluator LLM's context window while preventing unbounded payloads from
# web_fetch results causing timeouts or silent failures.
EVIDENCE_CHAR_BUDGET = 320_000


def _cap_evidence(evidence: str) -> str:
    """Truncate evidence to fit within the token budget for condition evaluation."""
    if len(evidence) <= EVIDENCE_CHAR_BUDGET:
        return evidence
    return evidence[:EVIDENCE_CHAR_BUDGET] + "\n\n[...evidence truncated to fit context window]"


def format_duration(seconds: int) -> str:
    """Format seconds into human-readable duration."""
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    elif seconds < 3600:
        minutes = seconds / 60
        if minutes == int(minutes):
            minutes = int(minutes)
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        return f"{minutes:.1f} minutes"
    elif seconds < 86400:
        hours = seconds / 3600
        if hours == int(hours):
            hours = int(hours)
            return f"{hours} hour{'s' if hours != 1 else ''}"
        return f"{hours:.1f} hours"
    else:
        days = seconds / 86400
        if days == int(days):
            days = int(days)
            return f"{days} day{'s' if days != 1 else ''}"
        return f"{days:.1f} days"


# =============================================================================
# CONDITION EVALUATION
# =============================================================================

class ConditionEvaluation(BaseModel):
    """Structured output for condition evaluation."""
    satisfied: bool = Field(description="Whether the condition is currently met based on the evidence")
    reasoning: str = Field(description="One sentence explanation of the determination")


@activity.defn
async def evaluate_condition_activity(
    condition: str,
    evidence: str,
    model: str,
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Lightweight LLM call to determine if a condition is satisfied given evidence.

    Uses structured output (Pydantic schema) for reliable boolean extraction.

    Returns:
        Dict with satisfied (bool), reasoning (str)
    """
    from helpers.llm import call_llm, prepare_schema_for_openai

    activity.heartbeat("Evaluating condition")

    schema = prepare_schema_for_openai(ConditionEvaluation)

    system_prompt = (
        "You are a yes/no classifier. Given a condition and evidence gathered from "
        "the web, determine if the condition is currently satisfied."
    )

    user_prompt = f"Condition: {condition}\n\nEvidence:\n{evidence}"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    result = await call_llm(
        messages,
        model=model,
        max_tokens=200,
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "ConditionEvaluation",
                "schema": schema,
                "strict": True,
            },
        },
        claude_token=claude_token,
        skip_cache=True,  # Unique evidence each poll — no cache reuse
    )
    raw = result.get("content", "")

    try:
        parsed = ConditionEvaluation.model_validate_json(raw)
        return {"satisfied": parsed.satisfied, "reasoning": parsed.reasoning}
    except Exception:
        # Fallback: try loose JSON parse
        try:
            data = json.loads(raw)
            return {
                "satisfied": bool(data.get("satisfied", False)),
                "reasoning": str(data.get("reasoning", raw.strip())),
            }
        except (json.JSONDecodeError, TypeError):
            return {"satisfied": False, "reasoning": raw.strip()}


# =============================================================================
# WAIT_FOR MANAGER
# =============================================================================

class WaitForManager(ToolManager):
    """Manager for wait-for operations (timestamp or condition polling)."""

    tool_name = "wait_for"

    async def execute_tool(
        self,
        workflow_instance,
        tool_call: Dict[str, Any],
        tool_call_id: str
    ) -> AsyncGenerator[ToolEvent, None]:
        """Dispatch to timestamp or condition mode."""
        until_timestamp = tool_call.get("until_timestamp")
        condition = tool_call.get("condition")

        if until_timestamp:
            async for event in self._timestamp_mode(workflow_instance, until_timestamp, tool_call_id):
                yield event
        elif condition:
            check_interval = tool_call.get("check_interval_seconds", 900)
            max_checks = tool_call.get("max_checks", 20)
            async for event in self._condition_mode(
                workflow_instance, condition, check_interval, max_checks, tool_call_id
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
        workflow_instance,
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

        if delta_seconds > 2_678_400:  # 31 days
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

        await workflow.sleep(delta_seconds)

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Wait complete",
            message=f"Reached {until_timestamp}",
            status=MessageStatus.FINISHED,
            metadata={"waitForMode": "timestamp"},
        )

    async def _condition_mode(
        self,
        workflow_instance,
        condition: str,
        check_interval_seconds: int,
        max_checks: int,
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Poll with explore agents until condition is satisfied.

        Delegates explore agent lifecycle to SpawnAgentManager._spawn_explore(),
        routing explore events as spawn_agent messages so the FE groups them
        correctly. wait_for events reference the explore via exploreTaskId.
        """
        from tools.spawn_agent import SpawnAgentManager, fetch_full_network_metadata
        from tools.grep import fetch_local_data_summary

        # Validate
        check_interval_seconds = max(60, min(86400, check_interval_seconds))
        max_checks = max(1, min(100, max_checks))

        interval_str = format_duration(check_interval_seconds)
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Waiting for {condition[:80]}",
            message=f"Checking every {interval_str}, up to {max_checks} checks",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "waitForMode": "condition",
                "condition": condition,
                "checkIntervalSeconds": check_interval_seconds,
                "maxChecks": max_checks,
            },
        )

        # Fetch network metadata + local data once before the loop
        try:
            network_metadata = await workflow.execute_activity(
                fetch_full_network_metadata,
                args=[workflow_instance.user_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception:
            network_metadata = ""

        try:
            local_data_summary = await workflow.execute_activity(
                fetch_local_data_summary,
                args=[workflow_instance.user_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception:
            local_data_summary = ""

        model = getattr(workflow_instance, "model", "rose-labs/rose-1-lite")
        claude_token = getattr(workflow_instance, "claude_max_token", None)
        spawn_mgr = SpawnAgentManager()
        all_usage: Dict[str, list] = {"llm": [], "service": []}

        for check_num in range(1, max_checks + 1):
            # Sleep between checks (skip before the first check - check immediately)
            if check_num > 1:
                await workflow.sleep(check_interval_seconds)

            # Check pause / cost limit
            await workflow_instance._check_parent_state()
            if workflow_instance.is_paused or getattr(workflow_instance, "_cost_limit_reached", False):
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling paused (check {check_num}/{max_checks})",
                    message="Agent paused or cost limit reached",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks,
                    },
                    data={"condition_met": False, "checks_completed": check_num - 1},
                )
                return

            # Spawn explore agent via SpawnAgentManager (reuses the full explore lifecycle:
            # IN_PROGRESS message, activity with pause polling, FINISHED message, usage)
            task_id = str(uuid_module.uuid4())
            explore_tool_call_id = str(uuid_module.uuid4())
            explore_goal = (
                f'Gather evidence for whether this is currently true: "{condition}". '
                f'Try to complete your task in as few tool calls as possible.'
            )

            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"Check {check_num}/{max_checks}: checking...",
                message=f"Verifying condition",
                status=MessageStatus.IN_PROGRESS,
                metadata={
                    "waitForMode": "condition",
                    "condition": condition,
                    "checkNum": check_num,
                    "maxChecks": max_checks,
                    "checkIntervalSeconds": check_interval_seconds,
                    "exploreTaskId": task_id,
                },
            )

            # Delegate to _spawn_explore — it handles the activity, pause polling,
            # and yields IN_PROGRESS/FINISHED events. We route those as spawn_agent
            # messages so the FE groups them under the explore chip.
            explore_result = ""
            explore_tool_call_results: list = []
            explore_usage: Dict[str, list] = {}
            was_cancelled = False

            async for event in spawn_mgr._spawn_explore(
                workflow_instance,
                {"type": "explore", "goal": explore_goal},
                explore_tool_call_id,
                task_id=task_id,
                network_metadata=network_metadata,
                local_data_summary=local_data_summary,
                display_goal=condition,
            ):
                # Route explore events as spawn_agent messages (correct toolName for FE grouping)
                await workflow_instance._handle_tool_event(event, explore_tool_call_id, "spawn_agent")

                # Capture result, raw tool results, and usage from the FINISHED event
                if event.status == MessageStatus.FINISHED and event.data:
                    explore_result = event.data.get("result", "")
                    explore_tool_call_results = event.data.get("tool_call_results", [])
                    explore_usage = event.data.get("usage", {})

            # Check if explore was cancelled (paused during explore)
            if workflow_instance.is_paused:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title=f"Polling cancelled (check {check_num}/{max_checks})",
                    message="Explore agent cancelled due to pause",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks,
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
            evidence = _cap_evidence(evidence)

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
                    title=f"Condition met (check {check_num}/{max_checks})",
                    message=f"Condition: {condition}\n\nEvidence: {evidence}\n\n{reasoning}",
                    status=MessageStatus.FINISHED,
                    metadata={
                        "waitForMode": "condition",
                        "condition": condition,
                        "checkNum": check_num,
                        "maxChecks": max_checks,
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
                title=f"Check {check_num}/{max_checks}: not yet met",
                message=reasoning,
                status=MessageStatus.FINISHED,
                metadata={
                    "waitForMode": "condition",
                    "condition": condition,
                    "checkNum": check_num,
                    "maxChecks": max_checks,
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
                    "maxChecks": max_checks,
                    "checkNum": check_num,
                    "conditionMet": False,
                },
            )

        # Exhausted all checks — signal failure so DAG exits
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"Condition not met after {max_checks} checks",
            message=f"Checked every {interval_str} for {format_duration(check_interval_seconds * max_checks)}. Condition \"{condition}\" was never satisfied.",
            status=MessageStatus.ERROR,
            metadata={
                "waitForMode": "condition",
                "condition": condition,
                "maxChecks": max_checks,
            },
            data={
                "condition_met": False,
                "checks_completed": max_checks,
                "usage": all_usage,
            },
        )


# =============================================================================
# SINGLETON
# =============================================================================

_manager: Optional[WaitForManager] = None


def get_manager() -> WaitForManager:
    global _manager
    if _manager is None:
        _manager = WaitForManager()
    return _manager


# =============================================================================
# WORKFLOW HELPER (called from TOOL_EXECUTORS - legacy signature)
# =============================================================================

async def wait_for(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
    """
    Workflow helper for wait_for tool.

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
            await workflow_instance._track_usage(event.data["usage"], tool_name="wait_for")
        # Capture result for context
        if isinstance(event, ToolEvent) and event.data:
            if event.data.get("condition_met") is not None:
                met = event.data["condition_met"]
                checks = event.data.get("checks_completed", 0)
                evidence = event.data.get("evidence", "")
                last_result = f"condition_met={met}, checks_completed={checks}"
                if evidence:
                    last_result += f", evidence={evidence}"
    return last_status, last_result
