"""Reasoning domain handler - Temporal activity entry point."""

from __future__ import annotations

import contextlib

import structlog
from temporalio import activity

from domains.reasoning.service import execute_reasoning
from domains.reasoning.types import ReasoningResponse

logger = structlog.get_logger()

# Re-export types for backward compatibility
__all__ = ["ReasoningResponse", "_safe_heartbeat", "execute_reasoning_activity"]


def _safe_heartbeat(msg: str) -> None:
    """Safe heartbeat that only calls when in activity context."""
    with contextlib.suppress(Exception):
        activity.heartbeat(msg)


@activity.defn
async def execute_reasoning_activity(
    goal: str,
    context: list[dict],
    model: str,
    agent_id: str | None = None,
    stream_id: str | None = None,
) -> dict:
    """Execute a reasoning task using LLM with streaming.

    Thin handler: validates inputs, delegates to service, handles errors.
    """
    try:
        return await execute_reasoning(
            goal=goal,
            context=context,
            model=model,
            agent_id=agent_id,
            stream_id=stream_id,
            heartbeat_fn=_safe_heartbeat,
        )
    except Exception as e:
        logger.error(f"[Reasoning] Error calling LLM: {e}")
        raise
