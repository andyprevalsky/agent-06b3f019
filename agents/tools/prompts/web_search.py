"""Prompt for web_search tool."""

PROMPT = """Search the web for real-time information. Use for current events, recent data, fact-checking.

WHEN NOT TO USE:
- Do NOT use directly if spawn_agent(type="explore") is available - explore agents search more thoroughly with multiple queries and cross-referencing.
- Do NOT use for searching user's local data (messages, contacts) - use grep instead.

RETURNS: A search result with answer summary, source URLs, and optional images/links."""
