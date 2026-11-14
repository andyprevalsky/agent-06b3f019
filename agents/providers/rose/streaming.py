"""SSE parsing for the Rose client.

Single replacement for the three duplicated SSE parsers that previously lived
inline in `helpers/llm.py` (`call_llm`, `call_llm_structured_streaming`,
`_call_llm_verifier`). Both Anthropic-native and OpenAI/OpenRouter-compatible
event streams collapse to one normalized output: an `AsyncIterator[StreamChunk]`
that begins with a `metadata` chunk, yields any number of `content` /
`tool_call` / `reasoning` chunks, then exactly one `usage` chunk and one `done`
chunk on clean completion.

Behavior is intentionally identical to
`research/domains/completions/service/streaming.ts`:
  - Anthropic `message_start` carries `input_tokens` + cache metrics; the
    final `message_delta` carries `output_tokens`. Both are folded into a
    single OpenAI-shaped usage dict.
  - Anthropic `tool_use` content blocks yield raw `tool_call` chunks
    (id + name + accumulated `input_json_delta` fragments). Native-tool
    JSON-envelope reconstruction is the caller's responsibility, not ours.
  - OpenAI tool_calls stream as deltas keyed by `index`; we accumulate
    arguments per index and flush one `tool_call` chunk per call when the
    stream ends or `finish_reason` arrives.
  - Empty streams (no content, no tool_call) raise `RoseStallError` for the
    same reason the TS waterfall counts an empty stream as a failed step.

The functions are Temporal-free: no `temporalio`, no `helpers.llm` imports.
This keeps them unit-testable in plain `pytest` and avoids circular deps when
`helpers/llm.py` migrates to call this module.
"""

from __future__ import annotations

import json
from contextvars import ContextVar
from typing import Any, AsyncIterator, Callable, Dict, Optional, Protocol

import structlog

from providers.rose.errors import (
    RoseAuthError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
    RoseRateLimitError,
    RoseRefusalError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.types import StreamChunk

logger = structlog.get_logger()

# Usage-chunk key carrying provider reasoning blocks (Anthropic thinking with
# signatures, redacted_thinking, OpenRouter reasoning_details). RoseClient pops
# it into the archived final record; callers never receive it.
REASONING_BLOCKS_USAGE_KEY = "_archive_reasoning_blocks"

# Parsers buffer tool arguments until a complete tool_call can be emitted.
# Report genuine fragments privately to the request guard without introducing
# partial tools, changing normalized output or counting them as completed calls.
_stream_progress: ContextVar[Optional[Callable[[str, int], None]]] = ContextVar(
    "rose_stream_progress", default=None,
)


def _note_stream_attempt() -> None:
    callback = _stream_progress.get()
    if callback is not None:
        callback("attempt", 0)


def _note_tool_argument(fragment: Any) -> None:
    if isinstance(fragment, str) and fragment:
        callback = _stream_progress.get()
        if callback is not None:
            callback("tool_arguments", len(fragment))


def _responses_error_to_exception(error_payload: Any, request_id: str):
    if isinstance(error_payload, dict):
        code = str(error_payload.get("code") or error_payload.get("type") or "").lower()
        error_type = str(error_payload.get("type") or "").lower()
        message = str(error_payload.get("message") or error_payload)
    else:
        code = ""
        error_type = ""
        message = str(error_payload or "Responses stream failed")

    details = f"Responses stream failed (request_id={request_id}, code={code or 'unknown'}): {message[:1000]}"
    if code in {
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_usage_limit_exceeded",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
    } or error_type == "insufficient_quota":
        return RosePaymentRequiredError(details)
    if code in {"invalid_request_error", "context_length_exceeded", "bad_request"}:
        return RoseInvalidRequest(details)
    if code in {"refusal", "safety_refusal", "content_policy_violation", "policy_violation"}:
        return RoseRefusalError(details)
    if code in {"rate_limit_exceeded", "rate_limit_error", "too_many_requests"}:
        return RoseRateLimitError(details)
    if code in {"authentication_error", "permission_error", "unauthorized", "forbidden"}:
        return RoseAuthError(details)
    if code in {"server_error", "internal_server_error", "overloaded"}:
        return RoseServerError(details)
    return RoseServerError(details)


def _reasoning_delta_text(event: Dict[str, Any], event_type: str) -> Optional[str]:
    if "reasoning" not in event_type:
        return None
    if event_type.endswith(".delta"):
        value = event.get("delta") or event.get("summary_text") or event.get("reasoning")
    else:
        value = event.get("summary_text") or event.get("reasoning")
    return value if isinstance(value, str) and value else None


class _LineStream(Protocol):
    """Minimal interface we need from `httpx.Response` for SSE parsing.

    Declared as a Protocol so tests can pass a fake stream without standing
    up an httpx server.
    """

    def aiter_lines(self) -> AsyncIterator[str]: ...

    async def aclose(self) -> None: ...


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def parse_anthropic_sse(
    response: _LineStream,
    *,
    actual_model: str,
    pool_name: str,
    request_id: str,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    """Parse Anthropic's native SSE format into normalized StreamChunks.

    Yields, in order:
      1. one `metadata` chunk (actual_model, pool_name, request_id)
      2. zero or more `content`, `reasoning`, `tool_call` chunks
      3. one `usage` chunk (prompt/completion/total + cache metrics)
      4. one `done` chunk

    Args:
        response: streaming response exposing `aiter_lines()` + `aclose()`
        actual_model: model name resolved by the orchestrator (e.g.
            `claude-sonnet-4-6-claude` for the claudeAuth path)
        pool_name: pool the model was selected from (e.g. `claude-token`)
        request_id: caller-provided correlation id for logging
        idle_timeout_s: deprecated; per-line idle timeouts are disabled.

    Raises:
        RoseStallError: if the stream closes without emitting any content /
            tool_call chunks.
    """
    yield StreamChunk(
        kind="metadata",
        data={
            "actual_model": actual_model,
            "pool_name": pool_name,
            "request_id": request_id,
        },
    )

    input_tokens = 0
    output_tokens = 0
    cache_creation_tokens = 0
    cache_read_tokens = 0
    finish_reason: str = ""

    # Per-content-block state. Anthropic streams blocks one-at-a-time so a
    # single mutable slot is sufficient.
    current_block_kind: Optional[str] = None  # "text" | "thinking" | "tool_use"
    current_block_index = 0
    current_tool_id: Optional[str] = None
    current_tool_name: Optional[str] = None
    current_tool_args: list[str] = []
    # Thinking blocks with their signatures and redacted_thinking payloads:
    # required to replay a thinking trajectory, archived via the usage chunk.
    reasoning_blocks: list[Dict[str, Any]] = []
    blocks_by_index: Dict[int, Dict[str, Any]] = {}

    emitted_content_or_tool = False

    try:
        async for line in _iter_with_idle_timeout(response, idle_timeout_s, request_id):
            if not line:
                continue
            if line.startswith("event: "):
                # Anthropic sends "event: <name>" + "data: <json>" pairs;
                # the JSON's own `type` field carries the same info, so the
                # event line is redundant — skip cleanly.
                continue
            if not line.startswith("data: "):
                continue

            data_str = line[6:]
            if data_str == "[DONE]":
                # Anthropic does not normally emit [DONE], but tolerate it
                # in case a proxy injects one.
                break

            try:
                event = json.loads(data_str)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "rose.sse.parse_error",
                    request_id=request_id,
                    provider="anthropic",
                    error=str(exc),
                    snippet=data_str[:200],
                )
                continue

            event_type = event.get("type")

            if event_type == "message_start":
                msg_usage = (event.get("message") or {}).get("usage") or {}
                input_tokens = msg_usage.get("input_tokens", 0) or 0
                cache_creation_tokens = msg_usage.get("cache_creation_input_tokens", 0) or 0
                cache_read_tokens = msg_usage.get("cache_read_input_tokens", 0) or 0
                continue

            if event_type == "message_delta":
                delta_usage = event.get("usage") or {}
                if delta_usage.get("output_tokens"):
                    output_tokens = delta_usage["output_tokens"]
                stop_reason = (event.get("delta") or {}).get("stop_reason")
                if stop_reason:
                    # Map Anthropic stop_reason -> OpenAI-style finish_reason so
                    # callers can branch on a single vocabulary.
                    finish_reason = {
                        "end_turn": "stop",
                        "max_tokens": "length",
                        "stop_sequence": "stop",
                        "tool_use": "tool_calls",
                    }.get(stop_reason, stop_reason)
                continue

            if event_type == "content_block_start":
                block = event.get("content_block") or {}
                block_type = block.get("type")
                current_block_index = event.get("index") if isinstance(event.get("index"), int) else 0
                if block_type == "tool_use":
                    current_block_kind = "tool_use"
                    current_tool_id = block.get("id")
                    current_tool_name = block.get("name") or ""
                    current_tool_args = []
                elif block_type == "thinking":
                    current_block_kind = "thinking"
                    thinking_block = {
                        "type": "anthropic_thinking",
                        "text": block.get("thinking") or "",
                        "signature": block.get("signature") or None,
                    }
                    reasoning_blocks.append(thinking_block)
                    blocks_by_index[current_block_index] = thinking_block
                elif block_type == "redacted_thinking":
                    current_block_kind = None
                    reasoning_blocks.append({"type": "anthropic_redacted_thinking", "data": block.get("data")})
                elif block_type == "text":
                    current_block_kind = "text"
                else:
                    current_block_kind = None
                continue

            if event_type == "content_block_delta":
                delta = event.get("delta") or {}
                delta_type = delta.get("type")

                if delta_type == "text_delta":
                    text = delta.get("text") or ""
                    if text:
                        emitted_content_or_tool = True
                        yield StreamChunk(
                            kind="content",
                            data={
                                "text": text,
                                "item_id": f"anthropic:{current_block_index}",
                                "output_index": current_block_index,
                                "content_index": 0,
                                "phase": "final_answer",
                            },
                        )
                elif delta_type == "signature_delta":
                    block_index = event.get("index", current_block_index)
                    target = blocks_by_index.get(block_index)
                    if target is not None:
                        target["signature"] = (target.get("signature") or "") + (delta.get("signature") or "")
                elif delta_type == "thinking_delta":
                    text = delta.get("thinking") or ""
                    target = blocks_by_index.get(event.get("index", current_block_index))
                    if target is not None:
                        target["text"] += text
                    if text:
                        # Reasoning counts as emitted: thinking models
                        # legitimately place their JSON payload in
                        # reasoning tokens, and the structured-streaming
                        # caller extracts it. The "no real content" case
                        # is gated at the caller via the "No JSON content
                        # received" raise, not here.
                        emitted_content_or_tool = True
                        yield StreamChunk(
                            kind="reasoning",
                            data={
                                "text": text,
                                "item_id": f"anthropic:{current_block_index}",
                                "output_index": current_block_index,
                                "content_index": 0,
                                "phase": "reasoning",
                            },
                        )
                elif delta_type == "input_json_delta":
                    fragment = delta.get("partial_json") or ""
                    if fragment:
                        current_tool_args.append(fragment)
                        if (current_block_kind == "tool_use"
                                and event.get("index", current_block_index) == current_block_index):
                            _note_tool_argument(fragment)
                continue

            if event_type == "content_block_stop":
                if current_block_kind == "tool_use" and current_tool_name is not None:
                    arguments = "".join(current_tool_args)
                    emitted_content_or_tool = True
                    yield StreamChunk(
                        kind="tool_call",
                        data={
                            "id": current_tool_id or "",
                            "name": current_tool_name,
                            "arguments": arguments,
                        },
                    )
                current_block_kind = None
                current_block_index = 0
                current_tool_id = None
                current_tool_name = None
                current_tool_args = []
                continue

            if event_type == "message_stop":
                # Wait for the loop to drain naturally so any trailing
                # `message_delta` usage event is captured first.
                continue

            if event_type == "error":
                err = event.get("error") or {}
                logger.warning(
                    "rose.sse.provider_error",
                    request_id=request_id,
                    provider="anthropic",
                    message=err.get("message"),
                    error_type=err.get("type"),
                )
                # Anthropic frequently returns HTTP 200 + opens SSE + emits
                # an in-band error (`rate_limit_error`, `authentication_error`,
                # etc.) instead of an HTTP error status. Raise a typed
                # exception so claude_auth.py can apply the same rotation /
                # transient-retry logic it already uses for HTTP 429/401.
                raise _responses_error_to_exception(err, request_id)
    finally:
        await _close_quietly(response)

    if finish_reason == "refusal":
        raise RoseRefusalError(f"Anthropic stream ended with refusal (request_id={request_id})")

    # Thinking can spend the whole budget before any visible text. The provider
    # reported that truncation (stop_reason=max_tokens), so surface it as
    # finish_reason=length for the caller's max_tokens escalation, not as a stall.
    if not emitted_content_or_tool and finish_reason != "length":
        raise RoseStallError(f"Anthropic stream closed without content or tool_call (request_id={request_id})")

    usage_data: Dict[str, Any] = {
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cache_creation_input_tokens": cache_creation_tokens,
        "cache_read_input_tokens": cache_read_tokens,
        "finish_reason": finish_reason,
    }
    if any(block.get("signature") or block["type"] == "anthropic_redacted_thinking" for block in reasoning_blocks):
        # Only when blocks carry data the reasoning chunks cannot (signatures,
        # redacted payloads). RoseClient moves them into the archived output
        # record and strips them from the usage chunk callers see.
        usage_data[REASONING_BLOCKS_USAGE_KEY] = reasoning_blocks
    yield StreamChunk(kind="usage", data=usage_data)
    yield StreamChunk(kind="done", data={})


async def parse_openai_sse(
    response: _LineStream,
    *,
    actual_model: str = "",
    pool_name: str = "",
    request_id: str,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    """Parse OpenAI / OpenRouter SSE format into normalized StreamChunks.

    Same output contract as `parse_anthropic_sse`, so callers don't need to
    branch on provider when consuming the stream.

    Tool-call accumulation: OpenAI streams tool_calls as deltas with an
    integer `index` and partial `arguments` strings. We accumulate per
    index and flush one `tool_call` chunk per index when the stream
    finishes (or when a `finish_reason` arrives — see streaming.ts for
    the matching TS behavior).

    `reasoning_content` (Gemini 3 Pro thinking) and `reasoning` (Anthropic
    via OpenRouter, GPT-5.2, DeepSeek) are both folded into `reasoning`
    chunks. The TS edge function emits `delta.reasoning`; some providers
    use the `reasoning_content` key on the raw upstream response.
    """
    yield StreamChunk(
        kind="metadata",
        data={
            "actual_model": actual_model,
            "pool_name": pool_name,
            "request_id": request_id,
        },
    )

    usage: Dict[str, Any] = {}
    finish_reason: str = ""
    # tool_calls keyed by streaming index — matches OpenAI's contract that
    # the same index refers to the same call across deltas.
    tool_calls: Dict[int, Dict[str, Any]] = {}
    flushed_tool_indices: set[int] = set()
    emitted_content_or_tool = False
    saw_done = False
    # OpenRouter `reasoning_details` (encrypted / summary / text items with
    # signatures) merged per streamed index; archived via the usage chunk.
    reasoning_details: Dict[Any, Dict[str, Any]] = {}

    def _merge_reasoning_detail(detail: Any) -> None:
        if not isinstance(detail, dict):
            return
        key = detail.get("index", detail.get("id", len(reasoning_details)))
        slot = reasoning_details.setdefault(key, {})
        for field, value in detail.items():
            if field in ("text", "summary", "data", "signature") and isinstance(value, str):
                slot[field] = (slot.get(field) or "") + value
            elif value is not None:
                slot[field] = value

    def _flush_tool_calls() -> list[StreamChunk]:
        chunks: list[StreamChunk] = []
        for idx in sorted(tool_calls.keys()):
            if idx in flushed_tool_indices:
                continue
            tc = tool_calls[idx]
            chunks.append(
                StreamChunk(
                    kind="tool_call",
                    data={
                        "id": tc.get("id", ""),
                        "name": tc.get("name", ""),
                        "arguments": tc.get("arguments", ""),
                    },
                )
            )
            flushed_tool_indices.add(idx)
        return chunks

    try:
        async for line in _iter_with_idle_timeout(response, idle_timeout_s, request_id):
            if not line or not line.startswith("data: "):
                continue

            data_str = line[6:]
            if data_str == "[DONE]":
                saw_done = True
                break

            try:
                event = json.loads(data_str)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "rose.sse.parse_error",
                    request_id=request_id,
                    provider="openai",
                    error=str(exc),
                    snippet=data_str[:200],
                )
                continue

            # Capture cumulative usage. OpenRouter/OpenAI either deliver
            # this on a final dedicated chunk (stream_options.include_usage)
            # or interleave it; either way the latest value wins.
            if event.get("usage"):
                usage = event["usage"]

            choices = event.get("choices") or []
            if not choices:
                continue

            choice = choices[0]
            delta = choice.get("delta") or {}
            choice_index = choice.get("index") if isinstance(choice.get("index"), int) else 0

            content = delta.get("content")
            if content:
                emitted_content_or_tool = True
                yield StreamChunk(
                    kind="content",
                    data={
                        "text": content,
                        "item_id": f"openai:choice:{choice_index}",
                        "output_index": choice_index,
                        "content_index": 0,
                        "phase": "final_answer",
                    },
                )

            # Two key spellings exist in the wild:
            #   - `reasoning`         (TS edge function transforms to this)
            #   - `reasoning_content` (Gemini 3 Pro thinking, raw upstream)
            reasoning_text = delta.get("reasoning") or delta.get("reasoning_content")
            if reasoning_text:
                # See parse_anthropic_sse thinking_delta — reasoning counts
                # as emitted so thinking-model JSON-in-reasoning reaches the
                # caller's extractor instead of stalling prematurely.
                emitted_content_or_tool = True
                yield StreamChunk(
                    kind="reasoning",
                    data={
                        "text": reasoning_text,
                        "item_id": f"openai:choice:{choice_index}",
                        "output_index": choice_index,
                        "content_index": 0,
                        "phase": "reasoning",
                    },
                )

            for detail in delta.get("reasoning_details") or []:
                _merge_reasoning_detail(detail)

            for tc_delta in delta.get("tool_calls") or []:
                index = tc_delta.get("index", 0)
                slot = tool_calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if tc_delta.get("id"):
                    slot["id"] = tc_delta["id"]
                fn = tc_delta.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["arguments"] += fn["arguments"]
                    _note_tool_argument(fn["arguments"])

            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
                # Flush any tool_calls that completed under this finish so
                # downstream consumers see them before the usage chunk.
                for chunk in _flush_tool_calls():
                    emitted_content_or_tool = True
                    yield chunk
    finally:
        await _close_quietly(response)

    # Flush any tool_calls that streamed without a finish_reason landing
    # before the [DONE] sentinel.
    for chunk in _flush_tool_calls():
        emitted_content_or_tool = True
        yield chunk

    if finish_reason == "refusal":
        raise RoseRefusalError(f"OpenAI/OpenRouter stream ended with refusal (request_id={request_id})")

    if not emitted_content_or_tool:
        # An empty stream is a stall in the TS waterfall sense: the
        # connection opened, no content arrived, the connection closed.
        raise RoseStallError(
            f"OpenAI/OpenRouter stream closed without content or tool_call "
            f"(request_id={request_id}, saw_done={saw_done})"
        )

    # Anthropic-native fields (direct claudeAuth path) live at the top level.
    # OpenRouter wraps them under prompt_tokens_details with different names.
    ptd = usage.get("prompt_tokens_details") or {}
    cache_write = usage.get("cache_creation_input_tokens") or ptd.get("cache_write_tokens") or 0
    cache_read = usage.get("cache_read_input_tokens") or ptd.get("cached_tokens") or 0

    usage_data: Dict[str, Any] = {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cache_creation_input_tokens": cache_write,
        "cache_read_input_tokens": cache_read,
        "finish_reason": finish_reason,
    }
    reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
    if isinstance(reasoning_tokens, int):
        usage_data["reasoning_tokens"] = reasoning_tokens
    if reasoning_details:
        usage_data[REASONING_BLOCKS_USAGE_KEY] = [
            {
                "type": "openrouter_reasoning_detail",
                "text": detail.get("text") if isinstance(detail.get("text"), str) else None,
                "signature": detail.get("signature") if isinstance(detail.get("signature"), str) else None,
                "data": detail.get("data") if isinstance(detail.get("data"), str) else None,
                "id": detail.get("id") if isinstance(detail.get("id"), str) else None,
                "summary": detail.get("summary"),
                "raw": detail,
            }
            for detail in reasoning_details.values()
        ]
    yield StreamChunk(kind="usage", data=usage_data)
    yield StreamChunk(kind="done", data={})


async def parse_responses_sse(
    response: _LineStream,
    *,
    actual_model: str = "",
    pool_name: str = "",
    request_id: str,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    """Parse OpenAI Responses API SSE events into normalized StreamChunks."""
    yield StreamChunk(
        kind="metadata",
        data={
            "actual_model": actual_model,
            "pool_name": pool_name,
            "request_id": request_id,
        },
    )

    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0
    cache_write_tokens = 0
    cache_write_reported = False
    cache_read_tokens = 0
    reasoning_tokens: Optional[int] = None
    finish_reason = ""
    emitted_content_or_tool = False
    saw_done = False
    output_items: Dict[str, Dict[str, Any]] = {}

    def apply_usage(usage: Optional[Dict[str, Any]]) -> None:
        nonlocal prompt_tokens, completion_tokens, total_tokens, cache_write_tokens, cache_read_tokens
        nonlocal cache_write_reported, reasoning_tokens
        if not usage:
            return
        output_details = usage.get("output_tokens_details") or {}
        if isinstance(output_details.get("reasoning_tokens"), int):
            reasoning_tokens = output_details["reasoning_tokens"]
        prompt_tokens = usage.get("input_tokens", prompt_tokens) or prompt_tokens
        completion_tokens = usage.get("output_tokens", completion_tokens) or completion_tokens
        total_tokens = usage.get("total_tokens", total_tokens) or total_tokens
        details = usage.get("input_tokens_details") or {}
        if isinstance(details.get("cache_write_tokens"), int):
            # GPT-5.6+ reports writes; zero is a real value with explicit breakpoints.
            cache_write_tokens = details["cache_write_tokens"]
            cache_write_reported = True
        cache_read_tokens = details.get("cached_tokens", cache_read_tokens) or cache_read_tokens

    try:
        async for line in _iter_with_idle_timeout(response, idle_timeout_s, request_id):
            if not line:
                continue
            if line.startswith("event: "):
                continue
            if not line.startswith("data: "):
                continue

            data_str = line[6:]
            if data_str == "[DONE]":
                saw_done = True
                break

            try:
                event = json.loads(data_str)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "rose.sse.parse_error",
                    request_id=request_id,
                    provider="responses",
                    error=str(exc),
                    snippet=data_str[:200],
                )
                continue

            event_type = str(event.get("type") or "")
            if event_type == "response.output_item.added":
                item = event.get("item") or {}
                item_id = item.get("id") if isinstance(item, dict) else None
                if isinstance(item_id, str) and item_id:
                    item_type = item.get("type")
                    item_phase = item.get("phase")
                    output_items[item_id] = {
                        "type": item_type,
                        "item_id": item_id,
                        "output_index": event.get("output_index") if isinstance(event.get("output_index"), int) else 0,
                        "content_index": 0,
                        "phase": item_phase
                        if isinstance(item_phase, str) and item_phase
                        else ("reasoning" if item_type == "reasoning" else "final_answer"),
                    }
                continue

            if event_type == "response.function_call_arguments.delta":
                item_id = event.get("item_id")
                item = output_items.get(item_id) if isinstance(item_id, str) else None
                if item is not None and item.get("type") == "function_call":
                    _note_tool_argument(event.get("delta"))
                continue

            delta = event.get("delta") or event.get("text")
            if (
                isinstance(delta, str)
                and delta
                and (
                    event_type.endswith(".output_text.delta")
                    or event_type.endswith(".text.delta")
                    or event_type == "response.output_item.delta"
                )
            ):
                emitted_content_or_tool = True
                yield StreamChunk(
                    kind="content",
                    data={"text": delta, **_responses_output_provenance(event, output_items, "final_answer")},
                )
                continue

            reasoning_delta = _reasoning_delta_text(event, event_type)
            if reasoning_delta:
                emitted_content_or_tool = True
                yield StreamChunk(
                    kind="reasoning",
                    data={"text": reasoning_delta, **_responses_output_provenance(event, output_items, "reasoning")},
                )
                continue

            if event_type == "response.output_item.done":
                item = event.get("item") or {}
                if not isinstance(item, dict):
                    continue
                item_id = item.get("id")
                if isinstance(item_id, str) and item_id in output_items:
                    # A finished item cannot produce additional arguments.
                    output_items[item_id]["type"] = "completed"
                if isinstance(item_id, str) and item_id and item_id not in output_items:
                    item_type = item.get("type")
                    item_phase = item.get("phase")
                    output_items[item_id] = {
                        "item_id": item_id,
                        "output_index": event.get("output_index") if isinstance(event.get("output_index"), int) else 0,
                        "content_index": 0,
                        "phase": item_phase
                        if isinstance(item_phase, str) and item_phase
                        else ("reasoning" if item_type == "reasoning" else "final_answer"),
                    }
                if item.get("type") == "reasoning":
                    encrypted_content = item.get("encrypted_content")
                    if isinstance(encrypted_content, str) and encrypted_content:
                        yield StreamChunk(
                            kind="codex_reasoning_item",
                            data={
                                "id": item.get("id"),
                                "encrypted_content": encrypted_content,
                                "summary": item.get("summary") if isinstance(item.get("summary"), list) else [],
                            },
                        )
                        continue
                if item.get("type") == "function_call":
                    emitted_content_or_tool = True
                    yield StreamChunk(
                        kind="tool_call",
                        data={
                            "id": item.get("call_id") or item.get("id") or "",
                            "name": item.get("name") or "",
                            "arguments": item.get("arguments") or "",
                        },
                    )
                    continue

            if event_type == "response.completed":
                response_obj = event.get("response") or {}
                apply_usage(response_obj.get("usage") or {})
                finish_reason = "stop"
                continue

            if event_type == "response.incomplete":
                response_obj = event.get("response") or {}
                apply_usage(response_obj.get("usage") or {})
                finish_reason = "length"
                continue

            if event_type in ("error", "response.failed"):
                error_payload = event.get("error")
                if error_payload is None and isinstance(event.get("response"), dict):
                    error_payload = (event.get("response") or {}).get("error")
                logger.warning(
                    "rose.sse.provider_error",
                    request_id=request_id,
                    provider="responses",
                    event_type=event_type,
                    error_payload=json.dumps(error_payload, default=str)[:1000],
                )
                raise _responses_error_to_exception(error_payload, request_id)
    finally:
        await _close_quietly(response)

    if not emitted_content_or_tool:
        raise RoseStallError(
            f"Responses stream closed without content or tool_call (request_id={request_id}, saw_done={saw_done})"
        )

    responses_usage: Dict[str, Any] = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens or prompt_tokens + completion_tokens,
        "cache_creation_input_tokens": (
            cache_write_tokens if cache_write_reported else max(prompt_tokens - cache_read_tokens, 0)
        ),
        "cache_read_input_tokens": cache_read_tokens,
        "finish_reason": finish_reason or "stop",
    }
    if reasoning_tokens is not None:
        responses_usage["reasoning_tokens"] = reasoning_tokens
    yield StreamChunk(kind="usage", data=responses_usage)
    yield StreamChunk(kind="done", data={})


def _responses_output_provenance(
    event: Dict[str, Any],
    output_items: Dict[str, Dict[str, Any]],
    default_phase: str,
) -> Dict[str, Any]:
    event_item_id = event.get("item_id")
    known = output_items.get(event_item_id) if isinstance(event_item_id, str) else None
    event_output_index = event.get("output_index")
    output_index = (
        event_output_index if isinstance(event_output_index, int) else (known.get("output_index", 0) if known else 0)
    )
    event_content_index = event.get("content_index")
    content_index = (
        event_content_index if isinstance(event_content_index, int) else (known.get("content_index", 0) if known else 0)
    )
    return {
        "item_id": event_item_id
        if isinstance(event_item_id, str) and event_item_id
        else (known.get("item_id") if known else f"responses:{default_phase}:{output_index}"),
        "output_index": output_index,
        "content_index": content_index,
        "phase": known.get("phase", default_phase) if known else default_phase,
    }


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


async def _iter_with_idle_timeout(
    response: _LineStream,
    idle_timeout_s: Optional[float],
    request_id: str,
) -> AsyncIterator[str]:
    """Yield SSE lines from `response`.

    `idle_timeout_s` is kept as a deprecated compatibility parameter. When
    provided, it is intentionally ignored; RoseClient's outer guard owns the
    time-to-first-contentful-chunk timeout and overall deadline.
    """
    iterator = response.aiter_lines().__aiter__()
    while True:
        try:
            line = await iterator.__anext__()
        except StopAsyncIteration:
            return
        yield line


async def _close_quietly(response: _LineStream) -> None:
    """Close the response, swallowing any error. The stream may already be
    closed (clean EOF) or in a half-broken state; either way
    we want the caller to see the original failure, not a close error.
    """
    try:
        await response.aclose()
    except Exception as exc:
        logger.debug("rose.sse.close_error", error=str(exc))
