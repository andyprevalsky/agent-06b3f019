"""Reasoning domain types - Pydantic models and type definitions."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ReasoningResponse(BaseModel):
    """Output from a reasoning task - simple response only, no tools."""

    response: str = Field(description="Your reasoning, analysis, and conclusions")
