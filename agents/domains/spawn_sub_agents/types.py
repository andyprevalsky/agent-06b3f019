"""Spawn-sub-agents domain types — TypedDicts and type aliases."""

from typing import Any, Dict, List, TypedDict


class SpawnResult(TypedDict):
    """Result from spawning a batch of sub-agents."""

    spawned: int
    completed: int
    failed: int
    agents: List[Dict[str, Any]]
