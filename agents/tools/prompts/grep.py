"""Prompt for grep tool."""

PROMPT = """Search local data sources for information specific to this agent network or user.

Usage:
- Do not use this for the public web, use web_search instead.
- `pattern` is a regular expression. Plain text works for literal searches.
- `source` is optional. Omit it to search messages, network, and agent_network.
- Supported sources: messages, network, agent_network, transactions, documents.
- Grep-style flags: -A lines after, -B lines before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- Use nested `filters` for source-specific narrowing. For messages: `person` and `since`. Legacy top-level `person` and `since` still work for messages.
- For transactions: `filters.since`, `filters.until`, `filters.account`, `filters.min_amount`, `filters.max_amount`, `filters.status` (`posted`, `pending`, or `all`), and `filters.include_pending_in_totals`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless `include_pending_in_totals` is true.
- Use `source="documents"` for synced ChatGPT/Claude exports, Apple Notes, Obsidian vault notes, and generic text documents. For documents: `filters.document_source` (`chatgpt`, `claude`, `apple_notes`, `obsidian`), `filters.since`, `filters.until`, `filters.path`, and `filters.tag`.

Returns:
- matching records with surrounding context and location metadata. agent_network matches include the message role."""
