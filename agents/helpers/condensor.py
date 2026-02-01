"""Condensor activity for compressing tool results before adding to agent context."""

from typing import Dict, Any
from temporalio import activity
import structlog

logger = structlog.get_logger()


@activity.defn
async def condense_tool_result_activity(
    tool_result_message: str,
    system_prompt: str,
    model: str,
    tool_name: str,
    max_tokens: int = 500,
) -> Dict[str, Any]:
    """
    Condense tool result to extract only relevant information.

    Args:
        tool_result_message: The full formatted tool result message
        system_prompt: The main agent's system prompt
        model: Model to use (inherited from main agent)
        tool_name: Name of the tool (for logging)
        max_tokens: Maximum tokens for condensed output

    Returns:
        Dict with:
            - condensed: The condensed message
            - usage: {tokens_in, tokens_out, model}
    """
    try:
        activity.heartbeat(f"Condensing {tool_name} result")

        from helpers.llm import call_llm
        from helpers.prompts import CONDENSOR_PROMPT

        prompt = CONDENSOR_PROMPT.format(
            system_prompt=system_prompt[:2000],
            tool_result=tool_result_message,
        )

        result = await call_llm(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=0.1,
            max_tokens=max_tokens,
        )

        condensed = result.get("content", "")
        usage = result.get("usage", {})

        logger.info(
            "Tool result condensed",
            tool_name=tool_name,
            original_length=len(tool_result_message),
            condensed_length=len(condensed),
        )

        return {
            "condensed": condensed if condensed else tool_result_message,
            "usage": {
                "tokens_in": usage.get("prompt_tokens", 0),
                "tokens_out": usage.get("completion_tokens", 0),
                "model": model,
            }
        }

    except Exception as e:
        logger.error("Failed to condense tool result", error=str(e), tool_name=tool_name)
        # Fail-safe: return original message
        return {
            "condensed": tool_result_message,
            "usage": {"tokens_in": 0, "tokens_out": 0, "model": model}
        }
