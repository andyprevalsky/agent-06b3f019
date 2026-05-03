"""Prompt for web_search tool."""

PROMPT = """Searches the web for real-time public information and returns snippet results.

Usage:
- Use for quick factual lookups (definitions, news, prices) where one query suffices.
- Use for reconnaissance before deciding whether to fetch a specific URL.
- Do not use for multi-step research with cross-referencing - prefer spawn_explore_agent.
- Do not use to read a specific URL's content - use web_fetch.
- Do not use to search local data (contacts, messages) - use grep.

CRITICAL REQUIREMENT - You MUST follow this:
  - Every claim derived from this tool's results MUST trace to a specific search-result URL.
  - When reporting findings to the user or to a parent agent, include a "Sources:" section
    listing the URLs you used as markdown hyperlinks: [Title](URL).
  - This is MANDATORY - never skip including sources when reporting facts learned from search.
  - Numbers, prices, statistics, names, and dates without a corresponding source entry are
    treated as fabrication and will cause the verifier to reject your answer.
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)
"""
