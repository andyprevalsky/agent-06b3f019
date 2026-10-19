"""Prompt for wait_for tool."""

PROMPT = """Use this tool to pause until a timestamp is reached, a natural-language condition is met, or other agents finish or message you. In condition mode, an explore agent is created every check_interval_seconds up to max_checks times to check the condition.

Usage:
- Pass exactly one of until_timestamp (ISO 8601), condition or agents.
- To wait on agents, use agents, not a condition: no checks are run.
- Any wait ends early on a user message or agent message; the result says what woke it and the time left. Call wait_for again to keep waiting.

# Examples
  wait_for(description="9:00 AM on March 12", until_timestamp="2026-03-12T09:00:00Z")
  wait_for(description="BTC price to exceed $100k", condition="Bitcoin price is above $100k", check_interval_seconds=900, max_checks=10)
  wait_for(description="Bar Shoji to reply", condition="Bar Shoji has replied with information about tonight's walk-in availability")
  wait_for(description="both drafts", agents=["/root/outreach/draft_a", "/root/outreach/draft_b"])"""
