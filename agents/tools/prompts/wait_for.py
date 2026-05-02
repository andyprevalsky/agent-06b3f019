"""Prompt for wait_for tool."""

# Examples retained because the validator hard-fails when both or neither of
# until_timestamp/condition are passed, and the two modes carry different
# parameter shapes (timestamp uses no polling args; condition needs
# check_interval_seconds and max_checks). Without explicit examples models
# routinely emit invalid combinations.
PROMPT = """Pauses execution until a specific timestamp is reached or a natural-language condition is met.

Usage:
- Pass exactly one of until_timestamp (ISO 8601) or condition (natural language); they are mutually exclusive.
- In condition mode, an explore agent polls every check_interval_seconds up to max_checks times.
- Use context_gates to trim the polling explore agent's user context for pure web-based checks.
- Do not spawn recursive sub-agents for "check X every Y minutes" - use condition mode here.
- Returns the final check result (condition mode) or resumes after the wait (timestamp mode).

# Examples
Timestamp mode:
  wait_for(until_timestamp="2026-03-12T09:00:00Z")
Condition mode:
  wait_for(condition="Bitcoin price is above $100k", check_interval_seconds=900, max_checks=10)"""
