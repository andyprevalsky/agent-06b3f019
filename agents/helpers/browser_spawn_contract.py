"""Workflow-safe benchmark task and DOM patch helpers.

Kept outside ``agents/benchmarks/`` so Temporal's replay-surface hash never
pulls benchmark catalog / fixture modules into the workflow generation key.
Harness code that needs ``tasks.json`` stays in ``benchmarks/spawn_contract.py``.
"""

from __future__ import annotations

import os
import re
from typing import Optional

BENCHMARK_ACTIVE_TASK_ENV = "BENCHMARK_ACTIVE_TASK_NAME"
BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV = "BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH"

_DOM_PATCH_EVALUATE_PATTERNS = (
    re.compile(r"\.(?:textContent|innerText|innerHTML)\s*=", re.IGNORECASE),
    re.compile(r"createElement\s*\(\s*['\"]option['\"]", re.IGNORECASE),
    re.compile(r"oat\s*\(\s*default\s*\)", re.IGNORECASE),
    re.compile(r"return\s+['\"]patched", re.IGNORECASE),
    re.compile(r"label(?:Text|s)?\s*[:=].*?(?:oat|almond|milk)", re.IGNORECASE),
)


def active_benchmark_task_name() -> Optional[str]:
    name = (os.environ.get(BENCHMARK_ACTIVE_TASK_ENV) or "").strip()
    return name or None


def active_benchmark_blocks_dom_patch() -> bool:
    """True when the active task treats payment-card request as success (env only)."""
    return (os.environ.get(BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV) or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def evaluate_dom_patch_blocked(code: str) -> Optional[str]:
    """Return a rejection reason when evaluate would fabricate menu state."""
    text = code if isinstance(code, str) else str(code or "")
    if not text.strip():
        return None
    for pattern in _DOM_PATCH_EVALUATE_PATTERNS:
        if pattern.search(text):
            return (
                "Blocked benchmark evaluate: DOM mutation cannot ground provider-side menu "
                "selections. Choose the closest available modifier or continue checkout."
            )
    return None
