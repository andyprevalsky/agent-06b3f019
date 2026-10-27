"""Policy redaction of credential-shaped values in free text (stdlib only)."""

import re

_KEY = r"(?:api[_-]?key|(?:access|refresh|id|auth)[_-]?token|token|authorization|passwd|password|(?:client[_-]?)?secret)"

SECRET_PATTERNS = [
    # Optional quotes around the key (JSON), an optional auth scheme word
    # (``Authorization: Bearer <token>``), then a quoted or bare value.
    re.compile(
        rf"(?i)(['\"]?{_KEY}['\"]?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(\"[^\"]*\"|'[^']*'|[^\s,;]+)"
    ),
    re.compile(r"(?i)(bearer\s+)[a-z0-9._~+/=-]{12,}"),
]


def _replace_value(match: re.Match) -> str:
    if match.re.groups < 2:
        return f"{match.group(1)}[REDACTED]"
    quote = match.group(2)[0]
    # Keep the key, separator and any quoting so JSON stays well-formed.
    return f"{match.group(1)}{quote}[REDACTED]{quote}" if quote in "\"'" else f"{match.group(1)}[REDACTED]"


def redact_sensitive_text(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(_replace_value, redacted)
    return redacted
