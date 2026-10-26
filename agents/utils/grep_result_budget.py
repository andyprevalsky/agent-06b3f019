"""Fit a grep result page under a character budget without cutting a match."""

from typing import Any, Callable, Dict


def _with_shown_matches(result: Dict[str, Any], kept: int, budget: int) -> Dict[str, Any]:
    matches = result["matches"]
    shown = matches[:kept]
    page = {**result, "matches": shown, "returned": kept, "truncated": True, "has_more": True}
    first = int(result.get("applied_offset") or 0) + 1
    held_back = (
        f"{len(matches) - kept} more matches from this page were held back whole "
        f"to keep this result under {budget:,} characters."
    )
    if "next_page_after" in result:
        page["next_page_after"] = shown[-1].get("path") if shown else result["next_page_after"]
        page["next_offset"] = None
        resume = f"page_after={page['next_page_after']}"
    else:
        page["next_offset"] = first - 1 + kept
        resume = f"offset={page['next_offset']}"
    page["size_notice"] = (
        f"Showing matches {first}-{first - 1 + kept}; {held_back} "
        f"To read them, repeat this grep with {resume}, or narrow pattern, context or record_kind."
    )
    return page


def fit_grep_result_to_budget(result: Dict[str, Any], budget: int, render: Callable[[Any], str]) -> Dict[str, Any]:
    """Hold back whole trailing matches so ``render(result)`` fits ``budget``.

    A character cut ends mid-match and drops the paging fields, so the model
    can neither see the lost matches nor ask for them. Kept matches stay
    byte-identical, and the result names where to resume. One oversized match
    is still returned for the caller's own hard cap.
    """
    matches = result.get("matches")
    if not isinstance(matches, list) or len(matches) < 2 or len(render(result)) <= budget:
        return result
    low, high = 1, len(matches) - 1
    while low < high:
        mid = (low + high + 1) // 2
        if len(render(_with_shown_matches(result, mid, budget))) <= budget:
            low = mid
        else:
            high = mid - 1
    return _with_shown_matches(result, low, budget)
