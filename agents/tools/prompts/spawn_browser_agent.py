"""Prompt for spawn_browser_agent (planner alias)."""

from utils.prompts import EPHEMERAL_SESSION_RULE

PROMPT = (
    """Spawns a browser sub-agent for stateful web trajectories (purchases, forms, JS-heavy sites) with a 25-step limit.

Usage:
- Use for login, navigation, form fill, checkout, and other interactive flows.
- goal must be self-contained and at least 50 characters (validator-enforced).
- start_url determines which domain's cookies are restored at session start.
- Do not use for sending emails or messages - use message_person.
- Do not use for information gathering - use spawn_explore_agent.
- IMPORTANT: keep stateful multi-step flows in ONE call; in-session state (cart, JS state) is lost between calls.

# Session Semantics
"""
    + EPHEMERAL_SESSION_RULE.strip()
)
