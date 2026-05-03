"""Reasoning domain configuration - constants, defaults, templates."""

# Maximum number of context messages to keep (plus the system prompt at index 0)
MAX_CONTEXT_MESSAGES = 30

# LLM parameters for reasoning tasks.
#
# REASONING_MAX_TOKENS is intentionally generous: reasoning tasks are typically
# the *synthesis* step at the end of a DAG (e.g. summarizing 80k+ tokens of
# research into a comparison table) and a small ceiling forces the inner
# escalation retry path in `call_llm_structured_streaming` (4000 → 32768),
# which doubles wall time on already-slow streaming calls and routinely
# pushes the activity past its 120s start_to_close_timeout.
#
# 16000 covers realistic synthesis outputs (multi-section comparison tables,
# detailed analyses) without triggering the recursive retry. The provider
# only bills actual completion tokens, so there is no cost penalty for the
# higher cap on shorter responses.
REASONING_TEMPERATURE = 0.7
REASONING_MAX_TOKENS = 16000

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
