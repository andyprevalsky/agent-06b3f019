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
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    claude_token_user_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    gpt_token_user_id: str | None = None,
    fast_mode_step: int | None = None,
    system_prompt_text: str | None = None,
) -> dict:
    """Execute a reasoning task using LLM with streaming.

    Thin handler: validates inputs, delegates to service, handles errors.
    """
    # Fast Mode: set a cache context so this reasoning node uses canonical request
    # fingerprinting (enabled+goal auto-resolve from the agent row).
    if fast_mode_step is not None:
        from providers.demo_cache.client import ensure_position_context

        await ensure_position_context(agent_id, fast_mode_step)

    try:
        return await execute_reasoning(
            goal=goal,
            context=context,
            model=model,
            agent_id=agent_id,
            stream_id=stream_id,
            heartbeat_fn=_safe_heartbeat,
            claude_token=claude_token,
            claude_token_source=claude_token_source,
            claude_token_pool_id=claude_token_pool_id,
            claude_token_user_id=claude_token_user_id,
            gpt_token=gpt_token,
            gpt_account_id=gpt_account_id,
            gpt_token_source=gpt_token_source,
            gpt_token_pool_id=gpt_token_pool_id,
            gpt_token_user_id=gpt_token_user_id,
            system_prompt_text=system_prompt_text,
        )
    except Exception as e:
        logger.error(f"[Reasoning] Error calling LLM: {e}")
        raise
