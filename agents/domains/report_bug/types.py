"""report_bug domain types.

No ``from __future__ import annotations`` here: Temporal decodes activity payloads
inside the workflow sandbox with get_type_hints(). The activity itself returns a
plain Dict[str, Any] (test_activity_return_types_decode_in_workflow_sandbox); this
TypedDict documents that shape.
"""

from typing import TypedDict


class AgentBugReportResult(TypedDict, total=False):
    """Backend reply to POST /api/agents/:id/report-bug/by-agent, or a refusal."""

    success: bool
    name: str  # boxes.dev thread title (`--ai-- …`)
    url: str  # boxes.dev Bug Report automation link
    run_id: str  # boxes.dev run id
    already_reported: bool  # this run's one report carries an earlier description
    error: str  # refusal reason (4xx / 503)
    status: int  # refusal HTTP status
