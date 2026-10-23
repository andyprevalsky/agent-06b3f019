"""Agent Display static checks: what the user was actually shown.

    run ends ─► hydrate_display_artifacts(data, base_url)
                  root + tree messages ─► display rows (metadata.source == "display")
                  page/bundle ─► GET <usercontent path> (entry + same-bundle text files)
                  image/svg+xml ─► storage bytes
                  ─► data["_benchmark"]["display_artifacts"]
               static checks (pure, run on the captured record):
                  display_media_shown       ≥ N displayed items of the allowed kinds
                  display_artifact_figures  one displayed text artifact holds every expected value
                  final_answer_figures      the root's final answer states every expected value

Figures are matched as numbers, not strings: "$2,342.78", "2342.78" and a
float sum such as 2342.7799999999997 in a chart's data array all match
2342.78 within the declared tolerance. Raster images (PNG/JPEG) carry no
text, so they satisfy display_media_shown but never display_artifact_figures.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Awaitable, Callable, Iterable, Optional
from urllib.parse import urlsplit

DISPLAY_CHECK_TYPES = frozenset({"display_media_shown", "display_artifact_figures", "final_answer_figures"})
# Checks that need a displayed item, so the local stack must let sandboxes reach the backend.
SANDBOX_DISPLAY_CHECK_TYPES = frozenset({"display_media_shown", "display_artifact_figures"})
TEXT_MEDIA_KINDS = frozenset({"page", "bundle"})
MAX_ARTIFACT_BYTES = 2_000_000
MAX_BUNDLE_FILES = 16
DEFAULT_TOLERANCE = Decimal("0.005")

_NUMBER_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
_BUNDLE_REF_RE = re.compile(r"""(?:src|href)\s*=\s*["']([^"'#?]+)["']""", re.IGNORECASE)
_TEXT_SUFFIXES = (".js", ".mjs", ".json", ".csv", ".css", ".svg", ".html", ".htm", ".txt")


def display_rows(messages: Iterable[Any]) -> list[dict]:
    """Inline media rows the backend posted for a successful display call."""
    rows: list[dict] = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        metadata = message.get("metadata")
        if not isinstance(metadata, dict) or metadata.get("source") != "display":
            continue
        display = metadata.get("display")
        if isinstance(display, dict) and display.get("kind") == "media":
            rows.append(message)
    return rows


def _row_identity(row: dict) -> str:
    display = row["metadata"]["display"]
    return str(display.get("canonical_id") or display.get("sha256") or row.get("id") or "")


def _numbers(text: str) -> list[Decimal]:
    values: list[Decimal] = []
    for token in _NUMBER_RE.findall(text or ""):
        try:
            values.append(Decimal(token.replace(",", "")))
        except InvalidOperation:
            continue
    return values


def missing_figures(text: str, expected: Iterable[Any], tolerance: Decimal = DEFAULT_TOLERANCE) -> list[str]:
    """Expected values that do not appear as a number in ``text``."""
    found = _numbers(text)
    missing = []
    for raw in expected:
        target = Decimal(str(raw))
        if not any(abs(value - target) <= tolerance for value in found):
            missing.append(str(raw))
    return missing


def _artifacts(data: dict) -> list[dict]:
    artifacts = (data.get("_benchmark") or {}).get("display_artifacts")
    return [a for a in artifacts if isinstance(a, dict)] if isinstance(artifacts, list) else []


def _hydration_error(data: dict) -> str:
    error = (data.get("_benchmark") or {}).get("display_artifacts_error")
    return f" ({error})" if error else ""


def check_display_media_shown(data: dict, check: dict) -> tuple[bool, str]:
    kinds = set(check.get("media_kinds") or [])
    minimum = int(check.get("min_items", 1))
    artifacts = _artifacts(data)
    matching = [a for a in artifacts if not kinds or a.get("media_kind") in kinds]
    if len(matching) < minimum:
        seen = sorted({str(a.get("media_kind")) for a in artifacts})
        return (
            False,
            f"Agent Display showed {len(matching)} item(s) of kinds {sorted(kinds)}; expected at least "
            f"{minimum} (displayed kinds: {seen}){_hydration_error(data)}",
        )
    return True, f"Agent Display showed {len(matching)} matching item(s)"


def check_display_artifact_figures(data: dict, check: dict) -> tuple[bool, str]:
    expected = list(check.get("expected_values") or [])
    if not expected:
        return False, "display_artifact_figures needs expected_values"
    tolerance = Decimal(str(check.get("tolerance", DEFAULT_TOLERANCE)))
    texts = [a for a in _artifacts(data) if isinstance(a.get("text"), str) and a["text"].strip()]
    if not texts:
        return False, f"No displayed HTML/SVG artifact content to check{_hydration_error(data)}"
    best: Optional[list[str]] = None
    for artifact in texts:
        missing = missing_figures(artifact["text"], expected, tolerance)
        if not missing:
            return True, f"Displayed {artifact.get('media_kind')} artifact shows all {len(expected)} figures"
        if best is None or len(missing) < len(best):
            best = missing
    return False, f"No displayed artifact shows every expected figure; closest is missing {best}"


def check_final_answer_figures(final_answer: str, check: dict) -> tuple[bool, str]:
    expected = list(check.get("expected_values") or [])
    if not expected:
        return False, "final_answer_figures needs expected_values"
    if not (final_answer or "").strip():
        return False, "Root final answer was empty"
    missing = missing_figures(final_answer, expected, Decimal(str(check.get("tolerance", DEFAULT_TOLERANCE))))
    if missing:
        return False, f"Root final answer is missing figures {missing}"
    return True, f"Root final answer states all {len(expected)} figures"


FetchText = Callable[[str], Awaitable[Optional[bytes]]]


def _decode(raw: Optional[bytes]) -> Optional[str]:
    if raw is None:
        return None
    return raw[:MAX_ARTIFACT_BYTES].decode("utf-8", errors="replace")


async def _bundle_text(entry_path: str, entry_html: str, fetch_usercontent: FetchText) -> str:
    """Entry HTML plus the same-bundle text files it references (chart data often lives in a .js/.json)."""
    parts = [entry_html]
    base = entry_path.rsplit("/", 1)[0]
    refs: list[str] = []
    for ref in _BUNDLE_REF_RE.findall(entry_html):
        if "://" in ref or ref.startswith(("/", "data:")) or ".." in ref:
            continue
        if ref.lower().endswith(_TEXT_SUFFIXES) and ref not in refs:
            refs.append(ref)
    for ref in refs[:MAX_BUNDLE_FILES]:
        text = _decode(await fetch_usercontent(f"{base}/{ref.lstrip('./')}"))
        if text:
            parts.append(text)
    return "\n".join(parts)


async def artifact_for_row(
    row: dict,
    *,
    fetch_usercontent: FetchText,
    fetch_storage: FetchText,
) -> dict:
    display = row["metadata"]["display"]
    pointer = row.get("file_pointer") or row.get("filePointer") or {}
    kind = str(display.get("media_kind") or pointer.get("kind") or "")
    mime = str(display.get("mime_type") or pointer.get("mime_type") or "")
    artifact: dict = {
        "message_id": row.get("id"),
        "agent_id": row.get("_agent_id"),
        "media_kind": kind,
        "mime_type": mime,
        "canonical_id": display.get("canonical_id"),
        "text": None,
    }
    try:
        usercontent_url = pointer.get("usercontent_url") if isinstance(pointer, dict) else None
        if kind in TEXT_MEDIA_KINDS and isinstance(usercontent_url, str):
            path = urlsplit(usercontent_url).path
            entry = _decode(await fetch_usercontent(path))
            if entry is not None and kind == "bundle":
                entry = await _bundle_text(path, entry, fetch_usercontent)
            artifact["text"] = entry
        elif kind == "image" and "svg" in mime and isinstance(pointer.get("storage_path"), str):
            artifact["text"] = _decode(await fetch_storage(pointer["storage_path"]))
    except Exception as exc:  # evidence gap, reported by the figures check
        artifact["fetch_error"] = str(exc)[:300]
    return artifact


async def hydrate_display_artifacts(
    data: dict,
    *,
    tree_messages: Callable[[], Awaitable[list[dict]]],
    fetch_usercontent: FetchText,
    fetch_storage: FetchText,
) -> None:
    """Record every distinct displayed item in the agent tree with its text content."""
    state = data.setdefault("_benchmark", {})
    if isinstance(state.get("display_artifacts"), list):
        return
    root_id = str((data.get("agent") or {}).get("agent_id") or (data.get("agent") or {}).get("id") or "")
    messages = [dict(m, _agent_id=root_id) for m in data.get("messages") or [] if isinstance(m, dict)]
    try:
        messages.extend(await tree_messages())
    except Exception as exc:
        state["display_artifacts_error"] = f"tree fetch failed: {str(exc)[:200]}"
    seen: set[str] = set()
    artifacts: list[dict] = []
    for row in display_rows(messages):
        identity = _row_identity(row)
        if identity in seen:
            continue
        seen.add(identity)
        artifacts.append(
            await artifact_for_row(row, fetch_usercontent=fetch_usercontent, fetch_storage=fetch_storage)
        )
    state["display_artifacts"] = artifacts
