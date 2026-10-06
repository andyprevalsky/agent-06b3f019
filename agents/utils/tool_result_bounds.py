"""Hard bounds on tool-result text before it enters an LLM context.

A single unbounded tool result (a broad ``grep`` over a large synced message
history returned 240–323 KB per call) pushed an explore agent to ~737k context
tokens: compaction cannot shrink one oversized message, and the activity result
then exceeded Temporal's 2 MB payload limit, killing the sub-agent. Every tool
layer should bound its own output; this guard is the last line of defence so no
tool can ever put more than ``TOOL_RESULT_CONTEXT_MAX_CHARS`` into context.

Pure Python only: imported from the workflow sandbox and from activities.
"""

from __future__ import annotations

# ~15k tokens. Large enough for any legitimately verbose tool page (web_fetch
# summaries are ≤ 50k chars before summarization), small enough that eight
# parallel results still fit a 200k window with room for the conversation.
TOOL_RESULT_CONTEXT_MAX_CHARS = 60_000

TRUNCATION_MARKER = "\n\n…[tool result truncated: {shown} of {total} chars shown; narrow the query or page with offset]"


def bound_tool_result_text(text: str, *, max_chars: int = TOOL_RESULT_CONTEXT_MAX_CHARS) -> tuple[str, bool]:
    """Return ``(text, truncated)`` with ``text`` capped at ``max_chars`` plus a marker."""
    if not isinstance(text, str):
        text = str(text)
    if max_chars <= 0 or len(text) <= max_chars:
        return text, False
    return text[:max_chars] + TRUNCATION_MARKER.format(shown=max_chars, total=len(text)), True
