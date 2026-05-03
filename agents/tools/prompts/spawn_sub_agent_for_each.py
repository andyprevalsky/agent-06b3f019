"""Prompt for spawn_sub_agent_for_each (planner alias)."""

PROMPT = """Spawns one sub-agent per item from a list or CSV, all sharing the same goal with row context appended per child.

Usage:
- Use for repeated work across many inputs (look up each company, email each person, process each row).
- goal must be self-contained and at least 50 characters; applied to EACH item with row data appended.
- Pass exactly one of items (list) or items_csv (str); they are mutually exclusive.
- start_phase="execute" for direct tasks; "plan" for complex per-item tasks; same criteria as spawn_sub_agent.
- Do not use for a single multi-step job - use spawn_sub_agent.
- Do not use for one-topic information gathering - use spawn_explore_agent.
- Returns a list of structured outputs, one per item."""
