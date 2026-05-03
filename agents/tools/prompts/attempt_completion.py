"""Prompt for attempt_completion tool."""

from utils.prompts import VERIFICATION_RULES

PROMPT = (
    """Signals that the current phase or task is complete; takes no parameters and any args are ignored.

Usage:
- In PLAN phase, call when the plan is ready and no more clarifications are needed.
- In EXECUTE phase, call when the goal is fully accomplished AND output schema data is visible in a prior tool result.
- Do not call until all required work is reflected in tool results.
- Do not call if required output_schema fields are still missing data.
- MUST be the only tool in that turn; do not batch with other tool calls.

# Verification (canonical rules - same block the main system prompt cites)
"""
    + VERIFICATION_RULES.strip()
)
