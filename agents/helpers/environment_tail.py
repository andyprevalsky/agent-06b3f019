"""Activity side of the unsaved environment tail (see helpers/environment_context.py).

    workflow (deterministic) ── seed {now, tz, agents from workflow state} ──▶ call_llm_activity
        │ only when a running agent is a child workflow (has agent_id):
        │   ONE bounded tree read (direct children, limit 50, 2s) for status /
        │   toolsInUse / sub-agent counts; any failure keeps workflow state
        ▼
    <environment-status> text ──▶ uncached_user_message() appended after the conversation

10k agents: no read unless this agent has a running child workflow; then one
indexed page per LLM call of this agent only (never a subtree scan).

Activity-only (does HTTP); never imported by workflow code.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import structlog

from config import load_config
from helpers.environment_context import merge_tree_status, render_environment_tail
from helpers.http_client import get_http_client
from providers.rose.uncached_context import uncached_user_message

logger = structlog.get_logger(__name__)

ENVIRONMENT_TREE_READ_TIMEOUT_SECONDS = 2.0
ENVIRONMENT_TREE_READ_LIMIT = "50"


def _seed_now(seed: Dict[str, Any]) -> datetime:
    value = seed.get("now")
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


async def _fetch_tree(agent_id: str, user_id: Optional[str]) -> Dict[str, Any]:
    """GET /api/agents/<self>/tree (the list_agents endpoint; helpers/ may not import domains/)."""
    config = load_config()
    headers = {"X-API-Key": config.backend.api_key or ""}
    if user_id:
        headers["X-User-Id"] = user_id
    response = await get_http_client().get(
        f"{config.backend.api_url.rstrip('/')}/api/agents/{agent_id}/tree",
        params={"depth": "1", "limit": ENVIRONMENT_TREE_READ_LIMIT},
        headers=headers,
        timeout=ENVIRONMENT_TREE_READ_TIMEOUT_SECONDS,
    )
    logger.info("[EnvironmentTail] child status read", agent_id=agent_id, status=response.status_code)
    response.raise_for_status()
    body = response.json()
    return body if isinstance(body, dict) else {}


async def _child_nodes(agent_id: str, user_id: Optional[str]) -> List[Dict[str, Any]]:
    view = await asyncio.wait_for(_fetch_tree(agent_id, user_id), timeout=ENVIRONMENT_TREE_READ_TIMEOUT_SECONDS)
    return [
        node for node in view.get("nodes") or [] if isinstance(node, dict) and node.get("parent_agent_id") == agent_id
    ]


async def build_environment_tail_text(
    seed: Dict[str, Any], *, agent_id: Optional[str], user_id: Optional[str]
) -> Optional[str]:
    if not isinstance(seed, dict):
        return None
    agents = [dict(agent) for agent in seed.get("agents") or [] if isinstance(agent, dict)]
    if agent_id and any(agent.get("agent_id") for agent in agents):
        try:
            agents = merge_tree_status(agents, await _child_nodes(agent_id, user_id))
        except Exception as exc:  # the tail is advisory; workflow state is enough
            logger.warning("[EnvironmentTail] child status read failed", agent_id=agent_id, error=str(exc)[:200])
    return render_environment_tail(now=_seed_now(seed), tz_name=seed.get("tz"), agents=agents)


def append_environment_tail(messages: List[Dict[str, Any]], text: Optional[str]) -> List[Dict[str, Any]]:
    """Append the tail as the LAST message; everything before it is untouched (cached prefix)."""
    if not text:
        return messages
    return [*messages, uncached_user_message(text)]


__all__ = ["append_environment_tail", "build_environment_tail_text"]
