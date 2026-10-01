"""Validation shared by generated and tool-declared agent output schemas."""

from typing import Any, Mapping

BOUND_KEYS = ("minItems", "maxItems", "minLength", "maxLength")


def bounds_from_entries(field_type: str, entries: Any) -> dict[str, int]:
    """Turn LLM-friendly constraint entries into canonical JSON Schema keys."""
    bounds: dict[str, int] = {}
    for entry in entries:
        key = entry.get("kind") if isinstance(entry, Mapping) else entry.kind
        value = entry.get("value") if isinstance(entry, Mapping) else entry.value
        if key in bounds:
            raise ValueError(f"duplicate {key} constraint")
        bounds[key] = value
    if any(key not in BOUND_KEYS for key in bounds):
        raise ValueError("unknown output field constraint")
    if any(key in bounds for key in ("minItems", "maxItems")) and not field_type.startswith("list["):
        raise ValueError("minItems/maxItems are only valid for list fields")
    if any(key in bounds for key in ("minLength", "maxLength")) and field_type != "str":
        raise ValueError("minLength/maxLength are only valid for str fields")
    for lower, upper in (("minItems", "maxItems"), ("minLength", "maxLength")):
        if lower in bounds and upper in bounds and bounds[lower] > bounds[upper]:
            raise ValueError(f"{lower} must be <= {upper}")
    return bounds


def coerce_direct_bounds_to_entries(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    direct = [{"kind": key, "value": value[key]} for key in BOUND_KEYS if value.get(key) is not None]
    if not direct:
        return value
    result = {key: item for key, item in value.items() if key not in BOUND_KEYS}
    result["constraints"] = list(result.get("constraints") or []) + direct
    return result


def explicitly_allows_empty_value(value: Any, field: Mapping[str, Any]) -> bool:
    """Only an explicit zero maximum permits an empty required scalar or list."""
    return (
        (value == "" and field.get("type") == "str" and field.get("maxLength") == 0)
        or (value == [] and str(field.get("type", "")).startswith("list[") and field.get("maxItems") == 0)
    )


def value_satisfies_output_field_constraints(value: Any, field: Mapping[str, Any]) -> bool:
    """Check declared bounds and nested fields before verifier soft-accept paths."""
    if value is None:
        return field.get("nullable") is True
    field_type = field.get("type", "")
    if field_type in ("int", "integer") and (not isinstance(value, int) or isinstance(value, bool)):
        return False
    if field_type in ("float", "number") and (not isinstance(value, (int, float)) or isinstance(value, bool)):
        return False
    if field_type in ("bool", "boolean") and not isinstance(value, bool):
        return False
    if isinstance(field_type, str) and field_type.startswith("list["):
        if not isinstance(value, list):
            return False
        if field_type == "list[str]" and not all(isinstance(item, str) for item in value):
            return False
        if field_type == "list[int]" and not all(isinstance(item, int) and not isinstance(item, bool) for item in value):
            return False
        if field.get("minItems") is not None and len(value) < field["minItems"]:
            return False
        if field.get("maxItems") is not None and len(value) > field["maxItems"]:
            return False
    if field_type == "str":
        if not isinstance(value, str):
            return False
        if field.get("minLength") is not None and len(value) < field["minLength"]:
            return False
        if field.get("maxLength") is not None and len(value) > field["maxLength"]:
            return False
    properties = field.get("properties")
    if field_type in ("object", "list[object]") and isinstance(properties, list):
        objects = value if field_type == "list[object]" else [value]
        for obj in objects:
            if not isinstance(obj, Mapping):
                return False
            for nested in properties:
                if not isinstance(nested, Mapping) or not isinstance(nested.get("name"), str):
                    return False
                if nested["name"] not in obj:
                    if nested.get("required", True) is False:
                        continue
                    return False
                if not value_satisfies_output_field_constraints(obj[nested["name"]], nested):
                    return False
    return True
