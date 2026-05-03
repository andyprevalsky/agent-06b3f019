"""Spawn-sub-agents domain — public API."""

from domains.spawn_sub_agents.handler import SpawnSubAgentManager, get_manager, spawn_sub_agent
from domains.spawn_sub_agents.service import spawn_sub_agent_activity
from helpers.attachments import fetch_parent_attachments_activity

__all__ = [
    "SpawnSubAgentManager",
    "fetch_parent_attachments_activity",
    "get_manager",
    "spawn_sub_agent",
    "spawn_sub_agent_activity",
]
