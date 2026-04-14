"""set-plan domain config -- constants, defaults."""

# Maximum planner LLM retry attempts on validation failure
MAX_RETRIES = 2

# Planner always uses rose-ultra for best DAG generation quality
PLANNER_MODEL = "rose-labs/rose-1-ultra"

# Temporal activity timeouts (seconds)
PLANNER_ACTIVITY_TIMEOUT_SECONDS = 240
PLANNER_ACTIVITY_MAX_ATTEMPTS = 2

SCHEMA_ACTIVITY_TIMEOUT_SECONDS = 90
SCHEMA_ACTIVITY_MAX_ATTEMPTS = 3

# Default goal when no user messages found
DEFAULT_GOAL = "Complete the user's request"

# Manual descriptions for planner-facing tool names (mapped to spawn_agent via DAG aliases)
PLANNING_TOOL_DESCRIPTIONS: dict[str, str] = {
    "spawn_explore_agent": (
        "Research agent for information gathering (web search, web fetch, message search across"
        " iMessage/email, read user memories/profile). Returns free-form summary."
    ),
    "spawn_browser_agent": (
        "Web automation agent for purchases, forms, JS-heavy sites. Needs start_url."
        " Do NOT use for sending emails -- use message_person instead."
    ),
    "spawn_code_agent": "Coding agent in ephemeral E2B sandbox. Optional github_repo_link.",
    "spawn_sub_agent": (
        "Delegate ONE complex task to a child agent with its own planning cycle. Use for a single"
        " multi-step job (e.g., 'research and book a venue'). NOT for repeated work across a list"
        " - use spawn_sub_agent_for_each instead."
    ),
    "spawn_sub_agent_for_each": (
        "Apply the SAME task to MANY items (list or CSV). Spawns one sub-agent per item/row with"
        " a shared goal. Use instead of spawn_sub_agent whenever the work is repeated across a"
        " list of inputs (e.g., 'look up each company', 'email each person', 'process each row"
        " in the CSV')."
    ),
    "reasoning": (
        "Pure thinking/analysis step with no external tool call. Use for synthesizing results or making decisions."
    ),
    "wait_for": (
        "Wait until a timestamp or condition is met. Timestamp mode: provide until_timestamp"
        " (ISO 8601). Condition mode: provide condition (natural language) +"
        " check_interval_seconds + max_checks. Explore agents periodically check the condition."
        " Use for polling/monitoring tasks (e.g., 'check every 15 min if package delivered')."
    ),
    "message_person": (
        "Send a message to a person via iMessage or email. Provide a person identifier"
        " (name, phone, or email) and describe the intent -- the tool generates the message,"
        " reads conversation history, and requests user approval before sending."
        " Use this for ALL email and messaging tasks."
    ),
    "call_phone_number": (
        "Make an outbound phone call to extract structured data via voice AI."
        " Provide a phone number, system prompt, and output schema."
    ),
    "send_message_to_user_execute_phase": (
        "Send an informational message back to the user during execution (non-blocking). Use for status updates."
    ),
}
