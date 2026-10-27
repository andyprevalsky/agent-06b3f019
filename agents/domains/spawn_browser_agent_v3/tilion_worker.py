"""Worker-side file and state paths for single-CDP-client providers (Tilion).

Tilion admits one CDP client per session and fails REST drive calls
(screenshot, act, files/fetch) with 409 ``session_driven_by_client`` while
that client is attached. The worker holds the only socket, so everything that
needs the browser mid-run happens over it:

- Uploads: bytes stay in the worker and are set on the file input through
  Playwright ``set_input_files`` (buffer payload). A raw
  ``DOM.setFileInputFiles`` with a path silently does nothing on Tilion's
  remote filesystem (lane E probe).
- Downloads: a Chrome download's URL is fetched in-page over the worker's
  socket and its bytes are kept in a per-session ledger that the verifier file
  list and ``extract_session_files`` read.
- Saved browser state: the backend returns a ``worker_apply`` payload
  (cookies + localStorage) instead of connecting, and the worker applies it.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import re
import uuid
from typing import Any, Dict, List, Optional, Set

import structlog

logger = structlog.get_logger()

TILION_PROVIDER = "tilion"
TILION_STAGED_UPLOAD_PREFIX = "tilion-staged://"
# Ledger paths are absolute remote-session paths, like other providers' downloads
# (verifier file_pointer paths must start with '/'). Reads route by ledger
# membership, never by this prefix.
TILION_DOWNLOAD_ROOT = "/tilion-downloads/"
# Earlier ledger paths, still found in persisted pause/resume contexts.
LEGACY_TILION_DOWNLOAD_PATH_PREFIX = "tilion-download://"
# Matches download_persist._MAX_PERSIST_BYTES; Tilion files/fetch caps at 32 MiB.
_MAX_FILE_BYTES = 25 * 1024 * 1024
_MAX_SESSION_BYTES = 100 * 1024 * 1024
_MAX_STAGED_BYTES = 50 * 1024 * 1024
_SCREENSHOT_NAME = "screenshot.png"
_KEPT_SCREENSHOTS = 3
_APPLY_TIMEOUT_SECONDS = 30.0

_staged_uploads: Dict[str, Dict[str, Dict[str, Any]]] = {}
_downloads: Dict[str, Dict[str, Dict[str, Any]]] = {}
# session -> legacy path -> current ledger path, for paths persisted before the namespace change.
_download_aliases: Dict[str, Dict[str, str]] = {}
_tilion_sessions: Set[str] = set()


def is_single_cdp_client_provider(provider: Optional[str]) -> bool:
    return (provider or "").strip().lower() == TILION_PROVIDER


# ----- uploads -----------------------------------------------------------


def stage_upload(session_id: str, filename: str, content: bytes, mime_type: str) -> Dict[str, Any]:
    """Keep upload bytes in the worker; return the session-file shape callers expect.

    Bounded per session (worker RSS, 10k-agent rule): only the latest
    ``_KEPT_SCREENSHOTS`` screenshots stay staged, and the oldest screenshots
    are evicted before an upload is refused for exceeding ``_MAX_STAGED_BYTES``.
    """
    if len(content) > _MAX_FILE_BYTES:
        raise ValueError(f"Upload {filename} exceeds {_MAX_FILE_BYTES} bytes")
    safe_name = os.path.basename(filename) or "upload.bin"
    staged = _staged_uploads.setdefault(session_id, {})
    screenshots = [path for path, item in staged.items() if item["name"] == _SCREENSHOT_NAME]
    if safe_name == _SCREENSHOT_NAME:
        for path in screenshots[: max(len(screenshots) - (_KEPT_SCREENSHOTS - 1), 0)]:
            staged.pop(path, None)
        screenshots = [path for path in screenshots if path in staged]
    while sum(len(item["buffer"]) for item in staged.values()) + len(content) > _MAX_STAGED_BYTES and screenshots:
        staged.pop(screenshots.pop(0), None)
    if sum(len(item["buffer"]) for item in staged.values()) + len(content) > _MAX_STAGED_BYTES:
        raise ValueError(f"Staged uploads for this browser session would exceed {_MAX_STAGED_BYTES} bytes")
    path = f"{TILION_STAGED_UPLOAD_PREFIX}{uuid.uuid4().hex}/{safe_name}"
    staged[path] = {
        "name": safe_name,
        "mimeType": mime_type or "application/octet-stream",
        "buffer": bytes(content),
    }
    return {"path": path, "size": len(content), "filename": safe_name}


def staged_upload_payload(path: str) -> Optional[Dict[str, Any]]:
    """Staged bytes for ``path``; staged paths are unique (uuid) across sessions."""
    for staged in _staged_uploads.values():
        if path in staged:
            return staged[path]
    return None


def is_staged_upload_path(path: str) -> bool:
    return str(path or "").startswith(TILION_STAGED_UPLOAD_PREFIX)


_ARM_UPLOAD_RECEIPT_JS = """function(marker) {
    const el = this;
    const view = el.ownerDocument.defaultView;
    const receipt = {size: -1, name: null, marker};
    const record = (event) => {
        if (event.target === el && el.files && el.files[0]) {
            receipt.size = el.files[0].size;
            receipt.name = el.files[0].name;
        }
    };
    view.addEventListener('input', record, true);
    view.addEventListener('change', record, true);
    receipt.cleanup = () => {
        view.removeEventListener('input', record, true);
        view.removeEventListener('change', record, true);
    };
    el.__roseUploadReceipt = receipt;
    el.setAttribute('data-rose-upload', marker);
}"""

_READ_UPLOAD_RECEIPT_JS = """function() {
    const receipt = this.__roseUploadReceipt || {size: -1, name: null};
    if (receipt.cleanup) receipt.cleanup();
    delete this.__roseUploadReceipt;
    this.removeAttribute('data-rose-upload');
    // A site that replaces the input (cloneNode) copies the marker; clear it there too.
    if (receipt.marker) {
        for (const copy of this.ownerDocument.querySelectorAll(`[data-rose-upload="${receipt.marker}"]`)) {
            copy.removeAttribute('data-rose-upload');
        }
    }
    const now = this.files && this.files[0] ? this.files[0].size : -1;
    return {size: receipt.size, name: receipt.name, now};
}"""


async def set_staged_file_on_input(
    *,
    input_page: Any,
    browser_session: Any,
    element: Any,
    payload: Dict[str, Any],
) -> int:
    """Set ``payload`` on the browser-use ``element`` through Playwright; return the landed size."""
    if input_page is None:
        raise RuntimeError("Playwright page unavailable for Tilion file upload")
    marker = uuid.uuid4().hex
    backend_node_id = getattr(element, "backend_node_id", None)
    if backend_node_id is None:
        raise RuntimeError("File input has no backend node id")
    cdp_session = await browser_session.get_or_create_cdp_session(focus=False)
    send = cdp_session.cdp_client.send
    resolved = await send.DOM.resolveNode(params={"backendNodeId": backend_node_id}, session_id=cdp_session.session_id)
    object_id = (resolved.get("object") or {}).get("objectId")
    if not object_id:
        raise RuntimeError("File input could not be resolved")
    # callFunctionOn needs no Runtime.enable (an automation tell on Tilion).
    # Mark the exact node for Playwright, and record the file the page itself
    # receives: capture-phase input/change listeners on the input's window run
    # before the site's handlers, which may read the file and reset the input
    # (TinyPNG). The delivered file is what those events carried.
    await send.Runtime.callFunctionOn(
        params={
            "objectId": object_id,
            "functionDeclaration": _ARM_UPLOAD_RECEIPT_JS,
            "arguments": [{"value": marker}],
        },
        session_id=cdp_session.session_id,
    )
    selector = f'[data-rose-upload="{marker}"]'
    delivered = False
    try:
        for frame in getattr(input_page, "frames", None) or [input_page.main_frame]:
            locator = frame.locator(selector)
            if await locator.count():
                await locator.set_input_files(payload)
                delivered = True
                break
        if not delivered:
            raise RuntimeError("File input not found in any frame")
    finally:
        receipt = await send.Runtime.callFunctionOn(
            params={
                "objectId": object_id,
                "functionDeclaration": _READ_UPLOAD_RECEIPT_JS,
                "returnByValue": True,
            },
            session_id=cdp_session.session_id,
        )
    value = (receipt.get("result") or {}).get("value") or {}
    if value.get("name") == payload["name"] and int(value.get("size", -1)) >= 0:
        return int(value["size"])
    return int(value.get("now", -1))


# ----- downloads ---------------------------------------------------------


def register_download_session(session_id: str) -> None:
    """Mark ``session_id`` as a live Tilion session (its file routes fail mid-run)."""
    _downloads.setdefault(session_id, {})
    _tilion_sessions.add(session_id)


def is_tilion_session(session_id: Optional[str]) -> bool:
    return bool(session_id) and session_id in _tilion_sessions


def owns_download_session(session_id: Optional[str]) -> bool:
    return bool(session_id) and session_id in _downloads


def record_download(
    session_id: str,
    *,
    filename: str,
    content: bytes,
    mime_type: str,
    file_pointer: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Record a Tilion download. With a durable ``file_pointer`` (attachment
    storage) only the pointer is kept; otherwise the bytes, within budget."""
    if not content or len(content) > _MAX_FILE_BYTES:
        return None
    ledger = _downloads.setdefault(session_id, {})
    safe_name = os.path.basename(filename) or "download.bin"
    path = tilion_download_path(safe_name, content)
    # Same basename replaces, like a provider downloads directory.
    replaced = [key for key, item in ledger.items() if item["filename"] == safe_name and key != path]
    if file_pointer is None:
        held = sum(len(item["content"] or b"") for key, item in ledger.items() if key != path and key not in replaced)
        if held + len(content) > _MAX_SESSION_BYTES:
            logger.warning(
                "[TilionFiles] Session download budget exhausted; not keeping file",
                session_id=session_id,
                filename=safe_name,
                size=len(content),
            )
            return None
    for key in replaced:
        ledger.pop(key, None)
        aliases = _download_aliases.get(session_id) or {}
        for legacy, current in list(aliases.items()):
            if current == key:
                aliases[legacy] = path
    ledger[path] = {
        "content": None if file_pointer is not None else bytes(content),
        "size": len(content),
        "mime_type": mime_type,
        "filename": safe_name,
        "file_pointer": file_pointer,
    }
    recorded = {"path": path, "size": len(content), "filename": safe_name, "mime_type": mime_type}
    if file_pointer is not None:
        recorded["storage_path"] = file_pointer.get("storage_path")
    return recorded


def tilion_download_path(filename: str, content: bytes) -> str:
    """Absolute ledger path for a download: stable for the same bytes (retries map to one entry)."""
    safe_name = os.path.basename(filename) or "download.bin"
    return f"{TILION_DOWNLOAD_ROOT}{hashlib.sha256(content).hexdigest()[:16]}/{safe_name}"


def _resolve_download_path(session_id: Optional[str], path: str) -> str:
    return (_download_aliases.get(session_id or "") or {}).get(path, path)


def has_download(session_id: Optional[str], path: Any) -> bool:
    """Whether ``path`` names a file in this session's worker ledger (current or legacy path)."""
    if not session_id or not isinstance(path, str) or not path:
        return False
    return _resolve_download_path(session_id, path) in (_downloads.get(session_id) or {})


def list_downloads(session_id: str) -> List[Dict[str, Any]]:
    return [
        {"path": path, "size": item["size"], "filename": item["filename"]}
        for path, item in (_downloads.get(session_id) or {}).items()
    ]


def read_download(session_id: str, path: str) -> Optional[Dict[str, Any]]:
    item = (_downloads.get(session_id) or {}).get(_resolve_download_path(session_id, path))
    if not item or item["content"] is None:
        return None
    return {"content": item["content"], "filename": item["filename"], "mime_type": item["mime_type"]}


def download_file_pointer(session_id: str, path: str) -> Optional[Dict[str, Any]]:
    """The durable attachment-storage pointer of a recorded download, if any."""
    item = (_downloads.get(session_id) or {}).get(_resolve_download_path(session_id, path))
    return dict(item["file_pointer"]) if item and item.get("file_pointer") else None


def durable_downloads(session_id: Optional[str]) -> List[Dict[str, Any]]:
    """Pointer-only entries for the resume context (write-lock/payment/auth pause)."""
    return [
        {
            "path": path,
            "size": item["size"],
            "filename": item["filename"],
            "mime_type": item["mime_type"],
            "file_pointer": dict(item["file_pointer"]),
        }
        for path, item in (_downloads.get(session_id or "") or {}).items()
        if item.get("file_pointer")
    ]


def restore_downloads(session_id: Optional[str], entries: Any) -> int:
    """Re-register pointer-only downloads from a resume context."""
    if not session_id or not isinstance(entries, list):
        return 0
    restored = 0
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("file_pointer"), dict):
            continue
        path = str(entry.get("path") or "")
        filename = str(entry.get("filename") or os.path.basename(path.rstrip("/")) or "download.bin")
        if path.startswith(LEGACY_TILION_DOWNLOAD_PATH_PREFIX):
            legacy = path
            filename = str(entry.get("filename") or path[len(LEGACY_TILION_DOWNLOAD_PATH_PREFIX) :])
            # Pointer-only entries have no bytes to digest; the stored object is the identity.
            identity = str(entry["file_pointer"].get("storage_path") or legacy).encode()
            path = tilion_download_path(filename, identity)
            _download_aliases.setdefault(session_id, {})[legacy] = path
        elif not path.startswith(TILION_DOWNLOAD_ROOT):
            continue
        _downloads.setdefault(session_id, {})[path] = {
            "content": None,
            "size": int(entry.get("size") or 0),
            "mime_type": str(entry.get("mime_type") or "application/octet-stream"),
            "filename": filename,
            "file_pointer": dict(entry["file_pointer"]),
        }
        restored += 1
    return restored


def move_session(previous_session_id: Optional[str], session_id: str) -> None:
    """Carry worker-held files across a rotation/recovery that replaced the session."""
    if not previous_session_id or previous_session_id == session_id:
        return
    _tilion_sessions.discard(previous_session_id)
    for store in (_downloads, _staged_uploads, _download_aliases):
        previous = store.pop(previous_session_id, None)
        if previous is not None:
            store.setdefault(session_id, {}).update(previous)


def release_session(session_id: Optional[str]) -> None:
    if session_id:
        _tilion_sessions.discard(session_id)
        _downloads.pop(session_id, None)
        _download_aliases.pop(session_id, None)
        _staged_uploads.pop(session_id, None)


# ----- backend worker_apply payloads --------------------------------------


def worker_apply_payload(response: Any) -> Optional[Dict[str, Any]]:
    """The backend's ``worker_apply`` block for a single-CDP-client session, if any."""
    if not isinstance(response, dict):
        return None
    block = response.get("worker_apply")
    if not isinstance(block, dict) or block.get("provider") != TILION_PROVIDER:
        return None
    return block


async def apply_worker_state(playwright_browser: Any, worker_apply: Dict[str, Any]) -> Dict[str, int]:
    """Apply backend-provided cookies and localStorage over the worker's socket.

    Cookies use Playwright ``addCookies`` params as sent. Each localStorage
    origin is written from a fresh page that is closed afterwards; the agent's
    tab is never navigated.
    """
    if playwright_browser is None or not playwright_browser.contexts:
        raise RuntimeError("Playwright context unavailable to apply Tilion browser state")
    context = playwright_browser.contexts[0]
    cookies = [cookie for cookie in worker_apply.get("cookies") or [] if isinstance(cookie, dict)]
    if cookies:
        await asyncio.wait_for(context.add_cookies(cookies), timeout=_APPLY_TIMEOUT_SECONDS)
    applied_entries = 0
    failed_origins = 0
    for origin_state in worker_apply.get("local_storage") or []:
        origin = str((origin_state or {}).get("origin") or "")
        entries = [
            {"key": str(entry.get("key")), "value": str(entry.get("value"))}
            for entry in (origin_state or {}).get("entries") or []
            if isinstance(entry, dict) and entry.get("key") is not None
        ]
        if not origin.startswith(("http://", "https://")) or not entries:
            continue
        page = await context.new_page()
        try:
            await page.goto(origin, wait_until="domcontentloaded", timeout=int(_APPLY_TIMEOUT_SECONDS * 1000))
            applied_entries += await asyncio.wait_for(
                page.evaluate(
                    "(entries) => { for (const e of entries) localStorage.setItem(e.key, e.value); return entries.length; }",
                    entries,
                ),
                timeout=_APPLY_TIMEOUT_SECONDS,
            )
        except Exception as error:
            # Best-effort per origin: one unreachable or slow origin (interstitial,
            # DNS, residential exit) must not skip the rest or fail the activity.
            failed_origins += 1
            logger.warning(
                "[TilionFiles] localStorage origin not applied",
                origin=origin,
                error=f"{type(error).__name__}: {error}"[:200],
            )
        finally:
            with contextlib.suppress(Exception):
                await page.close()
    logger.info(
        "[TilionFiles] Applied worker-side browser state",
        cookies=len(cookies),
        local_storage_entries=applied_entries,
        local_storage_failed_origins=failed_origins,
    )
    return {"cookies": len(cookies), "local_storage_entries": applied_entries}


# ----- locale ---------------------------------------------------------------

_LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


def accept_language_for_locale(locale: str) -> str:
    """``de-DE`` -> ``de-DE,de``; Chromium adds the q-values (header ``de-DE,de;q=0.9``)."""
    language = locale.split("-", 1)[0]
    return locale if language == locale else f"{locale},{language}"


def resolve_geo_locale(fingerprint_injection: Any, exit_geo_locale: Any) -> Dict[str, str]:
    """Timezone and locale for a Tilion session: ``fingerprint_injection`` first,
    then the backend's top-level ``exit_geo_locale``; each field independently."""
    resolved: Dict[str, str] = {}
    for source in (fingerprint_injection, exit_geo_locale):
        if not isinstance(source, dict):
            continue
        for field in ("timezone", "locale"):
            value = str(source.get(field) or "").strip()
            if field not in resolved and value:
                resolved[field] = value
    if "locale" in resolved and not _LOCALE_RE.match(resolved["locale"]):
        resolved.pop("locale")
    return resolved


def tilion_emulation(fingerprint_injection: Any, exit_geo_locale: Any) -> Optional[Dict[str, Any]]:
    """Emulation the CDP multiplexer applies to every page/iframe a client attaches.

    Tilion keeps every session on America/New_York + en-US whatever the exit
    geo, and backend emulation dies with the backend's connection. Overrides
    are per CDP session, so the multiplexer applies them on each new target
    session (holding new targets until they land) and again on every re-attach
    after an upstream redial. ``None`` when neither source sets anything.
    """
    resolved = resolve_geo_locale(fingerprint_injection, exit_geo_locale)
    if not resolved:
        return None
    emulation: Dict[str, Any] = dict(resolved)
    if "locale" in resolved:
        emulation["accept_language"] = accept_language_for_locale(resolved["locale"])
    user_agent_override = (
        fingerprint_injection.get("userAgentOverride") if isinstance(fingerprint_injection, dict) else None
    )
    if isinstance(user_agent_override, dict) and user_agent_override.get("userAgent"):
        emulation["user_agent_override"] = dict(user_agent_override)
    return emulation
