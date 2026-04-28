"""Prompt for message_person tool."""

PROMPT = """Send a message to a person via iMessage or email. Use this for ALL email and messaging tasks. Provide a person identifier (name, phone, or email) and describe the intent - the tool generates the message, reads conversation history, and requests user approval before sending.

Do NOT write the message yourself - describe the intent and the tool generates an appropriate message based on context, conversation history, and the user's communication style.

WHEN NOT TO USE:
- Do NOT use for sending messages to the user (the agent's operator) - use send_message_to_user instead.
- Do NOT use if you need to send raw/exact text - this tool generates the message from intent.

RETURNS: The generated message text that was sent (after user approval), or an error if the person could not be found or the user rejected the message."""
