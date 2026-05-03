"""Prompt for web_search tool."""

PROMPT = """Searches the web for real-time public information and returns snippet results.

Usage:
- Use for quick factual lookups (definitions, news, prices) where one query suffices.
- Use for reconnaissance before deciding whether to fetch a specific URL.
- Do not use for multi-step research with cross-referencing - prefer spawn_explore_agent.
- Do not use to read a specific URL's content - use web_fetch.
- Do not use to search local data (contacts, messages) - use grep."""
