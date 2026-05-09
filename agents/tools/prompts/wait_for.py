"""Prompt for wait_for tool."""

PROMPT = """Use this tool to pause execution until a specific timestamp is reached or a natural-language condition is met. In condition mode, an explore agent is created every check_interval_seconds up to max_checks times to gather the information necessary to validate whether the condition has been met.

Usage:
- Pass exactly one of until_timestamp (ISO 8601) or condition (natural language); they are mutually exclusive.
- Returns the final check result (condition mode) or resumes after the wait (timestamp mode).
- Only use this for a real future time or an external condition that can change without your own next action. Do not use wait_for for already-recorded transcript/tool history, verifier objections, or conditions about whether past tool calls were duplicated; those cannot become true by waiting.

# Examples
Timestamp mode:
  wait_for(until_timestamp="2026-03-12T09:00:00Z")
Condition mode:
  wait_for(condition="Bitcoin price is above $100k", check_interval_seconds=900, max_checks=10)"""
