"""Policy redaction of credential-shaped values in free text (stdlib only)."""

import json
import re

# Includes env-style suffixes such as SECRET_KEY, SECRET_ACCESS_KEY and PRIVATE_KEY.
_KEY = (
    r"(?:api[_-]?key|(?:access|refresh|id|auth)[_-]?token|token|authorization|passwd|password"
    r"|private[_-]?key|(?:client[_-]?)?secret(?:[_-]?(?:access[_-]?)?key)?)"
)
_SENSITIVE_KEY = re.compile(rf"(?i)^{_KEY}$")

SECRET_PATTERNS = [
    # Optional quotes around the key (JSON), an optional auth scheme word
    # (``Authorization: Bearer <token>``), then a quoted value (escaped quotes
    # stay inside it) or a bare value.
    re.compile(
        rf"(?i)(['\"]?{_KEY}['\"]?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?"
        r"(\"[^\"\\]*(?:\\.[^\"\\]*)*\"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s,;}]+)"
    ),
    re.compile(r"(?i)(bearer\s+)[a-z0-9._~+/=-]{12,}"),
]


def _replace_value(match: re.Match) -> str:
    if match.re.groups < 2:
        return f"{match.group(1)}[REDACTED]"
    quote = match.group(2)[0]
    # Keep the key, separator and any quoting so JSON stays well-formed.
    return f"{match.group(1)}{quote}[REDACTED]{quote}" if quote in "\"'" else f"{match.group(1)}[REDACTED]"


def _redact_patterns(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(_replace_value, redacted)
    return redacted


def _redact_json_value(value: object, depth: int = 0, trusted_placeholders: frozenset[str] = frozenset()) -> tuple[object, bool]:
    """Scrub JSON fields, including JSON serialized inside a string value."""
    if isinstance(value, dict):
        result = {}
        changed = False
        for key, item in value.items():
            is_trusted_placeholder = isinstance(item, str) and item in trusted_placeholders
            if _SENSITIVE_KEY.fullmatch(key) and not is_trusted_placeholder:
                result[key] = "[REDACTED]"
                changed = changed or item != "[REDACTED]"
            else:
                result[key], item_changed = _redact_json_value(item, depth + 1, trusted_placeholders)
                changed = changed or item_changed
        return result, changed
    if isinstance(value, list):
        result = []
        changed = False
        for item in value:
            clean, item_changed = _redact_json_value(item, depth + 1, trusted_placeholders)
            result.append(clean)
            changed = changed or item_changed
        return result, changed
    if isinstance(value, str):
        clean = _redact_patterns_preserving_trusted(value, trusted_placeholders)
        if depth < 8 and clean.lstrip().startswith(("{", "[", '"')):
            try:
                nested = json.loads(clean)
            except (ValueError, TypeError):
                pass
            else:
                if isinstance(nested, (dict, list, str)):
                    nested_clean, nested_changed = _redact_json_value(nested, depth + 1, trusted_placeholders)
                    if nested_changed:
                        return json.dumps(nested_clean, ensure_ascii=False), True
        return clean, clean != value
    return value, False


def _redact_patterns_preserving_trusted(text: str, trusted_placeholders: frozenset[str]) -> str:
    if not trusted_placeholders:
        return _redact_patterns(text)
    pieces = re.split(r"(\{\{secret:[^}]+\}\})", text)
    return "".join(piece if piece in trusted_placeholders else _redact_patterns(piece) for piece in pieces)


def redact_sensitive_text(text: str, *, trusted_placeholders: frozenset[str] = frozenset()) -> str:
    if text.lstrip().startswith(("{", "[", '"')):
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            pass
        else:
            if isinstance(parsed, (dict, list, str)):
                clean, changed = _redact_json_value(parsed, trusted_placeholders=trusted_placeholders)
                if changed:
                    return json.dumps(clean, ensure_ascii=False)
                # A parsed JSON value is already redacted at its field/value
                # boundaries. Regexing the serialized envelope can consume a
                # quote beside an allowed placeholder and corrupt the JSON.
                return text
    return _redact_patterns_preserving_trusted(text, trusted_placeholders)
