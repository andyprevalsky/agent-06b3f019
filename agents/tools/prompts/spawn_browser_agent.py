"""Prompt for spawn_browser_agent (planner alias)."""

PROMPT = (
    "Web automation agent for purchases, forms, JS-heavy sites. Needs start_url."
    " Do NOT use for sending emails - use message_person instead."
    " Do NOT use for information gathering - use spawn_explore_agent."
    " 25-step limit. Sessions are ephemeral - no state persists between calls."
)
