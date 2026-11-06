"""Data access for the report_bug domain.

    post_agent_bug_report ──▶ POST /api/agents/<agent>/report-bug/by-agent

Owner, root-run, one-per-run and daily-cap checks live in the backend.
"""

from __future__ import annotations

from typing import Any, Dict

import structlog

from config import load_config
from domains.report_bug.config import ERROR_TEXT_MAX_LEN, REPORT_BUG_HTTP_TIMEOUT_SECONDS
from helpers.http_client import get_http_client

logger = structlog.get_logger()


def _error_text(response: Any) -> str:
    try:
        body = response.json()
    except ValueError:
        return (response.text or "")[:ERROR_TEXT_MAX_LEN]
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"][:ERROR_TEXT_MAX_LEN]
    return str(body)[:ERROR_TEXT_MAX_LEN]


async def post_agent_bug_report(agent_id: str, user_id: str, description: str) -> Dict[str, Any]:
    """File one bug report for ``agent_id`` (reply shape: types.AgentBugReportResult).

    Returns the backend body ``{"name", "url", "run_id", "already_reported"}``, or
    ``{"error", "status"}`` for a refusal (4xx, or 503 when the automation is not
    configured). Other 5xx raise so the activity retries the same idempotent request.
    """
    config = load_config()
    if not config.backend.api_key:
        raise RuntimeError("BACKEND_API_KEY not configured")
    response = await get_http_client().post(
        f"{config.backend.api_url.rstrip('/')}/api/agents/{agent_id}/report-bug/by-agent",
        headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id, "Content-Type": "application/json"},
        json={"description": description},
        timeout=REPORT_BUG_HTTP_TIMEOUT_SECONDS,
    )
    logger.info(
        "[ReportBug] agent bug report posted",
        agent_id=agent_id,
        description_chars=len(description),
        status=response.status_code,
    )
    if 400 <= response.status_code < 500 or response.status_code == 503:
        return {"error": _error_text(response), "status": response.status_code}
    response.raise_for_status()
    body = response.json() or {}
    return body if isinstance(body, dict) else {}
