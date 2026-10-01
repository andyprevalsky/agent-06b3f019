"""Break identical browser-verifier reject loops when output is already complete.

Runtime evidence (browser-smoke agent 9f53aed4, 2026-09-28): live
example.com no longer exposes an H1. Schema generation required
``main_heading: Exact H1 text``. The verifier repeatedly scored 0.5 with
the same reasoning while already emitting a fully populated ``output``
(``main_heading`` + ``page_url``), and the browser loop rejected
``attempt_completion`` until the hub paused the agent (HIGH TOOL COUNT /
timeout).

When the verifier returns the same <1.0 judgment N times in a row AND its
structured ``output`` already satisfies every required schema field, break
the loop with an *unverified* completion (structured output preserved,
``success=False``). A stuck 0.5 with a complete extraction is not a request
for more evidence — continuing burns the smoke budget and ends PAUSED —
but the parent must still be able to tell this apart from a verified pass.
"""

from __future__ import annotations

import os
import re
from typing import Any, Mapping, Optional

from utils.response_schema_constraints import explicitly_allows_empty_value, value_satisfies_output_field_constraints


def _read_max_identical_verifier_rejections() -> int:
    try:
        return int(os.getenv("BROWSER_MAX_IDENTICAL_VERIFIER_REJECTIONS", "3"))
    except ValueError:
        return 3


MAX_IDENTICAL_VERIFIER_REJECTIONS = _read_max_identical_verifier_rejections()

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_verifier_rejection_fingerprint(reasoning: Any, score: float | None = None) -> str:
    """Collapse whitespace/case so identical reject reasons match.

    When ``score`` is provided it is quantized into the fingerprint so a streak
    only grows when both reasoning and score stay the same.
    """
    text = str(reasoning or "").strip().lower()
    if not text:
        return ""
    normalized = _WHITESPACE_RE.sub(" ", text)
    if score is None:
        return normalized
    try:
        score_key = f"{float(score):.2f}"
    except (TypeError, ValueError):
        score_key = "nan"
    return f"{score_key}|{normalized}"


def structured_response_covers_schema(
    structured_response: Any,
    response_schema: Optional[Mapping[str, Any]],
) -> bool:
    """True when every required schema field is present and non-empty.

    Presence-only: this circuit does not verify tool-grounded evidence. Only
    the literal ``required is False`` makes a field optional; any other
    ``required`` value (including non-booleans) is treated as required.

    An optional-only schema still requires a non-empty structured response so
    an empty dict cannot soft-complete after the reject streak.
    """
    if not isinstance(structured_response, Mapping):
        return False
    if not structured_response:
        return False
    fields = []
    if isinstance(response_schema, Mapping) and "fields" in response_schema:
        raw_fields = response_schema.get("fields")
        if not isinstance(raw_fields, list):
            # Malformed schema: do not fall through to the schema-less path.
            return False
        fields = [f for f in raw_fields if isinstance(f, Mapping)]
        if not fields:
            # Declared fields list but none usable — reject soft-accept.
            return False
    if not fields:
        # Schema-less agents: any non-empty structured dict is usable output.
        return True
    saw_required = False
    for field in fields:
        name = field.get("name")
        if not isinstance(name, str) or not name:
            return False
        required = field.get("required", True)
        if required is False:
            if name in structured_response and not value_satisfies_output_field_constraints(structured_response[name], field):
                return False
            continue
        saw_required = True
        value = structured_response.get(name)
        if value is None:
            if field.get("nullable") is True and name in structured_response:
                continue
            return False
        if not value_satisfies_output_field_constraints(value, field):
            return False
        if isinstance(value, str) and not value.strip() and not explicitly_allows_empty_value(value, field):
            return False
        if isinstance(value, (list, dict)) and len(value) == 0 and not explicitly_allows_empty_value(value, field):
            return False
    if not saw_required:
        # Optional-only schema: require at least one named optional field
        # with a non-empty value (ignore unrelated keys like "error").
        for field in fields:
            name = field.get("name")
            if not isinstance(name, str) or not name:
                continue
            value = structured_response.get(name)
            if value is None:
                continue
            if not value_satisfies_output_field_constraints(value, field):
                continue
            if isinstance(value, str) and not value.strip() and not explicitly_allows_empty_value(value, field):
                continue
            if isinstance(value, (list, dict)) and len(value) == 0 and not explicitly_allows_empty_value(value, field):
                continue
            return True
        return False
    return True


def should_soft_accept_identical_verifier_reject(
    *,
    consecutive_identical: int,
    structured_response: Any,
    response_schema: Optional[Mapping[str, Any]],
    threshold: int = MAX_IDENTICAL_VERIFIER_REJECTIONS,
) -> bool:
    """Break the reject loop after N identical <1.0 rejects with complete output.

    Callers must treat a True result as *unverified* completion (preserve
    structured output, do not report verified ``success=True``).
    """
    if consecutive_identical < max(1, int(threshold)):
        return False
    return structured_response_covers_schema(structured_response, response_schema)


def next_identical_reject_streak(
    *,
    previous_fingerprint: str,
    previous_streak: int,
    reasoning: Any,
    score: float,
) -> tuple[str, int]:
    """Update identical-reject streak for a verifier score < 1.0."""
    if float(score) >= 1.0:
        return "", 0
    fingerprint = normalize_verifier_rejection_fingerprint(reasoning, score)
    if not fingerprint:
        return "", 0
    if fingerprint == previous_fingerprint:
        return fingerprint, previous_streak + 1
    return fingerprint, 1
