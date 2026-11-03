"""Wait-seconds domain handler — thin runtime entry point.

Parses input, delegates to service, yields ``ToolEvent`` objects.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator

from temporalio import workflow

from domains.wait_seconds.service import format_duration, validate_seconds
from helpers.wait_on_world_clock import _wait_on_world_clock
from helpers.generation_handoff import (
    DEPLOY_INTERRUPTED_TOOL_MESSAGE,
    GenerationHandoffRequested,
)
from helpers.wait_condition_or_handoff import sleep_or_generation_handoff
from tools.base import EventType, MessageStatus, ToolEvent, ToolManager
from utils.simulated_clock import advance_simulated_clock, simulated_skip_metadata, simulated_time_skip_enabled


class WaitSecondsManager(ToolManager):
    """Manager for wait/sleep operations."""

    tool_name = "wait_seconds"

    async def execute_tool(
        self,
        workflow_instance: Any,
        tool_call: dict[str, Any],
        tool_call_id: str,
    ) -> AsyncGenerator[ToolEvent, None]:
        """Execute wait and yield events.

        Yields:
            Pre-execution status, then post-execution status.
        """
        seconds = tool_call.get("seconds", 1)

        # Validate
        error = validate_seconds(seconds)
        if error is not None:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Invalid wait duration",
                message=error,
                status=MessageStatus.ERROR,
            )
            return

        duration = format_duration(seconds)

        # 1. Pre-execution status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\u23f1\ufe0f Waiting {duration}",
            message="",
            status=MessageStatus.IN_PROGRESS,
        )

        # 2a. World-model simulate: nothing in the WMH-served world changes with
        # wall-clock time, so skip the sleep and advance the simulated clock.
        if simulated_time_skip_enabled(workflow_instance):
            world_ms = None
            if getattr(workflow_instance, "agent_id", None):
                world_ms = await _wait_on_world_clock(workflow_instance, tool_call_id, duration_ms=int(seconds * 1000))
            if world_ms is None:
                advance_simulated_clock(workflow_instance, seconds)
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"\u2713 Waited {duration} (simulated)",
                message=f"Simulated clock advanced {duration}; wall-clock wait skipped",
                status=MessageStatus.FINISHED,
                metadata=simulated_skip_metadata(workflow_instance, seconds),
            )
            return

        # 2. Execute wait in 30s slices so a long sleep can still cut over.
        try:
            await sleep_or_generation_handoff(workflow_instance, seconds, workflow_mod=workflow)
        except GenerationHandoffRequested:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title=f"\u23f1\ufe0f Waiting {duration}",
                message=DEPLOY_INTERRUPTED_TOOL_MESSAGE,
                status=MessageStatus.FINISHED,
            )
            raise
        except Exception as exc:
            yield ToolEvent(
                type=EventType.POST_MESSAGE,
                title="\u274c Wait failed",
                message=str(exc),
                status=MessageStatus.ERROR,
            )
            return

        # 3. Success status
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title=f"\u2713 Waited {duration}",
            message="",
            status=MessageStatus.FINISHED,
        )


# ========================================
# SINGLETON
# ========================================

_manager: WaitSecondsManager | None = None


def get_manager() -> WaitSecondsManager:
    """Get or create wait seconds manager singleton."""
    global _manager
    if _manager is None:
        _manager = WaitSecondsManager()
    return _manager


# ========================================
# WORKFLOW HELPER
# ========================================


async def wait_seconds(workflow_instance: Any, tool_call: dict[str, Any], tool_call_id: str) -> MessageStatus | None:
    """Workflow helper for wait_seconds (event-driven system).

    Yields events via ``_handle_tool_event`` and returns the last status.
    """
    manager = get_manager()
    last_status = None
    async for event in manager.execute_tool(workflow_instance, tool_call, tool_call_id):
        await workflow_instance._handle_tool_event(event, tool_call_id, "wait_seconds")
        if isinstance(event, ToolEvent) and event.status:
            last_status = event.status
    return last_status
