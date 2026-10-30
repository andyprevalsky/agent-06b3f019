"""Model-facing schema for reading retained tool output (dependency-free)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

READ_MAX_CHARS = 20_000


class ReadToolOutputTool(BaseModel):
    """Read a retained tool result with pagination.

    Use offset and limit for large results. Reads return at most 20,000 Unicode
    characters and a next_offset; continue with offset to read the rest.
    Use the output_id from a tool result preview. Results are available only
    within their originating agent/session for 24h. Use query to find a literal
    substring at or after offset.
    """

    tool: Literal["read_tool_output"]
    output_id: str = Field(pattern=r"^[a-f0-9]{32}$", description="Opaque ID from a tool result preview.")
    offset: int = Field(default=0, ge=0, description="Character offset; use next_offset to continue.")
    limit: int = Field(default=READ_MAX_CHARS, ge=1, le=READ_MAX_CHARS, description="Maximum number of Unicode characters to read (default: 20000, max: 20000).")
    query: str | None = Field(default=None, min_length=1, max_length=1000, description="Optional literal substring to find at or after offset.")
