"""Extract tool - Extract structured data from the current page."""

import json
import time
from typing import Any, Dict

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


async def extract_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any,
    execution_model: str = None
) -> Dict[str, Any]:
    """
    Extract structured data from the current page based on an instruction.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'instruction' and optional 'schema' keys
        logger: Logger instance
        execution_model: Optional model to use for extraction
        
    Returns:
        Result dictionary with success status, data, and formatted message
    """
    start_time = time.time()
    instruction = args.get("instruction", "")
    schema_str = args.get("schema", "")
    
    if not instruction:
        elapsed = time.time() - start_time
        return {
            "success": False,
            "error": "Instruction is required. Describe what data to extract.",
            "timestamp": int(time.time() * 1000),
            "message": format_tool_message(
                params=args,
                result={"error": "Instruction is required"},
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
    
    try:
        logger.info(
            f"Agent calling tool: extract",
            category="agent",
            auxiliary={
                "instruction": {"value": instruction, "type": "string"},
                "schema": {"value": schema_str, "type": "string"} if schema_str else None
            }
        )
        
        # Snapshot metrics BEFORE extract call to calculate delta
        metrics_before = stagehand.metrics
        prompt_tokens_before = metrics_before.extract_prompt_tokens
        completion_tokens_before = metrics_before.extract_completion_tokens
        
        # Build extraction kwargs
        extract_kwargs = {"instruction": instruction}
        
        # Include schema in instruction if provided
        if schema_str:
            extract_kwargs["instruction"] = f"{instruction}\n\nExpected format: {schema_str}"
        
        if execution_model:
            extract_kwargs["model_name"] = execution_model
        
        # Call stagehand.page.extract()
        result = await stagehand.page.extract(**extract_kwargs)
        
        # Snapshot metrics AFTER extract call
        metrics_after = stagehand.metrics
        prompt_tokens_used = metrics_after.extract_prompt_tokens - prompt_tokens_before
        completion_tokens_used = metrics_after.extract_completion_tokens - completion_tokens_before
        
        # Calculate cost from token usage
        cost_cents = calculate_llm_cost_cents(prompt_tokens_used, completion_tokens_used)
        
        logger.info(
            f"Extract LLM usage: {prompt_tokens_used} prompt, {completion_tokens_used} completion tokens, ${cost_cents / 100:.4f}",
            category="agent"
        )
        
        # Serialize the result properly
        if hasattr(result, 'model_dump'):
            result_data = result.model_dump()
        elif hasattr(result, 'dict'):
            result_data = result.dict()
        else:
            result_data = result
        
        elapsed = time.time() - start_time
        
        logger.info(
            f"Extract completed successfully",
            category="agent",
            auxiliary={
                "result": {"value": str(result_data), "type": "object"}
            }
        )
        
        return {
            "success": True,
            "data": result_data,
            "extracted": result_data,
            "prompt_tokens": prompt_tokens_used,
            "completion_tokens": completion_tokens_used,
            "timestamp": int(time.time() * 1000),
            "message": format_tool_message(
                params=args,
                result={"extracted_data": result_data},
                time_elapsed=elapsed,
                cost_cents=cost_cents
            )
        }
        
    except Exception as e:
        elapsed = time.time() - start_time
        error_message = str(e)
        logger.error(
            f"Extract failed: {error_message}",
            category="agent",
            auxiliary={"error": {"value": error_message, "type": "string"}}
        )
        
        class ExtractError(Exception):
            pass
        
        return {
            "success": False,
            "error": f"Failed to extract data: {error_message}",
            "timestamp": int(time.time() * 1000),
            "message": format_error_message(
                params=args,
                error=ExtractError(error_message),
                time_elapsed=elapsed,
                cost_cents=0
            )
        }
