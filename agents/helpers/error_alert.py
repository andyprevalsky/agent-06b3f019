"""Root-agent failure record for the agent worker.

Agent failures are not posted to Slack and do not dispatch a GitHub Auto RCA.
Every real prod agent run that is not COMPLETED 24 hours after it started gets
one Report Bug /rca from the backend's stuck-agent job
(back-end/src/domains/agents/stuckAgentBugReportService.ts), which covers
failed runs too. This activity only writes a structured worker log line, so it
has no external side effect and is safe under Temporal's at-least-once retries.

The activity name and signature stay unchanged because in-flight workflow
histories already schedule it from `_mark_failed`. The activity NEVER raises.
"""

from typing import Any, Dict, Optional

from temporalio import activity


@activity.defn
async def report_failure_activity(
    agent_id: Optional[str],
    source: str,
    message: str,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Log a root-agent failure; the 24h stuck-agent job owns the bug report."""
    try:
        reason = (context or {}).get("reason")
        activity.logger.warning(
            f"[ErrorAlert] Root agent failed: source={source} agent_id={agent_id} "
            f"reason={str(reason)[:200]} message={message[:200]}"
        )
    except Exception as e:  # never fail the agent because logging failed
        return {"alerted": False, "error": str(e)}
    return {"alerted": False, "logged": True}
