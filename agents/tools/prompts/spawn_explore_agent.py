"""Prompt for spawn_explore_agent (planner alias)."""

PROMPT = """Spawns a research sub-agent (web search, web fetch, local data grep) that returns a free-form summary of findings.

Usage:
- Use for any research, fact-finding, or data gathering task.
- The goal is the child's only context; include all relevant details.
- Do not use for stateful web flows (purchases, forms, JS interaction) - use spawn_browser_agent.
- Do not use for repeated work across a list of items - use spawn_sub_agent_for_each.
- Returns a free-form text summary, NOT structured output; do not pass output_schema."""
