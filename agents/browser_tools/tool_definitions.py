"""
Tool definitions in OpenAI function calling format.

These match the TypeScript Stagehand implementation exactly.
"""

from datetime import datetime


def get_browser_tool_definitions(current_url: str = "") -> list[dict]:
    """
    Get all browser tool definitions in OpenAI format.
    
    Args:
        current_url: Current page URL for context in system prompt
        
    Returns:
        List of tool definitions
    """
    return [
        {
            "type": "function",
            "function": {
                "name": "act",
                "description": "Perform an action on the page (click, type)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "description": """Describe the click, type, fill, scroll action within in a short, specific phrase that mentions the element type. 
          Examples:
          - "click the Login button"
          - "click the language dropdown"
          - type "John" into the first name input
          - type "Doe" into the last name input.
          When attempting to fill a field you can say 'fill the field x with the value y'."""
                        }
                    },
                    "required": ["action"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "ariaTree",
                "description": "gets the accessibility (ARIA) tree from the current page. this is useful for understanding the page structure and accessibility features. it should provide full context of what is on the page",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "close",
                "description": "Complete the task and close",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Summary of what was accomplished"
                        },
                        "success": {
                            "type": "boolean",
                            "description": "Whether the full goal of the task was a success or not"
                        }
                    },
                    "required": ["reasoning", "success"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "extract",
                "description": """Extract structured data from the current page based on a provided schema.
    
    USAGE GUIDELINES:
    - Keep schemas MINIMAL - only include fields essential for the task
    - IMPORANT: only use this if explicitly asked for structured output. In most scenarios, you should use the aria tree tool over this. 
    - If you need to extract a link, make sure the type defintion follows the format of z.string().url()
    EXAMPLES:
    1. Extract a single value:
       instruction: "extract the product price"
       schema: "z.object({ price: z.number()})"
    
    2. Extract multiple fields:
       instruction: "extract product name and price"
       schema: "z.object({ name: z.string(), price: z.number() })"
    
    3. Extract arrays:
       instruction: "extract all product names and prices"
       schema: "z.object({ products: z.array(z.object({ name: z.string(), price: z.number() })) })" """,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": "Clear instruction describing what data to extract from the page"
                        },
                        "schema": {
                            "type": "string",
                            "description": 'Zod schema as a string (e.g., "z.object({ price: z.number() })")'
                        }
                    },
                    "required": ["instruction", "schema"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fillForm",
                "description": """📝 FORM FILL - SPECIALIZED MULTI-FIELD INPUT TOOL

     CRITICAL: Use this for ANY form with 2+ input fields (text inputs, textareas, etc.)

    WHY THIS TOOL EXISTS:
    • Forms are the #1 use case for multi-field input
    • Optimized specifically for input/textarea elements
    • 4-6x faster than individual typing actions

    Use fillForm: Pure form filling (inputs, textareas only)


    MANDATORY USE CASES (always use fillForm for these):
    Registration forms: name, email, password fields
    Contact forms: name, email, message fields  
    Checkout forms: address, payment info fields
    Profile updates: multiple user data fields
    Search filters: multiple criteria inputs



    PARAMETER DETAILS:
    • fields: Array of { action, value } objects.
      – action: short description of where to type (e.g. "type 'john@example.com' into the email input").
      – value: the exact text to enter.
 """,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "fields": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "action": {
                                        "type": "string",
                                        "description": 'Description of the typing action, e.g. "type foo into the bar field"'
                                    },
                                    "value": {
                                        "type": "string",
                                        "description": "Text to type into the target field"
                                    }
                                },
                                "required": ["action", "value"]
                            },
                            "minItems": 1,
                            "description": "Provide at least one field to fill"
                        }
                    },
                    "required": ["fields"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "goto",
                "description": "Navigate to a specific URL",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The URL to navigate to"
                        }
                    },
                    "required": ["url"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "navback",
                "description": "Navigate back to the previous page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Why you're going back"
                        }
                    },
                    "required": ["reasoning"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "screenshot",
                "description": "Takes a screenshot of the current page. Use this tool to learn where you are on the page, or to get context of elements on the page",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "scroll",
                "description": "Scroll the page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pixels": {
                            "type": "number",
                            "description": "Number of pixels to scroll up or down"
                        },
                        "direction": {
                            "type": "string",
                            "enum": ["up", "down"],
                            "description": "Direction to scroll"
                        }
                    },
                    "required": ["pixels", "direction"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "wait",
                "description": "Wait for a specified time",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timeMs": {
                            "type": "number",
                            "description": "Time to wait in milliseconds"
                        }
                    },
                    "required": ["timeMs"],
                    "additionalProperties": False
                }
            }
        }
    ]


def get_system_prompt(task_instruction: str, current_url: str, custom_instructions: str = None) -> str:
    """
    Build the system prompt for the browser agent.
    
    This matches the TypeScript implementation exactly.
    
    Args:
        task_instruction: The user's task
        current_url: Current page URL
        custom_instructions: Optional custom system instructions
        
    Returns:
        System prompt string
    """
    if custom_instructions:
        return f"""{custom_instructions}
Your current goal: {task_instruction}"""
    
    current_date = datetime.now().strftime("%B %d, %Y")
    
    return f"""You are a web automation assistant using browser automation tools to accomplish the user's goal.

Your task: {task_instruction}

You have access to various browser automation tools. Use them step by step to complete the task.

IMPORTANT GUIDELINES:
1. Always start by understanding the current page state
2. Use the screenshot tool to verify page state when needed
3. Use appropriate tools for each action
4. When the task is complete, use the "close" tool with success: true
5. If the task cannot be completed, use "close" with success: false

TOOLS OVERVIEW:
- screenshot: Take a compressed JPEG screenshot for quick visual context (use sparingly)
- ariaTree: Get an accessibility (ARIA) hybrid tree for full page context (preferred for understanding layout and elements)
- act: Perform a specific atomic action (click, type, etc.). For filling a field, you can say 'fill the field x with the value y'.
- extract: Extract structured data
- goto: Navigate to a URL
- wait/navback/refresh: Control timing and navigation
- scroll: Scroll the page x pixels up or down

STRATEGY:
- Prefer ariaTree to understand the page before acting; use screenshot for quick confirmation.
- Keep actions atomic and verify outcomes before proceeding.

For each action, provide clear reasoning about why you're taking that step.
Today's date is {current_date}. You're currently on the website: {current_url}."""

