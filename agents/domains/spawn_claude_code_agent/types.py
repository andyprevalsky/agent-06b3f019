"""Spawn-claude-code-agent domain types — Pydantic models and type aliases."""

from typing import Optional, TypedDict

from pydantic import BaseModel, Field


class ClaudeCodeParentResponse(BaseModel):
    """Response model for parent LLM interacting with Claude Code."""

    # IMPORTANT: attempt_completion must be FIRST field so streaming can exit early
    attempt_completion: bool = Field(
        description="Set to true if the task appears to be complete and should be verified. "
        "Set to false if Claude Code is asking questions or needs more guidance."
    )
    response: str = Field(
        default="",
        description="Your response to send to Claude Code's stdin. "
        "If Claude asks numbered questions you can respond with just a number to select "
        "an option like multiple choice. Leave empty if attempting completion.",
    )


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
