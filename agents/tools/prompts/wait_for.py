"""Prompt for wait_for tool."""

PROMPT = """Use this tool to pause execution until a specific timestamp is reached or a natural-language condition is met. In condition mode, an explore agent is created every check_interval_seconds up to max_checks times to gather the information necessary to validate whether the condition has been met.

Usage:
- Pass exactly one of until_timestamp (ISO 8601) or condition (natural language); they are mutually exclusive.
- Returns the final check result (condition mode) or resumes after the wait (timestamp mode).

# Examples
Timestamp mode:
  wait_for(description="9:00 AM on March 12", until_timestamp="2026-03-12T09:00:00Z")
Condition mode:
  wait_for(description="BTC price to exceed $100k", condition="Bitcoin price is above $100k", check_interval_seconds=900, max_checks=10)
  wait_for(description="ticket sales to go live", condition="Tickets on the official event page are publicly available to purchase")
  wait_for(description="Bar Shoji to reply", condition="Bar Shoji has replied with information about tonight's walk-in availability")"""
