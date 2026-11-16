"""Tool for fetching agent data from database.

This is the SINGLE helper for GET /api/agents/{agent_id}.
Other helpers should import and use _fetch_agent_data_impl directly.
"""

from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import structlog
from temporalio import activity

from config import load_config
from helpers.http_client import get_http_client

logger = structlog.get_logger()


async def _fetch_agent_data_impl(
    agent_id: str, since: Optional[str] = None, browser_tool_call_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Core implementation for fetching agent data.

    This is the SINGLE function that calls GET /api/agents/{agent_id}.
    Can be called directly from other activities or via activity wrappers.

    Args:
        agent_id: The agent ID
        since: ISO timestamp — if provided, only messages after this time are returned

    Returns:
        Full response dict with 'agent' and 'messages' keys
    """
    config = load_config()

    url = f"{config.backend.api_url}/api/agents/{agent_id}"
    query = {}
    if since:
        query["since"] = since
    if browser_tool_call_id:
        query["browserToolCallId"] = browser_tool_call_id
    if query:
        url += "?" + urlencode(query)

    client = get_http_client()
    response = await client.get(
        url, headers={"X-API-Key": config.backend.api_key, "Content-Type": "application/json"}, timeout=30.0
    )
    response.raise_for_status()
    return response.json()


@activity.defn
async def fetch_agent_config(agent_id: str) -> Dict:
    """
    Activity: Fetch agent configuration from database.

    Returns:
        dict with: model, status, tool_ids, response_schema, etc.
    """
    try:
        activity.heartbeat("Fetching agent config")

        data = await _fetch_agent_data_impl(agent_id)
        agent = data["agent"]

        result = {
            "model": agent["model"],
            "reasoning_max_tokens": agent.get("reasoning_max_tokens", 256),
            "status": agent["status"],
            "price_limit_cents": agent.get("price_limit_cents", agent.get("priceLimitCents")),
            "tool_ids": [tool["id"] for tool in agent["tools"]],
            "parent_agent_id": agent.get("parentAgentId"),  # None if top-level agent
            "response_schema": agent.get("response_schema"),  # Structured output schema
            "token_in_price_microdollars": agent.get("token_in_price_microdollars"),  # For cost calculation
            "token_out_price_microdollars": agent.get("token_out_price_microdollars"),  # For cost calculation
            "write_lock_enabled": agent.get(
                "write_lock_enabled",
                agent.get("writeLockEnabled", True),
            ),  # Write lock for browser actions (default: True)
            # {name, repo_url, default_branch} of the agent's project; None = Home.
            "project": agent.get("project"),
        }

        logger.info(
            "Agent config fetched",
            agent_id=agent_id,
            model=result["model"],
            reasoning_max_tokens=result["reasoning_max_tokens"],
            status=result["status"],
        )

        return result

    except Exception as e:
        logger.error("Failed to fetch agent config", agent_id=agent_id, error=str(e))
        raise


MESSAGE_BATCH_LIMIT = 50  # POST /api/agents/messages/batch maximum


@activity.defn
async def fetch_message_texts(user_id: str, message_ids: List[str]) -> Dict[str, str]:
    """Activity (read-only, so retries are idempotent): {message_id: text} for the user's USER/TOOL rows.

    Claim check for continuation state: a workflow carries durable message ids
    across continue_as_new and resolves their text here instead of in its args.
    """
    config = load_config()
    client = get_http_client()
    texts: Dict[str, str] = {}
    for start in range(0, len(message_ids), MESSAGE_BATCH_LIMIT):
        chunk = message_ids[start : start + MESSAGE_BATCH_LIMIT]
        activity.heartbeat(f"Fetching message texts {start}/{len(message_ids)}")
        response = await client.post(
            f"{config.backend.api_url}/api/agents/messages/batch",
            headers={"X-API-Key": config.backend.api_key, "X-User-Id": user_id, "Content-Type": "application/json"},
            json={"ids": chunk, "user_id": user_id},
            timeout=30.0,
        )
        response.raise_for_status()
        for row in response.json().get("messages", []):
            if isinstance(row.get("id"), str) and isinstance(row.get("text"), str):
                texts[row["id"]] = row["text"]
    logger.info(
        "[ContinuationClaimCheck] Message texts fetched",
        user_id=user_id,
        requested=len(message_ids),
        found=len(texts),
    )
    return texts
