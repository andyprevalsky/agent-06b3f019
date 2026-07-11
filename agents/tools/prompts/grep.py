"""Prompt for grep tool."""

PROMPT = """Search local data sources for information specific to this agent network or user.

Usage:
- Do not use this for the public web, use web_search instead.
- `pattern` is a regular expression. Plain text works for literal searches.
- `sources` is a list — pick the SPECIFIC source(s) the task needs. Omit it to search the local defaults (messages, network, agent_network).
- Supported sources: email, imessage, whatsapp, sms (the user's communication channels), messages (umbrella over all channels), network, agent_network, transactions, documents.
- Prefer the concrete channel when you know it (e.g. `sources=["email"]` for email, `sources=["imessage"]`, `sources=["email","imessage"]` for both). Use `messages` only when the channel is genuinely unknown. `gmail` is a legacy alias for `email`.
- If a named source's connector isn't connected, the search returns a "source not connected" notice and Rose automatically asks the user to connect it — do NOT retry that source; report what you could and could not reach.
- For `source="documents"` provider checks, set `require_source_access=true` only when the user explicitly needs that provider (for example "check Notes" or "look in Claude exports"). Leave it false/omitted for opportunistic preference searches; missing provider access should not block those tasks.
- Grep-style flags: -A lines after, -B lines before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- Use nested `filters` for source-specific narrowing. For messages: `person` and `since`. Legacy top-level `person` and `since` still work for messages.
- For transactions: `filters.since`, `filters.until`, `filters.account`, `filters.min_amount`, `filters.max_amount`, `filters.status` (`posted`, `pending`, or `all`), and `filters.include_pending_in_totals`.
- Transaction results include row snippets plus full-result aggregate totals by currency. Pending rows are visible, but excluded from totals unless `include_pending_in_totals` is true.
- Use `source="documents"` for the umbrella documents corpus, then choose the concrete provider with `filters.document_source` (`chatgpt`, `claude`, `apple_notes`, or `obsidian`). For document provider aliases, use `chatgpt` for ChatGPT exports and `apple_notes` for Notes. Source-connect gates are raised for the concrete provider, not for the umbrella `documents` source.

Returns:
- matching records with surrounding context and location metadata. agent_network matches include the message role."""
