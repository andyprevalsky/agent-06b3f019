"""Prompt for grep tool."""

PROMPT = """Search this user's local data and the current agent tree.

Usage:
- Public web: use web_search. `pattern` is a regex; plain text also works.
- Pick `sources` for the task; omitted defaults: messages, network, agent_network. Prefer a channel such as `email` or `imessage` to the messages umbrella; `gmail` aliases email.
- Use `agent_trajectories` for this user's prior chat, SMS, and Temporal agent runs, including R2 archives. Active runs are excluded. `agent_network` is the current tree, not prior history.
- A "source not connected" notice means stop retrying that connector; report what was reachable.
- Flags: -A after, -B before, -C both, -n lines, -i case insensitive, head_limit, offset, multiline.
- Nested `filters`: messages (`person`, `since`); agent_trajectories (`path`, `since`, `until`, `role`, `surface`); transactions (`since`, `until`, `account`, `min_amount`, `max_amount`, `status`=posted/pending/all, `include_pending_in_totals`); documents (`document_source`=chatgpt/claude/apple_notes/obsidian, `since`, `until`, `path`, `tag`). Pending transactions are excluded from totals unless `include_pending_in_totals=true`.
- In the final answer, cite each trajectory fact with its exact returned path and message role. An uncited fact is incomplete. Root/child is an agent-tree label, not a message role.
- Document access checks use the concrete `document_source`; set `require_source_access=true` only when the user names it.

Returns:
- Matching records with context and location; agent_network matches include message roles."""
