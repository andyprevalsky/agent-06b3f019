"""Spawn Claude Code agent tool — re-exports from domains/spawn_claude_code_agent.

All logic lives in domains/spawn_claude_code_agent/. This file exists for
backward compatibility so existing ``from tools.spawn_claude_code_agent import ...``
continues to work.
"""

from domains.spawn_claude_code_agent.handler import (
    SpawnClaudeCodeAgentManager,
    get_manager,
    spawn_claude_code_agent,
)
from domains.spawn_claude_code_agent.service import spawn_claude_code_activity

__all__ = [
    "SpawnClaudeCodeAgentManager",
    "get_manager",
    "spawn_claude_code_agent",
    "spawn_claude_code_activity",
]
