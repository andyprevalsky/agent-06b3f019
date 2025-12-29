"""
Tool definitions in OpenAI function calling format.

HYBRID APPROACH: We expose Stagehand's observe() for element finding
(handles shadow DOM, iframes) but give the agent LLM direct Playwright
tools (click, fill, type) with explicit selectors.
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
        # ========== OBSERVATION TOOLS ==========
        {
            "type": "function",
            "function": {
                "name": "observe",
                "description": """Find actionable elements on the page matching your instruction.

Returns a list of elements with their CSS/XPath SELECTORS that you can use with click/fill/type tools.

IMPORTANT: Always call observe() first to get selectors before using click/fill/type.

Examples:
- observe(instruction="find the login button") → returns [{selector: "button#login", method: "click", ...}]
- observe(instruction="find all input fields") → returns multiple elements with their selectors
- observe(instruction="find the search box") → returns [{selector: "input[type='search']", ...}]

This tool handles shadow DOM traversal automatically. Set iframes=true to also search inside iframes.""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": "Describe what element(s) you're looking for"
                        },
                        "iframes": {
                            "type": "boolean",
                            "description": "Set to true to search inside iframes as well"
                        }
                    },
                    "required": ["instruction"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "ariaTree",
                "description": "Get the accessibility (ARIA) tree from the current page. This provides full context of what is on the page including text content and element structure. Use this to understand the page before taking actions.",
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
                "name": "screenshot",
                "description": "Take a screenshot of the current page. Use this for visual confirmation of page state.",
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
                "name": "extract",
                "description": """Extract structured data from the current page based on a provided schema.

USAGE GUIDELINES:
- Keep schemas MINIMAL - only include fields essential for the task
- Only use this if explicitly asked for structured output
- For general page understanding, use ariaTree instead

EXAMPLES:
1. Extract a single value:
   instruction: "extract the product price"
   schema: "z.object({ price: z.number()})"

2. Extract multiple fields:
   instruction: "extract product name and price"
   schema: "z.object({ name: z.string(), price: z.number() })"
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": "Clear instruction describing what data to extract"
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
        
        # ========== ACTION TOOLS (Direct Playwright with Selectors) ==========
        {
            "type": "function",
            "function": {
                "name": "click",
                "description": """Click an element by CSS or XPath selector.

IMPORTANT: Use observe() first to find the element and get its selector.

Selector formats:
- CSS: "button#login", ".submit-btn", "[data-testid='submit']"
- XPath: "//button[@id='login']", "//a[contains(text(), 'Sign in')]"

Examples:
- click(selector="button#login")
- click(selector="[data-testid='submit']")
- click(selector="//button[contains(text(), 'Login')]")
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector or XPath (prefix XPath with //) to identify the element"
                        }
                    },
                    "required": ["selector"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "fill",
                "description": """Fill a form field by selector. CLEARS existing value first, then types the new value.

IMPORTANT: Use observe() first to find the input element and get its selector.

Use this for:
- Login forms (username, password)
- Search boxes (if you want to replace existing text)
- Any text input where you want to replace content

Examples:
- fill(selector="input[name='email']", value="user@example.com")
- fill(selector="#password", value="secret123")
- fill(selector="//input[@placeholder='Search']", value="query")
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector or XPath for the input element"
                        },
                        "value": {
                            "type": "string",
                            "description": "Text to fill into the field"
                        }
                    },
                    "required": ["selector", "value"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "type",
                "description": """Type text into an element character by character (does NOT clear existing text).

IMPORTANT: Use observe() first to find the element and get its selector.

Use this for:
- Search boxes that trigger autocomplete on each keystroke
- When you want to APPEND text to existing content
- When you need keypress events to fire

Examples:
- type(selector="input[type='search']", text="python tutorials")
- type(selector="#message", text=" - additional text")
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "selector": {
                            "type": "string",
                            "description": "CSS selector or XPath for the element"
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to type"
                        },
                        "delay": {
                            "type": "number",
                            "description": "Delay between keystrokes in ms. Default: 50"
                        }
                    },
                    "required": ["selector", "text"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "pressKey",
                "description": """Press a keyboard key.

Use this to press special keys like Enter, Tab, Escape, or keyboard shortcuts.

Common keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown

For key combinations, use format like 'Control+a' or 'Shift+Tab'.

Examples:
- pressKey(key="Enter") - Submit a form
- pressKey(key="Tab") - Move to next field
- pressKey(key="Control+a") - Select all
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "description": "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'Control+a')"
                        }
                    },
                    "required": ["key"],
                    "additionalProperties": False
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "clickAtCoordinates",
                "description": """FALLBACK: Click at specific X,Y pixel coordinates on the page.

Use this ONLY when:
- Selector-based click() fails
- You have exact coordinates from a screenshot
- The element cannot be found with observe()

Coordinates are relative to the top-left corner of the viewport.

Examples:
- clickAtCoordinates(x=500, y=300)
- clickAtCoordinates(x=100, y=200, button="right")
""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "x": {
                            "type": "number",
                            "description": "X coordinate in pixels from left edge of viewport"
                        },
                        "y": {
                            "type": "number",
                            "description": "Y coordinate in pixels from top edge of viewport"
                        },
                        "button": {
                            "type": "string",
                            "enum": ["left", "right", "middle"],
                            "description": "Mouse button to click. Default: left"
                        }
                    },
                    "required": ["x", "y"],
                    "additionalProperties": False
                }
            }
        },
        
        # ========== NAVIGATION TOOLS ==========
        {
            "type": "function",
            "function": {
                "name": "goto",
                "description": "Navigate to a URL in the browser. You MUST provide the FULL URL including the protocol (https://).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The FULL URL to navigate to, including protocol (e.g., 'https://www.example.com'). Do NOT use partial URLs like 'example.com'."
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
                "name": "scroll",
                "description": "Scroll the page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pixels": {
                            "type": "number",
                            "description": "Number of pixels to scroll"
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
        },
        
        # ========== COMPLETION TOOL ==========
        {
            "type": "function",
            "function": {
                "name": "attempt_completion",
                "description": "Signal that the task is complete and ready for verification. Call this when you believe the goal has been accomplished. A verifier will confirm - if it passes, the session closes. If not, you'll receive feedback and can continue.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Summary of what was accomplished and why you believe the task is complete"
                        }
                    },
                    "required": ["reasoning"],
                    "additionalProperties": False
                }
            }
        }
    ]


def get_system_prompt(task_instruction: str, current_url: str, custom_instructions: str = None) -> str:
    """
    Build the system prompt for the browser agent.
    
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

WORKFLOW - OBSERVE THEN ACT:
1. Use observe() to find elements and get their selectors
2. Use click/fill/type with the selector from observe()
3. Verify results with screenshot or ariaTree

TOOLS OVERVIEW:
OBSERVATION:
- observe(instruction) → Find elements, returns selectors. ALWAYS USE FIRST.
- ariaTree() → Get full page content/structure
- screenshot() → Visual confirmation

ACTIONS (require selector from observe):
- click(selector) → Click an element
- fill(selector, value) → Clear field and type (for forms)
- type(selector, text) → Type without clearing (for search boxes)
- pressKey(key) → Press keyboard keys (Enter, Tab, etc.)

NAVIGATION:
- goto(url) → Navigate to FULL URL (must include https://)
- navback() → Go back
- scroll(pixels, direction) → Scroll page
- wait(timeMs) → Wait

COMPLETION:
- attempt_completion(reasoning) → Signal task complete for verification

IMPORTANT RULES:
1. ALWAYS call observe() first to get a selector before clicking/typing
2. Use fill() for login/forms (clears existing text)
3. Use type() for search boxes (doesn't clear, triggers autocomplete)
4. Verify actions worked with screenshot or ariaTree
5. When done, call attempt_completion with a summary - a verifier will confirm

Today's date is {current_date}. You're currently on: {current_url}"""
