"""Enrich domain types - schemas and type aliases."""

from typing import Any, Dict, Optional, TypedDict


class CreateTaskResult(TypedDict):
    """Result from creating an enrichment task."""

    run_id: str


class PollStatusResult(TypedDict):
    """Result from polling enrichment task status."""

    status: str
    is_active: bool
    is_completed: bool
    is_failed: bool
    warnings: Optional[str]


class TaskResultsData(TypedDict, total=False):
    """Result from retrieving enrichment task results."""

    output: Dict[str, Any]
    run: Dict[str, Any]
    usage: Optional[Dict[str, Any]]
