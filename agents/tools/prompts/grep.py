"""Prompt for grep tool."""

PROMPT = """Search local data sources for information specific to this agent network or user.

Usage:
- Do not use this for the public web, use web_search instead.
- `pattern` is a regular expression. Plain text works for literal searches.
- `sources` is a list, pick the specific source(s) the task needs; omit it to search the local defaults (messages, network, agent_network). Prefer a concrete channel (e.g. `sources=["email"]`, `sources=["email","imessage"]`) over the `messages` umbrella. `gmail` is a legacy alias for `email`.
- If a named source's connector is not connected, the search returns a "source not connected" notice and Rose asks the user to connect it; do NOT retry that source, report what you could and could not reach.
- Grep-style flags: -A after, -B before, -C/context both sides, -n line numbers, -i case-insensitive, head_limit, offset, multiline.
- Use nested `filters` for source-specific narrowing. Messages: `person`, `since`. Transactions: `since`, `until`, `account`, `min_amount`, `max_amount`, `status` (`posted`/`pending`/`all`), `include_pending_in_totals` (pending rows show but are excluded from currency totals unless true). Documents: `document_source` (`chatgpt`, `claude`, `apple_notes`, `obsidian`), `since`, `until`, `path`, `tag`.
- For `documents`, source-connect gates are raised for the concrete `document_source` provider, not the umbrella; set `require_source_access=true` only when the user explicitly names that provider.

Returns:
- matching records with surrounding context and location metadata. agent_network matches include the message role."""
