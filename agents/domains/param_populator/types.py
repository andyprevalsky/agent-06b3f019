"""param_populator domain — type definitions.

No custom types in this domain. Tool parameter schemas are defined in
helpers/tool_schemas (shared provider) and consumed via TOOL_MODELS /
create_agent_action_model.
"""

from typing import Any, TypedDict


class PopulatedParams(TypedDict):
    """Return type of the param populator service."""

    params: dict[str, Any]
    usage: dict[str, Any]
