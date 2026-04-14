"""Spawn-agent domain types: constants and shared type definitions."""

from __future__ import annotations

# Valid agent types for spawn_agent tool
VALID_AGENT_TYPES = frozenset({"browser", "code", "sub_agent", "explore", "for_each"})
