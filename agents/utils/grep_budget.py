"""Bound a grep result page by match-content characters.

The backend caps every page at ``MAX_RESULT_CHARS``; this mirrors that cap on
the agent side so an older/other backend can never hand the agent an unbounded
page (240–323 KB per call was observed for broad patterns over a 10k-message
history). Trailing matches are dropped and paging metadata is rewritten so the
model can continue with ``offset`` instead of losing the tail silently.

Pure Python: used from the grep activity (bounds its Temporal payload too).
"""

from __future__ import annotations

from typing import Any, Dict

CONTENT_TRUNCATION_MARKER = "\n…[match content truncated to {limit} chars]"


def bound_grep_result(result: Dict[str, Any], *, max_chars: int) -> Dict[str, Any]:
    """Return ``result`` with ``matches[].content`` totalling at most ``max_chars``.

    Keeps whole matches in order while the running content length fits. If the
    very first match alone exceeds the budget its content is cut to the budget
    (a single match must always be returned so the search is not a silent no-op).
    When anything was dropped or cut: ``truncated``/``has_more`` become true,
    ``returned`` and ``next_offset`` describe the kept prefix, and
    ``char_truncated``/``applied_char_limit`` record why.
    """
    matches = result.get("matches")
    if not isinstance(matches, list) or max_chars <= 0:
        return result
    kept: list = []
    used = 0
    char_truncated = False
    for match in matches:
        content = match.get("content") if isinstance(match, dict) else None
        length = len(content) if isinstance(content, str) else 0
        if used + length <= max_chars:
            kept.append(match)
            used += length
            continue
        if not kept and isinstance(match, dict):
            budget = max(0, max_chars - used)
            trimmed = dict(match)
            trimmed["content"] = (content or "")[:budget] + CONTENT_TRUNCATION_MARKER.format(limit=budget)
            kept.append(trimmed)
        char_truncated = True
        break
    if not char_truncated:
        return result
    offset = int(result.get("applied_offset") or 0)
    bounded = dict(result)
    bounded["matches"] = kept
    bounded["returned"] = len(kept)
    bounded["truncated"] = True
    bounded["has_more"] = True
    bounded["next_offset"] = offset + len(kept)
    bounded["char_truncated"] = True
    bounded["applied_char_limit"] = max_chars
    return bounded
