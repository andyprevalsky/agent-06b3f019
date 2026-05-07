"""Reasoning domain service - business logic for reasoning tasks."""

from __future__ import annotations

from typing import TYPE_CHECKING

import structlog

from domains.reasoning.config import (
    MAX_CONTEXT_MESSAGES,
    REASONING_MAX_TOKENS,
    REASONING_SYSTEM_PROMPT_TEMPLATE,
    REASONING_TEMPERATURE,
)
from domains.reasoning.types import ReasoningResponse
from helpers.llm import build_llm_messages, call_llm_structured_streaming
from helpers.messages import stream_assistant_chunk

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Any

logger = structlog.get_logger()


def build_system_prompt(goal: str) -> str:
    """Build the system prompt for a reasoning task."""
    return REASONING_SYSTEM_PROMPT_TEMPLATE.format(goal=goal)


async def build_reasoning_messages(
    context: list[dict[str, Any]],
    system_prompt: str,
    goal: str,
) -> list[dict[str, Any]]:
    """Build and trim the message list for a reasoning LLM call.

    Uses build_llm_messages to handle file attachments, then trims to
    MAX_CONTEXT_MESSAGES (preserving the system prompt at index 0),
    and appends the final user instruction.
    """
    messages = await build_llm_messages(context, system_prompt)

    if len(messages) > MAX_CONTEXT_MESSAGES + 1:
        messages = [messages[0], *messages[-(MAX_CONTEXT_MESSAGES):]]

    messages.append({"role": "user", "content": f"Please complete this reasoning task: {goal}"})

    return messages


async def execute_reasoning(
    goal: str,
    context: list[dict[str, Any]],
    model: str,
    agent_id: str | None = None,
    stream_id: str | None = None,
    heartbeat_fn: Callable[[str], None] | None = None,
    claude_token: str | None = None,
    claude_token_source: str | None = None,
    claude_token_pool_id: str | None = None,
    claude_token_user_id: str | None = None,
    gpt_token: str | None = None,
    gpt_account_id: str | None = None,
    gpt_token_source: str | None = None,
    gpt_token_pool_id: str | None = None,
    gpt_token_user_id: str | None = None,
) -> dict[str, Any]:
    """Execute a reasoning task using LLM with streaming.

    Streams content back to the frontend via Supabase Realtime,
    following the same pattern as call_llm_activity.

    Args:
        goal: The reasoning task goal
        context: Full message context
        model: Model to use (same as execute loop)
        agent_id: Agent ID for streaming (optional)
        stream_id: Stream session ID for ordering (optional)
        heartbeat_fn: Callable for activity heartbeats (optional)

    Returns:
        Dict with 'content' string and 'usage' dict for cost tracking
    """
    system_prompt = build_system_prompt(goal)
    messages = await build_reasoning_messages(context, system_prompt, goal)

    if heartbeat_fn:
        heartbeat_fn("Starting reasoning task")

    sequence = [0]
    last_text = [""]
    is_claude = [False]
    is_gpt = [False]

    def on_model_detected(actual_model: str) -> None:
        is_claude[0] = actual_model.endswith("-claude")
        is_gpt[0] = actual_model.endswith("-gpt")

    async def on_chunk(text_so_far: str, tokens: int) -> None:
        """Stream chunks to frontend via Supabase Realtime."""
        if heartbeat_fn:
            heartbeat_fn(f"LLM streaming... {len(text_so_far)} chars")
        if agent_id and stream_id:
            delta = text_so_far[len(last_text[0]) :]
            if delta:
                await stream_assistant_chunk(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    delta=delta,
                    done=False,
                    sequence=sequence[0],
                    is_claude=is_claude[0],
                    is_gpt=is_gpt[0],
                )
                sequence[0] += 1
            last_text[0] = text_so_far

    result, usage, _ = await call_llm_structured_streaming(
        messages=messages,
        model=model,
        temperature=REASONING_TEMPERATURE,
        max_tokens=REASONING_MAX_TOKENS,
        response_model=ReasoningResponse,
        on_chunk=on_chunk,
        agent_id=agent_id,
        call_site="dag_reasoning",
        claude_token=claude_token,
        claude_token_source=claude_token_source,
        claude_token_pool_id=claude_token_pool_id,
        claude_token_user_id=claude_token_user_id,
        gpt_token=gpt_token,
        gpt_account_id=gpt_account_id,
        gpt_token_source=gpt_token_source,
        gpt_token_pool_id=gpt_token_pool_id,
        gpt_token_user_id=gpt_token_user_id,
        on_model_detected=on_model_detected,
    )

    content = result.response if result and result.response else ""

    if agent_id and stream_id:
        try:
            final_delta = content[len(last_text[0]) :] if content else ""
            await stream_assistant_chunk(
                agent_id=agent_id,
                stream_id=stream_id,
                delta=final_delta,
                done=True,
                sequence=sequence[0],
                is_claude=is_claude[0],
                is_gpt=is_gpt[0],
            )
        except Exception as e:
            logger.warning(f"Final stream chunk failed (non-fatal): {e}")

    if not content:
        logger.error("[Reasoning] Empty response from LLM")
        return {"content": "Unable to complete reasoning task.", "usage": usage}

    logger.info(f"[Reasoning] Completed task, output length: {len(content)} chars")
    return {"content": content, "usage": usage}
