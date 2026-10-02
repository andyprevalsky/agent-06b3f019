"""Temporary env kill-switches read by tool schemas, prompts and spawn routing.

Each switch is on when its env var is 1 / true / yes / on.
"""

from __future__ import annotations

import os
from typing import Final

# Drop api_request from explore tool injection and prompt context so agents
# take the coding-agent / GitHub-script path instead.
ROSE_DISABLE_API_REQUEST_ENV: Final[str] = "ROSE_DISABLE_API_REQUEST"
# Drop general_purpose / for_each spawn routes so coding-agent GitHub ranking
# benches cannot burn budget (or trip forbidden_tools) on recursive GP fan-out.
# Prefer spawn_agent(type=code).
ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV: Final[str] = "ROSE_DISABLE_GENERAL_PURPOSE_AGENT"


def _switch_on(env_name: str) -> bool:
    return os.getenv(env_name, "").strip().lower() in {"1", "true", "yes", "on"}


def api_request_disabled() -> bool:
    """Return True when api_request must not be injected or mentioned."""
    return _switch_on(ROSE_DISABLE_API_REQUEST_ENV)


def general_purpose_agent_disabled() -> bool:
    """Return True when general_purpose / for_each spawn routes must be blocked."""
    return _switch_on(ROSE_DISABLE_GENERAL_PURPOSE_AGENT_ENV)
