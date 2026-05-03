"""Prompt for spawn_sub_agent (planner alias)."""

PROMPT = """Delegates one complex multi-step task to a child agent that runs its own planning cycle.

Usage:
- Use for a single multi-step job that benefits from independent planning (e.g., research and book a venue).
- goal must be self-contained and at least 50 characters; the child has no access to your context.
- start_phase="execute" for direct tasks (1-2 tool calls); "plan" for complex tasks (3+ tool calls, research, comparison).
- Pass read_only=true to keep the child in plan-only mode; pass verifier to override how success is judged.
- Do not use for repeated work across a list - use spawn_sub_agent_for_each.
- Do not use for pure information gathering - use spawn_explore_agent."""
