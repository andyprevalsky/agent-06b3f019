"""Wait-for domain types: Pydantic models and type aliases."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ConditionEvaluation(BaseModel):
    """Structured output for condition evaluation."""

    satisfied: bool = Field(description="Whether the condition is currently met based on the evidence")
    reasoning: str = Field(description="One sentence explanation of the determination")
