"""Policy redaction of credential-shaped values in free text (stdlib only)."""

import re

# Includes env-style suffixes such as SECRET_KEY, SECRET_ACCESS_KEY and PRIVATE_KEY.
_KEY = (
    r"(?:api[_-]?key|(?:access|refresh|id|auth)[_-]?token|token|authorization|passwd|password"
    r"|private[_-]?key|(?:client[_-]?)?secret(?:[_-]?(?:access[_-]?)?key)?)"
)

SECRET_PATTERNS = [
    # Optional quotes around the key (JSON), an optional auth scheme word
    # (``Authorization: Bearer <token>``), then a quoted value (escaped quotes
    # stay inside it) or a bare value.
    re.compile(
        rf"(?i)(['\"]?{_KEY}['\"]?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?"
        r"(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|[^\s,;]+)"
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
