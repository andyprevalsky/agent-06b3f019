"""Import-safe contract for user-facing completion-summary text.

The workflow and benchmark harness must agree on this boundary.  Keep the
module pure: Temporal workflows import it inside ``imports_passed_through`` and
the standalone benchmark runner imports it before any worker is running.
"""

from __future__ import annotations

import json
import re
from typing import Any


FAST_MODE_SUMMARY_MARKERS = (
    "fm_cold_namespace_passthrough",
    "fm_trajectory_end_passthrough",
    "fast mode",
    "fast mode cache trajectory ended",
    "cached trajectory",
    "from_fast_cache",
    "based on prior tool evidence",
    "the task completed successfully; verified results are included below",
)

_FETCH_FILTER_PROMPT = "you are filtering a fetched web page for an autonomous agent"
_TOOL_PARAMETER_NAMES = (
    "query",
    "url",
    "pattern",
    "path",
    "search_term",
    "search_query",
    "person",
    "person_name",
    "company",
    "params",
    "parameters",
)
_PARAMETER_NAME_PATTERN = "|".join(re.escape(name) for name in _TOOL_PARAMETER_NAMES)
_MARKDOWN_TOOL_ENVELOPE = re.compile(
    rf"^(?:\*\*params passed:\*\*\s*)?"
    rf"(?:[-*]\s*)?\*\*(?:{_PARAMETER_NAME_PATTERN})\*\*\s*:"
    rf"[\s\S]*?\*\*(?:result|output):\*\*",
    flags=re.IGNORECASE,
)
_PLAIN_TOOL_ENVELOPE = re.compile(
    rf"^(?:params passed\s*:\s*)?"
    rf"(?:{_PARAMETER_NAME_PATTERN})\s*:"
    rf"[\s\S]*?^(?:result|output)\s*:",
    flags=re.IGNORECASE | re.MULTILINE,
)


def _json_tool_envelope(text: str) -> bool:
    candidate = text.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        candidate = "\n".join(lines[1:-1]).strip() if len(lines) >= 3 else ""
    if not candidate.startswith("{"):
        return False
    try:
        payload = json.loads(candidate)
    except (TypeError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    keys = {str(key).strip().lower() for key in payload}
    has_result = bool(keys & {"result", "output", "content", "results"})
    has_parameters = bool(keys & set(_TOOL_PARAMETER_NAMES))
    nested_params = isinstance(payload.get("params"), dict) or isinstance(
        payload.get("parameters"), dict
    )
    return has_result and (has_parameters or nested_params)


def is_raw_tool_envelope(value: Any) -> bool:
    """Return whether text is tool I/O rather than user-facing narration."""
    text = str(value or "").strip()
    if not text:
        return False
    lowered = text.lower()
    if _FETCH_FILTER_PROMPT in lowered:
        return True
    if _MARKDOWN_TOOL_ENVELOPE.search(text) or _PLAIN_TOOL_ENVELOPE.search(text):
        return True
    return _json_tool_envelope(text)


def has_fast_mode_summary_marker(value: Any) -> bool:
    """Return whether text contains an explicit Fast Mode summary sentinel."""
    lowered = str(value or "").strip().lower()
    return bool(lowered) and any(marker in lowered for marker in FAST_MODE_SUMMARY_MARKERS)


def is_ablated_completion_summary(value: Any) -> bool:
    """Reject empty/cache-stub/tool-envelope text at every completion boundary."""
    text = str(value or "").strip()
    if not text:
        return True
    return has_fast_mode_summary_marker(text) or is_raw_tool_envelope(text)
