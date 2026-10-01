"""Prompt for grep tool."""

PROMPT = """Search this user's local data and current agent tree.

- `pattern` is a regex; plain text works. Use web_search for the public web.
- Pick relevant `sources`; omitted defaults: messages, network, agent_network. Prefer a channel (`email`, `imessage`) to the messages umbrella; `gmail` aliases email.
- `agent_trajectories` searches prior user chat, SMS, and Temporal runs, including R2 archives. It excludes active runs. `agent_network` covers the current tree.
- For past user messages to agents, search `agent_trajectories` alone with filters.role=USER and filters.record_kind=message. Match words in the message, not labels.
- Flags: -A after, -B before, -C both, -n lines, -i case insensitive, head_limit, offset, multiline.
- `filters`: messages (person, since); agent_trajectories (path, since, until, role, surface, record_kind); transactions (since, until, account, min_amount, max_amount, status, include_pending_in_totals); documents (document_source, since, until, path, tag). Pending transactions are excluded from totals unless requested.
- Trajectory record_kind: message (stored), llm_output (model reply), llm_context (possibly replayed input), all (full corpus). Default includes messages and outputs, newest first.
- For prior-run facts, prefer direct messages over later summaries. Cite the returned trace_path and message_role; agent_title is not a role.
- A "source not connected" notice means stop retrying that connector. For documents, require_source_access only when the user names the provider.

Returns matching records with context and location."""
