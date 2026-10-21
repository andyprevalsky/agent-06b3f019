"""Stop a descendant through a durable Temporal activity, never raw process signals."""
from datetime import timedelta
from typing import Any, Dict

import httpx
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from config import load_config
from tools.base import EventType, MessageStatus, ToolEvent


@activity.defn
async def kill_agent_activity(caller_agent_id: str, target_agent_id: str) -> Dict[str, Any]:
    config = load_config()
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.delete(
            f"{config.backend.api_url}/api/agent-graph/agents/{target_agent_id}",
            headers={"X-API-Key": config.backend.api_key or "", "X-Agent-Id": caller_agent_id},
        )
    if response.status_code >= 500:
        response.raise_for_status()
    body = response.json()
    return {"ok": response.is_success, **body}


async def kill_agent(workflow_instance, tool_call: Dict[str, Any], tool_call_id: str):
    target = str(tool_call.get("agent_id") or "").strip()
    if not target or target == str(workflow_instance.agent_id):
        result = {"ok": False, "error": "Choose a descendant agent ID; an agent cannot kill itself."}
    else:
        result = await workflow.execute_activity(
            kill_agent_activity,
            args=[str(workflow_instance.agent_id), target],
            start_to_close_timeout=timedelta(seconds=90),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )
    await workflow_instance._handle_tool_event(
        ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Agent stopped" if result.get("ok") else "Agent could not be stopped",
            message=result.get("message") or result.get("error") or str(result),
            status=MessageStatus.FINISHED if result.get("ok") else MessageStatus.ERROR,
            data=result,
        ),
        tool_call_id,
        "kill_agent",
    )
    return MessageStatus.FINISHED if result.get("ok") else MessageStatus.ERROR
