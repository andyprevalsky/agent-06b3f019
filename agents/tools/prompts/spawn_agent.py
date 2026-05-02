"""Prompt for spawn_agent tool."""

# Examples retained because the bad/good pattern (stateful-vs-stateless browser
# flows) is a high-frequency model failure mode that the validator cannot
# catch. Removing the example causes the model to chain browser spawns
# expecting cart/auth state to persist; the explicit BAD/GOOD pairing is
# what teaches the partition.
from utils.prompts import EPHEMERAL_SESSION_RULE

PROMPT = (
    """Spawns an autonomous sub-agent whose capabilities are determined by the type field.

Usage:
- type="explore" for research and information gathering; returns a free-form summary, no output_schema.
- type="browser" for stateful web trajectories (purchases, forms, JS-heavy sites); 25-step limit, requires start_url and output_schema.
- type="code" for ephemeral E2B sandbox tasks (code, data processing, file generation); one focused task under 10 minutes.
- type="sub_agent" delegates a complex multi-step job that runs its own planning cycle.
- type="for_each" fans out one sub-agent per item from a list or CSV.
- Goals must be at least 50 characters for browser/code/sub_agent/for_each (validator-enforced); explore is exempt.
- IMPORTANT: keep stateful multi-step web flows in ONE type="browser" call; see Session Semantics below.
- Multiple spawn_agent calls in one response execute in parallel.

# Examples
BAD (state lost between calls):
  spawn_agent(type="browser", goal="Login to site")
  spawn_agent(type="browser", goal="Add item to cart")
GOOD (one call covers the full stateful flow):
  spawn_agent(type="browser", start_url="https://x.com", goal="Login, post tweet, logout", output_schema=...)

# Session Semantics
"""
    + EPHEMERAL_SESSION_RULE.strip()
)
