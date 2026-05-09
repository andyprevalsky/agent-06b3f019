"""Prompt for attempt_completion tool."""

PROMPT = """Use this tool when you are finished with your task and are ready for the grader to review your work.

Usage:
- When you are in PLAN phase, call after set_plan succeeds and no more clarifications are needed.
- When you are in EXECUTE phase, call when the goal is fully accomplished.

MANDATORY: This must be the only tool call in the turn it is emitted; do not batch it with other tool calls.
"""
