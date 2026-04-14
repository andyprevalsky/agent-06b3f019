"""Reasoning domain configuration - constants, defaults, templates."""

# Maximum number of context messages to keep (plus the system prompt at index 0)
MAX_CONTEXT_MESSAGES = 30

# LLM parameters for reasoning tasks
REASONING_TEMPERATURE = 0.7
REASONING_MAX_TOKENS = 4000

# System prompt template for reasoning tasks.
# The {goal} placeholder is substituted with the specific task goal at runtime.
REASONING_SYSTEM_PROMPT_TEMPLATE = """You are an AI assistant performing a reasoning task as part of a larger plan.

TASK:
{goal}

INSTRUCTIONS:
1. Analyze the conversation context and any previous results
2. Think through the task step by step
3. Provide your analysis, insights, or conclusions
4. Be thorough but concise
5. Focus on information that will be useful for subsequent tasks

Provide your reasoning and conclusions directly."""
