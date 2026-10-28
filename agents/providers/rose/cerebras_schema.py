"""Conservative native-tool projection for Cerebras constrained decoding.

The caller's Pydantic model remains authoritative. Unsupported value bounds
are omitted only from this provider grammar; open JSON shapes are never closed.
"""

from __future__ import annotations

import math
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


def _validate_numeric_bounds(node: dict) -> None:
    lower = []
    upper = []
    for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"):
        if key not in node:
            continue
        value = node[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("invalid numeric constraint: " + key)
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("nonfinite numeric constraint: " + key)
        if key == "multipleOf":
            if value <= 0:
                raise ValueError("multipleOf must be positive")
        elif key in {"minimum", "exclusiveMinimum"}:
            lower.append((value, key == "exclusiveMinimum"))
        else:
            upper.append((value, key == "exclusiveMaximum"))
    if any(lo > hi or (lo == hi and (lo_open or hi_open)) for lo, lo_open in lower for hi, hi_open in upper):
        raise ValueError("impossible numeric bounds")


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
        if any(not isinstance(key, str) for key in props):
            raise ValueError("non-string property name")
        required = node.get("required", [])
        if not isinstance(required, list) or any(not isinstance(key, str) or key not in props for key in required):
            raise ValueError("invalid required properties")
        if len(required) != len(set(required)):
            raise ValueError("duplicate required properties")
        self.properties_count += len(props)
        self.counted_text += sum(len(key) for key in props)
        # Cerebras supports omitted optional properties. Preserve required
        # fields and never introduce null into non-null types; omittable
        # Optional[X] = None fields arrive here already collapsed to X.
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
        if any(not isinstance(key, str) for key in node):
            raise ValueError("non-string schema keyword")
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
        _validate_numeric_bounds(node)
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


_NULL_BRANCH = {"type": "null"}


def _collapse_node(node: Any) -> Any:
    if isinstance(node, list):
        return [_collapse_node(item) for item in node]
    if not isinstance(node, dict):
        return node
    result = {key: _collapse_node(value) for key, value in node.items()}
    props = result.get("properties")
    if isinstance(props, dict):
        required = node.get("required") if isinstance(node.get("required"), list) else []
        for key, prop in props.items():
            branches = prop.get("anyOf") if isinstance(prop, dict) else None
            if (
                key in required
                or "default" not in prop
                or prop["default"] is not None
                or not isinstance(branches, list)
                or len(branches) != 2
                or _NULL_BRANCH not in branches
            ):
                continue
            (kept,) = [branch for branch in branches if branch != _NULL_BRANCH]
            if not isinstance(kept, dict):
                continue
            if kept.get("type") == "string":
                # A string-typed (or string-enum) slot has no way to say "absent"
                # once the null branch is gone, so qwen fills it with the literal
                # text "null" (prod root 942d8562: start_phase, condition,
                # until_timestamp, items_csv, start_url). Keep the null branch
                # here; only arrays/integers/objects, which qwen string-encodes
                # inside the union, are collapsed.
                continue
            # The field's own description/title win over a nested model's docstring.
            props[key] = {**kept, **{name: value for name, value in prop.items() if name not in ("anyOf", "default")}}
    return result


def collapse_omittable_nulls(schema: Any) -> Any:
    """Send an omittable non-string ``Optional[X] = None`` property as plain ``X``.

    qwen on Cerebras serializes arrays and integers inside ``anyOf[X, null]``
    as JSON strings, with or without strict decoding. Omission already
    validates to None, so the null branch adds nothing for these properties.
    Required or non-null-default properties keep their union.
    """
    return _collapse_node(deepcopy(schema))
