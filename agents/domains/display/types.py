"""Display domain types.

No ``from __future__ import annotations`` here: Temporal decodes these activity
payloads inside the workflow sandbox with get_type_hints(), which needs real
annotations (structural guard test_activity_payload_types_need_no_module_globals).
"""

from typing import Any, Dict, List, TypedDict


class DisplayActivityInput(TypedDict):
    """Everything the backend call needs; small and JSON-serialisable."""

    agent_id: str
    user_id: str
    workflow_id: str
    tool_call_id: str
    items: List[Dict[str, str]]
    caption: str


class DisplayActivityResult(TypedDict, total=False):
    """Backend outcome. Definitive 4xx answers come back as data, not exceptions."""

    ok: bool
    status_code: int
    error: str
    details: List[str]
    body: Dict[str, Any]


class DisplayValidation(TypedDict, total=False):
    """Result of validating the LLM's tool_call."""

    ok: bool
    error: str
    payload: DisplayActivityInput
