"""Read-only access to archived trace bundles + credential redaction.

Bundles under ``trace-archive/`` are never written from this package.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from helpers.trace_archive import decrypt_and_validate_artifact, read_archive_artifact

_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b((?:github\s+)?api[\s_-]?(?:key|token)|access[\s_-]?token|refresh[\s_-]?token|"
    r"authorization|password|passwd|secret|private[\s_-]?key|otp|one[\s_-]?time[\s_-]?code)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}")
_HIGH_CONFIDENCE_SECRET_RE = re.compile(
    r"\b(?:"
    r"gh[pousr]_[A-Za-z0-9]{20,255}|"
    r"github_pat_[A-Za-z0-9_]{20,255}|"
    r"sk-[A-Za-z0-9_-]{20,255}|"
    r"xox[baprs]-[A-Za-z0-9-]{20,255}|"
    r"AKIA[A-Z0-9]{16}|"
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r")\b"
)
# 13-19 digit runs (card PANs) and 3-4 digit CVC-looking values after "cvc/cvv".
_CARD_PAN_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_CVC_RE = re.compile(r"(?i)\b(cvc|cvv|security code)(\s*[:=]?\s*)(\d{3,4})\b")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# A leading plus and 10-15 contiguous digits is unambiguously an E.164 phone
# number; keep this separate from formatted local numbers so ISO dates and
# ordinary numeric identifiers cannot match it.
_E164_PHONE_RE = re.compile(r"(?<![\w/.-])\+\d{10,15}(?![\w/-])")
# Phone numbers in the shapes people actually type: +1 (972) 977-7432, 972-977-7432,
# +44 20 7946 0958. Never a bare digit run glued to letters/hyphens (ids, hostnames).
_PHONE_RE = re.compile(
    r"(?<![\w/.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w/-])"
)
_URL_TOKEN_RE = re.compile(r"https?://[^\s\"'<>)\]]+")
_URL_SENSITIVE_PARAM_RE = re.compile(
    r"(?i)([?&](?:card(?:_?number)?|pan|cvc|cvv|email|e-?mail|phone|mobile|tel|"
    r"password|passwd|secret|token|api[_-]?key|authorization)=)([^&#]*)"
)


def _luhn_valid(value: str) -> bool:
    digits = [int(char) for char in value if char.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    parity = len(digits) % 2
    total = 0
    for index, digit in enumerate(digits):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def _redact_url(url: str) -> str:
    """Scrub sensitive URL values without corrupting ordinary public IDs."""
    redacted = _SECRET_ASSIGNMENT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}REDACTED", url)
    redacted = _BEARER_RE.sub("Bearer REDACTED", redacted)
    redacted = _HIGH_CONFIDENCE_SECRET_RE.sub("REDACTED", redacted)
    redacted = _CVC_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}REDACTED", redacted)
    redacted = _URL_SENSITIVE_PARAM_RE.sub(lambda m: f"{m.group(1)}REDACTED", redacted)
    redacted = _EMAIL_RE.sub("REDACTED_EMAIL", redacted)
    redacted = _E164_PHONE_RE.sub("REDACTED_PHONE", redacted)
    redacted = _PHONE_RE.sub("REDACTED_PHONE", redacted)

    def _pan(match: re.Match[str]) -> str:
        # Long public content IDs are common in URL paths. A Luhn-valid run is
        # card-shaped; a non-Luhn run remains an operational identifier.
        return "REDACTED_PAN" if _luhn_valid(match.group(0)) else match.group(0)

    return _CARD_PAN_RE.sub(_pan, redacted)


def _transform_urls(text: str, prose_transform) -> str:
    """Apply URL-aware and prose-aware transforms without conflating their syntax."""
    urls: list[str] = []

    def _hold(match: re.Match[str]) -> str:
        urls.append(match.group(0))
        return f"\x00URL{len(urls) - 1}\x00"

    transformed = prose_transform(_URL_TOKEN_RE.sub(_hold, text))
    for index, url in enumerate(urls):
        transformed = transformed.replace(f"\x00URL{index}\x00", _redact_url(url))
    return transformed


def redact_reference_text(text: str) -> str:
    """Remove credential-shaped values before text enters a memory record or prompt."""

    def _redact(prose: str) -> str:
        redacted = _SECRET_ASSIGNMENT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", prose)
        redacted = _BEARER_RE.sub("Bearer [REDACTED]", redacted)
        redacted = _HIGH_CONFIDENCE_SECRET_RE.sub("[REDACTED]", redacted)
        redacted = _CVC_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", redacted)
        return _CARD_PAN_RE.sub("[REDACTED-PAN]", redacted)

    return _transform_urls(text, _redact)


def scrub_personal_data(text: str) -> str:
    """Mask emails and phone numbers: memories describe paths, never who walked them.

    URL structure is preserved, but sensitive query values and PII-shaped URL
    contents are still scrubbed. Non-card public numeric IDs remain intact.
    """

    def _scrub(prose: str) -> str:
        scrubbed = _EMAIL_RE.sub("[EMAIL]", prose)
        scrubbed = _E164_PHONE_RE.sub("[PHONE]", scrubbed)
        return _PHONE_RE.sub("[PHONE]", scrubbed)

    return _transform_urls(text, _scrub)


def sanitize_memory_text(text: str) -> str:
    """Apply the canonical credential and personal-data policy to memory text."""
    return scrub_personal_data(redact_reference_text(text))


def read_bundle_json(root_agent_id: str, path: str) -> Optional[dict[str, Any]]:
    """Decrypt one JSON artifact of a bundle, or None when absent."""
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        return None
    value = json.loads(decrypt_and_validate_artifact(*stored).decode("utf-8"))
    return value if isinstance(value, dict) else None
