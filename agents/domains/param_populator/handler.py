"""param_populator domain — Temporal activity entry point.

Thin handler: parse input, call service, return result.
"""

from __future__ import annotations

from typing import Any

import structlog
from temporalio import activity

from domains.param_populator.service import populate_tool_params
from helpers.tracing import traced

logger = structlog.get_logger()


@activity.defn
@traced("populate_tool_params_activity")
async def populate_tool_params_activity(
    tool_name: str,
    goal: str,
    agent_id: str,
    model: str,
    alias_hint: str = "",
    claude_token: str | None = None,
) -> dict[str, Any]:
    """Temporal activity: populate tool parameters using LLM.

    Args:
        tool_name: Name of the tool to populate params for.
        goal: The task goal from the plan.
        agent_id: Agent ID to fetch context from DB.
        model: LLM model identifier selected for the agent.
        alias_hint: Original alias name for type-specific prompt instructions.
        claude_token: Optional Claude OAuth token for direct Anthropic calls.

    Returns:
        Dict with ``params`` and ``usage`` keys.
    """
    try:
        return await populate_tool_params(
            tool_name=tool_name,
            goal=goal,
            agent_id=agent_id,
            model=model,
            alias_hint=alias_hint,
            claude_token=claude_token,
            heartbeat=activity.heartbeat,
        )
    except Exception:
        logger.error(
            "[ParamPopulator] Error",
            tool_name=tool_name,
            goal=goal,
            exc_info=True,
        )
        raise
