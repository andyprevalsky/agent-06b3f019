"""Prompt for send_message_to_user_execute_phase tool."""

PROMPT = """Use this tool to send a message to the user. This tool does not block execution.

Text outside this tool is visible if the user expands the detail view, but most won't; assume unread. Anything you want them to actually see goes through this tool. A user message earns its place by carrying information.

Keep messages tight.

Usage:
- Use for status updates or sharing findings mid-execution.
- Do not use to ask a question; the user cannot reply during the EXECUTE phase.
- This is not a completion signal. If the message contains the final answer or
  fulfilled deliverable, call attempt_completion next. Do not send the same
  final message again, and do not call wait_for just to avoid completing."""
