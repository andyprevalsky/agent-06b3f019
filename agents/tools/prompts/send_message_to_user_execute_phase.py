"""Prompt for send_message_to_user_execute_phase tool."""

PROMPT = """Send an informational message to the user during execution (non-blocking). Use for status updates or sharing findings mid-execution.

WHEN NOT TO USE:
- Do NOT use during PLAN phase - use send_message_to_user instead.
- Do NOT use for questions or clarifications - the user cannot respond during EXECUTE phase.

RETURNS: Nothing. Message is delivered but workflow continues immediately.

EXCLUSIVITY: Must be the ONLY tool in that turn. Do NOT batch with other tool calls."""
