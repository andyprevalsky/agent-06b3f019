"""Effective provider-routing policy shared by execution and cache keying."""

from __future__ import annotations

import os
from typing import Literal, Optional


def anthropic_family_excluded(requested: bool = False) -> bool:
    """Resolve call-scoped and process-wide Anthropic exclusion consistently."""
    return requested or os.getenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def benchmark_compute_token_type() -> Optional[Literal["claude", "gpt"]]:
    """Return the provider family pinned by an isolated benchmark stack.

    Prompt-cache ratchets compare repeated calls from one sequence. Letting the
    unified compute endpoint choose a different provider after an external
    cooldown makes a healthy sequence unmeasurable (for example, GPT on turn
    one and Claude on turn two). The predeploy harness pins one provider so a
    provider outage fails honestly instead of silently changing the metric's
    denominator. Production leaves this unset and retains normal rotation.
    """
    value = os.getenv("BENCHMARK_COMPUTE_TOKEN_TYPE", "").strip().lower()
    if not value:
        return None
    if value not in {"claude", "gpt"}:
        raise ValueError("BENCHMARK_COMPUTE_TOKEN_TYPE must be claude or gpt")
    if value == "claude" and anthropic_family_excluded():
        raise ValueError(
            "BENCHMARK_COMPUTE_TOKEN_TYPE=claude conflicts with "
            "ROSE_EXCLUDE_ANTHROPIC_FAMILY"
        )
    return "claude" if value == "claude" else "gpt"
