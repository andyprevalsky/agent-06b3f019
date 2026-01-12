"""
Parameter Populator Activity - Populate tool parameters using LLM.

Given a tool name and goal, calls LLM with full context to generate
the appropriate parameters for the tool call.

Uses structured outputs to guarantee the LLM output matches the tool schema.
"""

import json
from typing import Dict, List, Any
from temporalio import activity
import structlog

from helpers.llm import call_llm, convert_context_to_messages, prepare_schema_for_openai
from helpers.tool_schemas import TOOL_MODELS

logger = structlog.get_logger()


def _get_tool_schema_description(tool_name: str) -> str:
    """
    Get a description of the tool's parameters for the LLM prompt.

    Args:
        tool_name: Name of the tool

    Returns:
        String description of the tool schema
    """
    if tool_name not in TOOL_MODELS:
        return f"Unknown tool: {tool_name}"

    model = TOOL_MODELS[tool_name]
    schema = model.model_json_schema()

    # Extract properties and their descriptions
    properties = schema.get("properties", {})
    required = schema.get("required", [])

    lines = [f"Tool: {tool_name}"]
    if model.__doc__:
        lines.append(f"Description: {model.__doc__.strip().split(chr(10))[0]}")
    lines.append("Parameters:")

    for prop_name, prop_schema in properties.items():
        if prop_name == "tool":
            continue  # Skip the literal tool name field

        prop_type = prop_schema.get("type", "any")
        prop_desc = prop_schema.get("description", "No description")
        is_required = prop_name in required
        req_marker = "(required)" if is_required else "(optional)"

        lines.append(f"  - {prop_name} ({prop_type}) {req_marker}: {prop_desc}")

    return "\n".join(lines)


def _build_populator_prompt(tool_name: str, goal: str) -> str:
    """
    Build the system prompt for parameter population.

    Args:
        tool_name: Name of the tool
        goal: The task goal

    Returns:
        System prompt string
    """
    tool_desc = _get_tool_schema_description(tool_name)

    return f"""You are a parameter extraction assistant. Extract parameters for a tool call.

TASK GOAL:
{goal}

TOOL SCHEMA:
{tool_desc}

INSTRUCTIONS:
1. The TASK GOAL contains what should be extracted as parameter values
2. For web_search: the query should be derived directly from the goal (e.g., "Find X" → query="X")
3. For required parameters, ALWAYS provide a non-empty value
4. Your response must match the schema exactly

EXAMPLE:
Goal: "Search for best hotels in Austin Texas"
Output: {{"query": "best hotels in Austin Texas"}}"""


@activity.defn
async def populate_tool_params_activity(
    tool_name: str,
    goal: str,
    context: List[Dict],
    model: str,
) -> Dict[str, Any]:
    """
    Populate tool parameters using LLM based on context.

    Uses structured outputs with the tool's Pydantic schema to guarantee
    the LLM output matches the expected format exactly.

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

    tool_model = TOOL_MODELS[tool_name]

    # Build JSON schema for structured output
    schema = prepare_schema_for_openai(tool_model)

    # Build system prompt
    system_prompt = _build_populator_prompt(tool_name, goal)

    # Use existing context formatter (handles timestamps, IN_PROGRESS filtering, tool matching)
    context_messages = convert_context_to_messages(context, include_system=True, include_assistant=True)

    # Keep last N messages to stay within context limits
    max_context_messages = 20
    if len(context_messages) > max_context_messages:
        context_messages = context_messages[-max_context_messages:]

    # Build full message list
    messages = [
        {"role": "system", "content": system_prompt},
        *context_messages,
        {"role": "user", "content": f"Extract parameters for {tool_name}. Goal: {goal}"},
    ]

    activity.heartbeat("Calling LLM for parameter population")

    try:
        # Use non-streaming call_llm with strict structured output
        result = await call_llm(
            messages=messages,
            model=model,
            temperature=0.1,  # Low temperature for deterministic extraction
            max_tokens=500,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": tool_model.__name__,
                    "schema": schema,
                    "strict": True,
                }
            },
        )

        content = result.get("content", "")
        if not content:
            raise ValueError("Empty response from LLM")

        # Parse JSON response (schema-validated by LLM)
        try:
            params = json.loads(content)
        except json.JSONDecodeError as e:
            logger.error(f"[ParamPopulator] Failed to parse JSON: {content[:200]}", error=str(e))
            raise ValueError(f"Invalid JSON response: {e}")

        # Remove 'tool' field (added during execution)
        params.pop("tool", None)

        # Validate required fields are non-empty
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
            tokens=result.get("usage", {}).get("total_tokens", 0),
        )
        return params

    except Exception as e:
        logger.error(f"[ParamPopulator] Error: {e}", tool_name=tool_name, goal=goal)
        raise
