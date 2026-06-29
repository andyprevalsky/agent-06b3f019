"""Prompt for grep tool."""

PROMPT = """Use this tool to search across local data sources for information specific to this agent network or this user.

Usage:
- Do not use this for the public web, use web_search instead.
- `pattern` is a regular expression. Plain text works for literal searches.
- `source` is optional. Omit it to search messages, network, and agent_network.
- Supported sources: messages, network, agent_network.
- Grep-style flags: -A lines after, -B lines before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- messages-only narrowing: `person` (email, phone, or full name) scopes to one contact; `since` (ISO 8601, or relative like 7d/24h/30m) limits to recent messages. Both are ignored for network and agent_network.

Returns:
- matching records with surrounding context and location metadata. agent_network matches include the message role."""
