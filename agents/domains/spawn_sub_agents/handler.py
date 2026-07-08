"""Spawn-sub-agents domain handler — thin runtime entry point.

Manages the lifecycle of a single sub-agent spawn from the parent workflow's
perspective: depth check, bus ID setup, activity execution, child tracking,
signal-based completion wait, and result/error reporting.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, AsyncGenerator, Dict

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.spawn_sub_agents.config import MAX_DEPTH
from domains.spawn_sub_agents.service import (
    extract_file_pointers_from_structured_response,
    spawn_sub_agent_activity,
)
from helpers.child_results import fetch_child_terminal_result_activity
from tools.base import AssistantEvent, EventType, MessageStatus, ToolEvent, ToolManager
from utils.error_utils import extract_error_message
from utils.tool_call_ids import spawn_group_id

logger = structlog.get_logger()

USER_FACING_TOOL_NAME = "spawn_general_purpose_agent"
CHILD_FAILURE_STATUSES = {"failed", "error", "max_iterations"}


def _child_result_is_failure(child_result: Dict[str, Any]) -> bool:
    status = str(child_result.get("status") or "").strip().lower()
    if status in CHILD_FAILURE_STATUSES:
        return True
    return child_result.get("success") is False


def _child_best_effort_text(child_result: Dict[str, Any]) -> str:
    for key in ("best_effort_response", "final_response", "summary", "message", "result"):
        value = child_result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _child_partial_structured_response(child_result: Dict[str, Any]) -> Any:
    failure_context = child_result.get("failure_context") or {}
    for value in (
        child_result.get("structured_response"),
        child_result.get("partial_structured_response"),
        failure_context.get("partial_structured_response"),
        failure_context.get("structured_response"),
    ):
        if value is not None:
            return value
    return None


class SpawnSubAgentManager(ToolManager):
    """Manager for spawn_sub_agent tool using event-driven architecture."""

    @property
    def tool_name(self) -> str:
        return "spawn_sub_agent"

    async def _reconcile_terminal_child_result(self, workflow_instance: Any, child_agent_id: str) -> bool:
        """Recover a terminal child result that was persisted but not signaled."""
        if child_agent_id in workflow_instance.child_results:
            workflow_instance.pending_children.discard(child_agent_id)
            return True

        try:
            recovered = await workflow.execute_activity(
                fetch_child_terminal_result_activity,
                args=[child_agent_id],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:
            logger.warning("Child terminal reconciliation failed", child_agent_id=child_agent_id, error=str(exc))
            return False
        if recovered is None:
            return False

        workflow_instance.child_results[child_agent_id] = recovered
        workflow_instance.pending_children.discard(child_agent_id)
        logger.info("Recovered terminal child result from durable state", child_agent_id=child_agent_id)
        return True

    async def execute_tool(  # noqa: C901
        self,
        workflow_instance: Any,
        tool_call: Dict[str, Any],
        tool_call_id: str,
        *,
        parent_attachments: Dict[str, Any] | None = None,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute spawn_sub_agent tool with event-driven architecture.

        Args:
            workflow_instance: The workflow instance
            tool_call: Dict with "sub_agent" field (single sub-agent config)
            tool_call_id: Unique ID for this tool call
            parent_attachments: Pre-fetched parent attachment dicts (from
                fetch_parent_attachments_activity).  Skips redundant backend
                fetch when provided.

        Yields:
            - Pre-execution status
            - Post-execution status with result
        """
        sub_agent = tool_call.get("sub_agent")

        if not sub_agent:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Sub-agent failed",
                message="No sub-agent specified",
                status=MessageStatus.ERROR,
                metadata={"toolName": USER_FACING_TOOL_NAME},
            )
            return

        try:
            info = workflow.info()
            user_id = workflow_instance.user_id
            parent_agent_id = workflow_instance.agent_id
            parent_workflow_id = info.workflow_id
            depth = getattr(workflow_instance, "depth", 0) + 1
            parent_is_paused = getattr(workflow_instance, "is_paused", False)

            if workflow_instance.depth >= MAX_DEPTH:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message=f"Cannot spawn sub-agent: maximum nesting depth ({MAX_DEPTH}) reached.",
                    status=MessageStatus.ERROR,
                )
                return

            parent_bus_id = getattr(workflow_instance, "bus_id", None)
            if parent_bus_id is None:
                bus_id = parent_agent_id
                workflow_instance.bus_id = bus_id
                await workflow_instance._update_tree_state()
            else:
                bus_id = parent_bus_id

            parent_model = getattr(workflow_instance, "model", "rose-labs/rose-1-lite")
            parent_source = getattr(workflow_instance, "agent_source", "WEB")

            result = await workflow.execute_activity(
                spawn_sub_agent_activity,
                args=[
                    user_id,
                    [sub_agent],
                    parent_agent_id,
                    parent_workflow_id,
                    depth,
                    parent_is_paused,
                    parent_model,
                    bus_id,
                    parent_source,
                    parent_attachments,
                ],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

            agents_list = result.get("agents", [])

            if not agents_list:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message="Failed to spawn sub-agent",
                    status=MessageStatus.ERROR,
                )
                return

            child_info = agents_list[0]
            if "error" in child_info:
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="❌ Sub-agent failed",
                    message=f"Error: {child_info.get('error', 'Unknown error')}",
                    status=MessageStatus.ERROR,
                )
                return

            async for event in self.finalize_child(
                workflow_instance,
                child_info,
                sub_agent,
                tool_call_id,
                bus_id,
            ):
                yield event

        except Exception as e:
            error_msg = extract_error_message(e)
            logger.error("Failed to spawn sub-agent", error=error_msg)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="Sub-agent failed",
                message=f"Error spawning sub-agent: {error_msg}",
                status=MessageStatus.ERROR,
                metadata={"toolName": USER_FACING_TOOL_NAME},
            )

    async def finalize_child(
        self,
        workflow_instance: Any,
        child_info: Dict[str, Any],
        sub_agent: Dict[str, Any],
        child_tool_id: str,
        bus_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Set up tracking, post IN_PROGRESS, wait for completion, post FINISHED.

        Shared between the per-child spawn path (execute_tool) and the batch
        path (_spawn_for_each via spawn_sub_agents_batch_activity). Caller has
        already created the row in the backend; this method only handles the
        parent-side bookkeeping + completion lifecycle.

        If ``child_info["status"] == "FAILED"`` (spawn-time failure surfaced by
        the batch endpoint), emits a failure event immediately and skips the
        wait_condition.
        """
        group_id = spawn_group_id(child_tool_id, sub_agent.get("_spawn_group_id"))
        if str(child_info.get("status", "")).upper() == "FAILED":
            err = child_info.get("error", "spawn failed")
            child_agent_id = child_info.get("agent_id", "")
            if child_agent_id:
                workflow_instance.pending_children.discard(child_agent_id)
            for event in self._build_failure_events(child_agent_id, {"error_reason": err}, bus_id, child_tool_id, group_id):
                yield event
            return

        logger.info("✅ Spawned sub-agent, setting up tracking...")
        child_agent_id = child_info["agent_id"]
        workflow_instance.child_tool_ids[child_agent_id] = child_tool_id
        workflow_instance.pending_children.add(child_agent_id)
        if child_agent_id in workflow_instance.child_results:
            workflow_instance.pending_children.discard(child_agent_id)

        child_temporal_workflow_id = child_info.get("temporal_workflow_id")
        if child_temporal_workflow_id:
            workflow_instance.child_workflow_ids[child_agent_id] = child_temporal_workflow_id

        await workflow_instance._post_message(
            child_info.get("goal", ""),
            "TOOL",
            metadata={
                "toolCallId": child_tool_id,
                "toolName": USER_FACING_TOOL_NAME,
                "toolStatus": "IN_PROGRESS",
                "title": "Sub-agent starting",
                "subAgentId": child_agent_id,
                "progress": 0.0,
            },
        )

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Spawning sub-agent",
            message="",
            status=MessageStatus.IN_PROGRESS,
            metadata={
                "toolName": USER_FACING_TOOL_NAME,
                "subAgentIds": [child_agent_id],
                "busId": bus_id,
                "spawnGroupId": group_id,
            },
        )

        logger.info(f"⏳ Waiting for sub-agent {child_agent_id} to complete...")
        while child_agent_id not in workflow_instance.child_results:
            if await self._reconcile_terminal_child_result(workflow_instance, child_agent_id):
                break
            try:
                await workflow.wait_condition(
                    lambda cid=child_agent_id: cid in workflow_instance.child_results,
                    timeout=timedelta(seconds=30),
                )
            except (asyncio.TimeoutError, TimeoutError):
                continue

        child_result = workflow_instance.child_results.get(child_agent_id, {})
        if _child_result_is_failure(child_result):
            for event in self._build_failure_events(child_agent_id, child_result, bus_id, child_tool_id, group_id):
                yield event
            return

        logger.info(f"🎉 Sub-agent {child_agent_id} completed!")
        structured_response = child_result.get("structured_response", {})
        child_tool_counts = child_result.get("tool_counts") or {}
        output_schema = sub_agent.get("output_schema", {})
        file_pointers = extract_file_pointers_from_structured_response(structured_response, output_schema)

        child_summary = child_result.get("summary", "") or f"Completed: {child_info.get('goal', '')}"
        workflow_instance.child_results.pop(child_agent_id, None)

        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Spawning sub-agent",
            message=child_summary,
            status=MessageStatus.FINISHED,
            metadata={
                "toolName": USER_FACING_TOOL_NAME,
                "subAgentIds": [child_agent_id],
                "busId": bus_id,
                "spawnGroupId": group_id,
                "structured_response": structured_response,
                "childToolCounts": child_tool_counts,
            },
        )
        if file_pointers:
            for fp in file_pointers:
                yield AssistantEvent(message="", file_pointer=fp)

    @staticmethod
    def _build_failure_events(
        child_agent_id: str,
        child_result: Dict[str, Any],
        bus_id: str,
        child_tool_id: str,
        group_id: str | None = None,
    ) -> list[ToolEvent]:
        """Build ToolEvent list for a failed child agent."""
        status = str(child_result.get("status") or "").strip()
        error_reason = child_result.get("error_reason") or child_result.get("message") or status or "unknown"
        failure_context = child_result.get("failure_context", {})
        trajectory = failure_context.get("trajectory", [])
        last_reasoning = failure_context.get("last_reasoning")
        last_plan = failure_context.get("last_plan")
        progress_estimate = failure_context.get("progress_estimate", "Unknown")
        verifier_reasoning = failure_context.get("verifier_reasoning")
        best_effort_response = _child_best_effort_text(child_result)
        partial_structured_response = _child_partial_structured_response(child_result)

        logger.warning(f"❌ Sub-agent {child_agent_id} failed: {error_reason}")

        error_parts = [f"Sub-agent failed: {error_reason}"]
        error_parts.append(f"Progress: {progress_estimate}")

        if best_effort_response:
            error_parts.append(f"\nBest-effort result:\n{best_effort_response[:1200]}")

        if verifier_reasoning:
            error_parts.append(f"\nWhy not complete:\n{verifier_reasoning[:400]}")

        if partial_structured_response and isinstance(partial_structured_response, dict):
            partial_lines = ["\nPartial data extracted:"]
            for key, value in list(partial_structured_response.items())[:5]:
                formatted_key = key.replace("_", " ").title()
                if isinstance(value, str) and len(value) > 100:
                    value = value[:100] + "..."
                elif isinstance(value, list):
                    value = f"[{len(value)} items]"
                partial_lines.append(f"- {formatted_key}: {value}")
            error_parts.append("\n".join(partial_lines))

        if last_reasoning:
            error_parts.append(f"\nLast thought:\n{last_reasoning[:300]}...")

        if last_plan:
            error_parts.append("\nPlan was:\n" + "\n".join(f"- {g}" for g in last_plan[:5]))

        if trajectory:
            trajectory_lines = []
            for step in trajectory[:10]:
                icon = "✓" if step.get("success") else "✗"
                tool = step.get("tool_name", "unknown")
                err = step.get("error_message", "")[:50] if not step.get("success") else ""
                trajectory_lines.append(f"{icon} {tool}" + (f": {err}" if err else ""))
            error_parts.append("\nTrajectory:\n" + "\n".join(trajectory_lines))

        error_message = "\n".join(error_parts)

        metadata = {
            "toolName": USER_FACING_TOOL_NAME,
            "subAgentIds": [child_agent_id],
            "busId": bus_id,
            "spawnGroupId": group_id or spawn_group_id(child_tool_id),
            "error_reason": error_reason,
            "failure_context": failure_context,
        }
        if best_effort_response:
            metadata["best_effort_response"] = best_effort_response
        if partial_structured_response is not None:
            metadata["structured_response"] = partial_structured_response
            metadata["partial_structured_response"] = partial_structured_response

        return [
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title="❌ Sub-agent failed",
                message=error_message,
                status=MessageStatus.ERROR,
                metadata=metadata,
            )
        ]


# Singleton instance
_manager_instance: SpawnSubAgentManager | None = None


def get_manager() -> SpawnSubAgentManager:
    """Get or create manager singleton."""
    global _manager_instance  # noqa: PLW0603
    if _manager_instance is None:
        _manager_instance = SpawnSubAgentManager()
    return _manager_instance


async def spawn_sub_agent(workflow_instance: Any, tool_call: Dict[str, Any], tool_call_id: str) -> str | None:
    """Workflow helper for spawn_sub_agent tool.

    This function is called from the workflow's _execute_tool method for
    event-driven tools.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "spawn_sub_agent")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status

    return last_status
