"""Provider-shape transforms for the Rose client.

Ports the message/tool-config/response transforms that previously lived in
`research/supabase/functions/completions/service/anthropic.ts` and `vision.ts`
into Python. Behavior here must stay byte-for-byte identical with the TS
originals — every consumer of the Rose API expects the same envelopes the
edge function produced.

What's in here:
  - transform_messages_for_anthropic: OpenAI-style messages -> Anthropic
    Messages API shape (system pulled out, tool_calls -> tool_use,
    tool role -> tool_result user message, image_url -> image, file -> document).
  - apply_anthropic_tool_config: writes `tools` / `tool_choice` /
    `output_config` onto an Anthropic request body. Returns True iff
    "native tool mode" is active (caller must reconstruct the response).
  - reconstruct_agent_response: builds the agent-side
    {"reasoning","response","tool_calls"} envelope from native tool_use blocks.
  - get_messages_for_model: vision-capable models get screenshot markers
    expanded into multimodal user messages; everything else passes through.
  - transform_messages_for_openai: pass-through for OpenRouter / OpenAI
    providers — the TS code does not normalize these (generic.ts forwards
    messages verbatim), so neither do we.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any, Dict, List, Optional, Tuple

import structlog

from providers.rose.truncation import model_key

logger = structlog.get_logger()


# Mirrors VISION_CAPABLE_MODELS in research/domains/completions/config.ts.
# Kept as a literal set so the source-of-truth lives next to the transform
# that uses it (matches the TS module structure).
VISION_MODELS: frozenset[str] = frozenset({
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/gpt-5.2",
    "openai/gpt-5.5",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-6-sol",
    "openai/gpt-6.1-sol",
    "openai/gpt-6.1-terra",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.5-flash",
    "google/gemini-3.5-flash-lite",
    "google/gemini-3.6-flash",
    "google/gemini-3.7-flash",
    "google/gemini-3.8-flash",
    "qwen/qwen3.8-27b",
    "qwen-3.8-27b",
    # Vision-capable per OpenRouter (text+image+video->text). Required by the
    # rose-1-ultra / rose-1-browser-use / rose-1-flash waterfalls. A waterfall
    # model missing from this set silently strips screenshots instead of
    # erroring, so the browser agent flies blind on that layer — see the
    # invariant test in tests/blackbox/rose.blackbox.py.
    "moonshotai/kimi-k3",
    "z-ai/glm-5.3-flash",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-opus-4",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5.1",
    "x-ai/grok-4.1-fast",
    "x-ai/grok-4.1",
})


_DATA_URI_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)


# ---------------------------------------------------------------------------
# Anthropic message + content transforms
# ---------------------------------------------------------------------------


def is_anthropic_model(model: str) -> bool:
    """Mirrors isAnthropicModel — substring match on 'anthropic/' or 'claude'."""
    lowered = model.lower()
    return "anthropic/" in lowered or "claude" in lowered


def transform_content_block_for_anthropic(block: Any) -> Any:
    """Convert one OpenAI-style content block to its Anthropic equivalent.

    image_url(data:) -> image/base64, image_url(http) -> image/url,
    file(data:) -> document/base64. Any other block type passes through.
    """
    if not isinstance(block, dict):
        return block

    block_type = block.get("type")

    if block_type == "image_url":
        image_url = block.get("image_url") or {}
        url = image_url.get("url")
        if isinstance(url, str):
            if url.startswith("data:"):
                match = _DATA_URI_RE.match(url)
                if match:
                    media_type, data = match.group(1), match.group(2)
                    return {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": data,
                        },
                    }
            return {
                "type": "image",
                "source": {"type": "url", "url": url},
            }

    if block_type == "file":
        file_obj = block.get("file") or {}
        file_data = file_obj.get("file_data")
        if isinstance(file_data, str) and file_data.startswith("data:"):
            match = _DATA_URI_RE.match(file_data)
            if match:
                media_type, data = match.group(1), match.group(2)
                return {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": data,
                    },
                }

    return block


def _is_blank_text_block(block: Any) -> bool:
    if isinstance(block, str):
        return not block.strip()
    return isinstance(block, dict) and block.get("type") == "text" and not str(block.get("text") or "").strip()


def transform_messages_for_anthropic(
    messages: List[Dict[str, Any]],
) -> Tuple[Optional[str], Optional[str], List[Dict[str, Any]]]:
    """OpenAI-style messages -> (static_system, dynamic_system, anthropic_messages).

    System messages are concatenated and split at the SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    marker into static (globally cacheable) and dynamic (per-call) portions.
    If the boundary marker is absent, static_system contains the full text and
    dynamic_system is None.

    - assistant messages with tool_calls become assistant messages with
      tool_use content blocks (preserving any preceding text/content).
    - tool-role messages become user messages with a single tool_result
      block; consecutive tool_result user messages get bundled into one
      message (Anthropic expects all tool results from one turn together).
    - Any image_url / file blocks anywhere get rewritten in-place via
      transform_content_block_for_anthropic.
    - Trailing assistant messages are stripped (Anthropic disallows
      assistant prefill alongside structured output).

    Raises ValueError on malformed assistant tool_calls (missing id/name,
    invalid arguments JSON, non-object arguments) and tool messages with
    no tool_call_id — these mirror the TS Error throws so callers get the
    same fail-fast semantics.
    """
    system_parts: List[str] = []
    anthropic_messages: List[Dict[str, Any]] = []

    for idx, msg in enumerate(messages):
        role = msg.get("role")

        if role == "system":
            content = msg.get("content")
            if isinstance(content, str):
                system_parts.append(content)
            elif isinstance(content, list):
                # Multi-block system content (e.g. message_person stacks a
                # static-rules block + a per-user voice block, each with its
                # own cache_control). Concatenate the text of each block —
                # the boundary marker / global cache_control on the assembled
                # static_system block in claude_auth.py covers caching here.
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        t = b.get("text") or ""
                        if t:
                            system_parts.append(t)
                    elif isinstance(b, str):
                        system_parts.append(b)
            elif content is not None:
                system_parts.append(json.dumps(content))
            continue

        tool_calls = msg.get("tool_calls")
        if (
            role == "assistant"
            and isinstance(tool_calls, list)
            and len(tool_calls) > 0
        ):
            content_blocks: List[Dict[str, Any]] = []
            content = msg.get("content")

            if isinstance(content, list):
                content_blocks.extend(
                    transform_content_block_for_anthropic(b) for b in content if not _is_blank_text_block(b)
                )
            elif isinstance(content, str):
                if content.strip():
                    content_blocks.append({"type": "text", "text": content})
            elif content is not None:
                content_blocks.append({"type": "text", "text": json.dumps(content)})

            for tool_idx, tc in enumerate(tool_calls):
                tc = tc or {}
                tool_call_id = tc.get("id")
                function = tc.get("function") or {}
                tool_name = function.get("name")
                raw_args = function.get("arguments")

                if not isinstance(tool_call_id, str) or len(tool_call_id) == 0:
                    raise ValueError(
                        "transform_messages_for_anthropic: assistant tool_call missing id "
                        f"(message_index={idx}, tool_index={tool_idx})"
                    )
                if not isinstance(tool_name, str) or len(tool_name) == 0:
                    raise ValueError(
                        "transform_messages_for_anthropic: assistant tool_call missing function.name "
                        f"(message_index={idx}, tool_index={tool_idx})"
                    )

                if raw_args is None or raw_args == "":
                    parsed_args: Any = {}
                elif isinstance(raw_args, str):
                    try:
                        parsed_args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        preview = raw_args[:200]
                        raise ValueError(
                            "transform_messages_for_anthropic: invalid tool_call arguments JSON "
                            f"(message_index={idx}, tool_index={tool_idx}, "
                            f"tool_name={tool_name}, preview={preview})"
                        )
                elif isinstance(raw_args, dict) or isinstance(raw_args, list):
                    parsed_args = raw_args
                else:
                    raise ValueError(
                        "transform_messages_for_anthropic: unsupported tool_call arguments type "
                        f"(message_index={idx}, tool_index={tool_idx}, "
                        f"tool_name={tool_name}, type={type(raw_args).__name__})"
                    )

                if not isinstance(parsed_args, dict):
                    raise ValueError(
                        "transform_messages_for_anthropic: tool_call arguments must decode to an object "
                        f"(message_index={idx}, tool_index={tool_idx}, tool_name={tool_name})"
                    )

                content_blocks.append({
                    "type": "tool_use",
                    "id": tool_call_id,
                    "name": tool_name,
                    "input": parsed_args,
                })

            anthropic_messages.append({
                "role": "assistant",
                "content": content_blocks if len(content_blocks) > 0 else [{"type": "text", "text": ""}],
            })
            continue

        if role == "tool":
            tool_call_id = msg.get("tool_call_id")
            if not isinstance(tool_call_id, str) or len(tool_call_id) == 0:
                raise ValueError(
                    "transform_messages_for_anthropic: tool message missing tool_call_id "
                    f"(message_index={idx})"
                )

            content = msg.get("content")
            if isinstance(content, list):
                tool_result_content: Any = [
                    transform_content_block_for_anthropic(b) for b in content
                ]
            elif isinstance(content, str):
                tool_result_content = content
            elif content is None:
                tool_result_content = ""
            else:
                tool_result_content = json.dumps(content)

            anthropic_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": tool_result_content,
                }],
            })
            continue

        # Anthropic rejects empty text ("messages: text content blocks must be
        # non-empty"). Context rows such as attachment placeholders and
        # tool-call-only assistant turns can render as "", so blank text is
        # dropped and a message left with no content is omitted, as Claude Code
        # does (claude-code-src/src/utils/messages.ts:4869).
        content = msg.get("content")
        if isinstance(content, list):
            transformed = [transform_content_block_for_anthropic(b) for b in content if not _is_blank_text_block(b)]
            if not transformed:
                continue
            new_msg = dict(msg)
            new_msg["content"] = transformed
            anthropic_messages.append(new_msg)
        elif content is None or (isinstance(content, str) and not content.strip()):
            continue
        else:
            anthropic_messages.append(msg)

    bundled: List[Dict[str, Any]] = []
    for msg in anthropic_messages:
        prev = bundled[-1] if bundled else None
        prev_is_tool_result = bool(
            prev
            and prev.get("role") == "user"
            and isinstance(prev.get("content"), list)
            and len(prev["content"]) > 0
            and all(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in prev["content"]
            )
        )
        curr_content = msg.get("content")
        curr_is_tool_result = bool(
            msg.get("role") == "user"
            and isinstance(curr_content, list)
            and len(curr_content) > 0
            and all(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in curr_content
            )
        )

        if prev_is_tool_result and curr_is_tool_result and prev is not None:
            prev["content"].extend(curr_content)
        else:
            bundled.append(msg)

    while len(bundled) > 0 and bundled[-1].get("role") == "assistant":
        bundled.pop()

    merged: List[Dict[str, Any]] = []

    def _is_tool_result_message(msg: Dict[str, Any]) -> bool:
        content = msg.get("content")
        return bool(
            msg.get("role") == "user"
            and isinstance(content, list)
            and len(content) > 0
            and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
        )

    def _as_content_blocks(content: Any) -> List[Any]:
        if isinstance(content, list):
            return content
        if isinstance(content, str):
            return [{"type": "text", "text": content}]
        if content is None:
            return []
        return [{"type": "text", "text": json.dumps(content)}]

    for msg in bundled:
        prev = merged[-1] if merged else None
        if (
            prev
            and prev.get("role") == "user"
            and msg.get("role") == "user"
            and not _is_tool_result_message(prev)
            and not _is_tool_result_message(msg)
        ):
            # Merge into a copy: `prev` may be the caller's own dict, and
            # RoseClient reuses the same messages list for the waterfall
            # fallback after a claudeAuth failure.
            merged[-1] = {
                **prev,
                "content": _as_content_blocks(prev.get("content")) + _as_content_blocks(msg.get("content")),
            }
        else:
            merged.append(msg)

    system_text: Optional[str] = "\n\n".join(system_parts) if system_parts else None

    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    static_system: Optional[str] = None
    dynamic_system: Optional[str] = None
    if system_text and SYSTEM_PROMPT_DYNAMIC_BOUNDARY in system_text:
        parts = system_text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
        static_system = parts[0].strip() or None
        dynamic_system = parts[1] if parts[1].strip() else None
    else:
        static_system = system_text

    return static_system, dynamic_system, merged


# ---------------------------------------------------------------------------
# Schema sanitization + tool extraction
# ---------------------------------------------------------------------------


_UNSUPPORTED_SCHEMA_KEYS = (
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "multipleOf",
    "minItems",
    "maxItems",
)


def transform_schema_for_anthropic(schema: Any) -> Any:
    """Strip JSON-schema constraints Anthropic rejects.

    Anthropic's tool input_schema validator throws on numeric/length/array
    bounds (`minimum`, `maximum`, `minLength`, …) and on
    `additionalProperties: <schema-object>` (Dict[str, str]-style maps).
    We delete the bounds and collapse object-typed additionalProperties
    to `false` so the schema still validates but loses no semantic content
    Anthropic actually enforces.
    """
    if not isinstance(schema, dict):
        return schema

    transformed: Dict[str, Any] = dict(schema)

    for key in _UNSUPPORTED_SCHEMA_KEYS:
        transformed.pop(key, None)

    if transformed.get("type") == "object":
        ap = transformed.get("additionalProperties")
        if isinstance(ap, dict):
            transformed["additionalProperties"] = False
        elif ap is True:
            # Anthropic's structured-output validator rejects explicit
            # `additionalProperties: true` ("For 'object' type, ... is not
            # supported. Please set 'additionalProperties' to false").
            # Collapsing to False satisfies the validator; the model still
            # emits whatever fields it produces.
            transformed["additionalProperties"] = False

    if "properties" in transformed and isinstance(transformed["properties"], dict):
        new_props = {}
        for key, value in transformed["properties"].items():
            new_props[key] = transform_schema_for_anthropic(value)
        transformed["properties"] = new_props

    if "items" in transformed:
        transformed["items"] = transform_schema_for_anthropic(transformed["items"])

    if "$defs" in transformed and isinstance(transformed["$defs"], dict):
        new_defs = {}
        for key, value in transformed["$defs"].items():
            new_defs[key] = transform_schema_for_anthropic(value)
        transformed["$defs"] = new_defs

    for keyword in ("anyOf", "oneOf", "allOf"):
        if keyword in transformed and isinstance(transformed[keyword], list):
            transformed[keyword] = [
                transform_schema_for_anthropic(item) for item in transformed[keyword]
            ]

    return transformed


def _close_output_format_objects(schema: Any) -> Any:
    """Set ``additionalProperties: false`` on every object of a structured-output schema.

    Anthropic's ``output_config.format`` rejects an object without it ("For
    'object' type, 'additionalProperties' must be explicitly set to false").
    Non-strict OpenAI schemas omit it; Claude Code always sets it
    (claude-code-src/src/utils/sessionTitle.ts:98). Tool input schemas are
    unaffected.
    """
    if not isinstance(schema, dict):
        return schema
    closed = dict(schema)
    for keyword in ("properties", "$defs"):
        if isinstance(schema.get(keyword), dict):
            closed[keyword] = {key: _close_output_format_objects(value) for key, value in schema[keyword].items()}
    if "items" in schema:
        closed["items"] = _close_output_format_objects(schema["items"])
    for keyword in ("anyOf", "oneOf", "allOf"):
        if isinstance(schema.get(keyword), list):
            closed[keyword] = [_close_output_format_objects(item) for item in schema[keyword]]
    schema_type = schema.get("type")
    if schema_type == "object" or (isinstance(schema_type, list) and "object" in schema_type):
        closed["additionalProperties"] = False
    return closed


def _extract_tools_from_response_format(
    response_format: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Pull native Anthropic tools out of an OpenAI-style response_format.

    Our agent ships structured-output schemas where `tool_calls.items.anyOf`
    enumerates each tool variant (with a `tool` const discriminator). Anthropic
    chokes on grammars over ~8 anyOf branches, so we lift those variants
    into actual `tools` entries and switch to native tool mode instead.

    Returns None when the schema doesn't fit the expected shape (lets the
    caller fall back to structured output).
    """
    if not response_format:
        return None
    json_schema = response_format.get("json_schema")
    if not isinstance(json_schema, dict):
        return None
    schema = json_schema.get("schema")
    if not isinstance(schema, dict):
        return None

    properties = schema.get("properties") or {}
    tool_calls = properties.get("tool_calls") or {}
    items = tool_calls.get("items") or {}
    any_of = items.get("anyOf")
    if not isinstance(any_of, list) or len(any_of) == 0:
        return None

    for variant in any_of:
        if not isinstance(variant, dict):
            return None
        variant_props = variant.get("properties") or {}
        tool_field = variant_props.get("tool") or {}
        if "const" not in tool_field:
            return None

    tools: List[Dict[str, Any]] = []
    for variant in any_of:
        variant_props = dict(variant.get("properties") or {})
        tool_name = variant_props["tool"]["const"]
        description = variant.get("description", "") or ""

        input_properties = dict(variant_props)
        input_properties.pop("tool", None)

        required = [r for r in (variant.get("required") or []) if r != "tool"]

        input_schema: Dict[str, Any] = {
            "type": "object",
            "properties": input_properties,
            "required": required,
        }
        if "additionalProperties" in variant:
            input_schema["additionalProperties"] = variant["additionalProperties"]

        tools.append({
            "name": tool_name,
            "description": description,
            "input_schema": transform_schema_for_anthropic(input_schema),
        })

    response_field_schema = properties.get("response") or {"type": "string"}
    return {"tools": tools, "response_field_schema": response_field_schema}


def apply_anthropic_tool_config(
    body: Dict[str, Any],
    response_format: Optional[Dict[str, Any]],
    use_native_tools: bool,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[Any] = None,
) -> bool:
    """Configure an Anthropic request body for tools / structured output.

    Mutates `body` in place. Priority:
      1. Explicit `tools` with `use_native_tools=True` (claudeAuth path) —
         tools are already in Anthropic-native shape; install directly,
         default tool_choice to "auto", return True (native tool mode).
      2. Explicit `tools` without native mode (waterfall path) — convert
         from OpenAI function-shape to Anthropic, return False.
      3. `response_format.json_schema` — install as structured output via
         `output_config` (claudeAuth) or `output_format` (legacy).

    Returns True iff native tool mode is now active (caller must use
    reconstruct_agent_response on the response).
    """
    if tools:
        if use_native_tools:
            body["tools"] = []
            for t in tools:
                function = t.get("function") if isinstance(t.get("function"), dict) else t
                tool_body = {
                    "name": function.get("name"),
                    "description": function.get("description"),
                    "input_schema": function.get("input_schema") or function.get("parameters"),
                }
                if "strict" in function:
                    tool_body["strict"] = function.get("strict")
                body["tools"].append(tool_body)
            if tool_choice is not None:
                if tool_choice == "auto":
                    body["tool_choice"] = {"type": "auto"}
                elif tool_choice in ("required", "any"):
                    body["tool_choice"] = {"type": "any"}
                elif isinstance(tool_choice, dict) and tool_choice.get("name"):
                    body["tool_choice"] = {
                        "type": "tool",
                        "name": tool_choice["name"],
                    }
                elif (
                    isinstance(tool_choice, dict)
                    and isinstance(tool_choice.get("function"), dict)
                    and tool_choice["function"].get("name")
                ):
                    body["tool_choice"] = {
                        "type": "tool",
                        "name": tool_choice["function"]["name"],
                    }
                else:
                    body["tool_choice"] = {"type": "any"}
            else:
                body["tool_choice"] = {"type": "auto"}
            # Anthropic disables parallel tool use by default when tool_choice
            # is `any` or `tool`. Keep parallel on so DAG-style fan-outs (multi
            # web_search, multi web_fetch) still work — single-tool unions get
            # at most one block anyway.
            tc = body["tool_choice"]
            if tc.get("type") in ("any", "tool"):
                tc["disable_parallel_tool_use"] = False
            body.pop("output_config", None)
            body.pop("output_format", None)
            return True

        body["tools"] = [
            {
                "name": (t.get("function") or {}).get("name") or t.get("name"),
                "description": (t.get("function") or {}).get("description")
                or t.get("description"),
                "input_schema": (t.get("function") or {}).get("parameters")
                or t.get("input_schema"),
            }
            for t in tools
        ]
        if tool_choice is not None:
            if tool_choice == "auto":
                body["tool_choice"] = {"type": "auto"}
            elif tool_choice in ("required", "any"):
                body["tool_choice"] = {"type": "any"}
            elif (
                isinstance(tool_choice, dict)
                and isinstance(tool_choice.get("function"), dict)
                and tool_choice["function"].get("name")
            ):
                body["tool_choice"] = {
                    "type": "tool",
                    "name": tool_choice["function"]["name"],
                }
        return False

    if response_format and isinstance(response_format.get("json_schema"), dict):
        schema = response_format["json_schema"].get("schema")
        if isinstance(schema, dict):
            if use_native_tools:
                extracted = _extract_tools_from_response_format(response_format)
                if extracted is not None:
                    body["tools"] = extracted["tools"]
                    body["tool_choice"] = {
                        "type": "any",
                        "disable_parallel_tool_use": False,
                    }
                    prev_effort = (body.get("output_config") or {}).get("effort")
                    body.pop("output_config", None)
                    body.pop("output_format", None)
                    if prev_effort:
                        body["output_config"] = {"effort": prev_effort}
                    return True


            transformed_schema = _close_output_format_objects(transform_schema_for_anthropic(schema))
            if use_native_tools:
                body["output_config"] = {
                    "format": {"type": "json_schema", "schema": transformed_schema},
                }
            else:
                body["output_format"] = {
                    "type": "json_schema",
                    "schema": transformed_schema,
                }

    return False


# ---------------------------------------------------------------------------
# Response reconstruction
# ---------------------------------------------------------------------------


def reconstruct_agent_response(
    text_content: str,
    tool_use_blocks: List[Dict[str, Any]],
) -> str:
    """Build the {"reasoning","response","tool_calls"} JSON envelope the
    agent's parser expects from Anthropic's native text + tool_use blocks.

    Each tool_use block contributes one tool_call shaped as
    `{"tool": <name>, **<input>}` — the same shape `reconstructNativeToolJson`
    in claude-token.ts produces, which the agent's response parser was
    written against.
    """
    tool_calls = []
    for block in tool_use_blocks:
        name = block.get("name")
        input_obj = block.get("input") or {}
        if not isinstance(input_obj, dict):
            input_obj = {}
        call: Dict[str, Any] = {"tool": name}
        call.update(input_obj)
        tool_calls.append(call)

    return json.dumps({
        "reasoning": "",
        "response": text_content,
        "tool_calls": tool_calls,
    })


# ---------------------------------------------------------------------------
# Vision / OpenAI message handling
# ---------------------------------------------------------------------------


def is_vision_capable(model: str) -> bool:
    """True iff the model is in VISION_MODELS (mirrors isVisionCapable)."""
    return model in VISION_MODELS


_VISION_MODEL_KEYS: frozenset[str] = frozenset(model_key(model) for model in VISION_MODELS)
_IMAGE_BLOCK_TYPES = frozenset({"image_url", "image", "input_image"})


def route_model_accepts_images(model: str) -> bool:
    """True when a route's model can see images.

    Direct routes name bare provider ids (``gpt-6-sol``, ``claude-opus-5-5``);
    ``model_key`` maps each onto its ``VISION_MODELS`` entry.
    """
    return model_key(model) in _VISION_MODEL_KEYS


def messages_contain_images(messages: List[Dict[str, Any]]) -> bool:
    """True iff any message carries an image content block."""
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list) and any(
            isinstance(block, dict) and block.get("type") in _IMAGE_BLOCK_TYPES for block in content
        ):
            return True
    return False


def has_screenshot_markers(messages: List[Dict[str, Any]]) -> bool:
    """True iff any tool-role message carries a `__screenshot_base64__` payload."""
    for msg in messages:
        if msg.get("role") == "tool":
            content = msg.get("content")
            if isinstance(content, str) and "__screenshot_base64__" in content:
                return True
    return False


def transform_messages_for_vision(
    messages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Expand `__screenshot_base64__` markers into trailing user image_url messages.

    OpenAI/OpenRouter reject image_url blocks attached to a tool-role message,
    so we keep the cleaned tool message (with the base64 stripped and a
    `screenshot_attached: true` flag) and append a synthetic user message
    that carries the image. Mirrors transformMessagesForVision in vision.ts.
    """
    transformed: List[Dict[str, Any]] = []

    for msg in messages:
        content = msg.get("content")
        is_tool_message = (
            msg.get("role") == "tool"
            and isinstance(content, str)
            and "__screenshot_base64__" in content
        )

        if not is_tool_message:
            transformed.append(msg)
            continue

        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            transformed.append(msg)
            continue

        if not isinstance(parsed, dict):
            transformed.append(msg)
            continue

        base64_data = parsed.get("__screenshot_base64__")
        if not base64_data:
            transformed.append(msg)
            continue

        tool_content = dict(parsed)
        tool_content.pop("__screenshot_base64__", None)
        tool_content["screenshot_attached"] = True

        cleaned_msg = dict(msg)
        cleaned_msg["content"] = json.dumps(tool_content)
        transformed.append(cleaned_msg)
        transformed.append({
            "role": "user",
            "content": [
                {"type": "text", "text": "[Screenshot from browser]"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{base64_data}"},
                },
            ],
        })

    return transformed


def get_messages_for_model(
    messages: List[Dict[str, Any]],
    model: str,
) -> List[Dict[str, Any]]:
    """Return the right messages array for the target model.

    Mirrors getMessagesForModel in vision.ts: vision-capable models with
    embedded screenshot markers get the markers expanded into multimodal
    user messages; everything else passes through untouched. Note that the
    TS function does NOT strip image content for non-vision models — it
    leaves the marker in place. That behavior is preserved here.
    """
    if is_vision_capable(model) and has_screenshot_markers(messages):
        return transform_messages_for_vision(messages)
    return messages


def _add_openrouter_cache_breakpoint(msg: Dict[str, Any]) -> None:
    """Add cache_control to a message's last content block (mutates in place).

    Works for OpenRouter's Gemini/Anthropic paths. Converts string content to
    the content-array format required for per-block cache_control.
    """
    content = msg.get("content")
    if isinstance(content, str):
        from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

        if SYSTEM_PROMPT_DYNAMIC_BOUNDARY in content:
            parts = content.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
            cache_all_parts = len(parts) > 2 or content.endswith(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
            blocks = []
            for idx, part in enumerate(parts):
                text = part.strip()
                if not text:
                    continue
                block: Dict[str, Any] = {"type": "text", "text": text}
                if cache_all_parts or idx == 0:
                    block["cache_control"] = {"type": "ephemeral"}
                blocks.append(block)
            msg["content"] = blocks
            return

        msg["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]
    elif isinstance(content, list) and content:
        target = content[-1]
        if isinstance(target, dict):
            target["cache_control"] = {"type": "ephemeral"}


def _has_openrouter_cache_breakpoint(value: Any) -> bool:
    """Return whether caller-owned content already selects a cache prefix."""
    if isinstance(value, dict):
        if "cache_control" in value:
            return True
        return any(_has_openrouter_cache_breakpoint(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_openrouter_cache_breakpoint(item) for item in value)
    return False


def _mark_first_large_completed_tool_prefix(
    messages: List[Dict[str, Any]],
    *,
    minimum_prefix_chars: int,
) -> bool:
    """Mark one deterministic completed-tool boundary above a cache floor.

    Gemini through OpenRouter honors only the final explicit breakpoint. A
    moving tail would therefore create a different cache prefix on every turn.
    Choosing the earliest complete assistant/tool batch above the conservative
    size floor keeps the selected prefix fixed as an append-only conversation
    grows, while never splitting a tool declaration from its results.
    """
    for index, message in enumerate(messages):
        if message.get("role") != "tool":
            continue
        if index + 1 < len(messages) and messages[index + 1].get("role") == "tool":
            continue

        batch_start = index
        while batch_start > 0 and messages[batch_start - 1].get("role") == "tool":
            batch_start -= 1
        declaration_index = batch_start - 1
        if declaration_index < 0:
            continue
        declaration = messages[declaration_index]
        if declaration.get("role") != "assistant" or not declaration.get("tool_calls"):
            continue

        prefix_chars = len(
            json.dumps(
                messages[: index + 1],
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            )
        )
        if prefix_chars < minimum_prefix_chars:
            continue

        _add_openrouter_cache_breakpoint(message)
        return True
    return False


def _strip_system_prompt_boundary(msg: Dict[str, Any]) -> None:
    """Remove cache-boundary sentinel text from non-cache system messages."""
    content = msg.get("content")
    if not isinstance(content, str):
        return
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in content:
        return
    blocks = []
    for part in content.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY):
        text = part.strip()
        if text:
            blocks.append({"type": "text", "text": text})
    msg["content"] = blocks


def _message_content_to_text(content: Any) -> str:
    """Best-effort flatten of a message `content` value into plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
                else:
                    # Structured tool results and provider-specific blocks are
                    # still conversation history. Preserve their JSON instead
                    # of silently turning the containing message into empty
                    # text when no tools are declared on a waterfall retry.
                    parts.append(json.dumps(block, ensure_ascii=False, sort_keys=True, default=str))
            elif isinstance(block, str) and block:
                parts.append(block)
            elif not isinstance(block, str):
                parts.append(json.dumps(block, ensure_ascii=False, sort_keys=True, default=str))
        return "\n".join(parts)
    return json.dumps(content, ensure_ascii=False, sort_keys=True, default=str)


def flatten_tool_history_to_text(
    messages: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Rewrite tool-call history into plain text for a request that declares no tools.

    Google rejects a request whose contents carry functionCall /
    functionResponse parts while `functionDeclarations` is absent, with a
    deterministic 400 INVALID_ARGUMENT. That combination is reachable on the
    waterfall: client.py sends `response_format=None if tools else
    response_format`, so a structured-output call drops `tools` while the
    conversation still carries assistant `tool_calls` and `role:"tool"` replies
    from earlier turns.

    Observed in a benchmark run (agent 64fe48c1, browser-smoke): the identical
    execute_loop request succeeded on Gemini while the history was 5
    system/user messages, then failed 10/10 once it reached 8 messages
    including assistant(tool_calls) + tool.

    Dropping the history outright would lose tool results the model still needs,
    so preserve them as readable text instead:
      - assistant.tool_calls -> "[Called <name>(<args>)]" folded into content,
        with the `tool_calls` key removed.
      - role:"tool"          -> a user message "[Result of <name>] <content>".
    Messages with no tool history pass through unchanged.
    """
    out: List[Dict[str, Any]] = []
    # tool_call_id -> function name, so a result can name the call it answers.
    call_names: Dict[str, str] = {}

    for msg in messages:
        role = msg.get("role")
        tool_calls = msg.get("tool_calls")

        if role == "assistant" and isinstance(tool_calls, list) and tool_calls:
            rewritten = dict(msg)
            rewritten.pop("tool_calls", None)
            summaries: List[str] = []
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                fn = call.get("function") if isinstance(call.get("function"), dict) else call
                name = str(fn.get("name") or "tool")
                call_id = call.get("id")
                if isinstance(call_id, str) and call_id:
                    call_names[call_id] = name
                args = fn.get("arguments")
                if not isinstance(args, str):
                    # `default=str` keeps a non-JSON-native argument value from
                    # raising TypeError here. This runs while flattening history
                    # for a provider that declared no tools, so a single exotic
                    # value must not abort the whole request.
                    args = json.dumps(args, default=str) if args is not None else ""
                summaries.append(f"[Called {name}({args})]")
            existing_text = _message_content_to_text(rewritten.get("content"))
            joined = "\n".join(summaries)
            rewritten["content"] = f"{existing_text}\n{joined}".strip() if existing_text else joined
            out.append(rewritten)
            continue

        if role == "tool":
            name = call_names.get(str(msg.get("tool_call_id") or ""), "tool")
            text = _message_content_to_text(msg.get("content"))
            # Re-role to `user`: a bare `tool` role is equally invalid without
            # declared tools, and the result is input the model must still see.
            out.append({"role": "user", "content": f"[Result of {name}] {text}".strip()})
            continue

        out.append(dict(msg))

    return out


def transform_messages_for_openai(
    messages: List[Dict[str, Any]],
    *,
    tools_declared: bool = True,
    cache_opening_user: bool = False,
    inject_cache_breakpoints: bool = True,
    cache_completed_tool_prefix: bool = False,
) -> List[Dict[str, Any]]:
    """Transform for OpenAI-compatible providers (OpenRouter, Gemini-via-OR,
    Kimi-via-OR, Anthropic-via-OR).

    When `tools_declared` is False, tool-call history is flattened to text
    first — see `flatten_tool_history_to_text` for the Gemini 400 it avoids.
    Defaults to True so existing callers keep today's behavior.

    cache_control placement contract (explicit-cache waterfall models):

    - We mark the trailing block of the FIRST system message as a cache
      breakpoint (idempotent — preserves any caller-supplied breakpoints).
      When the caller supplies a logical provider-cache sequence,
      ``cache_opening_user`` also marks the FIRST user message. That opening
      turn is stable for an append-only agent conversation and extends short
      system prompts past provider minimums.
    - We do NOT mark the last user message. Explicit-cache providers such as
      Anthropic accept multiple breakpoints and pick the longest matching
      prefix, so the stable opening turn is reusable while the conversation
      tail remains dynamic.

    Callers that want additional breakpoints (e.g. message_person stacks a
    static-rules block + a per-user voice block in one system message)
    should set cache_control explicitly on the relevant content blocks
    before calling — those markers are preserved here.

    ``cache_completed_tool_prefix=True`` is the Gemini/OpenRouter policy: when
    the caller did not provide a marker, select the earliest complete tool turn
    whose serialized prefix is confidently beyond Gemini 3's 4,096-token
    minimum. The deterministic boundary remains fixed on later append-only
    calls. If the conversation is still short, fall back to the stable opening
    markers used by other explicit-cache providers.

    ``inject_cache_breakpoints=False`` leaves caller-supplied markers intact
    but does not synthesize new ones (for one-shot calls).
    """
    source = messages if tools_declared else flatten_tool_history_to_text(messages)
    out: List[Dict[str, Any]] = []
    caller_supplied_breakpoint = _has_openrouter_cache_breakpoint(source)
    synthesize_cache_breakpoints = inject_cache_breakpoints and not caller_supplied_breakpoint
    declared_tool_names: Dict[str, str] = {}
    for message in source:
        # Cache markers mutate nested content blocks, so isolate the outbound
        # transform from the caller's append-only history.
        rewritten = copy.deepcopy(message)
        if rewritten.get("role") == "assistant":
            # Codex Responses items are history for the Responses transport
            # (gpt_auth) only; Cerebras 400s on them as unsupported properties.
            rewritten.pop("codex_reasoning_items", None)
            rewritten.pop("codex_message_items", None)
            tool_calls = rewritten.get("tool_calls")
            if isinstance(tool_calls, list):
                for call in tool_calls:
                    if not isinstance(call, dict):
                        continue
                    call_id = call.get("id")
                    fn = call.get("function")
                    if not isinstance(call_id, str) or not call_id or not isinstance(fn, dict):
                        continue
                    name = fn.get("name")
                    if isinstance(name, str) and name:
                        declared_tool_names[call_id] = name
        elif rewritten.get("role") == "tool":
            call_id = rewritten.get("tool_call_id")
            declared_name = declared_tool_names.get(str(call_id or ""))
            if declared_name:
                # OpenAI-compatible providers pair tool results by ID, but some
                # (notably Gemini via OpenRouter) also validate the optional
                # result name against the assistant declaration. Internal task
                # metadata can describe the concrete executor instead, so make
                # the outbound name follow the declared call.
                rewritten["name"] = declared_name
        out.append(rewritten)
    if not out:
        return out

    if (
        synthesize_cache_breakpoints
        and cache_completed_tool_prefix
        and _mark_first_large_completed_tool_prefix(out, minimum_prefix_chars=20_000)
    ):
        for message in out:
            if message.get("role") == "assistant":
                _normalize_openai_tool_calls(message)
            elif message.get("role") == "system":
                _strip_system_prompt_boundary(message)
        return out

    first_system_seen = False
    first_user_seen = False
    for m in out:
        if m.get("role") == "system":
            if synthesize_cache_breakpoints and not first_system_seen:
                _add_openrouter_cache_breakpoint(m)
            else:
                _strip_system_prompt_boundary(m)
            first_system_seen = True
        elif (
            synthesize_cache_breakpoints
            and cache_opening_user
            and m.get("role") == "user"
            and not first_user_seen
        ):
            _add_openrouter_cache_breakpoint(m)
            first_user_seen = True
        elif m.get("role") == "assistant":
            _normalize_openai_tool_calls(m)

    return out


def _normalize_openai_tool_calls(message: Dict[str, Any]) -> None:
    """Stamp OpenAI's ``type: "function"`` discriminator on assistant tool_calls.

    Google (via OpenRouter) rejects an assistant turn whose tool_calls lack it
    with 400 "Tool-call assistant message produced no valid function calls but
    is followed by tool result messages. The conversation transcript is
    malformed.", which silently demotes the pool to its weakest leg. Producers
    currently hand-write the field; normalizing here makes the invariant
    enforced instead of conventional. Mirrors normalizeOpenAiToolCalls in
    back-end/src/providers/rose/transforms.ts.
    """
    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return

    normalized: List[Dict[str, Any]] = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            normalized.append(tc)
            continue
        function = tc.get("function") if isinstance(tc.get("function"), dict) else {}
        name = function.get("name") or tc.get("name")
        if not isinstance(name, str) or not name:
            normalized.append(tc)
            continue
        arguments = function.get("arguments", tc.get("arguments"))
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments if arguments is not None else {})
        # The Responses dialect names this `call_id`; OpenAI's chat dialect
        # requires `id` to match a tool result back to its call.
        call_id = tc.get("id") or tc.get("call_id")
        normalized.append(
            {
                **tc,
                **({} if call_id is None else {"id": call_id}),
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }
        )
    message["tool_calls"] = normalized
