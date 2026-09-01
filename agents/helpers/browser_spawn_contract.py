"""Workflow-safe browser spawn contract helpers.

Kept outside ``agents/benchmarks/`` so Temporal's replay-surface hash never
pulls benchmark catalog / fixture modules into the workflow generation key.
Harness code that needs ``tasks.json`` stays in ``benchmarks/spawn_contract.py``.
"""

from __future__ import annotations

import os
import re
from copy import deepcopy
from typing import Any, Mapping, Optional
from urllib.parse import urlparse

BENCHMARK_ACTIVE_TASK_ENV = "BENCHMARK_ACTIVE_TASK_NAME"
BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV = "BENCHMARK_ACTIVE_TASK_LIVE_TARGET"
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


def active_benchmark_live_target() -> Optional[str]:
    """Workflow-safe live target lookup (env only — no tasks.json)."""
    target = (os.environ.get(BENCHMARK_ACTIVE_TASK_LIVE_TARGET_ENV) or "").strip()
    if target.startswith(("http://", "https://")):
        return target
    return None


def active_benchmark_blocks_dom_patch() -> bool:
    """True when the active task treats payment-card request as success (env only)."""
    return (os.environ.get(BENCHMARK_ACTIVE_TASK_BLOCK_DOM_PATCH_ENV) or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def primary_live_target(environment: Mapping[str, Any] | None) -> Optional[str]:
    if not environment:
        return None
    targets = environment.get("live_targets") or []
    if not isinstance(targets, list):
        return None
    for target in targets:
        if isinstance(target, str) and target.strip().startswith(("http://", "https://")):
            return target.strip()
    return None


def apply_live_target_to_tool_call(
    live_target: Optional[str],
    tool_call: Mapping[str, Any],
) -> dict[str, Any]:
    patched = dict(tool_call)
    if live_target:
        current_start = str(patched.get("start_url") or "").strip()
        if not current_start or should_replace_start_url(current_start, live_target):
            patched["start_url"] = live_target
    return patched


def should_replace_start_url(current_start: str, live_target: str) -> bool:
    current_host = urlparse(current_start).netloc.lower()
    target_host = urlparse(live_target).netloc.lower()
    if not current_host:
        return True
    if current_host == target_host:
        return False
    # Marketing/homepage detours before order.online are the dominant waste pattern.
    marketing_hosts = {
        "bluebottlecoffee.com",
        "www.bluebottlecoffee.com",
        "www.google.com",
        "google.com",
        "www.bing.com",
        "bing.com",
        "www.doordash.com",
        "doordash.com",
    }
    return current_host in marketing_hosts or current_host != target_host


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


def apply_active_task_spawn_contract(tool_call: Mapping[str, Any]) -> dict[str, Any]:
    """Workflow-safe spawn contract: reads live target from env only."""
    return apply_live_target_to_tool_call(active_benchmark_live_target(), tool_call)


def copy_tool_call(tool_call: Mapping[str, Any]) -> dict[str, Any]:
    return deepcopy(dict(tool_call))
