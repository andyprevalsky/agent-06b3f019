"""Prompt for send_message_to_user tool (PLAN phase)."""

PROMPT = """Sends a message to the user during PLAN phase, optionally blocking until they reply.

Usage:
- Use is_question=true to ask a clarification; the workflow blocks until the user responds.
- Use is_question=false to share the plan or an FYI without blocking.
- Do not use during EXECUTE phase - use send_message_to_user_execute_phase.
- Do not dump raw tool results; synthesize findings first.
- MUST be the only tool in that turn; do not batch with other tool calls."""
