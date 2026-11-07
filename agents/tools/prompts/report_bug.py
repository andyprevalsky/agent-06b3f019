"""Prompt for report_bug tool."""

PROMPT = """Reports a bug in Rose itself, the same as the user's Report Bug button: a separate engineering agent investigates your run and fixes it. Root agent only.

Use it only after you have confirmed that Rose's own tools, sub-agents or harness malfunction, and ruled out your own arguments and transient errors that a retry clears; not for problems outside Rose such as a website being down or a person not replying. A run files at most one report, so file it once you have evidence and describe every problem you saw, then continue your task."""
