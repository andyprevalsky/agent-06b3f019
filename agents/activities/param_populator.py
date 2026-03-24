"""
Parameter Populator Activity - Populate tool parameters using LLM.

Given a tool name and goal, calls LLM with full context to generate
the appropriate parameters for the tool call.

Uses the SAME call_llm_structured_streaming function as run_agent to ensure
consistent behavior between DAG execution and the main agent loop.
"""

from typing import Dict, List, Any, Optional
from temporalio import activity
import structlog

from helpers.llm import call_llm_structured_streaming, build_llm_messages
from helpers.tool_schemas import TOOL_MODELS, create_agent_action_model

logger = structlog.get_logger()


def _build_agent_system_prompt(tool_name: str, goal: str, alias_hint: str = "") -> str:
    """
    Build a full agent-style system prompt for parameter population.

    Args:
        tool_name: Name of the tool to call
        goal: The task goal
        alias_hint: Original alias name (e.g. 'spawn_sub_agent') for type-specific instructions

    Returns:
        System prompt string
    """
    prompt = f"""You are an AI agent executing a specific task from a plan. Your role is to ensure that the Required Tool is called with exactly the parameters necessary in order to complete the Goal below. The Goal below is the objective that the tool you are calling must accomplish — for agent-spawning tools, this means the Goal becomes the spawned agent's mission.

When calling a tool that creates an agent, the parameters you pass are the ONLY context that agent will have. If you mention a file but don't include that file-pointer in attachments, the agent will NOT have access to that file. You may not assume any context gets transferred over — if there is context from the conversation that the agent will rely on to complete its goal, you MUST reiterate that context in the goal string. This is very important.

You will be graded:
- points are deducted for including context that is not necessary to the goal in the goal string.
- points are deducted for NOT including context that is necessary to the goal in the goal string.
- points are deducted for adding new information that was NOT previously mentioned in any context fed to you.
- points are deducted if the goal string you output does not adhere to the Goal below. Do not change the intention of the goal even if it is against your better judgment.

CURRENT TASK:
Goal: {goal}
Required Tool: {tool_name}

INSTRUCTIONS:
1. Analyze the Goal and the conversation context
2. Call the {tool_name} tool with parameters that will accomplish the Goal
3. You should explain your reasoning
4. You MUST call exactly one tool: {tool_name}
5. Do NOT skip the tool call even if the goal appears already accomplished in context"""

    # Add type-specific param requirements for spawn_agent aliases
    SPAWN_PARAM_REQUIREMENTS = {
        "spawn_explore_agent": """
SPAWN TYPE: explore
- Set type="explore"
- Required: goal (str)
- Do NOT provide output_schema, verifier, start_url, or github_repo_link
- Explore agents return free-form research summaries

SELF-CONTAINED GOAL (CRITICAL):
The explore agent has NO access to your conversation or prior context.
The goal string is its ONLY source of information. Embed ALL relevant details:
specifics of what to research, constraints, and any prior findings it should build on.

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- For explore agents, two gates apply:
  - "network": false skips injecting 500-contact network metadata into explore prompt
  - "recent_communications": false skips local message thread summary
- Use for pure web research tasks that don't need the user's contacts or messages
- Example: context_gates: {"network": false, "recent_communications": false}""",
        "spawn_browser_agent": """
SPAWN TYPE: browser
- Set type="browser"
- Required: goal (str), start_url (str), output_schema (object with field names → types)
- output_schema MUST be provided — define the structured data you expect back
- Example output_schema: {"order_confirmation": "str", "total_price": "str"}

SELF-CONTAINED GOAL (CRITICAL):
The browser agent has NO access to your conversation or prior context.
The goal string is its ONLY source of information. Include ALL details needed to
complete the web task: what to click, what to fill in, names, addresses, selections, etc.""",
        "spawn_code_agent": """
SPAWN TYPE: code
- Set type="code"
- Required: goal (str), output_schema (object with field names → types)
- output_schema MUST be provided — define the structured data you expect back
- Optional: github_repo_link (str), attachments (list of filenames)
- Example output_schema: {"result": "str", "generated_file": "file_pointer"}

SELF-CONTAINED GOAL (CRITICAL):
The code agent has NO access to your conversation or prior context.
The goal string is its ONLY source of information. Include ALL specs, requirements,
and technical details needed to complete the coding task.""",
        "spawn_sub_agent": """
SPAWN TYPE: sub_agent
- Set type="sub_agent"
- Required: goal (str), output_schema (object with field names → types)
- output_schema MUST be provided — define the structured data you expect back
- Required by policy: start_phase ("plan" or "execute")
  - "execute" for clear direct tasks expected to need 1-2 tool calls
  - "plan" for complex tasks expected to need 3+ tool calls, research, comparison, or multi-step coordination
  - when in doubt, prefer "plan"
- Optional: read_only (bool), verifier (object), attachments (list of filenames), context_gates (object)
- Example output_schema: {"summary": "str", "findings": "list[str]"}

SELF-CONTAINED GOAL (CRITICAL):
The sub-agent has NO access to your conversation, user messages, or any prior context.
The goal string is its ONLY source of information. You MUST embed ALL relevant details:
- User preferences, constraints, addresses, names, budget, deadlines
- Prior research findings or results from earlier tasks
- Any specific instructions the user provided that apply to this sub-task
BAD: "Book the boxing class" — sub-agent has no idea which class, where, or for whom
GOOD: "Book the 6pm Tuesday boxing class at Dallas MMA (2000 Main St). Name: Andy, phone: 555-1234. Monthly membership, $150/mo."

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- Controls which user context sections the sub-agent receives
- Keys: user_profile, authenticated_sessions, integrations, recent_communications, network, custom_system_prompt, shared_files
- ONLY set a gate to false when you are 100% certain the sub-agent does NOT need that context to accomplish its goal
- Default is all true - when in doubt, leave gates open
- Use your best judgment based on the goal. These examples are non-comprehensive:
  - A browser purchase task probably doesn't need network or recent_communications
  - A code/data task probably doesn't need network or recent_communications
  - A communication task (email/SMS) likely needs everything, especially network + recent_communications
  - shared_files controls whether file attachments are resolved into the LLM context
- Example: context_gates: {"network": false, "recent_communications": false}""",
        "spawn_sub_agent_for_each": """
SPAWN TYPE: swarm
- Set type="swarm"
- Required: goal (str), output_schema (object with field names → types), and either:
  - items (list), OR
  - items_csv (string)
- The goal is shared across all rows/items; swarm applies it once per row/item downstream
- Downstream behavior: one spawn_sub_agent child is started per row/item goal
- Required by policy: start_phase ("plan" or "execute")
  - "execute" for clear direct tasks expected to need 1-2 tool calls
  - "plan" for complex tasks expected to need 3+ tool calls, research, comparison, or multi-step coordination
  - when in doubt, prefer "plan"
- Optional: read_only (bool), verifier (object), attachments (list of filenames), context_gates (object)
- Keep swarm lightweight: same high-level goal + one child per item/row

SELF-CONTAINED GOAL (CRITICAL):
Each swarm child has NO access to your conversation or prior context.
The goal string (combined with the per-item context) is their ONLY information.
Embed ALL relevant user preferences, constraints, and instructions in the goal.

CONTEXT GATES (compute optimization):
- Optional: context_gates (object with boolean values, default all true)
- ONLY set a gate to false when 100% certain the swarm children do NOT need that context
- Keys: user_profile, authenticated_sessions, integrations, recent_communications, network, custom_system_prompt, shared_files
- Example: context_gates: {"network": false, "recent_communications": false}""",
    }

    if alias_hint in SPAWN_PARAM_REQUIREMENTS:
        prompt += SPAWN_PARAM_REQUIREMENTS[alias_hint]

    prompt += f"""

CRITICAL - FILE OUTPUT SCHEMA RULES:
When defining output_schema fields, if the output is a FILE (image, document, PDF, generated artifact, etc.):
- You MUST use type='file_pointer' for single files
- You MUST use type='list[file_pointer]' for multiple files
- NEVER use type='str' for file paths - files will NOT be transferred!
The file_pointer type enables automatic file transfer from remote environments.

FILE ATTACHMENTS - HOW TO PASS FILES TO SUB-AGENTS:
When using spawn_sub_agent, spawn_claude_code_agent, or spawn_browser_agent:
- Sub-agents do NOT automatically inherit files from your context
- You MUST pass files via the `attachments` parameter
- Use the EXACT `original_filename` value from file_pointer objects in your context
- Example: if you see `"original_filename": "rs.jpeg"` in a file_pointer, use `attachments: ["rs.jpeg"]`
- Do NOT use the file's `id` field, storage_path, or any `file:` prefix format

Execute the task now by calling {tool_name} with the correct parameters."""

    # Add ephemeral session warning for spawn_* tools
    if tool_name.startswith("spawn_"):
        prompt += """

EPHEMERAL SESSION WARNING:
This tool creates a NEW session that does not persist. Any login state, cookies, or context
from previous calls will NOT be available. Include ALL necessary steps in a single goal
(e.g., "Login, add to cart, checkout" - not separate calls for each step)."""

    return prompt


@activity.defn
async def populate_tool_params_activity(
    tool_name: str,
    goal: str,
    context: List[Dict],
    model: str,
    alias_hint: str = "",
    claude_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Populate tool parameters using LLM based on context.

    Uses the SAME call_llm_structured_streaming function as run_agent to ensure
    consistent behavior. The LLM outputs a response + tool_calls array,
    and we extract the single tool call for the specified tool.

    Args:
        tool_name: Name of the tool to populate params for
        goal: The task goal from the plan
        context: Full message context
        model: LLM model to use (inherited from parent agent)
        alias_hint: Original alias name (e.g. 'spawn_sub_agent') for type-specific prompt instructions
        claude_token: Optional Claude OAuth token for direct Anthropic calls

    Returns:
        Dict with tool parameters ready for execution
    """
    # Get the Pydantic model for this tool
    if tool_name not in TOOL_MODELS:
        logger.error(f"[ParamPopulator] Unknown tool: {tool_name}")
        raise ValueError(f"Unknown tool: {tool_name}")

    # Create AgentAction model with only the target tool available
    # This constrains the LLM to only call the tool we need
    AgentAction = create_agent_action_model([tool_name])

    # Use rose-1-lite waterfall for param population (cheap one-shot call)
    model = "rose-labs/rose-1-lite"

    # Build system prompt (full agent style, not just extraction)
    system_prompt = _build_agent_system_prompt(tool_name, goal, alias_hint)

    # Use build_llm_messages which handles file attachments (images, PDFs, etc.)
    # This ensures the LLM can see attached files and their filenames
    messages = await build_llm_messages(context, system_prompt)

    # Append final instruction to execute the task
    messages.append({"role": "user", "content": f"Execute the task: {goal}"})

    activity.heartbeat("Calling LLM for parameter population")

    try:
        # No-op callback since we don't need streaming for param population
        async def noop_callback(text_so_far: str, token_count: int):
            pass

        pydantic_result, usage, detected_tools_ordered = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=0.38,
            max_tokens=4096,
            response_model=AgentAction,
            on_chunk=noop_callback,
            reasoning_max_tokens=2048,
            skip_cache=True,  # Unique system prompt per call — no cache reuse
            call_site="dag_param_populator",
        )

        # Extract tool calls from the Pydantic result
        tool_calls = []
        if pydantic_result.tool_calls:
            for tc in pydantic_result.tool_calls:
                if tc is not None:
                    tool_calls.append(tc.model_dump())

        if not tool_calls:
            raise ValueError(f"LLM did not call any tools. Response: {pydantic_result.response[:200] if pydantic_result.response else 'empty'}")

        # Find the tool call for our target tool
        tool_call = None
        for tc in tool_calls:
            if tc.get("tool") == tool_name:
                tool_call = tc
                break

        if not tool_call:
            # Use first tool call if it exists (shouldn't happen with constrained schema)
            tool_call = tool_calls[0]
            logger.warning(
                f"[ParamPopulator] Expected tool {tool_name}, got {tool_call.get('tool')}",
                tool_calls=tool_calls,
            )

        # Remove 'tool' field from params (added during execution)
        params = {k: v for k, v in tool_call.items() if k != "tool"}

        # Validate required fields are non-empty
        tool_model = TOOL_MODELS[tool_name]
        model_schema = tool_model.model_json_schema()
        required = model_schema.get("required", [])
        for field in required:
            if field == "tool":
                continue
            value = params.get(field)
            if value is None or (isinstance(value, str) and not value.strip()):
                raise ValueError(f"Required field '{field}' is empty. Goal was: {goal}")

        logger.info(
            f"[ParamPopulator] Populated params for {tool_name}",
            params=params,
            response=pydantic_result.response[:100] if pydantic_result.response else "",
            tokens=usage.get("total_tokens", 0),
        )
        return {"params": params, "usage": usage}

    except Exception as e:
        logger.error(f"[ParamPopulator] Error: {e}", tool_name=tool_name, goal=goal)
        raise
