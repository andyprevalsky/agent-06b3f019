"""Spawn-agent domain -- thin re-export shim.

All implementation has moved to domains/spawn_agent/.
This file exists solely so that existing consumers (tests, workflow sandbox imports)
that import from ``tools.spawn_agent`` continue to work without modification.
"""

from domains.spawn_agent.handler import SpawnAgentManager, get_manager, spawn_agent
from domains.spawn_agent.service import (
    _resolve_explore_attachments_activity,
    fetch_full_network_metadata,
    spawn_explore_agent_activity,
)

__all__ = [
    "SpawnAgentManager",
    "_resolve_explore_attachments_activity",
    "fetch_full_network_metadata",
    "get_manager",
    "spawn_agent",
    "spawn_explore_agent_activity",
]
