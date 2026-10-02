"""URL extraction shared by challenge recovery and the challenge classifier.

Kept dependency-free so challenge_recovery and challenge_llm_classifier can
both import it without importing each other.
"""

from __future__ import annotations

import re
from typing import List, Sequence, Tuple
from urllib.parse import urlparse

_URL_IN_TEXT_RE = re.compile(r"https?://[^\s)\]\"'<>]+", re.IGNORECASE)


def blocked_resource_urls_for_verify(urls: Sequence[str] | None) -> Tuple[str, ...]:
    """Deduped absolute http(s) URLs from the failures that triggered recovery."""
    cleaned: List[str] = []
    seen: set[str] = set()
    for raw in urls or ():
        value = str(raw or "").strip()
        if not value.startswith(("http://", "https://")):
            continue
        parsed = urlparse(value)
        if not parsed.hostname:
            continue
        # Drop query/fragment noise; keep path so script probes stay accurate.
        normalized = f"{parsed.scheme}://{parsed.hostname.lower()}{parsed.path or '/'}"
        if normalized in seen:
            continue
        seen.add(normalized)
        cleaned.append(normalized)
    return tuple(cleaned)


def urls_cited_in_recovery_reason(recovery_reason: str | None) -> Tuple[str, ...]:
    """Extract normalized http(s) URLs embedded in the agent recovery reason."""
    text = (recovery_reason or "").strip()
    if not text:
        return ()
    raw_urls = [match.group(0).rstrip(".,;") for match in _URL_IN_TEXT_RE.finditer(text)]
    return blocked_resource_urls_for_verify(raw_urls)
