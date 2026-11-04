"""Spawn-claude-code-agent domain types — Pydantic models and type aliases."""

from typing import Optional, TypedDict


class CodeAgentTarget(TypedDict):
    """Where a code agent runs, and whether that target can start right now.

    An activity result: this module keeps real (non-string) annotations because
    the workflow sandbox decodes it with get_type_hints().
    """

    target: str
    available: bool
    reason: Optional[str]
    device_id: Optional[str]
    device_name: Optional[str]
    error: Optional[str]
