"""Schema-bound final answer presentation; never interprets task wording."""
from __future__ import annotations

import json
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_validator, model_serializer


class FinalPresentation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    mode: Literal["report", "value"]
    field: str | None = None
    encoding: Literal["text", "json"] | None = None

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema, handler):
        schema = handler(core_schema)
        if handler.mode != "validation":
            return schema
        # Match the existing mode-dependent validator in provider input schemas.
        # Serialization and canonical accepted values remain unchanged.
        report = {
            "type": "object",
            "properties": {
                "version": {"const": 1, "type": "integer"},
                "mode": {"const": "report", "type": "string"},
                "field": {"type": "null"},
                "encoding": {"type": "null"},
            },
            "required": ["version", "mode"],
            "additionalProperties": False,
        }
        value = {
            "type": "object",
            "properties": {
                "version": {"const": 1, "type": "integer"},
                "mode": {"const": "value", "type": "string"},
                "field": {"type": "string", "minLength": 1},
                "encoding": {"enum": ["text", "json"], "type": "string"},
            },
            "required": ["version", "mode", "field", "encoding"],
            "additionalProperties": False,
        }
        return {"title": schema.get("title", cls.__name__), "anyOf": [report, value]}

    @model_serializer(mode="wrap")
    def canonical_shape(self, handler):
        data = handler(self)
        if self.mode == "report":
            data.pop("field", None)
            data.pop("encoding", None)
        return data

    @model_validator(mode="before")
    @classmethod
    def strict_version(cls, value):
        if not isinstance(value, dict) or type(value.get("version")) is not int:
            raise ValueError("presentation version must be an integer")
        return value

    @model_validator(mode="after")
    def valid_shape(self):
        if self.mode == "report" and (self.field is not None or self.encoding is not None):
            raise ValueError("report presentation cannot select a field")
        if self.mode == "value" and (not self.field or self.encoding is None):
            raise ValueError("value presentation requires a field and encoding")
        return self


def validate_presentation(schema: dict[str, Any]) -> FinalPresentation | None:
    raw = schema.get("presentation")
    if raw is None:
        return None
    policy = FinalPresentation.model_validate(raw)
    if policy.mode == "report":
        return policy
    fields = schema.get("fields")
    # Never silently suppress another deliverable or an operational notice.
    if not isinstance(fields, list) or len(fields) != 1:
        raise ValueError("value presentation requires exactly one output field")
    field = fields[0]
    if (field.get("name") != policy.field or field.get("required") is not True
            or field.get("nullable", False) is not False):
        raise ValueError("value presentation must bind a required nonnullable field")
    queue = [field]
    for node in queue:
        if node.get("type") in {"file_pointer", "list[file_pointer]", "session_file_pointer", "list[session_file_pointer]"}:
            raise ValueError("file outputs require report presentation")
        queue.extend(node.get("properties") or [])
    if policy.encoding == "text" and field.get("type") not in {"str", "int", "float", "bool"}:
        raise ValueError("text presentation requires a scalar field")
    return policy


def render_final_answer(schema: dict[str, Any] | None, outputs: dict[str, Any] | None) -> str | None:
    policy = validate_presentation(schema or {})
    if policy is None or policy.mode == "report":
        return None
    if not isinstance(outputs, dict) or policy.field not in outputs or len(outputs) != 1:
        raise ValueError("final answer does not match its accepted presentation schema")
    value = outputs[policy.field]
    field_type = schema["fields"][0]["type"]
    # Verification already owns full schema validation; enforce the final scalar
    # boundary as well so type coercion cannot change the displayed answer.
    expected = {"str": str, "int": int, "float": (int, float), "bool": bool}
    if value is None or (field_type in expected and (
        not isinstance(value, expected[field_type]) or
        (field_type in {"int", "float"} and isinstance(value, bool))
    )):
        raise ValueError("final answer has an invalid scalar type")
    if policy.encoding == "json":
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("final answer must be finite")
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
