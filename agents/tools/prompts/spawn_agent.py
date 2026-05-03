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
- type="explore" for read-only research and one-shot information lookups (facts, numbers, names, URLs).
  Uses web_search/web_fetch/grep + LLM summarization. Returns a free-form summary; no output_schema.
  This is the DEFAULT choice for "find/look up/research X" goals; it is faster and cheaper than browser.
- type="browser" ONLY for stateful web trajectories where session state must persist across steps:
  authenticated flows (login -> action), forms with multi-step submission, cart/checkout, JS-heavy SPAs
  whose data is not in static HTML. 25-step limit, requires start_url and output_schema. Do NOT pick
  browser for "find a public fact on the web"; explore handles that with one search call.
- type="code" for ephemeral E2B sandbox tasks (code, data processing, file generation); one focused task under 10 minutes.
- type="sub_agent" delegates a complex multi-step job that runs its own planning cycle.
- type="for_each" fans out one sub-agent per item from a list or CSV.
- Goals must be at least 50 characters for browser/code/sub_agent/for_each (validator-enforced); explore is exempt.
- IMPORTANT: keep stateful multi-step web flows in ONE type="browser" call; see Session Semantics below.
- Multiple spawn_agent calls in one response execute in parallel.

# Choosing explore vs browser

If the answer would appear on a public web page or in search results without
needing to click, log in, or maintain session state, use explore. Browser is
strictly slower and reserved for cases where explore cannot work because the
data is gated behind interaction.

GOOD explore: "Find the current population of Tokyo and return the numeric value with source URL."
GOOD browser: "Log in to acme.com with the saved credentials, navigate to billing, download the latest invoice PDF."
BAD browser:  "Search the web for the current population of Tokyo." (use explore)

# Examples
BAD (state lost between browser calls):
  spawn_agent(type="browser", goal="Login to site")
  spawn_agent(type="browser", goal="Add item to cart")
GOOD (one call covers the full stateful flow):
  spawn_agent(type="browser", start_url="https://x.com", goal="Login, post tweet, logout", output_schema=...)

# Session Semantics
"""
    + EPHEMERAL_SESSION_RULE.strip()
)
