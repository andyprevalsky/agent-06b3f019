"""Pydantic tool models for user-authored tools (``rose_user_ui/tools/<name>/``).

A user's root agent declares its published tools next to the built-in tools.
Each pinned tool spec (resolved once per workflow by
``domains.user_tools.repo.resolve_user_tools_activity``) becomes a Pydantic
model with a literal ``tool`` discriminator, so it flows through the same
``create_agent_action_model`` -> native-tools path as every built-in tool.

The model's JSON schema is the user's ``input_schema`` (properties/required)
plus the ``tool`` discriminator. Pydantic accepts any extra fields
(``extra="allow"``); the run activity validates the input against the real
JSON Schema before the handler runs.

Pure module: no project imports (utils boundary), safe in the workflow sandbox.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Literal, Optional, Type

from pydantic import BaseModel, ConfigDict, Field, create_model

USER_TOOL_PREFIX = "user__"


def is_user_tool_name(name: Optional[str]) -> bool:
    """True for a declared user-tool name (``user__<name>``)."""
    return isinstance(name, str) and name.startswith(USER_TOOL_PREFIX) and len(name) > len(USER_TOOL_PREFIX)


def sorted_user_tool_specs(user_tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Return valid specs sorted by declared name (stable cached prompt prefix)."""
    specs = [
        spec
        for spec in (user_tools or [])
        if isinstance(spec, dict) and is_user_tool_name(spec.get("name")) and isinstance(spec.get("input_schema"), dict)
    ]
    unique: Dict[str, Dict[str, Any]] = {}
    for spec in specs:
        unique.setdefault(spec["name"], spec)
    return [unique[name] for name in sorted(unique)]


def user_tool_names(user_tools: Optional[List[Dict[str, Any]]]) -> List[str]:
    """Declared names of the pinned user tools, sorted."""
    return [spec["name"] for spec in sorted_user_tool_specs(user_tools)]


def llm_declarations(user_tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """The LLM-facing subset (name, description, input_schema), sorted.

    This is what crosses the call_llm_activity boundary each turn, so it stays
    small (the resolve activity caps its total size).
    """
    return [
        {
            "name": spec["name"],
            "description": str(spec.get("description") or ""),
            "input_schema": spec["input_schema"],
        }
        for spec in sorted_user_tool_specs(user_tools)
    ]


def find_user_tool_spec(user_tools: Optional[List[Dict[str, Any]]], name: str) -> Optional[Dict[str, Any]]:
    for spec in sorted_user_tool_specs(user_tools):
        if spec["name"] == name:
            return spec
    return None


def build_user_tool_model(spec: Dict[str, Any]) -> Type[BaseModel]:
    """Build the Pydantic tool model for one pinned user-tool spec."""
    name = str(spec["name"])
    description = str(spec.get("description") or f"User tool {name}.").strip()
    input_schema = copy.deepcopy(spec.get("input_schema") or {})
    properties = dict(input_schema.get("properties") or {})
    properties.pop("tool", None)  # reserved discriminator; rejected at load time
    required = [r for r in (input_schema.get("required") or []) if isinstance(r, str) and r != "tool"]

    def _json_schema_extra(schema: Dict[str, Any], _model: Any = None) -> None:
        tool_property = (schema.get("properties") or {}).get("tool") or {"const": name, "type": "string"}
        schema["properties"] = {"tool": tool_property, **copy.deepcopy(properties)}
        schema["required"] = ["tool", *required]
        schema["additionalProperties"] = False
        schema["description"] = description

    model = create_model(
        "UserTool_" + name[len(USER_TOOL_PREFIX) :],
        __config__=ConfigDict(extra="allow", json_schema_extra=_json_schema_extra),
        __doc__=description,
        tool=(Literal[name], Field(description=f"Always '{name}'.")),
    )
    return model


def build_user_tool_registry(user_tools: Optional[List[Dict[str, Any]]]) -> Dict[str, Type[BaseModel]]:
    """``{declared_name: model}`` for the pinned user tools (sorted insertion order)."""
    return {spec["name"]: build_user_tool_model(spec) for spec in sorted_user_tool_specs(user_tools)}


__all__ = [
    "USER_TOOL_PREFIX",
    "build_user_tool_model",
    "build_user_tool_registry",
    "find_user_tool_spec",
    "is_user_tool_name",
    "llm_declarations",
    "sorted_user_tool_specs",
    "user_tool_names",
]
