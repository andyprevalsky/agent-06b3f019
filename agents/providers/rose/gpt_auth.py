"""Direct ChatGPT/Codex Responses streaming call + retry.

Uses the saved Codex ChatGPT OAuth access token directly against
https://chatgpt.com/backend-api/codex/responses. This does not route through
OpenRouter.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from helpers.tracing import span, stream_span
from providers.rose.errors import (
    RoseAuthError,
    RoseError,
    RoseInvalidRequest,
    RosePaymentRequiredError,
    RoseRateLimitError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_responses_sse
from providers.rose.transport import get_error_body, post_codex_stream, post_openai_responses_stream
from providers.rose.types import GptAuthContext, StreamChunk
from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

logger = structlog.get_logger()

_MAX_ATTEMPTS_PER_TOKEN = 3
_BACKOFF_CAP_S = 5.0
_DEFAULT_TTFT_TIMEOUT_S = 60.0
_DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant."
_OPENAI_CREDIT_ERROR_CODES = frozenset(
    {
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_usage_limit_exceeded",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
    }
)


def _openai_credit_error(error_body: str) -> bool:
    """Distinguish long-lived credit/spend 429s from transient rate limits."""
    try:
        error = json.loads(error_body).get("error", {})
    except (ValueError, AttributeError):
        return False
    if not isinstance(error, dict):
        return False
    code = error.get("code")
    return (isinstance(code, str) and code in _OPENAI_CREDIT_ERROR_CODES) or error.get("type") == "insufficient_quota"


# Codex 429 bodies look like:
#   {"error":{"type":"usage_limit_reached","plan_type":"pro",
#             "resets_at":1778618837,"resets_in_seconds":88465, ...}}
# When the body says "resets in 24h", we MUST persist that on the pool token
# so it isn't retried 5 minutes later. Falling back to a flat 5-min cooldown
# (the old behavior) means we'd burn another rotation every 5 min for a day.
_RESET_HEADER_NAMES = (
    "x-ratelimit-reset",
    "ratelimit-reset",
    "x-rate-limit-reset",
)
_DEFAULT_COOLDOWN_S = 5 * 60


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif block.get("type") == "image_url":
                parts.append("[Image attachment]")
            elif block.get("type") == "file":
                filename = (block.get("file") or {}).get("filename") or "file"
                parts.append(f"[File attachment: {filename}]")
        return "\n".join(p for p in parts if p)
    return str(content)


def _text_part_type(role: str) -> str:
    return "output_text" if role == "assistant" else "input_text"


def _content_to_responses_parts(content: Any, *, role: str, cache_breakpoints: bool = False) -> Any:
    if isinstance(content, str):
        return [{"type": _text_part_type(role), "text": content}]
    if not isinstance(content, list):
        return [{"type": _text_part_type(role), "text": str(content)}]

    parts: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            parts.append({"type": _text_part_type(role), "text": str(block)})
            continue

        block_type = block.get("type")
        if block_type in ("text", "input_text", "output_text") or isinstance(block.get("text"), str):
            text = block.get("text") or ""
            if text:
                part = {"type": _text_part_type(role), "text": text}
                if cache_breakpoints and role == "user" and isinstance(block.get("cache_control"), dict):
                    # The caller's cache marker, in GPT-5.6+'s form.
                    part["prompt_cache_breakpoint"] = {"mode": "explicit"}
                parts.append(part)
            continue

        if block_type in ("image_url", "input_image") and role == "user":
            image_url = block.get("image_url")
            if isinstance(image_url, dict):
                detail = image_url.get("detail")
                image_url = image_url.get("url")
            else:
                detail = block.get("detail")
            if isinstance(image_url, str) and image_url:
                image_part: dict[str, Any] = {"type": "input_image", "image_url": image_url}
                if isinstance(detail, str) and detail:
                    image_part["detail"] = detail
                parts.append(image_part)
            continue

        if block_type == "file":
            filename = (block.get("file") or {}).get("filename") or "file"
            parts.append({"type": _text_part_type(role), "text": f"[File attachment: {filename}]"})

    return parts or [{"type": _text_part_type(role), "text": ""}]


def _stable_call_id(name: str, arguments: Any, index: int) -> str:
    raw_args = arguments if isinstance(arguments, str) else json.dumps(arguments or {}, sort_keys=True, default=str)
    digest = hashlib.sha256(f"{name}:{raw_args}:{index}".encode()).hexdigest()[:16]
    return f"call_{digest}"


def _normalize_tool_arguments(arguments: Any) -> str:
    if arguments is None or arguments == "":
        return "{}"
    if isinstance(arguments, str):
        return arguments
    return json.dumps(arguments, sort_keys=True, default=str)


def _responses_tools(tools: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        parameters = function.get("parameters") or function.get("input_schema") or {}
        if not isinstance(parameters, dict):
            parameters = {}
        out.append(
            {
                "type": "function",
                "name": name,
                "description": function.get("description") or "",
                "strict": bool(function.get("strict", False)),
                "parameters": parameters,
            }
        )
    return out or None


def _responses_tool_choice(tool_choice: Any) -> Any:
    if tool_choice == "any":
        return "required"
    if isinstance(tool_choice, dict):
        name = tool_choice.get("name")
        if isinstance(name, str) and name:
            return {"type": "function", "name": name}
    return tool_choice or "auto"


def _normalize_codex_message_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    if item.get("type") != "message" or item.get("role") != "assistant":
        return None
    content = item.get("content")
    if not isinstance(content, list):
        return None
    normalized_content: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str):
            normalized_content.append({"type": "output_text", "text": text})
    if not normalized_content:
        return None
    status = item.get("status") if item.get("status") in ("completed", "incomplete", "in_progress") else "completed"
    normalized: dict[str, Any] = {
        "type": "message",
        "role": "assistant",
        "status": status,
        "content": normalized_content,
    }
    for key in ("id", "phase"):
        if isinstance(item.get(key), str) and item[key]:
            normalized[key] = item[key]
    return normalized


def _normalize_codex_reasoning_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    encrypted = item.get("encrypted_content")
    if not isinstance(encrypted, str) or not encrypted:
        return None
    return {
        "type": "reasoning",
        "encrypted_content": encrypted,
        "summary": item.get("summary") if isinstance(item.get("summary"), list) else [],
    }


_MAX_PROMPT_CACHE_BREAKPOINTS = 50
_BREAKPOINT_MODEL_RE = re.compile(r"gpt-(\d+)(?:\.(\d+))?")


def supports_prompt_cache_breakpoints(model: Optional[str]) -> bool:
    """GPT-5.6 and later cache only at breakpoints; earlier models reject the field (HTTP 400)."""
    match = _BREAKPOINT_MODEL_RE.search(model or "")
    if not match:
        return False
    major, minor = int(match.group(1)), int(match.group(2) or 0)
    return major > 5 or (major == 5 and minor >= 6)


def _mark_completed_user_messages(items: List[Dict[str, Any]]) -> None:
    """Breakpoint after every user message before the final item (its last text part).

    Replaying 911 real agent calls through the measured GPT-5.6+ rule (2026-10-12):
    implicit mode plus these marks cost 0.51x of no caching, against 0.55x for
    implicit mode alone and 0.61x for explicit mode, which loses the latest-message
    and opening-instructions caching that chat-style calls rely on.
    """
    for item in items[:-1]:
        content = item.get("content")
        if item.get("role") != "user" or not isinstance(content, list):
            continue
        texts = [part for part in content if isinstance(part, dict) and part.get("type") == "input_text"]
        if texts:
            texts[-1]["prompt_cache_breakpoint"] = {"mode": "explicit"}


def _cap_prompt_cache_breakpoints(items: List[Dict[str, Any]]) -> None:
    """Reads consider the latest 50 breakpoints; drop older marks beyond that."""
    marked = [part for item in items for part in item.get("content", []) if isinstance(item.get("content"), list)
              and isinstance(part, dict) and "prompt_cache_breakpoint" in part]
    for part in marked[: max(len(marked) - _MAX_PROMPT_CACHE_BREAKPOINTS, 0)]:
        part.pop("prompt_cache_breakpoint", None)


def _build_responses_input(messages: List[Dict[str, Any]], *, cache_breakpoints: bool = False) -> List[Dict[str, Any]]:
    out: list[dict[str, Any]] = []
    emitted_call_ids: set[str] = set()
    for msg_index, msg in enumerate(messages):
        role = msg.get("role")
        if role == "system":
            continue

        if role == "assistant":
            for item in msg.get("codex_reasoning_items") or []:
                normalized = _normalize_codex_reasoning_item(item)
                if normalized:
                    out.append(normalized)
            for item in msg.get("codex_message_items") or []:
                normalized = _normalize_codex_message_item(item)
                if normalized:
                    out.append(normalized)

        tool_calls = msg.get("tool_calls")
        if role == "assistant" and isinstance(tool_calls, list) and tool_calls:
            content_parts = _content_to_responses_parts(msg.get("content", ""), role="assistant")
            if any((part.get("text") or "") for part in content_parts if isinstance(part, dict)):
                out.append({"role": "assistant", "content": content_parts})
            for tool_index, tool_call in enumerate(tool_calls):
                function = (tool_call or {}).get("function") or {}
                name = function.get("name") or (tool_call or {}).get("name") or "tool"
                arguments = _normalize_tool_arguments(function.get("arguments") or (tool_call or {}).get("arguments"))
                call_id = (
                    (tool_call or {}).get("call_id")
                    or (tool_call or {}).get("id")
                    or _stable_call_id(name, arguments, msg_index + tool_index)
                )
                out.append(
                    {
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": arguments,
                    }
                )
                emitted_call_ids.add(call_id)
            continue

        if role == "tool":
            call_id = msg.get("tool_call_id") or msg.get("call_id")
            tool_text = _content_to_text(msg.get("content", ""))
            if isinstance(call_id, str) and call_id and call_id in emitted_call_ids:
                out.append(
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": tool_text,
                    }
                )
            else:
                # Stored DB transcripts frequently contain TOOL rows without
                # the matching assistant function_call item. Codex rejects
                # orphan function_call_output items, so keep the text as normal
                # user-visible context instead of sending an invalid sequence.
                out.append(
                    {
                        "role": "user",
                        "content": [{"type": "input_text", "text": f"[TOOL]: {tool_text}"}],
                    }
                )
            continue

        response_role = "assistant" if role == "assistant" else "user"
        content = _content_to_responses_parts(
            msg.get("content", ""), role=response_role, cache_breakpoints=cache_breakpoints
        )
        if not content:
            continue
        out.append({"role": response_role, "content": content})

    while out and out[-1].get("role") == "assistant":
        out.pop()
    if not out:
        out.append(
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "Begin."}],
            }
        )
    return out


def _build_system_text(messages: List[Dict[str, Any]]) -> str:
    parts = [_content_to_text(msg.get("content", "")).strip() for msg in messages if msg.get("role") == "system"]
    return "\n\n".join(p for p in parts if p)


def _build_instructions(messages: List[Dict[str, Any]]) -> Optional[str]:
    text = _build_system_text(messages)
    if not text:
        return None
    # The system producer's final delimiter can lose its surrounding newline.
    # Match reserved lines only; inline prose and non-system data stay intact.
    sections = [[]]
    for line in text.split("\n"):
        if line.strip(" \t\r") == SYSTEM_PROMPT_DYNAMIC_BOUNDARY.strip():
            sections.append([])
        else:
            sections[-1].append(line)
    if len(sections) == 1:
        return text
    parts = ["\n".join(section) for section in sections]
    return "\n\n".join(part.strip() for part in parts if part.strip()) or None


def _build_static_cache_scope(messages: List[Dict[str, Any]]) -> Optional[str]:
    """Return only the globally stable system prefix for GPT cache routing."""
    text = _build_system_text(messages)
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY in text:
        text = text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)[0]
    return text.strip() or None


def _build_prompt_cache_key(
    *,
    pool_spec: PoolSpec,
    model_override: Optional[str] = None,
    static_cache_scope: str,
    cache_namespace: Optional[str] = None,
) -> str:
    fingerprint = json.dumps(
        {
            "model": model_override or pool_spec.gpt_auth_model,
            "staticCacheScope": static_cache_scope,
            "cacheNamespace": cache_namespace,
        },
        sort_keys=True,
        default=str,
    )
    return "rose:" + hashlib.sha256(fingerprint.encode()).hexdigest()[:24]


def _build_cache_namespace(
    messages: List[Dict[str, Any]],
    *,
    lineage_key: Optional[str],
    agent_id: Optional[str],
    call_site: Optional[str],
) -> str:
    """Isolate provider cache sessions while preserving per-call prefix growth."""
    stable_lineage = lineage_key or agent_id
    first_non_system_message: Optional[Dict[str, Any]] = None
    if stable_lineage is None:
        for message in messages:
            if message.get("role") != "system":
                first_non_system_message = message
                break

    material = json.dumps(
        {
            # Agent lineage is the cache-session identity. Do not mix mutable
            # provider-visible message text into an already-bound session:
            # context-pointer resolution can annotate the first user message
            # between turns even though the conversation identity is unchanged.
            "lineage": stable_lineage or "unbound",
            "callSite": call_site or "unspecified",
            # Unbound helper calls still need content isolation because they
            # have no agent identity to prevent unrelated requests sharing a
            # provider cache session.
            "firstMessage": first_non_system_message if stable_lineage is None else None,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(material.encode()).hexdigest()[:24]


DEFAULT_REASONING_EFFORT = "xhigh"


def _normalize_reasoning_effort(effort: Optional[str]) -> str:
    """Normalize effort for OpenAI Responses / Codex.

    OpenAI accepts none / minimal / low / medium / high / xhigh / max (model-
    dependent). Our "max" sentinel maps to xhigh (highest reliably-streaming
    tier). Default is xhigh so every body always carries reasoning.effort.
    """
    if effort == "minimal":
        return "low"
    if effort == "max":
        return "xhigh"
    return effort or DEFAULT_REASONING_EFFORT


def build_codex_responses_body(
    *,
    pool_spec: PoolSpec,
    model_override: Optional[str] = None,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    temperature: Optional[float] = None,
    effort: Optional[str] = None,
    provider_fast_mode: bool = True,
    cache_namespace: Optional[str] = None,
    request_id: str,
    cache_breakpoints: bool = False,
) -> Dict[str, Any]:
    """Assemble the Codex Responses request body.

    Intentionally does not include max_tokens/max_output_tokens; Codex's
    ChatGPT backend handles limits differently from public API keys.
    """
    instructions = _build_instructions(messages) or _DEFAULT_CODEX_INSTRUCTIONS
    static_cache_scope = _build_static_cache_scope(messages) or _DEFAULT_CODEX_INSTRUCTIONS
    breakpoints = cache_breakpoints and supports_prompt_cache_breakpoints(model_override or pool_spec.gpt_auth_model)
    body: Dict[str, Any] = {
        "model": model_override or pool_spec.gpt_auth_model,
        "input": _build_responses_input(messages, cache_breakpoints=breakpoints),
        "stream": True,
        "store": False,
        "parallel_tool_calls": True,
        "tool_choice": _responses_tool_choice(tool_choice),
        "prompt_cache_key": _build_prompt_cache_key(
            pool_spec=pool_spec,
            model_override=model_override,
            static_cache_scope=static_cache_scope,
            cache_namespace=cache_namespace,
        ),
        "include": ["reasoning.encrypted_content"],
        "reasoning": {
            "effort": _normalize_reasoning_effort(effort),
            "summary": "auto",
        },
    }
    body["instructions"] = instructions
    if breakpoints:
        _mark_completed_user_messages(body["input"])
    _cap_prompt_cache_breakpoints(body["input"])
    responses_tools = _responses_tools(tools)
    # Responses input may retain historical function_call/output items without
    # re-declaring those functions. Definitions in body.tools are selectable,
    # so context-only tools must never be added to that callable set.
    del context_tools
    if responses_tools:
        body["tools"] = responses_tools
    if response_format:
        if response_format.get("type") == "json_object":
            body["text"] = {"format": {"type": "json_object"}}
        else:
            json_schema = response_format.get("json_schema") or {}
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": json_schema.get("name", "response"),
                    "strict": json_schema.get("strict", True),
                    "schema": json_schema.get("schema") or {},
                }
            }
    if provider_fast_mode:
        body["service_tier"] = "priority"
    return body


async def gpt_auth_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    temperature: Optional[float] = None,
    effort: Optional[str] = None,
    auth: GptAuthContext,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    cache_namespace: Optional[str] = None,
    provider_fast_mode: bool = True,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = None,
) -> AsyncIterator[StreamChunk]:
    body = build_codex_responses_body(
        pool_spec=pool_spec,
        messages=messages,
        response_format=response_format,
        tools=tools,
        context_tools=context_tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        provider_fast_mode=provider_fast_mode,
        cache_namespace=(
            cache_namespace
            if cache_namespace is not None
            else _build_cache_namespace(
                messages,
                lineage_key=auth.lineage_key,
                agent_id=agent_id,
                call_site=call_site,
            )
        ),
        request_id=request_id,
    )
    actual_model = f"{pool_spec.gpt_auth_model}-gpt"
    current_auth = auth
    rotations = 0

    while True:
        try:
            # One span per token attempt — see claude_auth for rationale. Without
            # this the gpt path was opaque: a 348s round_trip showed no breakdown.
            async with stream_span(
                "llm.attempt",
                provider="gptAuth",
                actual_model=actual_model,
                rotation=rotations,
                call_site=call_site,
                request_id=request_id,
                agent_id=agent_id,
            ):
                async for chunk in _attempt_with_token(
                    body=body,
                    auth=current_auth,
                    actual_model=actual_model,
                    request_id=request_id,
                    agent_id=agent_id,
                    call_site=call_site,
                    ttft_timeout_s=ttft_timeout_s,
                    idle_timeout_s=idle_timeout_s,
                ):
                    yield chunk
            return
        except (RoseAuthError, RoseRateLimitError) as exc:
            reason = "auth_error" if isinstance(exc, RoseAuthError) else "rate_limit"
            rate_limited_until = getattr(exc, "rate_limited_until", None)
            async with span(
                "llm.cooldown",
                reason=reason,
                rate_limited_until=rate_limited_until,
                rotation=rotations,
                call_site=call_site,
                request_id=request_id,
                agent_id=agent_id,
            ):
                await _cool_down(
                    current_auth,
                    reason,
                    request_id,
                    agent_id,
                    call_site,
                    rate_limited_until=rate_limited_until,
                )
            rotations += 1
            error_cls = RoseRateLimitError if reason == "rate_limit" else RoseAuthError
            if rotations > current_auth.max_rotations:
                raise error_cls(
                    f"gptAuth exhausted after {rotations} rotations ({reason})",
                    status=getattr(exc, "status", None),
                ) from exc
            fresh = await _fetch_fresh_or_none(current_auth)
            if fresh is None:
                raise error_cls(
                    f"gptAuth: no fresh token available after {rotations} rotations ({reason})",
                    status=getattr(exc, "status", None),
                ) from exc
            current_auth = fresh


async def openai_api_key_complete(
    *,
    pool_spec: PoolSpec,
    model: str,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    context_tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    temperature: Optional[float] = None,
    effort: Optional[str] = None,
    openai_key: str,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    cache_namespace: Optional[str] = None,
    provider_fast_mode: bool = True,
    ttft_timeout_s: float = _DEFAULT_TTFT_TIMEOUT_S,
    idle_timeout_s: Optional[float] = None,
    max_tokens: Optional[int] = None,
) -> AsyncIterator[StreamChunk]:
    body = build_codex_responses_body(
        pool_spec=pool_spec,
        model_override=model,
        cache_breakpoints=True,
        messages=messages,
        response_format=response_format,
        tools=tools,
        context_tools=context_tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        provider_fast_mode=provider_fast_mode,
        cache_namespace=(
            cache_namespace
            if cache_namespace is not None
            else _build_cache_namespace(
                messages,
                lineage_key=None,
                agent_id=agent_id,
                call_site=call_site,
            )
        ),
        request_id=request_id,
    )
    if max_tokens is not None:
        body["max_output_tokens"] = max_tokens
    actual_model = f"{model}-openai"
    last_error: Optional[Exception] = None

    for attempt in range(_MAX_ATTEMPTS_PER_TOKEN):
        try:
            async with post_openai_responses_stream(
                body=body,
                openai_key=openai_key,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                connect_timeout_s=ttft_timeout_s,
            ) as response:
                status = response.status_code
                if status == 200:
                    async for chunk in parse_responses_sse(
                        response,
                        actual_model=actual_model,
                        pool_name="openai-api-key",
                        request_id=request_id,
                        idle_timeout_s=idle_timeout_s,
                    ):
                        yield chunk
                    return

                error_body = get_error_body(response)

                if status == 402 or (status == 429 and _openai_credit_error(error_body)):
                    raise RosePaymentRequiredError(f"OpenAI {status}: {error_body[:2000]}", status=status)

                if status == 429:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(_backoff_for_429(response, attempt))
                        continue
                    raise RoseRateLimitError("OpenAI 429", status=status)

                if status in (401, 403):
                    raise RoseAuthError(f"OpenAI {status}", status=status)

                if status == 400:
                    raise RoseInvalidRequest("OpenAI 400", status=status)

                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(f"OpenAI {status}", status=status)

                # Mirror Codex: unexpected statuses (incl. 404) fall through as
                # RoseServerError, never bare RoseError (not in _FALL_THROUGH_ERRORS).
                raise RoseServerError(f"OpenAI {status}", status=status)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                continue
            raise RoseServerError(f"OpenAI connect/read error: {exc}") from exc
        except RoseStallError:
            raise
        except RoseError:
            raise

    if last_error:
        raise RoseServerError(f"OpenAI: exhausted retries: {last_error}") from last_error
    raise RoseServerError("OpenAI: exhausted retries with no error captured")


async def _attempt_with_token(
    *,
    body: Dict[str, Any],
    auth: GptAuthContext,
    actual_model: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    ttft_timeout_s: float,
    idle_timeout_s: Optional[float],
) -> AsyncIterator[StreamChunk]:

    last_error: Optional[Exception] = None
    for attempt in range(_MAX_ATTEMPTS_PER_TOKEN):
        try:
            async with post_codex_stream(
                body=body,
                gpt_token=auth.token,
                account_id=auth.account_id,
                request_id=request_id,
                agent_id=agent_id,
                call_site=call_site,
                connect_timeout_s=ttft_timeout_s,
            ) as response:
                status = response.status_code
                if status == 200:
                    # Spans the SSE generation phase only — separates "the model
                    # streamed slowly" (the 56→3 tok/s collapse) from connect/TTFT.
                    async with stream_span(
                        "llm.provider_read",
                        actual_model=actual_model,
                        attempt=attempt,
                        request_id=request_id,
                        agent_id=agent_id,
                    ):
                        async for chunk in parse_responses_sse(
                            response,
                            actual_model=actual_model,
                            pool_name="gpt-token",
                            request_id=request_id,
                            idle_timeout_s=idle_timeout_s,
                        ):
                            yield chunk
                    return

                error_body = get_error_body(response)

                if status == 429:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        async with span(
                            "llm.backoff",
                            reason="rate_limit_http",
                            attempt=attempt,
                            request_id=request_id,
                            agent_id=agent_id,
                        ):
                            await asyncio.sleep(_backoff_for_429(response, attempt))
                        continue
                    rate_limited_until = _extract_rate_limited_until(response, error_body)
                    exc = RoseRateLimitError("Codex 429", status=status)
                    exc.rate_limited_until = rate_limited_until  # type: ignore[attr-defined]
                    raise exc

                if status in (401, 403):
                    raise RoseAuthError(f"Codex {status}", status=status)

                if status == 400:
                    raise RoseInvalidRequest("Codex 400", status=status)

                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        async with span(
                            "llm.backoff", reason="5xx", attempt=attempt, request_id=request_id, agent_id=agent_id
                        ):
                            await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(f"Codex {status}", status=status)

                # 404 (and any other unexpected non-2xx) must be RoseServerError so
                # RoseClient._FALL_THROUGH_ERRORS catches it and walks openai-api-key
                # / waterfall. A bare RoseError is NOT in that tuple — that gap made
                # Cloudflare/edge 404s (empty body, same response for garbage tokens)
                # fail the whole agent 3× instead of falling through. Do not retry
                # 404 in-place: the same egress IP keeps getting blocked.
                raise RoseServerError(f"Codex {status}", status=status)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                async with span(
                    "llm.backoff", reason="connect_error", attempt=attempt, request_id=request_id, agent_id=agent_id
                ):
                    await asyncio.sleep(min(2**attempt, _BACKOFF_CAP_S))
                continue
            raise RoseServerError(f"Codex connect/read error: {exc}") from exc
        except RoseStallError:
            raise
        except RoseError:
            raise

    if last_error:
        raise RoseServerError(f"Codex: exhausted retries: {last_error}") from last_error
    raise RoseServerError("Codex: exhausted retries with no error captured")


def _format_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _epoch_to_iso(epoch: float) -> Optional[str]:
    # Codex sends seconds; accept ms too just in case.
    if epoch > 10_000_000_000:
        epoch = epoch / 1000.0
    if epoch < 1_000_000_000:
        return None
    return _format_utc(datetime.fromtimestamp(epoch, tz=timezone.utc))


def _extract_rate_limited_until(response: Optional[httpx.Response], error_body: str) -> Optional[str]:
    """Pull the upstream reset timestamp out of a Codex 429.

    Codex puts both `resets_at` (epoch seconds) and `resets_in_seconds`
    (relative) in the JSON body. We prefer the absolute epoch, fall back
    to the relative value, then to standard `retry-after` / reset headers.
    Returns an ISO8601 UTC string, or None if nothing usable was found.
    """
    body = error_body or ""
    try:
        parsed = json.loads(body)
        err = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(err, dict):
            resets_at = err.get("resets_at")
            if isinstance(resets_at, (int, float)):
                iso = _epoch_to_iso(float(resets_at))
                if iso:
                    return iso
            resets_in = err.get("resets_in_seconds")
            if isinstance(resets_in, (int, float)) and resets_in >= 0:
                return _format_utc(datetime.now(timezone.utc) + timedelta(seconds=float(resets_in)))
    except (ValueError, TypeError):
        pass

    if response is None:
        return None

    retry_after = response.headers.get("retry-after")
    if retry_after:
        stripped = retry_after.strip()
        try:
            seconds = max(0.0, float(stripped))
            return _format_utc(datetime.now(timezone.utc) + timedelta(seconds=seconds))
        except ValueError:
            try:
                dt = parsedate_to_datetime(stripped)
                if dt is not None:
                    return _format_utc(dt)
            except (TypeError, ValueError):
                pass

    for header_name in _RESET_HEADER_NAMES:
        raw = response.headers.get(header_name)
        if not raw:
            continue
        stripped = raw.strip().strip('"')
        try:
            iso = _epoch_to_iso(float(stripped))
            if iso:
                return iso
        except ValueError:
            try:
                dt = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
                return _format_utc(dt)
            except ValueError:
                continue

    return None


def _seconds_until(iso_ts: str) -> Optional[int]:
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    delta = (dt - datetime.now(timezone.utc)).total_seconds()
    if delta <= 0:
        return None
    return int(delta)


async def _cool_down(
    auth: GptAuthContext,
    reason: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    rate_limited_until: Optional[str] = None,
) -> None:
    if auth.mark_rate_limited is None:
        return
    cooldown_seconds = _seconds_until(rate_limited_until) if rate_limited_until else None
    if cooldown_seconds is None:
        cooldown_seconds = _DEFAULT_COOLDOWN_S
    try:
        await auth.mark_rate_limited(auth, cooldown_seconds, rate_limited_until, reason)
        logger.info(
            "rose.gpt_auth.cooldown_marked",
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            reason=reason,
            source=auth.source,
            pool_token_id=auth.pool_token_id,
        )
    except Exception as exc:
        logger.warning(
            "rose.gpt_auth.cooldown_failed",
            request_id=request_id,
            agent_id=agent_id,
            call_site=call_site,
            error=str(exc),
        )


async def _fetch_fresh_or_none(auth: GptAuthContext) -> Optional[GptAuthContext]:
    if auth.fetch_fresh is None:
        return None
    try:
        fresh = await auth.fetch_fresh(auth.user_id)
    except Exception as exc:
        logger.warning("rose.gpt_auth.fetch_fresh_failed", error=str(exc))
        return None
    if fresh is None or fresh.token_type != "gpt":
        return None
    fresh.mark_rate_limited = fresh.mark_rate_limited or auth.mark_rate_limited
    fresh.fetch_fresh = fresh.fetch_fresh or auth.fetch_fresh
    fresh.max_rotations = auth.max_rotations
    return fresh  # type: ignore[return-value]


def _backoff_for_429(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(1.0, min(float(retry_after), _BACKOFF_CAP_S))
        except ValueError:
            pass
    return min(2**attempt, _BACKOFF_CAP_S)
