"""Typed transport shapes for the existing native WHM output protocols.

Native validation still owns candidate identity, patch applicability, observation
content, probability totals and every other state-dependent constraint.
"""
from __future__ import annotations

import json
from typing import Annotated, Any, ClassVar, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, create_model

from benchmarks.wmh_outcomes import (
    DISTRIBUTION_PROTOCOL, DISTRIBUTION_SCHEMA, TIMED_DISTRIBUTION_PROTOCOL,
    TIMED_DISTRIBUTION_SCHEMA, MAXIMUM_ELAPSED_MS, OUTCOME_V4_PROTOCOL, OUTCOME_V4_SCHEMA,
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
    probability: Union[Annotated[int, Field(ge=0, le=1)], Annotated[float, Field(ge=0, le=1)]]
    description: str
    tool_results: list[ToolResult]
    state_patch: list[Patch]


class TimedOutcome(Outcome):
    elapsed_ms: Annotated[int, Field(ge=0, le=MAXIMUM_ELAPSED_MS)]


class BaseRateDeclaration(_Contract):
    key: str
    given: Union[str, None]
    deviation_reason: Union[str, None]


class V4Outcome(TimedOutcome):
    base_rate_results: dict[str, bool]
    delivered_event_ids: list[str]


class OutcomeDistribution(_Contract):
    schema: Literal[DISTRIBUTION_SCHEMA]
    outcomes: Annotated[list[Outcome], Field(min_length=1, max_length=6)]


class TimedOutcomeDistribution(_Contract):
    schema: Literal[TIMED_DISTRIBUTION_SCHEMA]
    outcomes: Annotated[list[TimedOutcome], Field(min_length=1, max_length=6)]


class V4OutcomeDistribution(_Contract):
    schema: Literal[OUTCOME_V4_SCHEMA]
    base_rates: list[BaseRateDeclaration]
    outcomes: Annotated[list[V4Outcome], Field(min_length=1, max_length=6)]


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


def response_model_for_protocol(
    protocol: str, *, expected_call_ids: tuple[str, ...] | None = None
) -> type[BaseModel] | None:
    model = {
        DISTRIBUTION_PROTOCOL: OutcomeDistribution,
        TIMED_DISTRIBUTION_PROTOCOL: TimedOutcomeDistribution,
        OUTCOME_V4_PROTOCOL: V4OutcomeDistribution,
        "text-world-model-v3": NativeTransition,
    }.get(protocol)
    if (model is None or not expected_call_ids or not isinstance(expected_call_ids, tuple)
            or any(not isinstance(value, str) or not value for value in expected_call_ids)):
        return model

    def ordered_call_ids(cls, results):
        if tuple(result.call_id for result in results) != expected_call_ids:
            raise ValueError("Native result call IDs differ from the candidate action")
        return results

    results_field = (
        list[ToolResult],
        ...,
    )
    validators = {"ordered_call_ids": field_validator("tool_results")(ordered_call_ids)}
    if model is NativeTransition:
        return create_model("CandidateNativeTransition", __base__=model,
                            __validators__=validators,
                            tool_results=(Annotated[list[ToolResult], Field(min_length=1)], ...))
    outcome = {TimedOutcomeDistribution: TimedOutcome, V4OutcomeDistribution: V4Outcome}.get(model, Outcome)
    outcome_model = create_model("Candidate" + outcome.__name__, __base__=outcome,
                                 __validators__=validators, tool_results=results_field)
    return create_model("Candidate" + model.__name__, __base__=model,
                        outcomes=(Annotated[list[outcome_model], Field(min_length=1, max_length=6)], ...))
