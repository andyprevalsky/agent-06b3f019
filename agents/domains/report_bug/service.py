"""Activity for the report_bug domain."""

from typing import Any, Dict

from temporalio import activity

from domains.report_bug.repo import post_agent_bug_report


@activity.defn
async def report_bug_activity(
    agent_id: str, user_id: str, description: str, record_only: bool = False
) -> Dict[str, Any]:
    """File (or, with record_only, only save) the agent's bug report; retry-safe (one frozen request per run)."""
    activity.heartbeat("Filing bug report")
    return await post_agent_bug_report(agent_id, user_id, description, record_only)
