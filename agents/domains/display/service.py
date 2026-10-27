"""Display domain business logic: validate the tool call, describe results.

Pure functions (no Temporal, no I/O) so the handler stays thin; the backend
activity is re-exported from repo for the handler.
"""

import base64
import re
from typing import Any, Dict, List, Optional

from domains.display.config import (
    DISPLAY_HTML_FILENAME,
    DISPLAY_MAX_HTML_BYTES,
    DISPLAY_MAX_ITEMS,
    QUESTION_ARGUMENTS,
)
from domains.display.repo import display_media_activity
from domains.display.types import DisplayValidation

# The handler schedules the activity through this layer (handler → service → repo).
__all__ = [
    "describe_error",
    "describe_inline",
    "display_media_activity",
    "validate_tool_call",
]

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _string_list(raw: Any, name: str) -> tuple[List[str], Optional[str]]:
    if raw is None:
        return [], None
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not all(isinstance(v, str) and v.strip() for v in raw):
        return [], f"`{name}` must be a list of non-empty strings."
    return [v.strip() for v in raw], None


def validate_tool_call(
    tool_call: Dict[str, Any],
    *,
    agent_id: str,
    user_id: str,
    workflow_id: str,
    tool_call_id: str,
) -> DisplayValidation:
    """Normalise the LLM's arguments into one backend request, or explain the error.

    display only shows media inline; a pinned question (placement / options /
    allow_other) is refused, since agents cannot ask the user through display.
    """
    asked = [key for key in QUESTION_ARGUMENTS if tool_call.get(key) not in (None, "inline")]
    if asked:
        return {
            "ok": False,
            "error": "display cannot ask questions: it only shows media inline "
            f"(remove {', '.join(f'`{key}`' for key in asked)}).",
        }
    paths, error = _string_list(tool_call.get("paths"), "paths")
    if error:
        return {"ok": False, "error": error}
    urls, error = _string_list(tool_call.get("urls"), "urls")
    if error:
        return {"ok": False, "error": error}
    bad_urls = [u for u in urls if not _URL_RE.match(u)]
    if bad_urls:
        return {"ok": False, "error": f"`urls` must be http(s) URLs (got {bad_urls[0][:200]}). Use `paths` for files."}
    html = tool_call.get("html")
    if html is not None and not isinstance(html, str):
        return {"ok": False, "error": "`html` must be a string (one complete HTML page)."}
    html = (html or "").strip()
    html_bytes = len(html.encode("utf-8"))
    if html_bytes > DISPLAY_MAX_HTML_BYTES:
        return {
            "ok": False,
            "error": f"`html` is {html_bytes} bytes (max {DISPLAY_MAX_HTML_BYTES}). Use `paths` for larger pages.",
        }
    caption = tool_call.get("caption") or ""
    if not isinstance(caption, str):
        return {"ok": False, "error": "`caption` must be a string."}
    caption = caption.strip()
    count = len(paths) + len(urls) + (1 if html else 0)
    if count > DISPLAY_MAX_ITEMS:
        return {"ok": False, "error": f"At most {DISPLAY_MAX_ITEMS} items per call (got {count})."}
    if count == 0:
        return {"ok": False, "error": "display needs `html` or at least one entry in `paths` or `urls`."}
    items = [{"file": p} for p in paths] + [{"url": u} for u in urls]
    if html:
        encoded = base64.b64encode(html.encode("utf-8")).decode("ascii")
        items.append({"content_base64": encoded, "filename": DISPLAY_HTML_FILENAME})
    return {
        "ok": True,
        "payload": {
            "agent_id": agent_id,
            "user_id": user_id,
            "workflow_id": workflow_id,
            "tool_call_id": tool_call_id,
            "items": items,
            "caption": caption,
        },
    }


def describe_error(error: str, details: List[str]) -> str:
    if not details:
        return error
    return error + ":\n" + "\n".join(f"- {d}" for d in details)


def describe_inline(body: Dict[str, Any]) -> str:
    posted = int(body.get("posted_count") or 0)
    duplicate = int(body.get("duplicate_count") or 0)
    kinds = sorted({str(item.get("mime_type")) for item in body.get("items") or [] if item.get("mime_type")})
    parts = [f"Displayed {posted} item(s) inline for the user"]
    if duplicate:
        parts.append(f"{duplicate} already shown")
    if kinds:
        parts.append(", ".join(kinds))
    return "; ".join(parts) + "."
