"""Prompt for send_message_to_user_execute_phase tool."""

PROMPT = """Use this tool to send a message to the user. This tool does not block execution.

Text outside this tool is visible if the user expands the detail view, but most won't; assume unread. Anything you want them to actually see goes through this tool. A user message earns its place by carrying information.

Keep messages tight.

Usage:
- Use for status updates or sharing findings mid-execution.
- Don't ask questions; the user can't reply in EXECUTE. If info is missing, make the best assumption and proceed; never wait for the user."""
