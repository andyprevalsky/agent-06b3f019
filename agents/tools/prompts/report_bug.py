"""Prompt for report_bug tool."""

PROMPT = """Reports a bug in Rose itself, the same as the user's Report Bug button: a separate engineering agent investigates your run and fixes it. Root agent only.

Use it when Rose's own tools, sub-agents or harness malfunction, not for problems outside Rose such as a website being down or a person not replying. A run files at most one report, so describe every problem you saw in it, then continue your task."""
