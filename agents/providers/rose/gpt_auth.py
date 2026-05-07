"""Direct ChatGPT/Codex Responses streaming call + retry.

Uses the saved Codex ChatGPT OAuth access token directly against
https://chatgpt.com/backend-api/codex/responses. This does not route through
OpenRouter.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import structlog

from providers.rose.errors import (
    RoseAuthError,
    RoseError,
    RoseInvalidRequest,
    RoseRateLimitError,
    RoseServerError,
    RoseStallError,
)
from providers.rose.pools import PoolSpec
from providers.rose.streaming import parse_responses_sse
from providers.rose.transport import get_error_body, post_codex_stream
from providers.rose.types import GptAuthContext, StreamChunk

logger = structlog.get_logger()

_MAX_ATTEMPTS_PER_TOKEN = 3
_BACKOFF_CAP_S = 5.0
_DEFAULT_IDLE_TIMEOUT_S = 60.0
_DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant."


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
                filename = ((block.get("file") or {}).get("filename") or "file")
                parts.append(f"[File attachment: {filename}]")
        return "\n".join(p for p in parts if p)
    return str(content)


def _text_part_type(role: str) -> str:
    return "output_text" if role == "assistant" else "input_text"


def _content_to_responses_parts(content: Any, *, role: str) -> Any:
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
                parts.append({"type": _text_part_type(role), "text": text})
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
            filename = ((block.get("file") or {}).get("filename") or "file")
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
        out.append({
            "type": "function",
            "name": name,
            "description": function.get("description") or "",
            "strict": bool(function.get("strict", False)),
            "parameters": parameters,
        })
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


def _build_responses_input(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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
                out.append({
                    "type": "function_call",
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments,
                })
                emitted_call_ids.add(call_id)
            continue

        if role == "tool":
            call_id = msg.get("tool_call_id") or msg.get("call_id")
            tool_text = _content_to_text(msg.get("content", ""))
            if isinstance(call_id, str) and call_id and call_id in emitted_call_ids:
                out.append({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": tool_text,
                })
            else:
                # Stored DB transcripts frequently contain TOOL rows without
                # the matching assistant function_call item. Codex rejects
                # orphan function_call_output items, so keep the text as normal
                # user-visible context instead of sending an invalid sequence.
                out.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": f"[TOOL]: {tool_text}"}],
                })
            continue

        response_role = "assistant" if role == "assistant" else "user"
        content = _content_to_responses_parts(msg.get("content", ""), role=response_role)
        if not content:
            continue
        out.append({"role": response_role, "content": content})

    while out and out[-1].get("role") == "assistant":
        out.pop()
    if not out:
        out.append({
            "role": "user",
            "content": [{"type": "input_text", "text": "Begin."}],
        })
    return out


def _build_instructions(messages: List[Dict[str, Any]]) -> Optional[str]:
    parts = [
        _content_to_text(msg.get("content", "")).strip()
        for msg in messages
        if msg.get("role") == "system"
    ]
    text = "\n\n".join(p for p in parts if p)
    return text or None


def _build_prompt_cache_key(
    *,
    pool_spec: PoolSpec,
    instructions: Optional[str],
    response_format: Optional[Dict[str, Any]],
) -> str:
    fingerprint = json.dumps(
        {
            "model": pool_spec.gpt_auth_model,
            "instructions": instructions or "",
            "responseFormat": response_format.get("json_schema") if response_format else None,
        },
        sort_keys=True,
        default=str,
    )
    return "rose:" + hashlib.sha256(fingerprint.encode()).hexdigest()[:24]


def _normalize_reasoning_effort(effort: Optional[str]) -> str:
    if effort == "minimal":
        return "low"
    if effort == "max":
        return "xhigh"
    return effort or "medium"


def build_codex_responses_body(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    temperature: Optional[float] = None,
    effort: Optional[str] = None,
    request_id: str,
) -> Dict[str, Any]:
    """Assemble the Codex Responses request body.

    Intentionally does not include max_tokens/max_output_tokens; Codex's
    ChatGPT backend handles limits differently from public API keys.
    """
    instructions = _build_instructions(messages) or _DEFAULT_CODEX_INSTRUCTIONS
    reasoning_effort = _normalize_reasoning_effort(effort)
    body: Dict[str, Any] = {
        "model": pool_spec.gpt_auth_model,
        "input": _build_responses_input(messages),
        "stream": True,
        "store": False,
        "parallel_tool_calls": True,
        "tool_choice": _responses_tool_choice(tool_choice),
        "prompt_cache_key": _build_prompt_cache_key(
            pool_spec=pool_spec,
            instructions=instructions,
            response_format=response_format,
        ),
        "reasoning": {"effort": reasoning_effort, "summary": "auto"},
        "include": ["reasoning.encrypted_content"],
    }
    body["instructions"] = instructions
    responses_tools = _responses_tools(tools)
    if responses_tools:
        body["tools"] = responses_tools
    if response_format:
        json_schema = response_format.get("json_schema") or {}
        body["text"] = {
            "format": {
                "type": "json_schema",
                "name": json_schema.get("name", "response"),
                "strict": json_schema.get("strict", True),
                "schema": json_schema.get("schema") or {},
            }
        }
    return body


async def gpt_auth_complete(
    *,
    pool_spec: PoolSpec,
    messages: List[Dict[str, Any]],
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Any = None,
    temperature: Optional[float] = None,
    effort: Optional[str] = None,
    auth: GptAuthContext,
    request_id: str,
    agent_id: Optional[str] = None,
    call_site: Optional[str] = None,
    ttft_timeout_s: float = _DEFAULT_IDLE_TIMEOUT_S,
    idle_timeout_s: float = _DEFAULT_IDLE_TIMEOUT_S,
) -> AsyncIterator[StreamChunk]:
    body = build_codex_responses_body(
        pool_spec=pool_spec,
        messages=messages,
        response_format=response_format,
        tools=tools,
        tool_choice=tool_choice,
        temperature=temperature,
        effort=effort,
        request_id=request_id,
    )
    actual_model = f"{pool_spec.gpt_auth_model}-gpt"
    current_auth = auth
    rotations = 0

    while True:
        try:
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
            await _cool_down(current_auth, reason, request_id, agent_id, call_site)
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


async def _attempt_with_token(
    *,
    body: Dict[str, Any],
    auth: GptAuthContext,
    actual_model: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
    ttft_timeout_s: float,
    idle_timeout_s: float,
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
                        await asyncio.sleep(_backoff_for_429(response, attempt))
                        continue
                    raise RoseRateLimitError(f"Codex 429: {error_body[:2000]}", status=status)

                if status in (401, 403):
                    raise RoseAuthError(f"Codex {status}: {error_body[:2000]}", status=status)

                if status == 400:
                    raise RoseInvalidRequest(f"Codex 400: {error_body[:2000]}", status=status)

                if status >= 500:
                    if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                        await asyncio.sleep(min(2 ** attempt, _BACKOFF_CAP_S))
                        continue
                    raise RoseServerError(f"Codex {status}: {error_body[:2000]}", status=status)

                raise RoseError(f"Codex {status}: {error_body[:2000]}", status=status)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
            last_error = exc
            if attempt < _MAX_ATTEMPTS_PER_TOKEN - 1:
                await asyncio.sleep(min(2 ** attempt, _BACKOFF_CAP_S))
                continue
            raise RoseServerError(f"Codex connect/read error: {exc}") from exc
        except RoseStallError:
            raise
        except RoseError:
            raise

    if last_error:
        raise RoseServerError(f"Codex: exhausted retries: {last_error}") from last_error
    raise RoseServerError("Codex: exhausted retries with no error captured")


async def _cool_down(
    auth: GptAuthContext,
    reason: str,
    request_id: str,
    agent_id: Optional[str],
    call_site: Optional[str],
) -> None:
    if auth.mark_rate_limited is None:
        return
    try:
        await auth.mark_rate_limited(auth, 5 * 60, None, reason)
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
    return min(2 ** attempt, _BACKOFF_CAP_S)
