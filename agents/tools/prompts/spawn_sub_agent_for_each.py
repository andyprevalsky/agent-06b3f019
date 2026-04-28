"""Prompt for spawn_sub_agent_for_each (planner alias)."""

PROMPT = (
    "Apply the SAME task to MANY items (list or CSV). Spawns one sub-agent per item/row with"
    " a shared goal. Use instead of spawn_sub_agent whenever the work is repeated across a"
    " list of inputs (e.g., 'look up each company', 'email each person', 'process each row"
    " in the CSV')."
)
