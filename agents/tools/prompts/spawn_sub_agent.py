"""Prompt for spawn_sub_agent (planner alias)."""

PROMPT = (
    "Delegate ONE complex task to a child agent with its own planning cycle. Use for a single"
    " multi-step job (e.g., 'research and book a venue'). NOT for repeated work across a list"
    " - use spawn_sub_agent_for_each instead."
)
