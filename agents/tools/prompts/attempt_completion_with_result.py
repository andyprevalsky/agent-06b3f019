"""Prompt for attempt_completion_with_result tool.

Used by sub-agent loops (explore, etc.) where the parent receives the
`result` string as the spawn_agent tool result. There is no future turn
after this call and no separate grader.
"""

PROMPT = """Submit your final findings to the parent agent and end your loop.

The `result` string you submit here is the ONLY payload the parent agent receives. There is no future turn after this call returns, so your `result` must be complete and self-contained when you emit it.

Requirements:
- Complete: do not defer the answer. There is no future turn.
- Grounded: every claim must be backed by evidence from your prior tool results. If a fact cannot be found, report the gap explicitly ("No results for [X] after searching [keywords]") rather than fabricating it.
- Token-efficient, punctual, and information-dense. Strip filler; every sentence should carry signal.
- Cite sources inline with [N] tags and end `result` with a `Sources:` block mapping each tag to its URL or source identifier.

MANDATORY: Emit a single `attempt_completion_with_result` tool_use block, do not batch it with other tool calls.
"""
