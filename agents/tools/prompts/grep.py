"""Prompt for grep tool."""

PROMPT = """Search this user's local records and current agent tree.

- `pattern` is a regex over record text. Omit it for metadata-only agent searches.
- `sources` selects one or more sources; omitted defaults: messages, network, agent_network. `gmail` aliases email.
- `agent_trajectories` contains prior user-owned chat, SMS, and Temporal runs, including R2 archives; `agent_network` contains the current tree.
- Typed agent parameters: `role` (USER, ASSISTANT, TOOL), `record_kind` (message, llm_output, llm_context, all), `surface`, `trace_path`, `since`, `until`. Agent parameters without `sources` select agent_trajectories.
- `trace_path` at a root or `/root/...` path spans its subtree; a child id narrows to one agent. For trajectory pages, keep the same query and set `page_after` to `next_page_after`; `order` selects newest_first or oldest_first.
- Other source-specific narrowing goes in `filters`, using the keys its schema lists per source. A flat key applies to every selected source that accepts it; `{"<source>": {...}}` targets one source.
- `calendar` and `drive` search Google Calendar and Drive. Paths are folders and files; omit `pattern` to list or read one.
- Flags: -A after, -B before, -C both, -n line numbers, -i case insensitive, head_limit, offset, multiline.
- Results include trace_path, message_role, agent_title, timestamps, and nearby text.
- Use web_search for the public web. A "source not connected" notice means that connector is unavailable. For documents, require_source_access applies only when the user names the provider."""
