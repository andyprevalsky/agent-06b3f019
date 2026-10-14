"""Typed transport shapes for the existing native WHM output protocols.

Native validation still owns candidate identity, patch applicability, observation
content, probability totals and every other state-dependent constraint.
"""
from __future__ import annotations

import json
from typing import Annotated, Any, ClassVar, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from benchmarks.wmh_outcomes import (
    DISTRIBUTION_PROTOCOL, DISTRIBUTION_SCHEMA, TIMED_DISTRIBUTION_PROTOCOL,
    TIMED_DISTRIBUTION_SCHEMA, MAXIMUM_ELAPSED_MS,
)


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    # Open state maps and arbitrary JSON Patch values cannot be represented by
    # Rose's closed-object strict adapter. Use its existing verifier precedent.
    rose_openai_strict: ClassVar[bool] = False


class ToolResult(_Contract):
    call_id: str
    content: str
    is_error: bool


class SetPatch(_Contract):
    op: Literal["add", "replace"]
    path: str
    value: Any

    @field_validator("value")
    @classmethod
    def json_value(cls, value: Any) -> Any:
        json.dumps(value, allow_nan=False)
        return value


class RemovePatch(_Contract):
    op: Literal["remove"]
    path: str


Patch = Union[SetPatch, RemovePatch]


class Outcome(_Contract):
    id: str
    probability: Annotated[Union[int, float], Field(ge=0, le=1)]
    description: str
    tool_results: list[ToolResult]
    state_patch: list[Patch]


class TimedOutcome(Outcome):
    elapsed_ms: Annotated[int, Field(ge=0, le=MAXIMUM_ELAPSED_MS)]


class OutcomeDistribution(_Contract):
    schema: Literal[DISTRIBUTION_SCHEMA]
    outcomes: Annotated[list[Outcome], Field(min_length=1, max_length=6)]


class TimedOutcomeDistribution(_Contract):
    schema: Literal[TIMED_DISTRIBUTION_SCHEMA]
    outcomes: Annotated[list[TimedOutcome], Field(min_length=1, max_length=6)]


class NativeTransition(_Contract):
    message: Literal[""]
    tool_results: Annotated[list[ToolResult], Field(min_length=1)]
    state: dict[str, Any]
    terminal: Literal[False]

    @field_validator("terminal", mode="before")
    @classmethod
    def exact_terminal(cls, value: Any) -> bool:
        if value is not False:
            raise ValueError("Native terminal must be false")
        return value

    @field_validator("state")
    @classmethod
    def json_state(cls, value: dict[str, Any]) -> dict[str, Any]:
        json.dumps(value, allow_nan=False)
        return value


def response_model_for_protocol(protocol: str) -> type[BaseModel] | None:
    return {
        DISTRIBUTION_PROTOCOL: OutcomeDistribution,
        TIMED_DISTRIBUTION_PROTOCOL: TimedOutcomeDistribution,
        "text-world-model-v3": NativeTransition,
    }.get(protocol)
