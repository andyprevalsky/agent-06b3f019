"""Prompt for spawn_agent tool."""

PROMPT = """Spawn an autonomous agent. Set type to determine capabilities:

type="explore": Research agent for ALL information gathering (web search, web fetch, user memories).
  Just provide a goal string - the explore agent searches thoroughly and returns a summary.
  Use this for ANY research, fact-finding, or data gathering task.
  ALWAYS use explore for information needs - do NOT use web_search/web_fetch directly.
  Explore agents can also read the user's stored memories and profile via read_memories.

type="browser": Ephemeral session. 25-step limit. For short web trajectories (purchases, forms, JS-heavy sites).
  Requires: start_url, output_schema. Do NOT use for information gathering - use explore.
  IMPORTANT: Browser cookies are ONLY synced for the start_url domain.

type="code": Ephemeral sandbox. For coding tasks: code execution, data processing, file generation.
  Requires: output_schema. Each agent = ONE focused task under 10 minutes.
  Use type='file_pointer' in output_schema for generated files.

type="sub_agent": Delegate complex tasks with own planning cycle. Run concurrently.
  Requires: output_schema. Use for parallel work or decomposing complex goals.
  start_phase is REQUIRED by policy:
  - start_phase="execute" for clear direct tasks expected to need 1-2 tool calls
  - start_phase="plan" for complex tasks expected to need 3+ tool calls, research, comparison, or multi-step coordination
  - when in doubt, prefer "plan"

type="for_each": Fan out one sub-agent per item/row from a list or CSV.
  Requires: output_schema and either items (list) or items_csv (string).
  The same shared goal is applied to every row/item, with row context appended per child goal.
  Downstream this executes one spawn_sub_agent child for each row/item goal.
  All children share the same parent bus/tree.
  start_phase follows the same criteria as sub_agent.
  USE THIS whenever the same task must be repeated across multiple items (research each company, email each person, process each row).

WHEN NOT TO USE:
- Do NOT use type="browser" for information gathering - use type="explore" instead.
- Do NOT split stateful web flows across multiple spawn_agent(type="browser") calls - sessions are ephemeral, cart/auth state is lost between calls.
- Do NOT use multiple spawn_agent(type="sub_agent") for repeated work across a list - use type="for_each" instead.

RETURNS: Structured output matching the output_schema (for browser/code/sub_agent/for_each), or a free-form summary string (for explore).

EXCLUSIVITY: This tool CAN be batched with other tool calls. Multiple spawn_agent calls in one response execute in parallel.

<bad-example>
spawn_agent(type="browser", goal="Login to site")
spawn_agent(type="browser", goal="Add item to cart")  SESSION LOST! Starts fresh.
</bad-example>

<good-example>
spawn_agent(type="explore", goal="Find pricing for Acme Corp enterprise plans")
spawn_agent(type="browser", start_url="https://x.com", goal="Login, post tweet, logout", output_schema=...)
</good-example>"""
