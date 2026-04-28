"""Prompt for read_memories tool."""

PROMPT = """Search the user's stored memories and profile for relevant context. Use this early in research to check if relevant context already exists before searching the web.

Provide a specific query to find matching memories, or leave query empty to get the full user profile. The profile contains static facts (expertise, preferences) and dynamic context (recent activity, current projects).

WHEN NOT TO USE:
- Do NOT use for searching message threads - use grep instead.
- Do NOT use for web research - use web_search or spawn_agent(type="explore") instead.

RETURNS: Matching memories as text, or the full user profile if query is empty. Includes preferences, past decisions, and context from previous agents."""
