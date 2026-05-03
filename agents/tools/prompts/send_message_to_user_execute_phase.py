"""Prompt for send_message_to_user_execute_phase tool."""

PROMPT = """Sends an informational message to the user during EXECUTE phase; does not block.

Usage:
- Use for status updates or sharing findings mid-execution.
- Do not use during PLAN phase - use send_message_to_user.
- Do not use to ask a question; the user cannot reply during EXECUTE phase.
- MUST be the only tool in that turn; do not batch with other tool calls."""
