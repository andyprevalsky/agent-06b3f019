"""Resolve browser credential references without putting plaintext in model data.

Resolution always produces a separate execution value.  The caller must keep
the original tool arguments for history and redact execution results before
logging or persisting them.  This module does not inspect screenshots or attempt
to prevent arbitrary JavaScript from encoding a credential.
"""

from __future__ import annotations

import json
import math
import re
import sys
import traceback
from html import escape as html_escape
from contextlib import contextmanager
from contextvars import ContextVar
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Iterator, Mapping, Optional
from urllib.parse import quote, quote_plus


_OPAQUE_REF = re.compile(r"\{\{secret:([^{}]+)\}\}")
_IDENTIFIER_CHAR = re.compile(r"[\w$]", re.UNICODE)
_LOG_SECRET_REFS: ContextVar[Optional[Dict[str, str]]] = ContextVar("browser_secret_log_refs", default=None)


def secret_placeholder(ref: str) -> str:
    """Return the explicit, unambiguous placeholder advertised to the model."""
    return "{{secret:" + ref + "}}"


def _string_refs(refs: Optional[Mapping[str, str]]) -> Dict[str, str]:
    return {
        ref: plaintext
        for ref, plaintext in (refs or {}).items()
        if isinstance(ref, str) and ref and isinstance(plaintext, str)
    }


def _replace_markers(text: str, refs: Mapping[str, str], used: Optional[set[str]] = None) -> str:
    def replace(match: re.Match[str]) -> str:
        ref = match.group(1)
        if ref not in refs:
            return match.group(0)
        if used is not None:
            used.add(ref)
        return refs[ref]

    return _OPAQUE_REF.sub(replace, text)


def _value_ref_pattern(bindings: Mapping[str, str]) -> re.Pattern[str]:
    password_refs = sorted((ref for ref in bindings if ref.startswith("pwd:")), key=len, reverse=True)
    alternatives = [r"\{\{secret:([^{}]+)\}\}"]
    if password_refs:
        alternatives.append(
            r"(?<![\w:@.+-])(?:" + "|".join(re.escape(ref) for ref in password_refs) + r")(?![\w:@.+-])"
        )
    return re.compile("|".join(alternatives))


def referenced_secret_refs(value: Any, refs: Optional[Mapping[str, str]]) -> set[str]:
    """Find registered references in parameter values without copying the payload."""
    bindings = _string_refs(refs)
    tokens = _value_ref_pattern(bindings)
    used: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, str):
            if item in bindings:
                used.add(item)
                return
            for match in tokens.finditer(item):
                ref = match.group(1) if match.group(1) is not None else match.group(0)
                if ref in bindings:
                    used.add(ref)
        elif isinstance(item, dict):
            for entry in item.values():
                visit(entry)
        elif isinstance(item, (list, tuple)):
            for entry in item:
                visit(entry)

    visit(value)
    return used


def resolve_secret_values(value: Any, refs: Optional[Mapping[str, str]]) -> Any:
    """Copy tool parameter values, resolving explicit or whole-value legacy refs.

    Password aliases have a distinctive ``pwd:`` prefix and can also occur as
    bounded tokens in a larger value.  Bare card aliases can be ordinary field
    names, so they resolve only when they occupy the entire parameter value.
    Replacements are simultaneous: a secret containing another reference is data.
    """
    bindings = _string_refs(refs)
    tokens = _value_ref_pattern(bindings)

    def resolve(item: Any) -> Any:
        if isinstance(item, str):
            if item in bindings:
                return bindings[item]

            def replace(match: re.Match[str]) -> str:
                ref = match.group(1) if match.group(1) is not None else match.group(0)
                return bindings.get(ref, match.group(0))

            return tokens.sub(replace, item)
        if isinstance(item, dict):
            return {key: resolve(entry) for key, entry in item.items()}
        if isinstance(item, list):
            return [resolve(entry) for entry in item]
        if isinstance(item, tuple):
            return tuple(resolve(entry) for entry in item)
        return item

    return resolve(value)


def _decode_js_string(text: str) -> str:
    """Decode a quoted JS literal's content, without evaluating any source."""
    result = []
    index = 0
    escapes = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t", "v": "\v", "0": "\0"}
    while index < len(text):
        char = text[index]
        if char != "\\":
            result.append(char)
            index += 1
            continue
        index += 1
        if index >= len(text):
            raise ValueError("Unterminated JavaScript string escape")
        char = text[index]
        if char in "\r\n":
            index += 2 if char == "\r" and text[index:index + 2] == "\r\n" else 1
            continue
        if char == "x":
            digits = text[index + 1:index + 3]
            if not re.fullmatch(r"[0-9a-fA-F]{2}", digits):
                raise ValueError("Invalid JavaScript hexadecimal escape")
            result.append(chr(int(digits, 16)))
            index += 3
            continue
        if char == "u":
            if text[index + 1:index + 2] == "{":
                end = text.find("}", index + 2)
                digits = text[index + 2:end] if end >= 0 else ""
                if not re.fullmatch(r"[0-9a-fA-F]{1,6}", digits) or int(digits, 16) > 0x10FFFF:
                    raise ValueError("Invalid JavaScript Unicode escape")
                result.append(chr(int(digits, 16)))
                index = end + 1
            else:
                digits = text[index + 1:index + 5]
                if not re.fullmatch(r"[0-9a-fA-F]{4}", digits):
                    raise ValueError("Invalid JavaScript Unicode escape")
                result.append(chr(int(digits, 16)))
                index += 5
            continue
        if char in "1234567" or (char == "0" and text[index + 1:index + 2].isdigit()):
            # Legacy octal depends on strict mode. Never silently change it.
            raise ValueError("Legacy octal escapes are unsupported in credential-bearing JavaScript strings")
        result.append(escapes.get(char, char))
        index += 1
    return "".join(result)


def _template_content(value: str) -> str:
    # JSON escaping handles control characters, Unicode separators and lone
    # surrogates. Backticks and interpolation have additional template meaning.
    return json.dumps(value, ensure_ascii=True)[1:-1].replace("`", "\\`").replace("${", "\\${")


class _EvaluateResolver:
    """A lexical pass: only literals/explicit markers can become secret data."""

    _PREFIX_WORDS = frozenset({
        "return", "throw", "case", "delete", "void", "typeof", "new", "in", "of",
        "yield", "await", "instanceof", "else", "do",
    })
    _CONTROL_WORDS = frozenset({"if", "while", "for", "with", "switch", "catch"})

    def __init__(self, code: str, refs: Mapping[str, str]):
        self.code = code
        self.refs = refs
        self.used: set[str] = set()

    def _next_non_comment(self, index: int) -> int:
        while index < len(self.code):
            if self.code[index].isspace():
                index += 1
            elif self.code.startswith("//", index):
                end = self.code.find("\n", index + 2)
                index = len(self.code) if end < 0 else end + 1
            elif self.code.startswith("/*", index):
                end = self.code.find("*/", index + 2)
                index = len(self.code) if end < 0 else end + 2
            else:
                break
        return index

    def _quoted(self, start: int, *, property_key: bool, possible_object_key: bool) -> tuple[str, int]:
        delimiter = self.code[start]
        index = start + 1
        while index < len(self.code):
            if self.code[index] == "\\":
                index += 2
            elif self.code[index] == delimiter:
                end = index + 1
                content = self.code[start + 1:index]
                # Most source strings are unrelated to credentials; preserve
                # them byte-for-byte, including escape style and directives.
                if not ("secret:" in content or any(ref in content for ref in self.refs)):
                    return self.code[start:end], end
                decoded = _decode_js_string(content)
                next_index = self._next_non_comment(end)
                object_key = possible_object_key and self.code[next_index:next_index + 1] == ":"
                if decoded.startswith("pwd:") and decoded in self.refs and not property_key and not object_key:
                    self.used.add(decoded)
                    resolved = self.refs[decoded]
                else:
                    resolved = _replace_markers(decoded, self.refs, self.used)
                return (json.dumps(resolved, ensure_ascii=True) if resolved != decoded else self.code[start:end]), end
            else:
                index += 1
        raise ValueError("Unterminated JavaScript string literal")

    def _regex(self, start: int) -> int:
        index = start + 1
        character_class = False
        while index < len(self.code):
            char = self.code[index]
            if char == "\\":
                index += 2
                continue
            if char in "\r\n":
                return start + 1
            if char == "[":
                character_class = True
            elif char == "]":
                character_class = False
            elif char == "/" and not character_class:
                index += 1
                while index < len(self.code) and self.code[index].isalpha():
                    index += 1
                return index
            index += 1
        return start + 1

    def _template(self, start: int, *, tagged: bool) -> tuple[str, int]:
        index = start + 1
        chunk_start = index
        chunks = []
        interpolated = False
        changed = False

        def append_chunk(end: int) -> None:
            nonlocal changed
            raw = self.code[chunk_start:end]
            if "secret:" not in raw:
                chunks.append(raw)
                return
            decoded = _decode_js_string(raw)
            resolved = _replace_markers(decoded, self.refs, self.used)
            changed = changed or resolved != decoded
            chunks.append(_template_content(resolved) if resolved != decoded else raw)

        while index < len(self.code):
            char = self.code[index]
            if char == "\\":
                index += 2
                continue
            if char == "`":
                if not interpolated:
                    raw = self.code[start + 1:index]
                    if any(ref in raw for ref in self.refs) or "secret:" in raw:
                        decoded = _decode_js_string(raw)
                        if decoded.startswith("pwd:") and decoded in self.refs:
                            self.used.add(decoded)
                            resolved = self.refs[decoded]
                        else:
                            resolved = _replace_markers(decoded, self.refs, self.used)
                        if resolved != decoded:
                            if tagged:
                                raise ValueError("Secret references in tagged template literals are unsupported; use an ordinary string literal")
                            return json.dumps(resolved, ensure_ascii=True), index + 1
                    return self.code[start:index + 1], index + 1
                append_chunk(index)
                if changed and tagged:
                    raise ValueError("Secret references in tagged template literals are unsupported; use an ordinary string literal")
                return "`" + "".join(chunks) + "`", index + 1
            if self.code.startswith("${", index):
                interpolated = True
                append_chunk(index)
                body, end = self.scan(index + 2, stop_at_brace=True)
                changed = changed or body != self.code[index + 2:end - 1]
                chunks.append("${" + body + "}")
                index = end
                chunk_start = index
                continue
            index += 1
        raise ValueError("Unterminated JavaScript template literal")

    def scan(self, start: int = 0, *, stop_at_brace: bool = False) -> tuple[str, int]:
        pieces = []
        index = start
        braces = 0
        brace_kinds = []
        can_start_regex = True
        previous_word = ""
        previous_token = ""
        parens = []
        brackets = []
        while index < len(self.code):
            char = self.code[index]
            if char.isspace():
                pieces.append(char)
                index += 1
                continue
            if self.code.startswith("//", index) or self.code.startswith("/*", index):
                line = self.code[index + 1] == "/"
                end = self.code.find("\n" if line else "*/", index + 2)
                end = len(self.code) if end < 0 else end + (0 if line else 2)
                pieces.append(self.code[index:end])
                index = end
                continue
            marker = _OPAQUE_REF.match(self.code, index)
            if marker and (index == 0 or not _IDENTIFIER_CHAR.fullmatch(self.code[index - 1])) and (
                marker.end() == len(self.code) or not _IDENTIFIER_CHAR.fullmatch(self.code[marker.end()])
            ):
                ref = marker.group(1)
                if ref in self.refs:
                    self.used.add(ref)
                pieces.append(json.dumps(self.refs[ref], ensure_ascii=True) if ref in self.refs else marker.group(0))
                index = marker.end()
                can_start_regex = False
                previous_word = ""
                previous_token = "literal"
                continue
            if char in "\"'":
                text, index = self._quoted(
                    index,
                    property_key=bool(brackets and brackets[-1]),
                    possible_object_key=previous_token in {"{", ","},
                )
                pieces.append(text)
                can_start_regex = False
                previous_word = ""
                previous_token = "literal"
                continue
            if char == "`":
                text, index = self._template(index, tagged=not can_start_regex)
                pieces.append(text)
                can_start_regex = False
                previous_word = ""
                previous_token = "literal"
                continue
            if char == "/" and can_start_regex:
                end = self._regex(index)
                pieces.append(self.code[index:end])
                index = end
                can_start_regex = False
                previous_word = ""
                previous_token = "literal"
                continue
            if _IDENTIFIER_CHAR.fullmatch(char):
                end = index + 1
                while end < len(self.code) and _IDENTIFIER_CHAR.fullmatch(self.code[end]):
                    end += 1
                previous_word = self.code[index:end]
                previous_token = previous_word
                pieces.append(previous_word)
                can_start_regex = previous_word in self._PREFIX_WORDS
                index = end
                continue
            if self.code.startswith("=>", index):
                pieces.append("=>")
                index += 2
                previous_word = ""
                previous_token = "=>"
                can_start_regex = True
                continue
            if char == "{":
                braces += 1
                brace_kinds.append(
                    previous_token in {"", ")", ";", "}", "=>", "else", "try", "finally", "do"}
                )
            elif char == "}":
                if stop_at_brace and braces == 0:
                    return "".join(pieces), index + 1
                braces -= 1
            if char == "(":
                parens.append(previous_word in self._CONTROL_WORDS)
                can_start_regex = True
            elif char == ")":
                can_start_regex = parens.pop() if parens else False
            elif char == "[":
                brackets.append(not can_start_regex)
                can_start_regex = True
            elif char == "]":
                if brackets:
                    brackets.pop()
                can_start_regex = False
            elif char == "}":
                can_start_regex = brace_kinds.pop() if brace_kinds else False
            else:
                can_start_regex = char not in ".}"
            pieces.append(char)
            index += 1
            previous_word = ""
            previous_token = char
        if stop_at_brace:
            raise ValueError("Unterminated JavaScript template interpolation")
        return "".join(pieces), index


def resolve_evaluate_secret_refs(code: str, refs: Optional[Mapping[str, str]]) -> str:
    """Resolve credential literals in JavaScript with escaping appropriate to JS.

    Comments, regexes, identifiers, and legacy property names are untouched.
    Bare card field names remain ordinary JavaScript data; only explicit
    markers or unambiguous legacy ``pwd:`` literals resolve credentials.
    This lexical transform does not execute source and introduces no global
    variables or browser state. Explicit markers can also be literal expressions.
    """
    bindings = _string_refs(refs)
    if not bindings or not isinstance(code, str):
        return code
    return _EvaluateResolver(code, bindings).scan()[0]


def referenced_evaluate_secret_refs(code: str, refs: Optional[Mapping[str, str]]) -> set[str]:
    """Find the JS references using exactly the same literal lexer as resolution."""
    bindings = _string_refs(refs)
    if not bindings or not isinstance(code, str):
        return set()
    resolver = _EvaluateResolver(code, bindings)
    resolver.scan()
    return resolver.used


def _is_masked_secret_ref(ref: str) -> bool:
    """Every registered credential binding is private, including short card fields."""
    return isinstance(ref, str) and bool(ref)


def mask_secret_values(value: Any, secret_refs: Optional[Mapping[str, str]]) -> Any:
    """Copy model-visible data while masking registered plaintext and JSON echoes.

    Outer dictionary keys belong to the tool protocol; nested page-supplied
    keys are redacted along with their values. Booleans remain protocol values.
    Exact numeric echoes of numeric credentials are also replaced by their ref.
    A larger digit sequence is a different numeric value: a CVV of ``234``
    matches ``cvv234`` but does not rewrite DOM index ``1234``. Nonnumeric
    credentials retain substring masking, including inside surrounding labels.
    Replacement text is never rescanned, including when refs contain secrets.
    """
    bindings = _string_refs(secret_refs)
    forms: Dict[str, str] = {}
    numeric: Dict[Decimal, str] = {}
    formatted_patterns = []
    formatted_refs = {}
    for ref, plaintext in bindings.items():
        if not plaintext:
            continue
        common_forms = {
            plaintext,
            html_escape(plaintext, quote=True),
            html_escape(plaintext, quote=True).replace("&#x27;", "&#39;"),
            quote(plaintext, safe=""),
            quote(plaintext),
            quote_plus(plaintext),
        }
        for common_form in common_forms:
            for form in (
                common_form,
                json.dumps(common_form, ensure_ascii=False)[1:-1],
                json.dumps(common_form, ensure_ascii=True)[1:-1],
            ):
                forms.setdefault(form, ref)
                if "/" in form:
                    forms.setdefault(form.replace("/", "\\/"), ref)
        # Hosted payment widgets commonly format the same PAN with spaces or
        # hyphens. Match only those bounded separators, never arbitrary text.
        canonical_ref = re.sub(r"(?::previous|#redacted-[0-9]+)+$", "", ref)
        if canonical_ref == "card_number" and re.fullmatch(r"[0-9]{12,19}", plaintext):
            name = f"formatted_{len(formatted_patterns)}"
            pattern = r"(?<![0-9])" + r"[ \u00a0\u202f\-]?".join(plaintext) + r"(?![0-9])"
            formatted_patterns.append(f"(?P<{name}>{pattern})")
            formatted_refs[name] = ref
        if canonical_ref == "card_expiry" and re.fullmatch(r"[0-9]{2}/[0-9]{2}", plaintext):
            name = f"formatted_{len(formatted_patterns)}"
            month, year = plaintext.split("/")
            pattern = r"(?<![0-9])" + month + r"[ \t\u00a0\u202f]{0,3}/[ \t\u00a0\u202f]{0,3}" + year + r"(?![0-9])"
            formatted_patterns.append(f"(?P<{name}>{pattern})")
            formatted_refs[name] = ref
        try:
            number = Decimal(plaintext)
            if number.is_finite():
                numeric.setdefault(number, ref)
        except InvalidOperation:
            pass
    if not forms:
        return value
    aliases = "|".join(re.escape(ref) for ref in sorted(bindings, key=len, reverse=True))
    # Already-advertised references are public identifiers. Protect complete
    # registered markers/aliases before matching their contents (a CVV may be
    # part of a password alias, and a cardholder name can be the word "card").
    protected = (
        r"(?P<public_ref>\{\{secret:(?:" + aliases + r")\}\}"
        r"|(?<![\w:@.+-])(?:" + aliases + r")(?![\w:@.+-]))"
    )
    literals = [
        (r"(?<![0-9])" + re.escape(form) + r"(?![0-9])")
        if re.fullmatch(r"[0-9]+", form) else re.escape(form)
        for form in sorted(forms, key=len, reverse=True)
    ]
    pattern = re.compile("|".join([protected, *formatted_patterns, *literals]))

    def replacement(match: re.Match[str]) -> str:
        if match.lastgroup == "public_ref":
            return match.group(0)
        ref = formatted_refs[match.lastgroup] if match.lastgroup is not None else forms[match.group(0)]
        return secret_placeholder(ref)

    def mask(item: Any, *, outer: bool = False) -> Any:
        if isinstance(item, str):
            return pattern.sub(replacement, item)
        if isinstance(item, bool):
            return item
        if isinstance(item, (int, float)):
            if isinstance(item, float) and not math.isfinite(item):
                return item
            ref = numeric.get(Decimal(str(item)))
            return secret_placeholder(ref) if ref is not None else item
        if isinstance(item, dict):
            return {(key if outer else mask(key)): mask(entry) for key, entry in item.items()}
        if isinstance(item, list):
            return [mask(entry) for entry in item]
        if isinstance(item, tuple):
            return tuple(mask(entry) for entry in item)
        return item

    return mask(value, outer=isinstance(value, dict))


@contextmanager
def secret_logging_context(refs: Optional[Mapping[str, str]], *, fresh: bool = False) -> Iterator[None]:
    """Bind redaction to this async task and descendants; always restore scope.

    Enter ``fresh=True`` at activity entry before starting child tasks. Those
    children share only that activity's dictionary, including later bindings.
    Nested actions retain the activity's union of previously known values.
    There is no worker-wide secret registry.
    """
    existing = _LOG_SECRET_REFS.get()
    bindings = existing if existing is not None and not fresh else {}
    _register_log_bindings(bindings, refs)
    # An empty activity scope must still retain its dictionary: an already
    # running event bus inherits this same activity-owned object and needs to
    # see credentials registered after it started.
    token = _LOG_SECRET_REFS.set(bindings)
    try:
        yield
    finally:
        _LOG_SECRET_REFS.reset(token)


def _register_log_bindings(bindings: Dict[str, str], refs: Optional[Mapping[str, str]]) -> None:
    for ref, plaintext in _string_refs(refs).items():
        label = ref
        suffix = 1
        while label in bindings and bindings[label] != plaintext:
            label = f"{ref}#redacted-{suffix}"
            suffix += 1
        bindings[label] = plaintext


def register_logging_secret_refs(refs: Optional[Mapping[str, str]]) -> None:
    """Update the current activity's shared log policy, retaining older values.

    Enter an empty logging context before starting the browser/event bus.
    Descendants inherit that dictionary, so later registration protects logs
    from event handlers created before the credential was available. Distinct
    activities have distinct dictionaries; no worker-wide secret map exists.
    """
    bindings = _LOG_SECRET_REFS.get()
    if bindings is not None:
        _register_log_bindings(bindings, refs)


def redact_current_secret_values(value: Any) -> Any:
    """Redact known activity bindings before DOM binding or during cleanup."""
    return mask_secret_values(value, _LOG_SECRET_REFS.get())


def current_secret_placeholders() -> frozenset[str]:
    """Only placeholders issued by this activity may bypass generic redaction."""
    return frozenset(secret_placeholder(ref) for ref in (_LOG_SECRET_REFS.get() or {}))


def redact_secret_log_values(logger: Any, method_name: str, event_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Shared structlog/stdlib processor for execution-scoped credential logs."""
    refs = _LOG_SECRET_REFS.get()
    if not refs:
        return event_dict

    def exception_values(item: Any) -> Any:
        if isinstance(item, BaseException):
            return f"{type(item).__name__}: {item}"
        if isinstance(item, dict):
            return {key: exception_values(value) for key, value in item.items()}
        if isinstance(item, list):
            return [exception_values(value) for value in item]
        if isinstance(item, tuple):
            return tuple(exception_values(value) for value in item)
        return item

    safe_event = dict(event_dict)
    exception_info = safe_event.pop("exc_info", None)
    if exception_info:
        if exception_info is True:
            exception_info = sys.exc_info()
        elif isinstance(exception_info, BaseException):
            exception_info = (type(exception_info), exception_info, exception_info.__traceback__)
        if isinstance(exception_info, tuple) and len(exception_info) == 3:
            safe_event["exception"] = "".join(traceback.format_exception(*exception_info))
        else:
            safe_event["exception"] = str(exception_info)
    visible = mask_secret_values(exception_values(safe_event), refs)
    # These fields identify the producing task/session, rather than page data.
    # A short CVV occurring in a public ID must not detach logs from their
    # owner. Nested page payloads and exception messages remain redacted.
    for key in (
        "agent_id", "user_id", "task_id", "session_id", "workflow_id", "run_id",
        "tool_call_id", "request_id", "span_id", "parent_span_id",
        "temporal_workflow", "temporal_activity",
    ):
        if key in safe_event:
            visible[key] = safe_event[key]
    return visible
