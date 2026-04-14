"""Find All domain types — Pydantic models, TypedDicts, and type aliases."""

from __future__ import annotations

from typing import Any, TypedDict


class IngestResult(TypedDict):
    """Result from the FindAll ingest endpoint."""

    entity_type: str
    match_conditions: list[dict[str, Any]]


class CreateRunResult(TypedDict):
    """Result from the FindAll create-run endpoint."""

    findall_id: str


class PollStatusResult(TypedDict):
    """Result from polling a FindAll run's status."""

    status: dict[str, Any]
    is_completed: bool
    is_failed: bool
    generated_candidates_count: int
    matched_candidates_count: int


class GetResultsResult(TypedDict):
    """Result from retrieving a completed FindAll run's results."""

    candidates: list[dict[str, Any]]
    usage: Any
    status: dict[str, Any]


class GeneratorPricing(TypedDict):
    """Pricing structure for a FindAll generator tier."""

    fixed: int
    per_match: int
