"""Reasoning domain service - business logic for reasoning tasks."""

from __future__ import annotations

import time
from ssl import SSLError
from typing import TYPE_CHECKING

import structlog

from domains.reasoning.config import (
    MAX_CONTEXT_MESSAGES,
    REASONING_MAX_TOKENS,
    REASONING_SYSTEM_PROMPT_TEMPLATE,
    REASONING_TEMPERATURE,
)
from domains.reasoning.types import ReasoningResponse
from helpers.attachment_context import attachment_request_overhead
from helpers.llm import build_llm_messages, call_llm, call_llm_structured_streaming
from helpers.messages import stream_assistant_chunk
from helpers.model_info import _DEFAULT_CONTEXT_WINDOW, get_model_context_window

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import Any

logger = structlog.get_logger()


def _should_retry_reasoning_as_raw_text(error: Exception) -> bool:
    error_text = str(error)
    return isinstance(error, (ValueError, SSLError)) or any(
        marker in error_text
        for marker in (
            "No JSON content received",
            "invalid_json_schema",
            "context_length_exceeded",
            "SSL",
            "ssl/tls",
        )
    )


def build_system_prompt(goal: str) -> str:
    """Build the system prompt for a reasoning task."""
    return REASONING_SYSTEM_PROMPT_TEMPLATE.format(goal=goal)


async def build_reasoning_messages(
    context: list[dict[str, Any]],
    system_prompt: str,
    goal: str,
    max_context_tokens: int = _DEFAULT_CONTEXT_WINDOW,
) -> list[dict[str, Any]]:
    """Build and trim the message list for a reasoning LLM call.

    Attachment bodies are admitted against the complete request budget (bodies
    that do not fit keep their metadata label), then the list is trimmed to
    MAX_CONTEXT_MESSAGES (preserving the system prompt at index 0) and the final
    user instruction is appended.
    """
    messages = await build_llm_messages(
        context, system_prompt,
        max_context_tokens=max_context_tokens,
        request_overhead=attachment_request_overhead(ReasoningResponse, f"Please complete this reasoning task: {goal}"),
    )

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
    system_prompt_text: str | None = None,
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
    system_prompt = system_prompt_text or build_system_prompt(goal)
    messages = await build_reasoning_messages(
        context, system_prompt, goal,
        max_context_tokens=await get_model_context_window(model),
    )

    if heartbeat_fn:
        heartbeat_fn("Starting reasoning task")

    sequence = [0]
    last_text = [""]
    is_claude = [False]
    is_gpt = [False]
    llm_started_at_ms = [None]

    def on_model_detected(actual_model: str) -> None:
        is_claude[0] = actual_model.endswith("-claude")
        is_gpt[0] = actual_model.endswith(("-gpt", "-openai", "-foundry"))

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
                    llm_started_at_ms=llm_started_at_ms[0],
                )
                sequence[0] += 1
            last_text[0] = text_so_far

    llm_started_at_ms[0] = int(time.time() * 1000)
    if agent_id and stream_id:
        await stream_assistant_chunk(
            agent_id=agent_id,
            stream_id=stream_id,
            delta="",
            done=False,
            sequence=sequence[0],
            is_claude=is_claude[0],
            is_gpt=is_gpt[0],
            llm_started_at_ms=llm_started_at_ms[0],
        )

    result = None
    usage: dict[str, Any] = {}
    try:
        result, usage, _ = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=REASONING_TEMPERATURE,
            max_tokens=REASONING_MAX_TOKENS,
            response_model=ReasoningResponse,
            on_chunk=on_chunk,
            agent_id=agent_id,
            skip_cache_write=True,
            call_site="dag_reasoning",
            include_reasoning_in_response=False,
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
    except Exception as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            raise
        streamed_text = last_text[0].strip()
        if streamed_text:
            if "No JSON content received" not in str(e):
                logger.warning(
                    "[Reasoning] Structured stream failed after text; using streamed assistant text",
                    error=str(e),
                    streamed_len=len(streamed_text),
                )
            else:
                logger.warning(
                    "[Reasoning] Structured wrapper produced no JSON; using streamed assistant text",
                    streamed_len=len(streamed_text),
                )
            if agent_id and stream_id:
                await stream_assistant_chunk(
                    agent_id=agent_id,
                    stream_id=stream_id,
                    delta="",
                    done=True,
                    sequence=sequence[0],
                    is_claude=is_claude[0],
                    is_gpt=is_gpt[0],
                    llm_started_at_ms=llm_started_at_ms[0],
                )
            return {"content": streamed_text, "usage": {}}

        logger.warning(
            "[Reasoning] Structured stream failed before text; retrying as raw assistant text",
            error=str(e),
        )
        if not _should_retry_reasoning_as_raw_text(e):
            raise
        try:
            fallback = await call_llm(
                messages=messages,
                model=model,
                temperature=REASONING_TEMPERATURE,
                max_tokens=REASONING_MAX_TOKENS,
                response_model=None,
                claude_token=claude_token,
                claude_token_source=claude_token_source,
                claude_token_pool_id=claude_token_pool_id,
                claude_token_user_id=claude_token_user_id,
                gpt_token=gpt_token,
                gpt_account_id=gpt_account_id,
                gpt_token_source=gpt_token_source,
                gpt_token_pool_id=gpt_token_pool_id,
                gpt_token_user_id=gpt_token_user_id,
                skip_cache_write=True,
                call_site="dag_reasoning",
                agent_id=agent_id,
                user_id=claude_token_user_id or gpt_token_user_id,
            )
        except Exception:
            raise

        content = (fallback.get("content") or "").strip()
        usage = fallback.get("usage") or {}
        if not content:
            raise e
        if agent_id and stream_id:
            await stream_assistant_chunk(
                agent_id=agent_id,
                stream_id=stream_id,
                delta=content,
                done=False,
                sequence=sequence[0],
                is_claude=is_claude[0],
                is_gpt=is_gpt[0],
                llm_started_at_ms=llm_started_at_ms[0],
            )
            sequence[0] += 1
            await stream_assistant_chunk(
                agent_id=agent_id,
                stream_id=stream_id,
                delta="",
                done=True,
                sequence=sequence[0],
                is_claude=is_claude[0],
                is_gpt=is_gpt[0],
                llm_started_at_ms=llm_started_at_ms[0],
            )
        return {"content": content, "usage": usage}

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
                llm_started_at_ms=llm_started_at_ms[0],
            )
        except Exception as e:
            logger.warning(f"Final stream chunk failed (non-fatal): {e}")

    if not content:
        logger.error("[Reasoning] Empty response from LLM")
        return {"content": "Unable to complete reasoning task.", "usage": usage}

    logger.info(f"[Reasoning] Completed task, output length: {len(content)} chars")
    return {"content": content, "usage": usage}
