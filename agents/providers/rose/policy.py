"""Effective provider-routing policy shared by execution and cache keying."""

from __future__ import annotations

import os


def anthropic_family_excluded(requested: bool = False) -> bool:
    """Resolve call-scoped and process-wide Anthropic exclusion consistently."""
    return requested or os.getenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
