"""Prompt for attempt_completion tool."""

PROMPT = """Signal that you believe your current phase/task is complete.

In PLAN phase: Call when plan is ready and you no longer need clarifications.
In EXECUTE phase: Call when you believe the goal has been fully accomplished.

A separate verifier LLM evaluates whether you actually completed the task. The verifier ONLY sees USER messages and TOOL results - it cannot see your reasoning or response text. Make sure your work is reflected in tool calls and their results, not just described in the response field.

If verification passes, the loop exits. If not, you receive feedback and can continue working.

WHEN NOT TO USE:
- Do NOT call until all required work is done and reflected in tool results.
- Do NOT call if required output_schema fields are still missing data.

RETURNS: Triggers verification. Either exits the loop (success) or returns feedback (keep working).

EXCLUSIVITY: Must be the ONLY tool in that turn. Do NOT batch with other tool calls."""
