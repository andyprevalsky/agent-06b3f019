"""Prompt for message_person tool."""

PROMPT = """Drafts and sends a message to a person via iMessage or email after blocking on synchronous user approval.

Usage:
- Use for any iMessage/SMS/email task targeting a person other than the operator.
- intent describes the message's purpose; the tool reads conversation history, researches the person, and drafts the text.
- channel="email" requires from_email matching one of the user's connected accounts.
- Set context_gates.recent_communications=false to skip the cross-contact voice sample when voice matching isn't needed.
- The tool BLOCKS the workflow on a synchronous user-approval prompt; rejection returns an error so adjust intent and call again.
- Do not use to message the operator - use send_message_to_user (PLAN) or send_message_to_user_execute_phase (EXECUTE).
- Do not pre-write raw text; the tool generates the message from intent."""
