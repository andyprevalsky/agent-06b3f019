"""Schema adapters for Rose provider requests.

Pydantic models are the semantic boundary. Provider-specific JSON Schema
shapes are adapter outputs:

- OpenRouter/OpenAI receives strict `response_format`.
- claudeAuth receives `output_config.format` for plain structured outputs,
  or Anthropic native `tools[].input_schema` for real tool-call models.
"""

from __future__ import annotations

import copy
import inspect
import json
from types import UnionType
from typing import Any, Dict, List, Optional, Type, Union, get_args, get_origin

from pydantic import BaseModel

SYNTHETIC_OUTPUT_TOOL_NAME = "submit_response"
_FORCE_TOOL_CHOICE_KEY = "__rose_force_tool_choice"

_UNSUPPORTED_STRICT_SCHEMA_KEYS = (
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "multipleOf",
    "minItems",
    "maxItems",
)


def prepare_schema_for_openai(pydantic_model: Type[BaseModel]) -> Dict[str, Any]:  # noqa: C901
    """Convert a Pydantic model to OpenAI strict structured-output schema."""
    schema = pydantic_model.model_json_schema()
    schema = _inline_refs(schema)

    if "$defs" in schema:
        del schema["$defs"]

    _add_openai_strict_properties(schema)
    return schema


def build_openai_response_format(response_model: Type[BaseModel]) -> Dict[str, Any]:
    """Build the OpenAI/OpenRouter response_format envelope for a Pydantic model."""
    strict = bool(getattr(response_model, "rose_openai_strict", True))
    if strict:
        schema = prepare_schema_for_openai(response_model)
    else:
        schema = _inline_refs(response_model.model_json_schema())
        schema.pop("$defs", None)
    return {
        "type": "json_schema",
        "json_schema": {
            "name": response_model.__name__,
            "schema": schema,
            "strict": strict,
        },
    }


_STRICT_TOOL_ATTR = "anthropic_strict_tool"


def model_supports_anthropic_strict_tools(model: Optional[str]) -> bool:
    if not model:
        return False
    canonical = model.lower().replace(".", "-")
    return (
        "claude-sonnet-4-6" in canonical
        or "claude-sonnet-5" in canonical
        or "claude-sonnet-4-5" in canonical
        or "claude-fable-5" in canonical
        or "claude-opus-4-1" in canonical
        or "claude-opus-4-5" in canonical
        or "claude-opus-4-6" in canonical
        or "claude-opus-4-7" in canonical
        or "claude-opus-4-8" in canonical
        or "claude-haiku-4-5" in canonical
    )


def build_anthropic_tools_from_response_model(
    response_model: Optional[Type[BaseModel]],
    *,
    model: Optional[str] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Extract Anthropic native tools from an AgentAction-style model.

    The supported shape is:

        class AgentAction(BaseModel):
            response: str
            tool_calls: list[Union[ToolA, ToolB, ...]]

    Each union member must be a Pydantic tool model with a literal `tool`
    discriminator. The discriminator selects the Anthropic tool name and is
    removed from the tool input schema because Anthropic already carries the
    name on the `tool_use` block.

    Matches Claude Code's pattern: native tools are always used; API
    `strict: true` is only attached when the individual tool opts in and the
    target model supports structured outputs.
    """
    if response_model is None:
        return None

    fields = getattr(response_model, "model_fields", {})
    tool_calls = fields.get("tool_calls")
    if tool_calls is None:
        return [_synthetic_output_tool(response_model)]

    tool_models = _tool_models_from_annotation(tool_calls.annotation)
    if not tool_models:
        return None

    tools: List[Dict[str, Any]] = []
    for tool_model in tool_models:
        tool_name = _literal_tool_name(tool_model)
        if not tool_name:
            return None

        strict = bool(getattr(tool_model, _STRICT_TOOL_ATTR, False)) and (
            model_supports_anthropic_strict_tools(model)
        )
        schema = _anthropic_input_schema_for_tool_model(tool_model, strict=strict)
        tool: Dict[str, Any] = {
            "name": tool_name,
            # Send the FULL Pydantic docstring as the tool description. We
            # used to truncate to the first non-empty line, which silently
            # dropped multi-line tool docs (usage hints, examples,
            # when-to-use guidance) before they reached the model. The
            # Anthropic API has no length limit on tool descriptions.
            # `inspect.cleandoc` handles Python's standard docstring shape
            # (first line flush against `"""`, body indented) correctly,
            # unlike textwrap.dedent which would leave the body indented.
            "description": inspect.cleandoc(tool_model.__doc__ or ""),
            "input_schema": schema,
        }
        if strict:
            tool["strict"] = True
        tools.append(tool)

    return tools


def tool_requires_forced_choice(tool: Dict[str, Any]) -> bool:
    return bool(tool.get(_FORCE_TOOL_CHOICE_KEY))


def build_anthropic_strict_tools_from_response_model(
    response_model: Optional[Type[BaseModel]],
    *,
    model: Optional[str] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Backward-compatible alias for older tests/callers.

    Strict remains opt-in per tool; this function name is historical.
    """
    return build_anthropic_tools_from_response_model(response_model, model=model)


def _anthropic_input_schema_for_tool_model(
    tool_model: Type[BaseModel],
    *,
    strict: bool,
) -> Dict[str, Any]:
    schema = _inline_refs(tool_model.model_json_schema())

    properties = dict(schema.get("properties") or {})
    properties.pop("tool", None)

    required = [r for r in (schema.get("required") or []) if r != "tool"]

    input_schema: Dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }
    if strict:
        return _prepare_schema_for_anthropic_strict(input_schema)
    return input_schema


def _synthetic_output_tool(response_model: Type[BaseModel]) -> Dict[str, Any]:
    schema = _inline_refs(response_model.model_json_schema())
    schema.pop("$defs", None)
    if schema.get("type") != "object":
        schema = {
            "type": "object",
            "properties": {"value": schema},
            "required": ["value"],
            "additionalProperties": False,
        }
    elif "additionalProperties" not in schema:
        schema["additionalProperties"] = False

    return {
        "name": SYNTHETIC_OUTPUT_TOOL_NAME,
        "description": f"Submit the final {response_model.__name__} response.",
        "input_schema": schema,
        _FORCE_TOOL_CHOICE_KEY: True,
    }


def _prepare_schema_for_anthropic_strict(schema: Any) -> Any:
    """Transform JSON Schema into Anthropic strict-tool compatible shape.

    Strict tool use shares the structured-output grammar pipeline. The API
    validates the simplified schema; Pydantic validates the original model
    after the tool call, preserving runtime guarantees for constraints the
    grammar does not support.
    """
    if isinstance(schema, list):
        return [_prepare_schema_for_anthropic_strict(item) for item in schema]
    if not isinstance(schema, dict):
        return schema

    transformed: Dict[str, Any] = {}
    constraint_notes: List[str] = []

    for key, value in schema.items():
        if key in _UNSUPPORTED_STRICT_SCHEMA_KEYS:
            constraint_notes.append(_constraint_note(key, value))
            continue
        if key == "$defs":
            continue
        if key == "additionalProperties" and value is not False:
            # Strict tool schemas require closed objects. For map-like fields,
            # keep the field description as guidance and rely on Pydantic to
            # validate any runtime values.
            transformed[key] = False
            continue
        transformed[key] = _prepare_schema_for_anthropic_strict(value)

    if transformed.get("type") == "object":
        transformed["additionalProperties"] = False

    if constraint_notes:
        existing_description = transformed.get("description")
        note = " ".join(n for n in constraint_notes if n)
        if note:
            transformed["description"] = (
                f"{existing_description} {note}".strip()
                if existing_description
                else note
            )

    return transformed


def _constraint_note(key: str, value: Any) -> str:
    if key == "minimum":
        return f"Must be >= {value}."
    if key == "maximum":
        return f"Must be <= {value}."
    if key == "exclusiveMinimum":
        return f"Must be > {value}."
    if key == "exclusiveMaximum":
        return f"Must be < {value}."
    if key == "multipleOf":
        return f"Must be a multiple of {value}."
    if key == "minLength":
        return f"Must have length >= {value}."
    if key == "maxLength":
        return f"Must have length <= {value}."
    if key == "minItems":
        return f"Must contain at least {value} item(s)."
    if key == "maxItems":
        return f"Must contain at most {value} item(s)."
    return ""


def _tool_models_from_annotation(annotation: Any) -> List[Type[BaseModel]]:
    origin = get_origin(annotation)
    args = get_args(annotation)

    if origin is list or origin is List:
        if not args:
            return []
        return _tool_models_from_annotation(args[0])

    if origin is Union or origin is UnionType:
        models: List[Type[BaseModel]] = []
        for arg in args:
            if isinstance(arg, type) and issubclass(arg, BaseModel):
                models.append(arg)
        return models

    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return [annotation]

    return []


def _literal_tool_name(tool_model: Type[BaseModel]) -> Optional[str]:
    field = getattr(tool_model, "model_fields", {}).get("tool")
    if field is None:
        return None
    args = get_args(field.annotation)
    if len(args) == 1 and isinstance(args[0], str):
        return args[0]
    return None


def _inline_refs(schema: Dict[str, Any]) -> Dict[str, Any]:
    defs = schema.get("$defs", {})

    def resolve_ref(ref: str) -> Dict[str, Any]:
        if ref.startswith("#/$defs/"):
            def_name = ref[8:]
            if def_name in defs:
                return copy.deepcopy(defs[def_name])
        raise ValueError(f"Cannot resolve reference: {ref}")

    def walk(obj: Any) -> Any:
        if not isinstance(obj, dict):
            if isinstance(obj, list):
                return [walk(item) for item in obj]
            return obj

        if "$ref" in obj:
            resolved = walk(resolve_ref(obj["$ref"]))
            for key, value in obj.items():
                if key != "$ref":
                    resolved[key] = walk(value)
            return resolved

        return {key: walk(value) for key, value in obj.items()}

    return walk(copy.deepcopy(schema))


def _add_openai_strict_properties(obj: Dict[str, Any]) -> None:
    if not isinstance(obj, dict):
        return

    if obj.get("type") == "object":
        existing_additional = obj.get("additionalProperties")

        if isinstance(existing_additional, dict):
            _add_openai_strict_properties(existing_additional)
        else:
            obj["additionalProperties"] = False

        if "properties" in obj:
            obj["required"] = list(obj["properties"].keys())
            for prop in obj["properties"].values():
                _add_openai_strict_properties(prop)

    for key in ["anyOf", "oneOf", "allOf"]:
        if key in obj:
            for item in obj[key]:
                _add_openai_strict_properties(item)

    if obj.get("type") == "array" and "items" in obj:
        _add_openai_strict_properties(obj["items"])

    if "$defs" in obj:
        for definition in obj["$defs"].values():
            _add_openai_strict_properties(definition)


def _first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def schema_fingerprint(obj: Any) -> str:
    """Stable helper useful in diagnostics and tests."""
    return json.dumps(obj, sort_keys=True, default=str)
