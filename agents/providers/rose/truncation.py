"""Recovery for a reply cut off by the output limit before it produced its result.

A call that must end in a tool call or a structured result is useless when the
model hits the output limit first (``finish_reason == "length"`` with no tool
call): thinking used the whole budget. Asking again with the same context and
the same limit usually repeats the same cut-off, so this is the one policy for
every such call:

    attempt 1  as requested
       │ cut off
       ▼
    attempt 2  same route, larger output limit
       │ cut off
       ▼
    attempt 3  next model in the pool (the cut-off model is skipped)
       │
       ▼
    whatever attempt 3 returns is final

Each abandoned attempt is followed by one ``restart`` chunk telling the consumer
to drop what it accumulated. Only consumers that understand ``restart`` opt in
(``RoseClient.collect`` does, for every collected call); a plain-text reply is
never retried here, since a cut-off answer is still a partial answer.
"""

from __future__ import annotations

import re
import time
from contextlib import aclosing
from typing import Any, AsyncIterator, Callable, Dict, FrozenSet, List, Optional

import structlog

from providers.rose.types import StreamChunk

logger = structlog.get_logger(__name__)

# Most replies fit the caller's limit; the few that do not get one retry with room to finish.
ESCALATED_MAX_TOKENS_FLOOR = 16_000
ESCALATED_MAX_TOKENS_CEILING = 32_000
ESCALATION_FACTOR = 4
# A retry that cannot get this long before the caller's deadline is not started.
MIN_RETRY_BUDGET_S = 30.0


def escalated_max_tokens(max_tokens: Optional[int]) -> Optional[int]:
    """The larger limit for the retry, or None when there is nothing to raise."""
    if not max_tokens or max_tokens >= ESCALATED_MAX_TOKENS_CEILING:
        return None
    return min(max(max_tokens * ESCALATION_FACTOR, ESCALATED_MAX_TOKENS_FLOOR), ESCALATED_MAX_TOKENS_CEILING)


def model_key(model: Optional[str]) -> str:
    """One key per model across routes: ``qwen/qwen3.8-27b`` and ``qwen-3.8-27b`` match."""
    name = str(model or "").split("/")[-1].lower()
    for suffix in ("-claude", "-gpt", "-foundry", "-anthropic", "-openai"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    return re.sub(r"[^a-z0-9]", "", name)


def needs_result(*, tools: Any, tool_choice: Any, response_model: Any) -> bool:
    """True for calls whose reply is only usable as a tool call or structured result."""
    if response_model is not None:
        return True
    return bool(tools) and tool_choice != "none"


# Token counters an abandoned attempt still spent; the cache counters are kept
# separate from prompt tokens by the cost accounting in client.py.
USAGE_COUNTERS = (
    "prompt_tokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


async def recover_truncated(
    attempt: Callable[..., AsyncIterator[StreamChunk]],
    kwargs: Dict[str, Any],
) -> AsyncIterator[StreamChunk]:
    """Run ``attempt(**kwargs)`` under the cut-off policy above, streaming live."""
    if not needs_result(
        tools=kwargs.get("tools"),
        tool_choice=kwargs.get("tool_choice"),
        response_model=kwargs.get("response_model"),
    ):
        async with aclosing(attempt(**kwargs)) as stream:
            async for chunk in stream:
                yield chunk
        return

    started = time.monotonic()
    deadline_s = kwargs.get("deadline_s")
    larger = escalated_max_tokens(kwargs.get("max_tokens"))
    # Stages still available after the attempt that just ran.
    remaining: List[str] = (["larger_limit"] if larger else []) + ["next_model"]
    current = dict(kwargs)
    skipped: FrozenSet[str] = frozenset()
    # Tokens the abandoned attempts consumed are real spend; they ride on the
    # final usage chunk (per attempt, with the model that produced them) so the
    # ledgers see the whole call rather than its last attempt.
    abandoned: List[Dict[str, Any]] = []

    while True:
        held: List[StreamChunk] = []
        actual_model = ""
        finish_reason = ""
        completion_tokens = 0
        prompt_tokens = 0
        usage_data: Dict[str, Any] = {}
        saw_tool_call = False
        async with aclosing(attempt(**current)) as stream:
            async for chunk in stream:
                if chunk.kind == "metadata":
                    actual_model = str(chunk.data.get("actual_model") or actual_model)
                elif chunk.kind == "tool_call":
                    saw_tool_call = True
                elif chunk.kind == "usage":
                    finish_reason = str(chunk.data.get("finish_reason") or "")
                    completion_tokens = int(chunk.data.get("completion_tokens") or 0)
                    prompt_tokens = int(chunk.data.get("prompt_tokens") or 0)
                    usage_data = dict(chunk.data)
                if chunk.kind in ("usage", "done"):
                    held.append(chunk)
                    continue
                yield chunk

        cut_off = finish_reason == "length" and not saw_tool_call
        elapsed = time.monotonic() - started
        out_of_time = deadline_s is not None and float(deadline_s) - elapsed < MIN_RETRY_BUDGET_S
        if not cut_off or not remaining or out_of_time:
            if cut_off:
                logger.warning(
                    "rose.truncation.unrecovered",
                    call_site=kwargs.get("call_site"),
                    agent_id=kwargs.get("agent_id"),
                    actual_model=actual_model,
                    completion_tokens=completion_tokens,
                    out_of_time=out_of_time,
                )
            for chunk in held:
                if chunk.kind == "usage" and abandoned:
                    merged = dict(chunk.data)
                    for counter in USAGE_COUNTERS:
                        extra = sum(int(item.get(counter) or 0) for item in abandoned)
                        if extra or counter in merged:
                            merged[counter] = int(merged.get(counter) or 0) + extra
                    merged["abandoned_attempts"] = list(abandoned)
                    chunk = StreamChunk(kind="usage", data=merged)
                yield chunk
            return

        # Every model that cut off so far is excluded once we move on, not just
        # the last one: a larger-limit retry can be served by a different model.
        skipped = skipped | {model_key(actual_model)}
        abandoned.append(
            {
                "model": actual_model,
                **{counter: int(usage_data.get(counter) or 0) for counter in USAGE_COUNTERS},
            }
        )
        # Codex-style Responses routes (direct GPT, the funded OpenAI key,
        # Foundry) send no output limit at all, so a larger limit changes
        # nothing for them; go straight to the next model.
        if "larger_limit" in remaining and actual_model.endswith(("-gpt", "-openai", "-foundry")):
            remaining.remove("larger_limit")
            if not remaining:
                for chunk in held:
                    yield chunk
                return
        stage = remaining.pop(0)
        if stage == "next_model":
            # The direct-token routes serve one model; leaving it means the pool's waterfall.
            current = {**current, "claude_auth": None, "gpt_auth": None, "_skip_models": skipped}
        if larger:
            current = {**current, "max_tokens": larger}
        if deadline_s is not None:
            current = {**current, "deadline_s": float(deadline_s) - elapsed}
        logger.warning(
            "rose.truncation.retry",
            call_site=kwargs.get("call_site"),
            agent_id=kwargs.get("agent_id"),
            stage=stage,
            cut_off_model=actual_model,
            completion_tokens=completion_tokens,
            max_tokens=current.get("max_tokens"),
            elapsed_s=round(elapsed, 3),
        )
        yield StreamChunk(
            kind="restart",
            data={"reason": "output_limit", "stage": stage, "cut_off_model": actual_model},
        )
