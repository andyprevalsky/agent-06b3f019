"""Prompt for grep tool."""

PROMPT = """Search this user's local data and the current agent tree.

Usage:
- Public web: use web_search. `pattern` is a regex; plain text also works.
- Pick `sources` for the task; omitted defaults: messages, network, agent_network. Prefer a channel such as `email` or `imessage` to the messages umbrella; `gmail` aliases email.
- `agent_trajectories`: prior user chat, SMS, and Temporal runs, including R2; excludes active runs. `agent_network`: current tree.
- A "source not connected" notice means stop retrying that connector; report what was reachable.
- Flags: -A after, -B before, -C both, -n lines, -i case insensitive, head_limit, offset, multiline.
- Nested `filters`: messages (`person`, `since`); agent_trajectories (`path`, `since`, `until`, `role`, `surface`); transactions (`since`, `until`, `account`, `min_amount`, `max_amount`, `status`=posted/pending/all, `include_pending_in_totals`); documents (`document_source`=chatgpt/claude/apple_notes/obsidian, `since`, `until`, `path`, `tag`). Pending transactions are excluded from totals unless `include_pending_in_totals=true`.
- Trajectory `pattern` matches message text, not labels such as tool_status; filter metadata by role or surface.
- For each trajectory fact in the final answer, cite its exact trace_path and message_role (USER, ASSISTANT, or TOOL). The agent_title and root/child labels are not message roles.
- Document access checks use the concrete `document_source`; set `require_source_access=true` only when the user names it.

Returns:
- Matching records with context and location; agent_network matches include message roles."""
