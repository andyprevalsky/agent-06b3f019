"""Prompt for add_memory tool."""

PROMPT = """Save important context that should persist across all future agents for this user.

Use this proactively to remember: user preferences, completed actions (bookings, purchases, decisions), key facts, or anything the user would want future agents to know.

WHEN NOT TO USE:
- Do NOT store ephemeral task state or raw tool outputs - store synthesized, actionable facts.
- Do NOT store information already available in the user's profile or message history.

RETURNS: Confirmation that the memory was saved.

Examples of good memories: dietary restrictions, travel preferences, completed reservations, important dates, relationship context."""
