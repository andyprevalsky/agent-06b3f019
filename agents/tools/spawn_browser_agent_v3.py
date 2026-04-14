"""Spawn-browser-agent-v3 domain -- thin re-export shim.

All implementation has moved to domains/spawn_browser_agent_v3/.
This file exists solely so that existing consumers (tests, workflow sandbox imports)
that import from ``tools.spawn_browser_agent_v3`` continue to work without modification.
"""

from domains.spawn_browser_agent_v3.handler import (
    SpawnBrowserAgentManagerV3,
    get_manager,
    spawn_browser_agent,
    spawn_browser_agent_activity_v3,
)

__all__ = [
    "SpawnBrowserAgentManagerV3",
    "get_manager",
    "spawn_browser_agent",
    "spawn_browser_agent_activity_v3",
]
