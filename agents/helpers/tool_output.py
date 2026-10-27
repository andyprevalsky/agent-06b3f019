"""Bounded model previews with scoped readback in the existing attachment store.

Only policy-redacted textual results belong here; attachments keep their own
transport. This module never writes model previews back to the source record.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from collections import OrderedDict
from typing import Any

from utils.secret_text_redaction import redact_sensitive_text
from utils.tool_output_schema import READ_MAX_CHARS, ReadToolOutputTool

DEFAULT_INLINE_CHARS = 100_000
OUTPUT_TTL_SECONDS = 24 * 60 * 60
MAX_STORED_BYTES = 32 * 1024 * 1024
_FILENAME = "retained-tool-output.json"
# Process-local metadata only: no retained body, credentials, or model context.
# Eviction/restart may create another artifact; warm rebuilds keep exact handles.
MAX_PERSISTED_OUTPUTS = 1024
_persisted_outputs: OrderedDict[tuple[tuple[str, str, str], str], tuple[str, float]] = OrderedDict()
_pending_outputs: dict[tuple[tuple[str, str, str], str], asyncio.Future[str]] = {}


def _owner(user_id: str, agent_id: str, session_id: str) -> tuple[str, str, str]:
    if not user_id or not agent_id or any(char in user_id for char in "/\\"):
        raise ValueError("Retained output requires trusted user and agent identity")
    return user_id, agent_id, session_id


class RetentionError(OSError):
    """Retained-output storage could not issue a readback handle for this text."""


def _stated_cut(text: str, limit: int, reason: str) -> str:
    notice = f"\n[Tool output truncated: total_chars={len(text)}; {reason}.]"
    return text[: max(0, limit - len(notice))] + notice


def stated_cut(text: str, *, limit: int, reason: str) -> str:
    """Policy-redacted text bounded to ``limit`` with an explicit cut; no storage I/O.

    For caller boundaries that must keep a tool result when retention fails.
    """
    text = _safe_text(text)
    return text if len(text) <= limit else _stated_cut(text, limit, reason)


def _storage_key(owner: tuple[str, str, str], output_id: str) -> str:
    scope = hashlib.sha256(json.dumps(owner).encode()).hexdigest()
    return f"retained-tool-output-v1:{scope}:{output_id}"


def _storage_path(owner: tuple[str, str, str], output_id: str) -> str:
    file_id = uuid.uuid5(uuid.NAMESPACE_URL, _storage_key(owner, output_id))
    return f"{owner[0]}/{file_id}_{_FILENAME}"


def _safe_text(text: str) -> str:
    from browser_tools.secret_refs import redact_current_secret_values

    # Do not let the generic key=value matcher consume a trusted placeholder
    # and the unrelated source text immediately following its closing braces.
    pieces = re.split(r"(\{\{secret:[^}]+\}\})", redact_current_secret_values(text))
    return "".join(piece if piece.startswith("{{secret:") else redact_sensitive_text(piece) for piece in pieces)


async def _persist(text: str, owner: tuple[str, str, str]) -> str:
    from helpers.attachments import upload_to_storage

    now = time.time()
    key = (owner, hashlib.sha256(text.encode("utf-8")).hexdigest())
    for expired_key, (_, expires) in list(_persisted_outputs.items()):
        if expires <= now:
            del _persisted_outputs[expired_key]
    cached = _persisted_outputs.get(key)
    if cached is not None:
        _persisted_outputs.move_to_end(key)
        return cached[0]
    pending = _pending_outputs.get(key)
    if pending is not None:
        # A cancelled follower must not cancel the upload another caller owns.
        return await asyncio.shield(pending)
    pending = asyncio.get_running_loop().create_future()
    # Retrieve failures even when the owning caller has no concurrent followers.
    pending.add_done_callback(lambda future: None if future.cancelled() else future.exception())
    _pending_outputs[key] = pending
    try:
        output_id = uuid.uuid4().hex
        expires = now + OUTPUT_TTL_SECONDS
        body = json.dumps({"owner": owner, "expires": expires, "text": text}, ensure_ascii=False).encode("utf-8")
        if len(body) > MAX_STORED_BYTES:
            raise RetentionError("Tool output exceeds retained storage limit; no preview was substituted")
        try:
            result = await upload_to_storage(owner[0], body, _FILENAME, "application/json", idempotency_key=_storage_key(owner, output_id))
        except Exception as error:
            raise RetentionError(f"Retained output upload failed: {type(error).__name__}: {error}") from error
        if result.get("storage_path") != _storage_path(owner, output_id):
            raise RetentionError("Retained output storage did not confirm its scoped path")
        _persisted_outputs[key] = (output_id, expires)
        while len(_persisted_outputs) > MAX_PERSISTED_OUTPUTS:
            _persisted_outputs.popitem(last=False)
        pending.set_result(output_id)
        return output_id
    except BaseException as error:
        if isinstance(error, asyncio.CancelledError):
            pending.cancel()
        else:
            pending.set_exception(error)
        raise
    finally:
        _pending_outputs.pop(key, None)


def _preview(text: str, output_id: str, limit: int) -> str:
    offset = limit
    for _ in range(4):
        suffix = (f'\n[Retained tool output: read_tool_output output_id="{output_id}" '
                  f'offset={offset} limit={READ_MAX_CHARS}; total_chars={len(text)}; '
                  'Unicode characters; originating agent/session only; expires after 24h.]')
        offset = limit - len(suffix)
    if offset < 0:
        raise ValueError("Inline output limit is too small for a retrieval marker")
    return text[:offset] + suffix


_RETAINED_MARKER = re.compile(
    r'\n\[Retained tool output: read_tool_output output_id="([a-f0-9]{32})" '
    r'offset=([0-9]{1,8}) limit=20000; total_chars=[0-9]{1,8}; Unicode characters; '
    r'originating agent/session only; expires after 24h\.\]'
)


def contains_retained_marker(text: str) -> bool:
    """Whether projecting this text would verify a marker against storage."""
    return bool(_RETAINED_MARKER.search(text))


def retained_marker(text: str) -> str:
    """The complete native marker that ends ``text``, or ``""``."""
    matches = list(_RETAINED_MARKER.finditer(text))
    return matches[-1][0] if matches and matches[-1].end() == len(text) else ""


def _storage_object_missing(response: Any) -> bool:
    """Whether a storage error response reports a missing object.

    Supabase Storage answers a missing object with HTTP 400 and a structured
    body ``{"statusCode": "404", "error": "not_found", "code": "NoSuchKey"}``,
    not a bare 404.
    """
    status = getattr(response, "status_code", None)
    if status == 404:
        return True
    if status != 400:
        return False
    try:
        body = response.json()
    except Exception:
        return False
    return isinstance(body, dict) and (str(body.get("statusCode")) == "404" or body.get("code") == "NoSuchKey")


async def _load_output(owner: tuple[str, str, str], output_id: str) -> dict:
    from helpers.attachments import download_from_storage

    try:
        raw = await download_from_storage(_storage_path(owner, output_id))
    except Exception as error:
        # A guessed or expired handle is an expected miss, not an outage.
        if _storage_object_missing(getattr(error, "response", None)):
            raise FileNotFoundError("Retained output not found") from error
        raise
    if len(raw) > MAX_STORED_BYTES:
        raise ValueError("Retained output exceeds storage limit")
    stored = json.loads(raw)
    if tuple(stored["owner"]) != owner or stored["expires"] <= time.time():
        raise ValueError("Retained output unavailable for this scope or expired")
    if not isinstance(stored["text"], str):
        raise ValueError("Retained output is not text")
    return stored


async def _redact_retained_preview(text: str, owner: tuple[str, str, str]) -> str:
    # The terminal native marker can follow page text containing forged markers.
    # Only the exact preview reconstructed from an owned artifact is trusted.
    matches = list(_RETAINED_MARKER.finditer(text))
    if not matches:
        return _safe_text(text)
    marker = matches[-1]
    offset = int(marker[2])
    start = marker.start() - offset
    if start < 0:
        return _safe_text(text)
    try:
        stored = await _load_output(owner, marker[1])
    except (FileNotFoundError, KeyError, ValueError):
        # A missing forged ID is ordinary untrusted text. Real storage outages
        # remain errors, rather than silently corrupting issued handles.
        return _safe_text(text)
    preview_limit = offset + len(marker[0])
    if preview_limit < 512:
        return _safe_text(text)
    safe_source = _safe_text(stored["text"])
    if not any(_preview(source, marker[1], preview_limit) == text[start:marker.end()]
               for source in (stored["text"], safe_source)):
        return _safe_text(text)
    preview = (_preview(safe_source, marker[1], preview_limit)
               if len(safe_source) > preview_limit else safe_source)
    return _safe_text(text[:start]) + preview + _safe_text(text[marker.end():])


async def preview_tool_text(text: str, *, user_id: str, agent_id: str, session_id: str = "", limit: int = DEFAULT_INLINE_CHARS) -> str:
    text = (await _redact_retained_preview(text, _owner(user_id, agent_id, session_id))
            if _RETAINED_MARKER.search(text) and user_id and agent_id else _safe_text(text))
    if len(text) <= limit:
        return text
    if limit < 512:
        raise ValueError("Inline output limit must allow the retrieval marker")
    if not user_id or not agent_id:
        # No scoped readback exists without the originating identity; keep the
        # bound and state the cut instead of failing the caller's tool result.
        return _stated_cut(text, limit, "no retained readback without agent identity")
    output_id = await _persist(text, _owner(user_id, agent_id, session_id))
    return _preview(text, output_id, limit)


async def bound_tool_result(value: Any, *, user_id: str, agent_id: str, session_id: str = "", limit: int = DEFAULT_INLINE_CHARS) -> Any:
    """Keep small native JSON values; retain oversized JSON in a valid envelope.

    Callers must remove binary/media fields before calling this helper.
    """
    if isinstance(value, str):
        return await preview_tool_text(value, user_id=user_id, agent_id=agent_id, session_id=session_id, limit=limit)
    serialized = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(serialized) <= limit:
        return value
    text = _safe_text(serialized)
    output_id = await _persist(text, _owner(user_id, agent_id, session_id))
    flags = {key: value[key] for key in ("success", "error", "status") if isinstance(value, dict) and key in value and isinstance(value[key], (bool, int, float, type(None)))}
    if isinstance(value, dict) and isinstance(value.get("status"), str) and len(value["status"]) <= 100:
        flags["status"] = value["status"]
    if isinstance(value, dict) and isinstance(value.get("error"), str) and value["error"]:
        flags["error"] = True
    # JSON escaping can expand text sixfold. Reserve room for the envelope and
    # measure the actual serialized result rather than clipping JSON bytes.
    preview_limit = max(512, (limit - 512) // 6)
    result = {**flags, "retained_output": {"output_id": output_id, "total_chars": len(text), "encoding": "json", "expires_in_seconds": OUTPUT_TTL_SECONDS}, "preview": _preview(text, output_id, preview_limit)}
    if len(json.dumps(result, ensure_ascii=False)) > limit:
        raise ValueError("Inline output limit is too small for the retained JSON envelope")
    return result


async def read_tool_output(*, user_id: str, agent_id: str, session_id: str = "", output_id: str, offset: int = 0, limit: int = READ_MAX_CHARS, query: str | None = None) -> dict:
    args = ReadToolOutputTool(tool="read_tool_output", output_id=output_id, offset=offset, limit=limit, query=query)
    owner = _owner(user_id, agent_id, session_id)
    stored = await _load_output(owner, args.output_id)
    from browser_tools.secret_refs import redact_current_secret_values
    text = redact_current_secret_values(stored["text"])
    if offset > len(text):
        raise ValueError("Offset exceeds retained output length")
    if query is not None:
        found = text.find(query, offset)
        if found == -1:
            return {"success": True, "output_id": output_id, "content": "", "offset": offset, "next_offset": None, "total_chars": len(text), "found": False}
        offset = found
    content = text[offset:offset + limit]
    end = offset + len(content)
    return {"success": True, "output_id": output_id, "content": content, "offset": offset, "next_offset": end if end < len(text) else None, "total_chars": len(text), **({"found": True} if query is not None else {})}
