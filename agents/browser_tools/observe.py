"""Observe tool - Find actionable elements on the page with their selectors.

This tool exposes Stagehand's observe() method directly to the agent LLM,
returning elements with their selectors so the agent can then use click/fill/type
with explicit selectors.

This is the "hybrid approach" - we use Stagehand's observe for element finding
(which handles shadow DOM and iframes) but let the agent LLM decide what to click.
"""

import time
from typing import Any, Dict, List

from tools.base import format_tool_message, format_error_message
from helpers.model_pricing import get_default_pricing


def calculate_llm_cost_cents(
    prompt_tokens: int,
    completion_tokens: int,
    model: str = "rose-1-ultra"
) -> int:
    """Calculate LLM cost in cents from token counts using default pricing."""
    pricing = get_default_pricing(model)
    
    # cents_per_1k = X means X cents per 1000 tokens
    # cost = (tokens / 1000) * cents_per_1k
    input_cost = (prompt_tokens / 1000) * pricing["input_cents_per_1k"]
    output_cost = (completion_tokens / 1000) * pricing["output_cents_per_1k"]
    
    # Return rounded to nearest cent, minimum 0
    return max(0, round(input_cost + output_cost))


def format_observe_result(elements: List[Dict[str, Any]], instruction: str) -> Dict[str, Any]:
    """Format observe results for display."""
    if not elements:
        return {
            "found": 0,
            "instruction": instruction,
            "elements": "No elements found"
        }
    
    # Build formatted element list
    lines = []
    for i, el in enumerate(elements, 1):
        selector = el.get("selector", "unknown")
        description = el.get("description", "")
        method = el.get("method", "")
        
        line = f"{i}. `{selector}`"
        if description:
            line += f" - {description}"
        if method:
            line += f" (action: {method})"
        lines.append(line)
    
    return {
        "found": len(elements),
        "instruction": instruction,
        "elements": "\n".join(lines)
    }


async def observe_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any,
    execution_model: str = None
) -> Dict[str, Any]:
    """
    Find actionable elements on the page matching an instruction.
    
    Uses Stagehand's observe() which handles:
    - Shadow DOM traversal
    - Iframe detection
    - Element accessibility analysis
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'instruction' key
        logger: Logger instance
        execution_model: Optional model to use for observe
        
    Returns:
        Result dictionary with list of elements and their selectors
    """
    start_time = time.time()
    instruction = args.get("instruction", "")
    iframes = args.get("iframes")
    
    if not instruction:
        elapsed = time.time() - start_time
        error_result = {
            "success": False,
            "error": "Instruction is required. Describe what element(s) you're looking for.",
            "elements": []
        }
        return {
            **error_result,
            "message": format_tool_message(
                params=args,
                result={"error": "Instruction is required"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: observe",
            category="agent",
            auxiliary={
                "instruction": {"value": instruction, "type": "string"},
                "iframes": {"value": str(iframes), "type": "boolean"} if iframes is not None else None
            }
        )
        
        # Snapshot metrics BEFORE observe call to calculate delta
        metrics_before = stagehand.metrics
        prompt_tokens_before = metrics_before.observe_prompt_tokens
        completion_tokens_before = metrics_before.observe_completion_tokens
        
        # Call Stagehand's observe() with named params
        results = await stagehand.page.observe(
            instruction=instruction,
            draw_overlay=True,
            iframes=iframes,
        )
        
        # Snapshot metrics AFTER observe call
        metrics_after = stagehand.metrics
        prompt_tokens_used = metrics_after.observe_prompt_tokens - prompt_tokens_before
        completion_tokens_used = metrics_after.observe_completion_tokens - completion_tokens_before
        
        # Calculate cost from token usage
        cost_cents = calculate_llm_cost_cents(prompt_tokens_used, completion_tokens_used)
        
        logger.info(
            f"Observe LLM usage: {prompt_tokens_used} prompt, {completion_tokens_used} completion tokens, ${cost_cents / 100:.4f}",
            category="agent"
        )
        
        # Transform results to plain dicts for the LLM
        elements = []
        for result in results:
            element = {
                "selector": getattr(result, 'selector', None),
                "description": getattr(result, 'description', None),
                "method": getattr(result, 'method', None),
                "arguments": getattr(result, 'arguments', []),
            }
            if element["selector"]:
                elements.append(element)
        
        elapsed = time.time() - start_time
        
        # Format result for display
        formatted_result = format_observe_result(elements, instruction)
        
        return {
            "success": True,
            "elements": elements,
            "count": len(elements),
            "prompt_tokens": prompt_tokens_used,
            "completion_tokens": completion_tokens_used,
            "message": format_tool_message(
                params=args,
                result=formatted_result,
                time_elapsed=elapsed,
                cost_cents=cost_cents
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_str = str(e)
        logger.error(
            f"Observe failed: {error_str}",
            category="agent",
            auxiliary={"error": {"value": error_str, "type": "string"}}
        )
        
        # Create a fake exception for format_error_message
        class ObserveError(Exception):
            pass
        
        return {
            "success": False,
            "error": f"Failed to observe: {error_str}",
            "elements": [],
            "message": format_error_message(
                params=args,
                error=ObserveError(error_str),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
