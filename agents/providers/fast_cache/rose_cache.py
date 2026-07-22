"""Fast Mode cache — Rose LLM call record/replay.

Wraps `RoseClient.complete()` (an async iterator of StreamChunk). On a cache HIT it
re-emits stored content chunks with their normalized item provenance;
on a MISS it tees the live stream (forward each chunk while accumulating) and writes
the assembled response once the stream finishes cleanly.
Partial / aborted streams are never written (#8).

When Fast Mode is off this is normally a transparent passthrough. Allowlisted
accounts may use write-through mode: no cache read, but successful live responses
are written for future Fast Mode runs.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, AsyncIterator, Dict

import structlog

from providers.fast_cache import client as cache_client
from providers.fast_cache.context import current_context
from providers.rose.policy import anthropic_family_excluded
from providers.rose.pools import get_pool

if TYPE_CHECKING:
    from providers.rose.types import StreamChunk

logger = structlog.get_logger(__name__)


def _empty_response() -> Dict[str, Any]:
    return {
        "actual_model": "unknown",
        "pool_name": "",
        "request_id": "",
        "content": "",
        "content_chunks": [],
        "reasoning": "",
        "tool_calls": [],
        "codex_reasoning_items": [],
        "usage": {},
    }


def _cache_replay_usage(original: Dict[str, Any]) -> Dict[str, Any]:
    """Convert stored live-call usage into synthetic read-side accounting.

    Provider usage from the write run may contain prompt/cache-write counters.
    On Fast Mode replay there is no provider call; for benchmark and cost
    accounting, count the original input prefix as cache-read and zero the
    write/uncached prompt side.
    """
    usage = dict(original or {})
    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
    cache_read = int(usage.get("cache_read_input_tokens", 0) or 0)
    cache_write = int(usage.get("cache_creation_input_tokens", 0) or 0)
    replay_read = max(prompt_tokens, cache_read + cache_write)
    usage["prompt_tokens"] = 0
    usage["cache_read_input_tokens"] = replay_read
    usage["cache_creation_input_tokens"] = 0
    usage["from_fast_cache"] = True
    return usage


async def _replay(stored: Dict[str, Any]) -> AsyncIterator["StreamChunk"]:
    """Reconstruct the StreamChunk sequence from a stored response."""
    yield SimpleNamespace(
        kind="metadata",
        data={
            "actual_model": stored.get("actual_model", "unknown"),
            "pool_name": stored.get("pool_name", ""),
            "request_id": stored.get("request_id", ""),
            "from_fast_cache": True,
        },
    )
    reasoning = stored.get("reasoning") or ""
    if reasoning:
        yield SimpleNamespace(
            kind="reasoning",
            data={
                "text": reasoning,
                "item_id": "cache:reasoning:0",
                "output_index": 0,
                "content_index": 0,
                "phase": "reasoning",
            },
        )
    content_chunks = stored.get("content_chunks") or []
    if content_chunks:
        for content_chunk in content_chunks:
            yield SimpleNamespace(kind="content", data=dict(content_chunk))
    else:
        content = stored.get("content") or ""
        if content:
            yield SimpleNamespace(
                kind="content",
                data={
                    "text": content,
                    "item_id": "cache:legacy:0",
                    "output_index": 0,
                    "content_index": 0,
                    "phase": "final_answer",
                },
            )
    for tc in stored.get("tool_calls") or []:
        yield SimpleNamespace(kind="tool_call", data=tc)
    for item in stored.get("codex_reasoning_items") or []:
        yield SimpleNamespace(kind="codex_reasoning_item", data=item)
    usage = _cache_replay_usage(stored.get("usage") or {})
    yield SimpleNamespace(kind="usage", data=usage)
    yield SimpleNamespace(kind="done", data={"timing": {"round_trip_s": 0.0}, "from_fast_cache": True})


def _accumulate(acc: Dict[str, Any], chunk: "StreamChunk") -> None:
    if chunk.kind == "metadata":
        acc["actual_model"] = chunk.data.get("actual_model", acc["actual_model"])
        acc["pool_name"] = chunk.data.get("pool_name", acc["pool_name"])
        acc["request_id"] = chunk.data.get("request_id", acc["request_id"])
    elif chunk.kind == "content":
        acc["content"] += chunk.data.get("text", "")
        acc["content_chunks"].append(dict(chunk.data))
    elif chunk.kind == "reasoning":
        acc["reasoning"] += chunk.data.get("text", "")
    elif chunk.kind == "tool_call":
        acc["tool_calls"].append(dict(chunk.data))
    elif chunk.kind == "codex_reasoning_item":
        acc["codex_reasoning_items"].append(dict(chunk.data))
    elif chunk.kind == "usage":
        acc["usage"] = dict(chunk.data)


# Public aliases — `RoseClient.complete` (the central cache notch) imports these to
# replay/accumulate the stream. Keeping them here keeps all the StreamChunk shaping
# in one module.
empty_response = _empty_response
replay = _replay
accumulate_chunk = _accumulate


def request_key_material(complete_kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Stable, behavior-shaping request material for LLM cache keys."""
    pool_name = complete_kwargs.get("pool")
    pool_contract: Any = None
    if isinstance(pool_name, str):
        pool = get_pool(pool_name)
        pool_contract = {
            "claude_auth_model": pool.claude_auth_model,
            "gpt_auth_model": pool.gpt_auth_model,
            "waterfall": pool.waterfall,
        }
    response_model = complete_kwargs.get("response_model")
    response_schema: Any = None
    if response_model is not None:
        try:
            response_schema = response_model.model_json_schema()
        except Exception:
            response_schema = getattr(response_model, "__name__", str(response_model))
    return {
        "pool": pool_name,
        "pool_contract": pool_contract,
        "messages": complete_kwargs.get("messages"),
        "tools": complete_kwargs.get("tools"),
        "tool_choice": complete_kwargs.get("tool_choice"),
        "temperature": complete_kwargs.get("temperature"),
        "max_tokens": complete_kwargs.get("max_tokens"),
        "seed": complete_kwargs.get("seed"),
        "thinking": complete_kwargs.get("thinking"),
        "effort": complete_kwargs.get("effort"),
        "provider_fast_mode": complete_kwargs.get("provider_fast_mode"),
        "exclude_anthropic_family": anthropic_family_excluded(
            bool(complete_kwargs.get("_exclude_anthropic_family", False))
        ),
        "response_schema": response_schema,
        "env_fingerprint": os.getenv("FAST_MODE_AGENT_ENV_FINGERPRINT", "default"),
    }


async def cached_complete(
    rose_client: Any,
    *,
    call_site: str,
    **complete_kwargs: Any,
) -> AsyncIterator[StreamChunk]:
    """Compatibility wrapper for tests and legacy call sites.

    Production LLM calls use the central `RoseClient.complete()` notch. This
    wrapper intentionally mirrors that behavior so callers that still enter here
    get the same record/replay semantics instead of a passthrough.
    """
    ctx = current_context()
    if ctx is None or not ctx.active:
        async for chunk in rose_client.complete(call_site=call_site, **complete_kwargs):
            yield chunk
        return

    if "provider_fast_mode" not in complete_kwargs:
        complete_kwargs = {**complete_kwargs, "provider_fast_mode": bool(ctx.provider_fast_mode)}

    key = ctx.llm_key(call_site, request_key_material(complete_kwargs))
    if ctx.read_enabled:
        try:
            stored = await cache_client.cache_get(key)
        except Exception as exc:  # cache read failures degrade to live
            logger.warning("fast_cache.get_error", key=key, error=str(exc))
            stored = None
        if stored is not None:
            logger.info("llm.cache.replay", call_site=call_site, key=key)
            async for chunk in _replay(stored):
                yield chunk
            return
        logger.info("llm.cache.miss", call_site=call_site, key=key)
    else:
        logger.info("llm.cache.write_only", call_site=call_site, key=key)

    structured_response_model = complete_kwargs.get("response_model") is not None
    acc = _empty_response()
    async for chunk in rose_client.complete(call_site=call_site, **complete_kwargs):
        _accumulate(acc, chunk)
        if chunk.kind == "done" and ctx.should_write and not structured_response_model:
            try:
                await cache_client.cache_set(key, "llm", ctx.goal_hash, acc)
                logger.info("llm.cache.stored", call_site=call_site, key=key)
            except Exception as exc:
                logger.warning("fast_cache.set_error", key=key, error=str(exc))
        yield chunk
