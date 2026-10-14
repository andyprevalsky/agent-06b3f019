"""Conservative native-tool projection for Cerebras constrained decoding.

The caller's Pydantic model remains authoritative. Unsupported value bounds
are omitted only from this provider grammar; open JSON shapes are never closed.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

# Supported by Cerebras, excluding model-dependent string-length features.
_SCHEMA_KEYS = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "const",
    "description",
    "title",
    "default",
    "$schema",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
}
_LOCAL_CONSTRAINTS = {"pattern", "format", "minLength", "maxLength", "minItems", "maxItems"}
_PRIMITIVES = {"string", "number", "integer", "boolean", "null"}


class _SchemaProjection:
    def __init__(self) -> None:
        self.counted_text = 0
        self.properties_count = 0
        self.enum_count = 0

    def object_properties(self, node: dict, depth: int) -> dict:
        if node.get("additionalProperties") is not False:
            raise ValueError("free-form object")
        props = node.get("properties")
        if not isinstance(props, dict):
            raise ValueError("object lacks properties")
        required = node.get("required", [])
        if not isinstance(required, list) or any(not isinstance(key, str) or key not in props for key in required):
            raise ValueError("invalid required properties")
        self.properties_count += len(props)
        self.counted_text += sum(len(key) for key in props)
        # Cerebras supports omitted optional properties. Preserve required
        # and nullable fields rather than introducing null into non-null types.
        return {
            "properties": {key: self.walk(value, depth + 1) for key, value in props.items()},
            "required": list(required),
        }

    def count_values(self, node: dict) -> None:
        if "enum" in node:
            values = node["enum"]
            if not isinstance(values, list) or not values or any(isinstance(v, (dict, list)) for v in values):
                raise ValueError("unsupported enum")
            self.enum_count += len(values)
            text_size = sum(len(value) for value in values if isinstance(value, str))
            self.counted_text += text_size
            if len(values) > 250 and text_size > 7500:
                raise ValueError("enum text exceeds provider limit")
        if "const" in node:
            if isinstance(node["const"], (dict, list)):
                raise ValueError("unsupported constant")
            if isinstance(node["const"], str):
                self.counted_text += len(node["const"])

    def walk(self, node: Any, depth: int) -> dict:
        if not isinstance(node, dict) or not node:
            raise ValueError("untyped or boolean schema")
        if depth > 10:
            raise ValueError("schema nesting exceeds provider limit")
        unknown = node.keys() - _SCHEMA_KEYS - _LOCAL_CONSTRAINTS
        if unknown:
            raise ValueError("unsupported schema keyword: " + sorted(unknown)[0])
        result = {key: deepcopy(value) for key, value in node.items() if key not in _LOCAL_CONSTRAINTS}
        kind = node.get("type")
        if kind == "object":
            result.update(self.object_properties(node, depth))
        elif kind == "array":
            result["items"] = self.walk(node.get("items"), depth + 1)
        elif kind is not None and (not isinstance(kind, str) or kind not in _PRIMITIVES):
            raise ValueError("unsupported JSON type")
        elif kind is None and "anyOf" not in node:
            raise ValueError("untyped schema")
        if "anyOf" in node:
            branches = node["anyOf"]
            if not isinstance(branches, list) or not branches:
                raise ValueError("invalid union")
            result["anyOf"] = [self.walk(branch, depth + 1) for branch in branches]
        self.count_values(node)
        return result


def project_cerebras_tool_schema(schema: Any) -> tuple[dict | None, str | None]:
    """Return a supported grammar or a reason to retain ordinary tool calling."""
    try:
        if not isinstance(schema, dict) or schema.get("type") != "object" or "anyOf" in schema:
            raise ValueError("tool root must be an object")
        projection = _SchemaProjection()
        projected = projection.walk(schema, 1)
        if projection.counted_text > 5000 or projection.properties_count > 500 or projection.enum_count > 500:
            raise ValueError("schema exceeds provider size limits")
        return projected, None
    except ValueError as exc:
        return None, str(exc)
