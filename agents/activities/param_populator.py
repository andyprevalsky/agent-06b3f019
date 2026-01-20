"""
Parameter Populator Activity - Populate tool parameters using LLM.

Given a tool name and goal, calls LLM with full context to generate
the appropriate parameters for the tool call.

Uses the SAME call_llm_structured_streaming function as run_agent to ensure
consistent behavior between DAG execution and the main agent loop.
"""

from typing import Dict, List, Any
from temporalio import activity
import structlog

from helpers.llm import call_llm_structured_streaming, build_llm_messages
from helpers.tool_schemas import TOOL_MODELS, create_agent_action_model

logger = structlog.get_logger()


def _build_agent_system_prompt(tool_name: str, goal: str) -> str:
    """
    Build a full agent-style system prompt for parameter population.

    Args:
        tool_name: Name of the tool to call
        goal: The task goal

    Returns:
        System prompt string
    """
    prompt = f"""You are an AI agent executing a specific task from a plan.

CURRENT TASK:
Goal: {goal}
Required Tool: {tool_name}

INSTRUCTIONS:
1. Analyze the goal and the conversation context
2. Call the {tool_name} tool with appropriate parameters to accomplish the goal
3. Your response field should briefly explain your reasoning
4. You MUST call exactly one tool: {tool_name}
5. Do NOT skip the tool call even if the goal appears already accomplished in context

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

    # Build system prompt (full agent style, not just extraction)
    system_prompt = _build_agent_system_prompt(tool_name, goal)

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

        # Use SAME function as run_agent - this is the key fix!
        pydantic_result, usage, detected_tools_ordered = await call_llm_structured_streaming(
            messages=messages,
            model=model,
            temperature=1.0,  # Same as run_agent
            max_tokens=4096,  # Same as run_agent
            response_model=AgentAction,
            on_chunk=noop_callback,
            reasoning_max_tokens=256,  # Same as run_agent default
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
        return params

    except Exception as e:
        logger.error(f"[ParamPopulator] Error: {e}", tool_name=tool_name, goal=goal)
        raise
