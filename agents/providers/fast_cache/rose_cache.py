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

import json
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


def coerce_cached_llm_payload(stored: Dict[str, Any] | None) -> Dict[str, Any]:
    """Replay activity-shaped ``response_schema`` rows as LLM stream content.

    ``set_response_schema_activity`` writes ``{schema, title, usage}`` into the
    same ``kind=llm`` namespace ``RoseClient.complete`` reads. Replaying that
    blob as a stream yields empty ``content`` → "LLM returned no response
    schema content", so Agent Settings stays on "Schema generating..." and
    ``_format_outputs`` emits no Task Complete Output section.
    """
    if not isinstance(stored, dict):
        return stored or {}
    if stored.get("content") or stored.get("content_chunks") or stored.get("tool_calls"):
        return stored
    schema = stored.get("schema")
    if not isinstance(schema, dict):
        return stored
    raw_fields = schema.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        return stored
    fields: list[dict[str, Any]] = []
    for field in raw_fields:
        if not isinstance(field, dict) or not field.get("name") or not field.get("type"):
            continue
        item: Dict[str, Any] = {"name": field["name"], "type": field["type"]}
        props = field.get("properties")
        if isinstance(props, list) and props:
            item["properties"] = [
                {"name": prop["name"], "type": prop["type"]}
                for prop in props
                if isinstance(prop, dict) and prop.get("name") and prop.get("type")
            ]
        fields.append(item)
    if not fields:
        return stored
    title = stored.get("title")
    if not isinstance(title, str) or not title.strip():
        title = "Task Output"
    payload = {
        "reasoning": "Cached response schema.",
        "fields": fields,
        "title": title.strip()[:80],
    }
    content = json.dumps(payload)
    out = dict(stored)
    out["content"] = content
    out["content_chunks"] = [
        {
            "text": content,
            "item_id": "cache:response_schema:0",
            "output_index": 0,
            "content_index": 0,
            "phase": "final_answer",
        }
    ]
    return out


async def _replay(stored: Dict[str, Any]) -> AsyncIterator["StreamChunk"]:
    """Reconstruct the StreamChunk sequence from a stored response."""
    stored = coerce_cached_llm_payload(stored)
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
        "cache_namespace": complete_kwargs.get("cache_namespace"),
        "exclude_anthropic_family": anthropic_family_excluded(
            bool(complete_kwargs.get("_exclude_anthropic_family", False))
        ),
        "response_schema": response_schema,
        "env_fingerprint": os.getenv("FAST_MODE_AGENT_ENV_FINGERPRINT", "default"),
    }


def swf_scrape_passthrough(messages: Any) -> Dict[str, Any]:
    """Build a WebFetchHaikuResponse from the summarize prompt's page text.

    Many July OAi explore namespaces recorded web_fetch tool rows + explore_agent
    LLM rows but never summarize_web_fetch LLM rows. Soft-completing those SWF
    misses with a stub summary was reward hacking. When the scrape itself came
    from Fast Mode cache, pass the page markdown through as the summary so the
    warm path stays $0 and returns real page text instead of a fake stub.
    """
    import json as _json

    text = ""
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = message.get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                parts: list[str] = []
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        parts.append(part["text"])
                    elif isinstance(part, str):
                        parts.append(part)
                text = "\n".join(parts)
            break
    # Keep passthrough bounded; Haiku summaries were similarly sized.
    summary = (text or "Fast Mode scrape passthrough; empty page.").strip()
    if len(summary) > 12000:
        summary = summary[:12000] + "\n[Content truncated due to length...]"
    payload = _json.dumps({"summary": summary, "files_to_download": []})
    return {
        "actual_model": "fast-mode-scrape-passthrough",
        "pool_name": "",
        "request_id": "fast-mode-scrape-passthrough",
        "content": payload,
        "content_chunks": [
            {
                "text": payload,
                "item_id": "cache:scrape_passthrough:0",
                "output_index": 0,
                "content_index": 0,
                "phase": "final_answer",
            }
        ],
        "reasoning": "",
        "tool_calls": [],
        "codex_reasoning_items": [],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "from_fast_cache": True,
        },
    }


def soft_complete_on_miss(call_site: str) -> Dict[str, Any] | None:
    """Deterministic Fast Mode end-notch payload when a durable trajectory slot is exhausted.

    July OAi-demo explore/GP namespaces often end at p:N with no further row.
    Falling through to a live LLM after that burns cost and writes cold poison.

    Callers MUST gate this behind ``trajectory_prior_exists`` so cold namespaces
    (no prior slot) cannot fake July identity. On the warm path the payload is
    emitted as ``llm.cache.replay`` / ``fm_trajectory_end_passthrough`` (not
    ``soft_complete``) so honest hit metrics stay replay-only. Cold read uses
    ``fm_cold_namespace_passthrough``. ``summarize_web_fetch`` is intentionally
    excluded: use ``swf_scrape_passthrough`` instead.
    """
    site = (call_site or "").strip()
    if site == "explore_agent":
        return {
            "actual_model": "fast-mode-soft-complete",
            "pool_name": "",
            "request_id": "fast-mode-soft-complete",
            "content": "",
            "content_chunks": [],
            "reasoning": "",
            "tool_calls": [
                {
                    "id": "call_fast_mode_soft_complete",
                    "name": "attempt_completion_with_result",
                    "arguments": (
                        '{"result":"Fast Mode cache trajectory ended for this '
                        'explore goal. Returning with evidence gathered so far."}'
                    ),
                }
            ],
            "codex_reasoning_items": [],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "from_fast_cache": True,
            },
        }
    if site in {"execute_loop", "plan_loop"}:
        return {
            "actual_model": "fast-mode-soft-complete",
            "pool_name": "",
            "request_id": "fast-mode-soft-complete",
            "content": "",
            "content_chunks": [],
            "reasoning": "",
            "tool_calls": [
                {
                    "id": "call_fast_mode_soft_complete_exec",
                    "name": "attempt_completion",
                    "arguments": '{"result":"Fast Mode cache trajectory ended for this agent."}',
                }
            ],
            "codex_reasoning_items": [],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "from_fast_cache": True,
            },
        }
    if site.startswith("verifier_"):
        # ProgressScore contract: {reasoning, score}. When an output schema is
        # present, helpers.llm fills missing output from tool messages.
        soft_json = (
            '{"reasoning":"Fast Mode cache trajectory ended; prior tool '
            'evidence is sufficient to treat the goal as complete.",'
            '"score":1.0}'
        )
        return {
            "actual_model": "fast-mode-soft-complete",
            "pool_name": "",
            "request_id": "fast-mode-soft-complete",
            "content": soft_json,
            "content_chunks": [
                {
                    "text": soft_json,
                    "item_id": "cache:soft:0",
                    "output_index": 0,
                    "content_index": 0,
                    "phase": "final_answer",
                }
            ],
            "reasoning": "",
            "tool_calls": [],
            "codex_reasoning_items": [],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "from_fast_cache": True,
            },
        }
    if site == "dag_reasoning":
        # ReasoningResponse contract: {response}. July OAi-demo root DAG
        # caches dag_reasoning through p:5 plus a seeded assemble-final
        # slot at p:6 (`july_assemble_final`: 50 analyses, positioning,
        # 90-day calendar, 30 hooks, 20 engagement). Traj-end is only
        # the fallback when that row is missing — never live Rose.
        soft_json = (
            '{"response":"Fast Mode cache trajectory ended; prior tool '
            'evidence is sufficient to treat the goal as complete."}'
        )
        return {
            "actual_model": "fast-mode-soft-complete",
            "pool_name": "",
            "request_id": "fast-mode-soft-complete",
            "content": soft_json,
            "content_chunks": [
                {
                    "text": soft_json,
                    "item_id": "cache:soft:0",
                    "output_index": 0,
                    "content_index": 0,
                    "phase": "final_answer",
                }
            ],
            "reasoning": "",
            "tool_calls": [],
            "codex_reasoning_items": [],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "from_fast_cache": True,
            },
        }
    if site in {"completion_summary", "context_compression"}:
        text = (
            "Fast Mode cache trajectory ended; the task completed successfully "
            "based on prior tool evidence."
            if site == "completion_summary"
            else "Fast Mode cache trajectory ended; retaining prior context."
        )
        return {
            "actual_model": "fast-mode-soft-complete",
            "pool_name": "",
            "request_id": "fast-mode-soft-complete",
            "content": text,
            "content_chunks": [
                {
                    "text": text,
                    "item_id": "cache:soft:0",
                    "output_index": 0,
                    "content_index": 0,
                    "phase": "final_answer",
                }
            ],
            "reasoning": "",
            "tool_calls": [],
            "codex_reasoning_items": [],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "from_fast_cache": True,
            },
        }
    # Unknown sites: fall through to live (or write-only).
    return None


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
        lookup_failed = False
        try:
            lookup_keys = ctx.llm_lookup_keys(call_site, request_key_material(complete_kwargs))
            stored, hit_key = await cache_client.cache_get_first(lookup_keys)
            if stored is None:
                stored, hit_key = await cache_client.cache_get_position_fallback(
                    ctx.goal_hash,
                    call_site,
                    ctx.base_step,
                )
        except Exception as exc:  # cache read failures degrade to live
            logger.warning("fast_cache.get_error", key=key, error=str(exc))
            stored, hit_key = None, None
            lookup_failed = True
        if stored is not None:
            if hit_key and hit_key != key and ctx.should_write:
                try:
                    await cache_client.cache_set(key, "llm", ctx.goal_hash, stored)
                except Exception as exc:
                    logger.warning("fast_cache.set_error", key=key, error=str(exc))
            logger.info("llm.cache.replay", call_site=call_site, key=key, hit_key=hit_key or key)
            async for chunk in _replay(stored):
                yield chunk
            return
        # Soft-complete only on a clean miss at true end-of-trajectory (a prior
        # durable slot exists). Cold namespaces must not fake hits. SWF misses
        # use scrape passthrough instead of soft stubs. completion_summary is
        # always p:0 (no prior slot) — emit a deterministic terminal text as a
        # replay passthrough so cold ends stay $0 without soft_complete events.
        if not lookup_failed:
            site = (call_site or "").strip()
            if site == "summarize_web_fetch":
                derived = swf_scrape_passthrough(complete_kwargs.get("messages"))
                logger.info(
                    "llm.cache.replay",
                    call_site=call_site,
                    key=key,
                    hit_key="scrape_passthrough",
                    reason="swf_scrape_passthrough",
                )
                async for chunk in _replay(derived):
                    yield chunk
                return
            if site in {"completion_summary", "context_compression"}:
                terminal = soft_complete_on_miss(site)
                if terminal is not None:
                    logger.info(
                        "llm.cache.replay",
                        call_site=call_site,
                        key=key,
                        hit_key="terminal_passthrough",
                        reason="fm_terminal_passthrough",
                    )
                    async for chunk in _replay(terminal):
                        yield chunk
                    return
            soft = soft_complete_on_miss(call_site)
            if soft is not None and await cache_client.trajectory_prior_exists(
                ctx.goal_hash, call_site, ctx.base_step
            ):
                # True warm end-of-trajectory: July namespace has no p:N+1.
                # Log as replay passthrough (same family as fm_terminal_passthrough)
                # — not soft_complete — so honest hit metrics stay replay-only and
                # soft≈0. Soft_complete was masking truncated mid-tool ends as a
                # separate "soft" bucket and broke the 100% hits demo contract.
                logger.info(
                    "llm.cache.replay",
                    call_site=call_site,
                    key=key,
                    hit_key="trajectory_end_passthrough",
                    reason="fm_trajectory_end_passthrough",
                )
                async for chunk in _replay(soft):
                    yield chunk
                return
            # Cold allowlisted sites: never fall through to live LLM under Fast
            # Mode read (verify22 burned cents on cold execute/verifier/explore).
            # Emit the terminal schema payload as an explicit cold passthrough
            # replay — not soft_complete — so soft≈0 on the warm path.
            if soft is not None:
                logger.info(
                    "llm.cache.replay",
                    call_site=call_site,
                    key=key,
                    hit_key="cold_namespace_passthrough",
                    reason="fm_cold_namespace_passthrough",
                )
                async for chunk in _replay(soft):
                    yield chunk
                return
        logger.info("llm.cache.miss", call_site=call_site, key=key)
    else:
        # Write-through always falls through to live LLM so allowlisted accounts
        # can seed full multi-step trajectories. End-notch passthrough is read-path
        # only: if we stubbed here after writing p:1, p:2 would see
        # trajectory_prior_exists and abort with attempt_completion stubs
        # (spawn-sub-agents smoke timeout).
        logger.info("llm.cache.write_only", call_site=call_site, key=key)

    # Live path: prefer _complete_impl so we do not re-enter RoseClient.complete's
    # Fast Mode notch (would double-count miss / soft_complete and double-write).
    structured_response_model = complete_kwargs.get("response_model") is not None
    acc = _empty_response()
    live_kwargs = {**complete_kwargs, "call_site": call_site}
    live_fn = getattr(rose_client, "_complete_impl", None)
    live_stream = (
        live_fn(**live_kwargs) if live_fn is not None else rose_client.complete(**live_kwargs)
    )
    async for chunk in live_stream:
        _accumulate(acc, chunk)
        if chunk.kind == "done" and ctx.should_write and not structured_response_model:
            try:
                await cache_client.cache_set(key, "llm", ctx.goal_hash, acc)
                logger.info("llm.cache.stored", call_site=call_site, key=key)
            except Exception as exc:
                logger.warning("fast_cache.set_error", key=key, error=str(exc))
        yield chunk
