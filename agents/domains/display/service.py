"""Display domain business logic: validate the tool call, describe results.

Pure functions (no Temporal, no I/O) so the handler stays thin; the backend
activity is re-exported from repo for the handler.
"""

import re
from typing import Any, Dict, List, Optional

from domains.display.config import DISPLAY_MAX_ITEMS, DISPLAY_MAX_OPTIONS, PLACEMENTS, REJECTED_RESPONSE
from domains.display.repo import display_media_activity
from domains.display.types import DisplayOptionInput, DisplayValidation

# The handler schedules the activity through this layer (handler → service → repo).
__all__ = [
    "describe_answer",
    "describe_error",
    "describe_inline",
    "display_media_activity",
    "format_question_text",
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


def _options(raw: Any) -> tuple[List[DisplayOptionInput], Optional[str]]:
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return [], "`options` must be a list of {label, description, recommended}."
    options: List[DisplayOptionInput] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get("label"), str) or not item["label"].strip():
            return [], f"option {index + 1} needs a non-empty `label`."
        option: DisplayOptionInput = {"label": item["label"].strip()}
        description = item.get("description")
        if isinstance(description, str) and description.strip():
            option["description"] = description.strip()
        if item.get("recommended") is True:
            option["recommended"] = True
        options.append(option)
    if len(options) > DISPLAY_MAX_OPTIONS:
        return [], f"At most {DISPLAY_MAX_OPTIONS} options (got {len(options)})."
    return options, None


def validate_tool_call(
    tool_call: Dict[str, Any],
    *,
    agent_id: str,
    user_id: str,
    workflow_id: str,
    tool_call_id: str,
) -> DisplayValidation:
    """Normalise the LLM's arguments into one backend request, or explain the error."""
    paths, error = _string_list(tool_call.get("paths"), "paths")
    if error:
        return {"ok": False, "error": error}
    urls, error = _string_list(tool_call.get("urls"), "urls")
    if error:
        return {"ok": False, "error": error}
    bad_urls = [u for u in urls if not _URL_RE.match(u)]
    if bad_urls:
        return {"ok": False, "error": f"`urls` must be http(s) URLs (got {bad_urls[0][:200]}). Use `paths` for files."}
    placement = tool_call.get("placement") or "inline"
    if placement not in PLACEMENTS:
        return {"ok": False, "error": '`placement` must be "inline" or "pinned".'}
    caption = tool_call.get("caption") or ""
    if not isinstance(caption, str):
        return {"ok": False, "error": "`caption` must be a string."}
    caption = caption.strip()
    options, error = _options(tool_call.get("options"))
    if error:
        return {"ok": False, "error": error}
    allow_other = tool_call.get("allow_other")
    if allow_other is not None and not isinstance(allow_other, bool):
        return {"ok": False, "error": "`allow_other` must be a boolean."}
    count = len(paths) + len(urls)
    if count > DISPLAY_MAX_ITEMS:
        return {"ok": False, "error": f"At most {DISPLAY_MAX_ITEMS} items per call (got {count})."}
    if placement == "inline":
        if count == 0:
            return {"ok": False, "error": "display needs at least one entry in `paths` or `urls`."}
        if options or allow_other is not None:
            return {"ok": False, "error": '`options` and `allow_other` need placement "pinned".'}
    else:
        if not caption:
            return {"ok": False, "error": "A pinned question needs a `caption` (the question text)."}
        if not options and allow_other is False:
            return {"ok": False, "error": "A pinned question needs `options` or allow_other."}
    items = [{"file": p} for p in paths] + [{"url": u} for u in urls]
    return {
        "ok": True,
        "payload": {
            "agent_id": agent_id,
            "user_id": user_id,
            "workflow_id": workflow_id,
            "tool_call_id": tool_call_id,
            "items": items,
            "caption": caption,
            "placement": placement,
            "options": options,
            "allow_other": allow_other is not False,
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


def format_question_text(question: str, options: List[DisplayOptionInput], allow_other: bool) -> str:
    """Numbered question text for the agent graph (mirrors back-end formatQuestionText)."""
    if not options:
        return question
    lines = []
    for index, option in enumerate(options, start=1):
        recommended = " (recommended)" if option.get("recommended") else ""
        description = f" — {option['description']}" if option.get("description") else ""
        lines.append(f"{index}. {option['label']}{recommended}{description}")
    if allow_other:
        lines.append(f"{len(options) + 1}. Other (free text)")
    return question + "\n\nOptions:\n" + "\n".join(lines)


def describe_answer(response: str, question: Dict[str, Any], options: List[DisplayOptionInput]) -> str:
    """The tool result the caller's model sees once the user answers the pin."""
    who = "The user"
    text = (response or "").strip()
    if text == REJECTED_RESPONSE:
        return f"{who} dismissed the question without choosing an option."
    labels = [o["label"] for o in options]
    if text in labels:
        return f"{who} chose option {labels.index(text) + 1}: {text}"
    if text.isdigit() and 1 <= int(text) <= len(labels):
        return f"{who} chose option {text}: {labels[int(text) - 1]}"
    return f"{who} answered: {text}"
