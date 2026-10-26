"""Policy redaction of credential-shaped values in free text (stdlib only)."""

import re

SECRET_PATTERNS = [
    re.compile(
        r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[:=]\s*([^\s,;]+)"
    ),
    re.compile(r"(?i)(bearer\s+)[a-z0-9._~+/=-]{12,}"),
]


def redact_sensitive_text(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        if pattern.groups >= 2:
            redacted = pattern.sub(lambda m: f"{m.group(1)}=[REDACTED]", redacted)
        else:
            redacted = pattern.sub(lambda m: f"{m.group(1)}[REDACTED]", redacted)
    return redacted
