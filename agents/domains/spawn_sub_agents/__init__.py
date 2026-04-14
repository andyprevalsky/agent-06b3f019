"""Spawn-sub-agents domain — public API."""

from domains.spawn_sub_agents.handler import SpawnSubAgentManager, get_manager, spawn_sub_agent
from domains.spawn_sub_agents.service import spawn_sub_agent_activity

__all__ = [
    "SpawnSubAgentManager",
    "get_manager",
    "spawn_sub_agent",
    "spawn_sub_agent_activity",
]
