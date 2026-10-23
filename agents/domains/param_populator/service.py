"""param_populator domain — business logic layer.

Builds system prompts, calls the LLM, and extracts / validates tool parameters.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

from domains.param_populator.config import (
    CALL_SITE,
    MAX_TOKENS,
    REASONING_MAX_TOKENS,
    TEMPERATURE,
)
from domains.param_populator.repo import fetch_agent_context
from helpers.attachment_context import attachment_request_overhead
from helpers.llm import build_llm_messages, call_llm_structured_streaming
from helpers.model_info import get_model_context_window
from utils.prompts import (
    CONTEXT_POINTERS_RULE,
    EPHEMERAL_SESSION_RULE,
    FILE_HANDLING_RULE,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
)
from utils.tool_schemas import TOOL_MODELS, create_agent_action_model

if TYPE_CHECKING:
    from domains.param_populator.types import PopulatedParams

logger = structlog.get_logger()


def build_agent_system_prompt(tool_name: str, goal: str, alias_hint: str = "") -> str:
    """Build a full agent-style system prompt for parameter population.

    Args:
        tool_name: Name of the tool to call.
        goal: The task goal.
        alias_hint: Original alias name (e.g. ``spawn_general_purpose_agent``) for type-specific instructions.

    Returns:
        System prompt string.
    """
    # --- Static prefix (shared across all param populator calls, cached) ---
    prompt = f"""You populate parameters for a specific tool call. Call the Required Tool with exactly the parameters necessary to complete the Goal below. For agent-spawning tools, the Goal becomes the spawned agent's mission.

When calling a tool that creates an agent, the parameters you pass are the only context that agent will have. If you mention a file but don't include that file-pointer in attachments, the agent will not have access to that file. Do not assume context transfers over; if context from the conversation is needed to complete the goal, reiterate that context in the goal string.

You will be graded:
- points are deducted for including context that is not necessary to the goal in the goal string.
- points are deducted for NOT including context that is necessary to the goal in the goal string.
- points are deducted for adding new information that was NOT previously mentioned in any context fed to you.
- points are deducted if the goal string you output does not adhere to the Goal below. Do not change the intention of the goal even if it is against your better judgment.

# Context Pointers
{CONTEXT_POINTERS_RULE.strip()}

# File Handling
{FILE_HANDLING_RULE.strip()}"""

    # --- Dynamic suffix (per-call unique: goal, tool, alias-specific rules) ---
    prompt += SYSTEM_PROMPT_DYNAMIC_BOUNDARY

    prompt += f"""CURRENT TASK:
Goal: {goal}
Required Tool: {tool_name}

INSTRUCTIONS:
1. Analyze the Goal and the conversation context
2. Call the {tool_name} tool with parameters that will accomplish the Goal
3. Explain your reasoning
4. Call exactly one tool: {tool_name}
5. Do not skip the tool call even if the goal appears already accomplished in context"""

    prompt += f"""

Execute the task now by calling {tool_name} with the correct parameters."""

    if tool_name.startswith("spawn_"):
        prompt += f"""

# Ephemeral Session
{EPHEMERAL_SESSION_RULE.strip()}"""

    return prompt


async def populate_tool_params(
    tool_name: str,
    goal: str,
    agent_id: str,
    model: str,
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
        model: Model selected for the agent.
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

    messages = await build_llm_messages(
        context, system_prompt,
        max_context_tokens=await get_model_context_window(model),
        request_overhead=attachment_request_overhead(agent_action, f"Execute the task: {goal}"),
    )
    messages.append({"role": "user", "content": f"Execute the task: {goal}"})

    if heartbeat:
        heartbeat("Calling LLM for parameter population")

    async def _noop_callback(text_so_far: str, token_count: int) -> None:
        pass

    pydantic_result, usage, _detected_tools = await call_llm_structured_streaming(
        messages=messages,
        model=model,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
        response_model=agent_action,
        on_chunk=_noop_callback,
        reasoning_max_tokens=REASONING_MAX_TOKENS,
        skip_cache_write=True,
        call_site=CALL_SITE,
        claude_token=claude_token,
        agent_id=agent_id,  # lets Fast Mode auto-resolve the cache context
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
