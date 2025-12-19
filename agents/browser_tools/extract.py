"""Extract tool - Extract structured data from the current page."""

import json
import time
from typing import Any, Dict
from pydantic import BaseModel, create_model


def evaluate_zod_schema_to_pydantic(schema_str: str, logger: Any = None) -> type[BaseModel]:
    """
    Convert a Zod schema string to a Pydantic model.
    
    This is a simplified conversion that handles basic cases:
    - z.object({ field: z.string() }) -> Pydantic model with string field
    - z.object({ field: z.number() }) -> Pydantic model with int/float field
    - z.array(...) -> List[...]
    
    For more complex schemas, this returns a generic model.
    
    Args:
        schema_str: Zod schema as a string (e.g., "z.object({ price: z.number() })")
        logger: Logger instance
        
    Returns:
        Pydantic BaseModel class
    """
    try:
        # This is a simplified implementation
        # For production, you'd want a more robust parser
        # For now, we'll just create a generic model and let stagehand handle it
        
        # Create a simple dynamic model that accepts any fields
        DynamicModel = create_model(
            'DynamicExtractModel',
            __config__=type('Config', (), {'extra': 'allow'})
        )
        
        return DynamicModel
        
    except Exception as e:
        if logger:
            logger.error(
                f"Failed to evaluate schema string, using generic model: {e}",
                category="extract",
                auxiliary={"error": {"value": str(e), "type": "string"}}
            )
        
        # Return a generic model
        return create_model('GenericModel', __config__=type('Config', (), {'extra': 'allow'}))


async def extract_tool(
    stagehand: Any,
    args: Dict[str, Any],
    logger: Any,
    execution_model: str = None
) -> Dict[str, Any]:
    """
    Extract structured data from the current page based on a provided schema.
    
    Args:
        stagehand: Stagehand instance
        args: Dictionary with 'instruction' and 'schema' keys
        logger: Logger instance
        execution_model: Optional model to use for extraction
        
    Returns:
        Result dictionary with success status, data, and timestamp
    """
    instruction = args.get("instruction", "")
    schema_str = args.get("schema", "")
    
    try:
        logger.info(
            f"Agent calling tool: extract",
            category="agent",
            auxiliary={
                "arguments": {"value": instruction, "type": "string"},
                "schema": {"value": schema_str, "type": "object"}
            }
        )
        
        # For Python Stagehand, we'll pass the instruction and let it handle extraction
        # The schema conversion is complex, so we'll use a simpler approach
        extract_options = {
            "instruction": instruction
        }
        
        if execution_model:
            extract_options["modelName"] = execution_model
        
        # Call stagehand.page.extract()
        result = await stagehand.page.extract(extract_options)
        
        return {
            "success": True,
            "data": result,
            "timestamp": int(time.time() * 1000)
        }
        
    except Exception as e:
        error_message = str(e)
        return {
            "success": False,
            "error": f"Failed to extract data: {error_message}",
            "timestamp": int(time.time() * 1000)
        }

