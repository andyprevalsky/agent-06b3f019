"""Activity for the report_bug domain."""

from typing import Any, Dict

from temporalio import activity

from domains.report_bug.repo import post_agent_bug_report


@activity.defn
async def report_bug_activity(agent_id: str, user_id: str, description: str) -> Dict[str, Any]:
    """File the agent's bug report; retry-safe (the backend freezes one request per run)."""
    activity.heartbeat("Filing bug report")
    return await post_agent_bug_report(agent_id, user_id, description)
