"""Spawn-sub-agents tool -- thin re-export shim.

All implementation lives in ``domains.spawn_sub_agents``.  This module preserves
the public surface so that existing callers (worker.py, agent_workflow.py,
blackbox tests) continue to work without import changes.
"""

from domains.spawn_sub_agents.handler import SpawnSubAgentManager, get_manager, spawn_sub_agent
from domains.spawn_sub_agents.service import (
    spawn_sub_agent_activity,
    spawn_sub_agents_batch_activity,
)

__all__ = [
    "SpawnSubAgentManager",
    "get_manager",
    "spawn_sub_agent",
    "spawn_sub_agent_activity",
    "spawn_sub_agents_batch_activity",
]
