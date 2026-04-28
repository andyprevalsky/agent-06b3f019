"""Prompt for send_message_to_user tool (PLAN phase)."""

PROMPT = """Send a message to the user during PLAN phase. Use is_question=true for clarification questions that block the workflow until the user responds, or false for non-blocking FYI messages (e.g., sharing the plan).

WHEN NOT TO USE:
- Do NOT use during EXECUTE phase - use send_message_to_user_execute_phase instead.
- Do NOT use to share tool results or raw data - synthesize findings first.

RETURNS: If is_question=true, blocks until user responds and the response appears in context. If is_question=false, sends immediately and continues.

EXCLUSIVITY: Must be the ONLY tool in that turn. Do NOT batch with other tool calls."""
