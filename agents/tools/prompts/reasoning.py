"""Prompt for reasoning (planner-only pseudo-tool)."""

PROMPT = """Runs a pure thinking step over the goal and emits its output as a TOOL result message; no external side effects.

Usage:
- Use to synthesize prior tool results into a derived value (rank, compare, compute, pick).
- Use to produce a final answer that depends only on data already in context.
- The PlannerTask.goal supplies the question and references prior task outputs explicitly.
- Do not use when external data is needed - use spawn_explore_agent or web_search.
- Do not use when the work needs side effects (sending, code, browser) - use the appropriate tool."""
