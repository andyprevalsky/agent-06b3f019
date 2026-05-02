"""Prompt for grep tool."""

PROMPT = """Searches the user's local data (messages, contact network, agent network) by case-insensitive substring.

Usage:
- source="messages" searches iMessage/email threads; supports person_id and since filters.
- source="network" searches the contact database (name, phone, email, company, title, relation).
- source="agent_network_user_messages" searches user messages across all agents in this workflow tree.
- source="agent_network_tool_results" searches tool results across all agents in this workflow tree.
- pattern is plain-text (NOT regex), case-insensitive; pass "" to return all records.
- Do not use this for the public web - use web_search or spawn_explore_agent.
- Returns matching records with surrounding context (like grep -C)."""
