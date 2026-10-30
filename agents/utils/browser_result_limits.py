"""Character bounds for browser observations sent to the model."""

EVALUATE_RESULT_MAX_CHARS = 20_000
BROWSER_STATE_MAX_CHARS = 40_000


def cap_browser_result_text(text: str, max_chars: int) -> str:
    """Include the truncation notice inside the total character budget."""
    if len(text) <= max_chars:
        return text
    marker = f"\n... [Truncated after {max_chars} characters]"
    return text[: max_chars - len(marker)] + marker
