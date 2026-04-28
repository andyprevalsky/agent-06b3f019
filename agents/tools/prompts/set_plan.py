"""Prompt for set_plan tool."""

PROMPT = """Signal readiness for plan generation. A dedicated planner LLM will analyze the conversation history and available tools to generate an optimal execution plan.

Call this when you have gathered enough context and are ready to proceed. The planner will structure your research into tasks with proper dependencies.

WHEN NOT TO USE:
- Do NOT call before finishing research - gather context first.
- Do NOT call during EXECUTE phase - planning is PLAN phase only.

RETURNS: A structured execution plan with tasks and dependency graph. After set_plan, you must call attempt_completion to transition to EXECUTE phase."""
