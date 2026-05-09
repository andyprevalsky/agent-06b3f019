"""param_populator domain — constants and configuration."""

from utils.prompts import SELF_CONTAINED_GOAL_RULE

# Model used for parameter population (cheap one-shot call)
PARAM_POPULATOR_MODEL = "rose-labs/rose-1-lite"

# LLM generation settings
TEMPERATURE = 0.38
MAX_TOKENS = 4096
REASONING_MAX_TOKENS = 2048

# Call-site identifier for telemetry / cost tracking
CALL_SITE = "dag_param_populator"

# ── Spawn-type-specific parameter requirements ───────────────────────────
# Keyed by the alias_hint value passed from the planner (e.g. "spawn_explore_agent").
# Appended to the system prompt so the LLM knows which fields are required
# for each spawn type.

_SELF_CONTAINED_GOAL = SELF_CONTAINED_GOAL_RULE.strip()

SPAWN_PARAM_REQUIREMENTS: dict[str, str] = {
    "spawn_explore_agent": f"""
SPAWN TYPE: explore
- Set type="explore"
- Required: goal (str)
- Do NOT provide output_schema, start_url, or github_repo_link
- Explore agents return free-form research summaries

# Self-Contained Goal
{_SELF_CONTAINED_GOAL}

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- For explore agents, two gates apply:
  - "network": false skips injecting 500-contact network metadata into explore prompt
  - "recent_communications": false skips local message thread summary
- Use for pure web research tasks that don't need the user's contacts or messages
- Example: context_gates: {{"network": false, "recent_communications": false}}""",
    "spawn_browser_agent": f"""
SPAWN TYPE: browser
- Set type="browser"
- Required: goal (str), start_url (str), output_schema (object with field names -> types)
- output_schema is required, define the structured data you expect back
- Example output_schema: {{"order_confirmation": "str", "total_price": "str"}}

# Self-Contained Goal
{_SELF_CONTAINED_GOAL}""",
    "spawn_code_agent": f"""
SPAWN TYPE: code
- Set type="code"
- Required: goal (str), output_schema (object with field names -> types)
- output_schema is required, define the structured data you expect back
- Optional: github_repo_link (str), attachments (list of filenames)
- Example output_schema: {{"result": "str", "generated_file": "file_pointer"}}

# Self-Contained Goal
{_SELF_CONTAINED_GOAL}""",
    "spawn_sub_agent": f"""
SPAWN TYPE: sub_agent
- Set type="sub_agent"
- Required: goal (str), output_schema (object with field names -> types)
- output_schema is required, define the structured data you expect back
- Required by policy: start_phase ("PLAN" or "EXECUTE")
  - "EXECUTE" for clear direct tasks expected to need 1-2 tool calls
  - "PLAN" for complex tasks expected to need 3+ tool calls, research, comparison, or multi-step coordination
  - when in doubt, prefer "PLAN"
- Optional: attachments (list of filenames), context_gates (object)
- Example output_schema: {{"summary": "str", "findings": "list[str]"}}

# Self-Contained Goal
{_SELF_CONTAINED_GOAL}
BAD: "Book the boxing class", sub-agent has no idea which class, where, or for whom
GOOD: "Book the 6pm Tuesday boxing class at Dallas MMA (2000 Main St). Name: Andy, phone: 555-1234. Monthly membership, $150/mo."

SUB-AGENT TOOLS:
Sub-agents have access to the full EXECUTE phase toolset: spawn_agent (browser, code, sub_agent, explore),
wait_for, call_phone_number, message_person, attempt_completion.

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- Controls which user context sections the sub-agent receives
- Keys: user_profile, authenticated_sessions, integrations, recent_communications, network, custom_system_prompt, shared_files
- Only set a gate to false when you are certain the sub-agent does NOT need that context to accomplish its goal
- Default is all true; when in doubt, leave gates open
- Use your best judgment based on the goal. These examples are non-comprehensive:
  - A browser purchase task probably doesn't need network or recent_communications
  - A code/data task probably doesn't need network or recent_communications
  - A communication task (email/SMS) likely needs everything, especially network + recent_communications
  - shared_files controls whether file attachments are resolved into the LLM context
- Example: context_gates: {{"network": false, "recent_communications": false}}""",
    "spawn_sub_agent_for_each": f"""
SPAWN TYPE: for_each
- Set type="for_each"
- Required: goal (str), output_schema (object with field names -> types), and either:
  - items (list), OR
  - items_csv (string)
- The goal is shared across all rows/items; for_each applies it once per row/item downstream
- Downstream behavior: one spawn_sub_agent child is started per row/item goal
- Required by policy: start_phase ("PLAN" or "EXECUTE")
  - "EXECUTE" for clear direct tasks expected to need 1-2 tool calls
  - "PLAN" for complex tasks expected to need 3+ tool calls, research, comparison, or multi-step coordination
  - when in doubt, prefer "PLAN"
- Optional: attachments (list of filenames), context_gates (object)
- Keep for_each lightweight: same high-level goal + one child per item/row

# Self-Contained Goal
{_SELF_CONTAINED_GOAL}

FOR_EACH CHILD TOOLS:
Each child has access to the full EXECUTE phase toolset: spawn_agent (browser, code, sub_agent, explore),
wait_for, call_phone_number, message_person, attempt_completion.

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- Only set a gate to false when certain the for_each children do NOT need that context
- Keys: user_profile, authenticated_sessions, integrations, recent_communications, network, custom_system_prompt, shared_files
- Example: context_gates: {{"network": false, "recent_communications": false}}""",
}
