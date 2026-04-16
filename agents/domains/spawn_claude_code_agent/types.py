"""Spawn-claude-code-agent domain types — Pydantic models and type aliases."""

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
