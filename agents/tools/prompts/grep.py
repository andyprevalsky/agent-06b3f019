"""Prompt for grep tool."""

PROMPT = """Search user's local data (message threads, contact network, agent network) by keyword.

Sources:
- "messages" (default): Search iMessage and email conversation threads. Optional filters: person_id (scope to one thread), since (ISO 8601 timestamp cutoff).
- "network": Search the full contact database by name, phone, email, company, title, relation. Pattern matches any field (case-insensitive substring).
- "agent_network_user_messages": Search user messages across all agents in this workflow tree.
- "agent_network_tool_results": Search tool results (research findings, search results) across all agents.

Pattern is plain text (not regex). Use empty string '' to return all records without filtering.

WHEN NOT TO USE:
- Do NOT use for web searches - use web_search or spawn_agent(type="explore") instead.
- Do NOT use for reading stored memories/preferences - use read_memories instead.

RETURNS: Matching records with surrounding context (like grep -C). For messages: matching messages with thread context. For network: matching contacts with metadata."""
