"""param_populator domain — business logic layer.

Builds system prompts, calls the LLM, and extracts / validates tool parameters.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

from domains.param_populator.config import (
    CALL_SITE,
    MAX_TOKENS,
    PARAM_POPULATOR_MODEL,
    REASONING_MAX_TOKENS,
    SPAWN_PARAM_REQUIREMENTS,
    TEMPERATURE,
)
from domains.param_populator.repo import fetch_agent_context
from helpers.llm import build_llm_messages, call_llm_structured_streaming
from utils.tool_schemas import TOOL_MODELS, create_agent_action_model

if TYPE_CHECKING:
    from domains.param_populator.types import PopulatedParams

logger = structlog.get_logger()


def build_agent_system_prompt(tool_name: str, goal: str, alias_hint: str = "") -> str:
    """Build a full agent-style system prompt for parameter population.

    Args:
        tool_name: Name of the tool to call.
        goal: The task goal.
        alias_hint: Original alias name (e.g. ``spawn_sub_agent``) for type-specific instructions.

    Returns:
        System prompt string.
    """
    prompt = f"""You are an AI agent executing a specific task from a plan. Your role is to ensure that the Required Tool is called with exactly the parameters necessary in order to complete the Goal below. The Goal below is the objective that the tool you are calling must accomplish — for agent-spawning tools, this means the Goal becomes the spawned agent's mission.

When calling a tool that creates an agent, the parameters you pass are the ONLY context that agent will have. If you mention a file but don't include that file-pointer in attachments, the agent will NOT have access to that file. You may not assume any context gets transferred over — if there is context from the conversation that the agent will rely on to complete its goal, you MUST reiterate that context in the goal string. This is very important.

You will be graded:
- points are deducted for including context that is not necessary to the goal in the goal string.
- points are deducted for NOT including context that is necessary to the goal in the goal string.
- points are deducted for adding new information that was NOT previously mentioned in any context fed to you.
- points are deducted if the goal string you output does not adhere to the Goal below. Do not change the intention of the goal even if it is against your better judgment.

CONTEXT POINTERS (CRITICAL):
Messages and tool results in the conversation include "Reference: @ref:message:<id>" pointers.
When populating tool parameters (especially goal strings for spawn_agent):
- PREFER including @ref:message: pointers over rewriting/paraphrasing the referenced content
- The pointer is automatically resolved to the original data when the child agent runs
- This prevents information loss — phone numbers, names, and details stay exact
- Use @ref:message:<id>[start="prefix"|end="suffix"] to reference a specific substring
- Example: Instead of rewriting "Call John Smith at 555-1234", pass the pointer:
  "Call the person mentioned in @ref:message:abc123[start="John Smith"|end="555-1234"]"

CURRENT TASK:
Goal: {goal}
Required Tool: {tool_name}

INSTRUCTIONS:
1. Analyze the Goal and the conversation context
2. Call the {tool_name} tool with parameters that will accomplish the Goal
3. You should explain your reasoning
4. You MUST call exactly one tool: {tool_name}
5. Do NOT skip the tool call even if the goal appears already accomplished in context"""

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

    if tool_name.startswith("spawn_"):
        prompt += """

EPHEMERAL SESSION WARNING:
This tool creates a NEW session that does not persist. Any login state, cookies, or context
from previous calls will NOT be available. Include ALL necessary steps in a single goal
(e.g., "Login, add to cart, checkout" - not separate calls for each step)."""

    return prompt


async def populate_tool_params(
    tool_name: str,
    goal: str,
    agent_id: str,
    alias_hint: str = "",
    claude_token: str | None = None,
    *,
    heartbeat: Any = None,
) -> PopulatedParams:
    """Populate tool parameters by calling the LLM with full agent context.

    Args:
        tool_name: Name of the tool to populate params for.
        goal: The task goal from the plan.
        agent_id: Agent ID to fetch context from DB.
        alias_hint: Original alias name for type-specific prompt instructions.
        claude_token: Optional Claude OAuth token for direct Anthropic calls.
        heartbeat: Optional callable for Temporal heartbeat signals.

    Returns:
        A ``PopulatedParams`` dict with ``params`` and ``usage`` keys.

    Raises:
        ValueError: If the tool is unknown, the LLM returns no tool calls,
            or a required field is empty.
    """
    if tool_name not in TOOL_MODELS:
        logger.error("[ParamPopulator] Unknown tool: %s", tool_name)
        msg = f"Unknown tool: {tool_name}"
        raise ValueError(msg)

    agent_action = create_agent_action_model([tool_name])

    system_prompt = build_agent_system_prompt(tool_name, goal, alias_hint)

    if heartbeat:
        heartbeat("Fetching context from DB")
    context = await fetch_agent_context(agent_id)

    messages = await build_llm_messages(context, system_prompt)
    messages.append({"role": "user", "content": f"Execute the task: {goal}"})

    if heartbeat:
        heartbeat("Calling LLM for parameter population")

    async def _noop_callback(text_so_far: str, token_count: int) -> None:
        pass

    pydantic_result, usage, _detected_tools = await call_llm_structured_streaming(
        messages=messages,
        model=PARAM_POPULATOR_MODEL,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        response_model=agent_action,
        on_chunk=_noop_callback,
        reasoning_max_tokens=REASONING_MAX_TOKENS,
        skip_cache=True,
        call_site=CALL_SITE,
        claude_token=claude_token,
    )

    tool_calls: list[dict[str, Any]] = []
    if pydantic_result.tool_calls:
        for tc in pydantic_result.tool_calls:
            if tc is not None:
                tool_calls.append(tc.model_dump())

    if not tool_calls:
        response_preview = pydantic_result.response[:200] if pydantic_result.response else "empty"
        msg = f"LLM did not call any tools. Response: {response_preview}"
        raise ValueError(msg)

    tool_call: dict[str, Any] | None = None
    for tc in tool_calls:
        if tc.get("tool") == tool_name:
            tool_call = tc
            break

    if not tool_call:
        tool_call = tool_calls[0]
        logger.warning(
            "[ParamPopulator] Expected tool %s, got %s",
            tool_name,
            tool_call.get("tool"),
            tool_calls=tool_calls,
        )

    params = {k: v for k, v in tool_call.items() if k != "tool"}

    tool_model = TOOL_MODELS[tool_name]
    model_schema = tool_model.model_json_schema()
    required = model_schema.get("required", [])
    for field in required:
        if field == "tool":
            continue
        value = params.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            msg = f"Required field '{field}' is empty. Goal was: {goal}"
            raise ValueError(msg)

    logger.info(
        "[ParamPopulator] Populated params for %s",
        tool_name,
        params=params,
        response=pydantic_result.response[:100] if pydantic_result.response else "",
        tokens=usage.get("total_tokens", 0),
    )

    return {"params": params, "usage": usage}
