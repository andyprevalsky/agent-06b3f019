"""Prompt for wait_for tool."""

PROMPT = """Wait until a specific time or until a condition is met.

Timestamp mode: provide until_timestamp (ISO 8601) to sleep until that time.
Condition mode: provide condition (natural language) + check_interval_seconds (60-86400, default 900) + max_checks (1-100, default 20). An explore agent will periodically check if the condition is satisfied using web search and local data.

WHEN NOT TO USE:
- Do NOT use both until_timestamp and condition in the same call - they are mutually exclusive.
- Do NOT use recursive sub-agents for "check X every Y minutes" - use condition mode instead.

RETURNS: For timestamp mode, resumes after the wait. For condition mode, returns whether the condition was met and the final check result.

Examples: wait_for(condition="Bitcoin price is above $100k", check_interval_seconds=900, max_checks=10), wait_for(until_timestamp="2026-03-12T09:00:00Z")"""
