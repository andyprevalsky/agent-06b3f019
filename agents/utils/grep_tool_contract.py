"""The one grep tool contract: its description and its per-source filter keys.

Every grep surface reads these values. The explore agent's native tool and the
planner use them through ``utils.tool_schemas.GrepTool``. The SMS supervisor
and web chat read the definition generated from that model
(``scripts/grep_tool_definition.py`` writes
``back-end/src/providers/grepTool/grepToolDefinition.json``), so a change here
must be regenerated; ``tests/blackbox/grep.blackbox.py`` fails on any drift.
"""

GREP_TOOL_PROMPT = """Search your records, explicitly shared team communication accounts, and current agent tree.

- Default scope is `all` (own plus explicit direct team account grants). Use `scope="own"` for personal-only or `scope="shared"` for shared-only; `team_id`, `owner_user_id`, and `account_id` narrow results before counting/paging. Result ownership identifies each owner, account and team. Never infer sharing from a shared project or access another owner's credentials/iPhone.
- `pattern` is a regex over record text. Omit it for metadata-only agent searches.
- `sources` selects one or more sources; omitted defaults: messages, network, agent_network. `gmail` aliases email.
- `shared_project_agents` lists/searches titles, statuses and project names in explicitly shared projects. Omit pattern to list; use filters.project_id and offset/head_limit to page. It never reads goals, trajectories, credentials or environment.
- `agent_trajectories` contains prior user-owned chat, SMS, and Temporal runs, including R2 archives; `agent_network` contains the current tree.
- Typed agent parameters: `role` (USER, ASSISTANT, TOOL), `record_kind` (message, llm_output, llm_context, all), `surface`, `trace_path`, `since`, `until`. Agent parameters without `sources` select agent_trajectories.
- `trace_path` at a root or `/root/...` path spans its subtree; a child id narrows to one agent. For trajectory pages, keep the same query and set `page_after` to `next_page_after`; `order` selects newest_first or oldest_first.
- Other source-specific narrowing goes in `filters`, using the keys its schema lists per source. A flat key applies to every selected source that accepts it; `{"<source>": {...}}` targets one source.
- `calendar` and `drive` search Google Calendar and Drive. Paths are folders and files; omit `pattern` to list or read one.
- Flags: -A after, -B before, -C both, -n line numbers, -i case insensitive, head_limit, offset, multiline.
- Results include trace_path, message_role, agent_title, timestamps, and nearby text.
- Use web_search for the public web. A "source not connected" notice means that connector is unavailable. For documents, require_source_access applies only when the user names the provider."""

# Filter keys each grep source accepts. Mirrors back-end DATA_SOURCE_CONFIGS
# (src/domains/data/types.ts); grep.blackbox.py fails if they differ.
GREP_SOURCE_FILTER_KEYS = {
    "messages": ("person", "since", "path"),
    "gmail": ("person", "since", "path"),
    "email": ("person", "since", "path"),
    "imessage": ("person", "since", "path"),
    "whatsapp": ("person", "since", "path"),
    "network": ("path",),
    "shared_project_agents": ("project_id", "path"),
    "agent_network": ("path", "role"),
    "agent_trajectories": ("path", "since", "until", "role", "surface", "record_kind"),
    "transactions": (
        "path",
        "since",
        "until",
        "account",
        "min_amount",
        "max_amount",
        "status",
        "include_pending_in_totals",
    ),
    "documents": ("document_source", "since", "until", "path", "tag"),
    "calendar": ("since", "until", "path"),
    "drive": ("since", "until", "path"),
}
