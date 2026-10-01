"""Prompt for grep tool."""

PROMPT = """Search this user's local data and the current agent tree.

Usage:
- Public web: use web_search. `pattern` is a regex; plain text also works.
- Pick `sources` for the task; omitted defaults: messages, network, agent_network. Prefer a channel such as `email` or `imessage` to the messages umbrella; `gmail` aliases email.
- `agent_trajectories`: prior user chat, SMS, and Temporal runs, including R2; excludes active runs. Use it for earlier agents. `agent_network` covers only the current tree. Select the relevant source rather than combining these two for a prior-run search.
- A "source not connected" notice means stop retrying that connector; report what was reachable.
- Flags: -A after, -B before, -C both, -n lines, -i case insensitive, head_limit, offset, multiline.
- Nested `filters`: messages (`person`, `since`); agent_trajectories (`path`, `since`, `until`, `role`, `surface`, `record_kind`); transactions (`since`, `until`, `account`, `min_amount`, `max_amount`, `status`=posted/pending/all, `include_pending_in_totals`); documents (`document_source`=chatgpt/claude/apple_notes/obsidian, `since`, `until`, `path`, `tag`). Pending transactions are excluded from totals unless `include_pending_in_totals=true`.
- Trajectory `record_kind`: `message` is a stored agent message; `llm_output` is a model response; `llm_context` is text passed to a model and may replay earlier turns. Ordinary results include messages and outputs, newest first. Set `record_kind=llm_context` for replayed inputs, or `record_kind=all` for the full corpus.
- If a result only summarizes an action, search for the underlying message before reporting it as direct evidence.
- Trajectory `pattern` matches message text, not labels such as tool_status; filter metadata by role or surface.
- For each trajectory fact in the final answer, cite its exact trace_path and message_role (USER, ASSISTANT, or TOOL). The agent_title and root/child labels are not message roles.
- Document access checks use the concrete `document_source`; set `require_source_access=true` only when the user names it.

Returns:
- Matching records with context and location; agent_network matches include message roles."""
