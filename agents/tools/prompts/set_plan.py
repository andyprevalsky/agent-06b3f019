"""Prompt for set_plan tool."""

PROMPT = """Hands off to a dedicated planner LLM that generates an execution plan as a DAG of tasks with dependencies.

Usage:
- Call after gathering enough context and ready to proceed to execution.
- The DAG executor dispatches the resulting tasks; an automated verifier scores the result on completion.
- A score of 1.0 ends the workflow; a score below 1.0 returns feedback for further work.
- Do not call before finishing research; gather context first.
- Do not call during EXECUTE phase; planning is PLAN phase only.
- MUST be the only tool in that turn; do not batch with other tool calls."""
