"""Persist real Chrome downloads into provider session_files.

Product rule: chat only gets files that Chrome would put in its Downloads
folder — not ordinary page Fetch/XHR assets (SVG icons, map sprites, etc.).

Providers differ on where session listing sees those bytes:

- Kernel: CDP ``downloads_path`` + upload ``directory`` must be ``/tmp/downloads``
- Steel: CDP ``downloads_path`` is ``/files``; the Files API owns that root, so
  materialize uploads must omit ``directory`` (backend rejects ``/files``)
- Browser Use: the cloud browser publishes Chrome downloads directly through
  its downloads API; wait for that listing instead of uploading a second copy.

When CDP reports a real download (``Browser.downloadWillBegin`` /
``downloadProgress``) or goto hits ``net::ERR_ABORTED`` on a download
navigation, materialize that file via an in-page credentialed fetch and write
it through the browser-session upload API so ``extract_session_files`` /
attempt_completion can pass.

Do NOT sniff ``Network.responseReceived`` for Content-Disposition / URL
extensions — that invents "downloads" from normal browsing.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
from typing import Any, Dict, List, Optional, Set
from urllib.parse import unquote, urlparse

import structlog

from browser_tools.dom_service import (
    KERNEL_DOWNLOADS_PATH,
    STEEL_DOWNLOADS_PATH,
    browser_downloads_path_for_provider,
)
from domains.spawn_browser_agent_v3.tilion_worker import (
    is_single_cdp_client_provider,
    move_session,
    record_download,
    register_download_session,
)

logger = structlog.get_logger()

# Re-export for callers/tests that historically imported KERNEL_DOWNLOADS_DIR.
KERNEL_DOWNLOADS_DIR = KERNEL_DOWNLOADS_PATH
_MAX_PERSIST_BYTES = 25 * 1024 * 1024
_ATTACHMENT_RESOURCE_TYPES = frozenset({"Document", "Fetch", "XHR", "Other"})
# Document/archive extensions only — never image/svg/json by extension alone
# (those are page chrome unless Chrome itself starts a download).
_DOCUMENT_DOWNLOAD_EXTENSIONS = frozenset(
    {
        "zip",
        "pdf",
        "csv",
        "xlsx",
        "xls",
        "doc",
        "docx",
        "gz",
        "tgz",
        "tar",
        "7z",
        "rar",
        "mp4",
        "mp3",
        "txt",
        "bin",
    }
)
_FILENAME_RE = re.compile(
    r"filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)|filename\s*=\s*\"([^\"]+)\"|filename\s*=\s*([^;]+)",
    re.IGNORECASE,
)


def resolve_browser_provider(provider: Optional[str] = None) -> str:
    return (provider or os.getenv("BROWSER_PROVIDER") or "kernel").strip().lower()


def is_kernel_browser_provider(provider: Optional[str] = None) -> bool:
    return resolve_browser_provider(provider) == "kernel"


def is_steel_browser_provider(provider: Optional[str] = None) -> bool:
    return resolve_browser_provider(provider) == "steel"


async def wait_for_browser_use_download(
    config: Any, session_id: str, filename: str
) -> Optional[Dict[str, Any]]:
    """Wait for the cloud browser's native download to reach its files API."""
    from domains.spawn_browser_agent_v3.repo import list_session_files

    safe_name = os.path.basename(filename)
    for attempt in range(12):
        files = await list_session_files(config, session_id)
        match = next(
            (
                item
                for item in files
                if os.path.basename(str(item.get("path") or "")) == safe_name
                and int(item.get("size") or 0) > 0
            ),
            None,
        )
        if match:
            return {
                "path": match["path"],
                "size": match["size"],
                "filename": safe_name,
                "mime_type": mime_from_headers_or_name(mime_type="", filename=safe_name),
            }
        if attempt < 11:
            await asyncio.sleep(1)
    return None


def session_upload_directory_for_provider(provider: Optional[str] = None) -> Optional[str]:
    """Directory form field for session file upload, or None when the provider owns the root.

    Kernel needs ``directory=/tmp/downloads`` so listFiles sees the bytes.
    Steel's Files API always lands under ``/files``; the backend route rejects
    ``directory=/files``, so omit the field.
    """
    downloads = browser_downloads_path_for_provider(provider)
    if downloads == STEEL_DOWNLOADS_PATH or is_steel_browser_provider(provider):
        return None
    return downloads


def content_disposition_is_attachment(headers: Optional[Dict[str, Any]]) -> bool:
    if not headers:
        return False
    for key, value in headers.items():
        if str(key).lower() == "content-disposition":
            return "attachment" in str(value).lower()
    return False


def filename_from_content_disposition(headers: Optional[Dict[str, Any]]) -> Optional[str]:
    if not headers:
        return None
    disposition = ""
    for key, value in headers.items():
        if str(key).lower() == "content-disposition":
            disposition = str(value)
            break
    if not disposition:
        return None
    match = _FILENAME_RE.search(disposition)
    if not match:
        return None
    raw = next((group for group in match.groups() if group), None)
    if not raw:
        return None
    name = unquote(raw.strip().strip("\"'"))
    # Ads CDNs often force attachment; filename="f.txt" on Script payloads.
    if name.lower() in {"f.txt", "download", "file"}:
        return None
    return os.path.basename(name) or None


def filename_from_url(url: str) -> str:
    path = urlparse(url).path
    name = unquote(path.rsplit("/", 1)[-1] if path else "")
    name = os.path.basename(name.strip())
    return name or "download.bin"


def looks_like_download_url(url: str) -> bool:
    """True for download-shaped navigations — not bare image/svg/json page assets."""
    lower = (url or "").lower()
    if not lower.startswith(("http://", "https://")):
        return False
    path = urlparse(lower).path
    if any(marker in path for marker in ("/download", "/downloads", "/export", "/attachment")):
        return True
    basename = path.rsplit("/", 1)[-1]
    if "." in basename:
        ext = basename.rsplit(".", 1)[-1]
        if ext in _DOCUMENT_DOWNLOAD_EXTENSIONS:
            return True
    return False


def is_browser_attachment_download(
    *,
    url: str,
    resource_type: str = "",
    mime_type: str = "",
    response_headers: Optional[Dict[str, Any]] = None,
) -> bool:
    """True for real file attachments; false for ad/script attachment false-positives.

    Used only for goto ERR_ABORTED navigation fallback — not for sniffing every
    network response. Chrome ``Browser.download*`` events do not go through this.
    """
    if not url.startswith(("http://", "https://")):
        return False
    rtype = (resource_type or "").strip()
    if rtype and rtype not in _ATTACHMENT_RESOURCE_TYPES:
        return False
    lower_mime = (mime_type or "").lower()
    if any(marker in lower_mime for marker in ("javascript", "ecmascript", "text/css", "font/")):
        return False
    has_attachment = content_disposition_is_attachment(response_headers)
    if has_attachment:
        # Ads sometimes mark HTML beacons as attachment; require a file-like URL/name.
        if "text/html" in lower_mime and not looks_like_download_url(url):
            return bool(filename_from_content_disposition(response_headers))
        return True
    # No Content-Disposition: only trust download-shaped navigations.
    return looks_like_download_url(url)


def resolve_attachment_filename(
    *,
    url: str,
    response_headers: Optional[Dict[str, Any]] = None,
) -> str:
    return filename_from_content_disposition(response_headers) or filename_from_url(url)


def mime_from_headers_or_name(
    *,
    mime_type: str = "",
    response_headers: Optional[Dict[str, Any]] = None,
    filename: str = "",
) -> str:
    if mime_type and mime_type.strip():
        return mime_type.strip()
    if response_headers:
        for key, value in response_headers.items():
            if str(key).lower() == "content-type":
                raw = str(value).split(";", 1)[0].strip()
                if raw:
                    return raw
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
        "pdf": "application/pdf",
        "zip": "application/zip",
        "csv": "text/csv",
        "json": "application/json",
        "txt": "text/plain",
    }.get(ext, "application/octet-stream")


async def persist_bytes_to_session_downloads(
    config: Any,
    session_id: str,
    *,
    filename: str,
    content: bytes,
    mime_type: str = "application/octet-stream",
    provider: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Write bytes into the session downloads root via the provider-neutral API.

    Tilion has no session file API usable while the worker holds CDP, so its
    downloads go to the worker ledger and, given ``user_id``, straight to
    attachment storage, which outlives the activity (write-lock return,
    Temporal retry, another worker). The ledger then keeps only the pointer.
    """
    from domains.spawn_browser_agent_v3.repo import upload_file_to_session

    if not content:
        return None
    if len(content) > _MAX_PERSIST_BYTES:
        logger.warning(
            "[DownloadPersist] Refusing oversized attachment",
            session_id=session_id,
            filename=filename,
            size=len(content),
            max_bytes=_MAX_PERSIST_BYTES,
        )
        return None
    safe_name = os.path.basename(filename) or "download.bin"
    if is_single_cdp_client_provider(resolve_browser_provider(provider)):
        file_pointer = None
        if user_id:
            from helpers.attachments import upload_to_storage

            try:
                file_pointer = await upload_to_storage(
                    user_id=user_id,
                    file_content=content,
                    filename=safe_name,
                    mime_type=mime_type,
                    # Activities are at-least-once: the same bytes map to one object.
                    idempotency_key=f"tilion-download:{session_id}:{hashlib.sha256(content).hexdigest()}",
                )
            except Exception as error:
                logger.warning(
                    "[DownloadPersist] Durable copy of Tilion download failed; kept in worker memory",
                    session_id=session_id,
                    filename=safe_name,
                    error=str(error)[:200],
                )
        return record_download(
            session_id, filename=safe_name, content=content, mime_type=mime_type, file_pointer=file_pointer
        )
    downloads_dir = browser_downloads_path_for_provider(provider)
    upload_directory = session_upload_directory_for_provider(provider)
    uploaded = await upload_file_to_session(
        config,
        session_id,
        safe_name,
        content,
        mime_type,
        directory=upload_directory,
    )
    if not uploaded:
        return None
    fallback_path = (
        f"{downloads_dir.rstrip('/')}/{safe_name}"
        if downloads_dir
        else safe_name
    )
    return {
        "path": uploaded.get("path") or fallback_path,
        "size": uploaded.get("size") or len(content),
        "filename": safe_name,
        "mime_type": mime_type,
    }


_MAX_LISTED_DOWNLOADS = 20


class BrowserDownloadPersister:
    """Materialize Chrome Downloads into the provider session root via Browser.download* CDP.

    Only reacts when Chrome itself starts a download (same as the Downloads UI).
    Does not sniff Network Fetch/XHR for Content-Disposition or file extensions.
    """

    def __init__(
        self,
        *,
        browser_session: Any,
        session_id: str,
        config: Any,
        agent_id: str = "",
        task_id: str = "",
        provider: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> None:
        self.browser_session = browser_session
        self.user_id = user_id
        self.session_id = session_id
        self.config = config
        self.agent_id = agent_id
        self.task_id = task_id
        self.provider = resolve_browser_provider(provider)
        self.downloads_dir = browser_downloads_path_for_provider(self.provider)
        if is_single_cdp_client_provider(self.provider):
            register_download_session(session_id)
        self._closed = False
        self._cdp_client: Any = None
        self._tasks: Set[asyncio.Task] = set()
        self._pending_by_guid: Dict[str, Dict[str, Any]] = {}
        self._persisted_keys: Set[str] = set()
        # Files this browser activity downloaded, newest last (bounded), so the
        # agent's browser state can show them mid-run on every provider.
        self._downloaded_files: List[Dict[str, Any]] = []
        # Track which CDP client the Browser.download* handlers are bound to.
        # A lifetime boolean would skip re-register after transition_browser
        # swaps the client (proxy rotation / Steel auth restart).
        self._listeners_bound_to: Any = None

    @classmethod
    async def create(
        cls,
        *,
        browser_session: Any,
        session_id: Optional[str],
        config: Any,
        agent_id: str = "",
        task_id: str = "",
        provider: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Optional["BrowserDownloadPersister"]:
        if not session_id or config is None:
            return None
        # Kernel and Steel both emit Browser.download* when setDownloadBehavior
        # eventsEnabled is on — do not gate on a single provider.
        if not hasattr(browser_session, "get_or_create_cdp_session"):
            return None
        persister = cls(
            browser_session=browser_session,
            session_id=session_id,
            config=config,
            agent_id=agent_id,
            task_id=task_id or "",
            provider=provider,
            user_id=user_id,
        )
        try:
            await persister.start()
        except Exception as exc:
            logger.warning(
                "[DownloadPersist] Failed to start",
                agent_id=agent_id,
                session_id=session_id,
                provider=persister.provider,
                error=str(exc),
            )
            return None
        return persister

    async def start(self) -> None:
        cdp_session = await self.browser_session.get_or_create_cdp_session()
        cdp_client = getattr(self.browser_session, "cdp_client", None) or cdp_session.cdp_client
        self._cdp_client = cdp_client

        # Ensure Chrome emits downloadWillBegin / downloadProgress into downloads_path.
        try:
            await cdp_client.send.Browser.setDownloadBehavior(
                params={
                    "behavior": "allow",
                    "downloadPath": self.downloads_dir,
                    "eventsEnabled": True,
                }
            )
        except Exception as exc:
            logger.warning(
                "[DownloadPersist] setDownloadBehavior failed; still listening for events",
                provider=self.provider,
                downloads_dir=self.downloads_dir,
                error=str(exc)[:160],
            )

        # Bind Browser.download* listeners to this CDP client. Same client
        # (refresh after setDownloadBehavior only) must not stack duplicates;
        # a replacement client after transition_browser must re-register.
        if self._listeners_bound_to is not cdp_client:
            register = cdp_client.register
            register.Browser.downloadWillBegin(
                lambda event, session_id: self._on_download_will_begin(event, session_id)
            )
            register.Browser.downloadProgress(
                lambda event, session_id: self._on_download_progress(event, session_id)
            )
            self._listeners_bound_to = cdp_client
            logger.info(
                "[DownloadPersist] Listening for Chrome download events",
                agent_id=self.agent_id,
                task_id=self.task_id,
                session_id=self.session_id,
                provider=self.provider,
                downloads_dir=self.downloads_dir,
            )
        else:
            logger.info(
                "[DownloadPersist] Refreshing setDownloadBehavior after browser transition",
                agent_id=self.agent_id,
                session_id=self.session_id,
                provider=self.provider,
                downloads_dir=self.downloads_dir,
            )

    async def transition_browser(
        self, *, browser_session: Any, session_id: str, provider: Optional[str] = None
    ) -> None:
        if self._closed:
            return
        previous_session_id = self.session_id
        self.browser_session = browser_session
        self.session_id = session_id
        move_session(previous_session_id, session_id)
        if provider:
            # Rotation/recovery may switch provider; persist where the new one can.
            self.provider = resolve_browser_provider(provider)
            self.downloads_dir = browser_downloads_path_for_provider(self.provider)
        if is_single_cdp_client_provider(self.provider):
            register_download_session(session_id)
        await self.start()

    async def close(self) -> None:
        self._closed = True
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()
        self._pending_by_guid.clear()

    def _schedule_materialize(self, meta: Dict[str, Any]) -> None:
        task = asyncio.create_task(self._materialize_chrome_download(meta=meta))
        self._tasks.add(task)
        task.add_done_callback(lambda done: self._tasks.discard(done))

    def _on_download_will_begin(
        self,
        event: Dict[str, Any],
        session_id: str | None,
    ) -> None:
        if self._closed:
            return
        try:
            guid = str(event.get("guid") or "")
            if not guid:
                return
            url = str(event.get("url") or "")
            suggested = str(event.get("suggestedFilename") or "") or filename_from_url(url)
            meta = {
                "guid": guid,
                "url": url,
                "suggested_filename": os.path.basename(suggested) or "download.bin",
                "cdp_session_id": session_id,
            }
            self._pending_by_guid[guid] = meta
            logger.info(
                "[DownloadPersist] Chrome downloadWillBegin",
                agent_id=self.agent_id,
                session_id=self.session_id,
                provider=self.provider,
                guid=guid,
                filename=suggested[:120],
                url=url[:200],
            )
            # Providers often emit willBegin without a completed progress event.
            # Materialize from the Chrome-download URL immediately (idempotent).
            self._schedule_materialize(meta)
        except Exception as exc:
            logger.warning("[DownloadPersist] downloadWillBegin handler failed", error=str(exc))

    def _on_download_progress(
        self,
        event: Dict[str, Any],
        session_id: str | None,
    ) -> None:
        if self._closed:
            return
        guid = str(event.get("guid") or "")
        if not guid:
            return
        state = str(event.get("state") or "")
        if state == "canceled":
            self._pending_by_guid.pop(guid, None)
            return
        if state != "completed":
            return
        meta = self._pending_by_guid.pop(guid, None) or {
            "guid": guid,
            "url": "",
            "suggested_filename": "download.bin",
            "cdp_session_id": session_id,
        }
        file_path = event.get("filePath")
        if file_path:
            meta["file_path"] = str(file_path)
            meta["suggested_filename"] = (
                os.path.basename(str(file_path)) or meta["suggested_filename"]
            )
        self._schedule_materialize(meta)

    def _note_downloaded_file(self, result: Dict[str, Any], filename: str) -> None:
        name = os.path.basename(str(result.get("filename") or result.get("path") or "")) or filename
        size = result.get("size")
        # Same basename replaces, as in the session downloads root.
        self._downloaded_files = [item for item in self._downloaded_files if item["name"] != name]
        self._downloaded_files.append({"name": name, "size": int(size) if isinstance(size, int) else None})
        del self._downloaded_files[:-_MAX_LISTED_DOWNLOADS]

    def downloaded_files(self) -> List[Dict[str, Any]]:
        """Name and size of each file this activity downloaded, oldest first."""
        return [dict(item) for item in self._downloaded_files]

    async def _materialize_chrome_download(self, *, meta: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if self._closed:
            return None
        url = str(meta.get("url") or "")
        filename = str(meta.get("suggested_filename") or "download.bin")
        dedupe = f"{meta.get('guid')}|{url}|{filename}"
        if dedupe in self._persisted_keys:
            return None

        if self.provider == "browser-use":
            result = await wait_for_browser_use_download(
                self.config, self.session_id, filename
            )
            if result:
                self._persisted_keys.add(dedupe)
                self._note_downloaded_file(result, filename)
            return result

        # Do NOT skip solely because a same-basename file already exists in the
        # session. TinyPNG (and similar) upload the source as rs.jpeg under the
        # provider downloads root, then Chrome downloads the compressed output
        # with the same suggestedFilename — skipping leaves the original bytes
        # and fails the compressed file_pointer. Always materialize Chrome
        # download URLs; upload overwrite is idempotent. Dedupe is guid-keyed.

        if not url.startswith(("http://", "https://")):
            logger.warning(
                "[DownloadPersist] Completed download missing http(s) URL; cannot materialize",
                agent_id=self.agent_id,
                provider=self.provider,
                filename=filename,
            )
            return None

        # Prefer the CDP filePath via the provider Files API when present —
        # listFiles can miss the entry while content-by-path still works.
        # Fall back to a credentialed page fetch of the Chrome-download URL.
        file_path = str(meta.get("file_path") or "").strip()
        result: Optional[Dict[str, Any]] = None
        # Tilion fails files/fetch while the worker holds CDP; read in-page instead.
        if file_path and not is_single_cdp_client_provider(self.provider):
            result = await self._materialize_from_provider_file_path(
                file_path=file_path,
                filename=filename,
            )
        if not result:
            result = await persist_navigation_download_via_page_fetch(
                session=self.browser_session,
                url=url,
                session_id=self.session_id,
                config=self.config,
                provider=self.provider,
                trust_download=True,
                **({"user_id": self.user_id} if self.user_id else {}),
            )
        if result:
            self._persisted_keys.add(dedupe)
            self._note_downloaded_file(result, filename)
            logger.info(
                "[DownloadPersist] Materialized Chrome download into session downloads",
                agent_id=self.agent_id,
                session_id=self.session_id,
                provider=self.provider,
                path=result.get("path"),
                size=result.get("size"),
                url=url[:200],
            )
        return result

    async def _materialize_from_provider_file_path(
        self,
        *,
        file_path: str,
        filename: str,
    ) -> Optional[Dict[str, Any]]:
        from domains.spawn_browser_agent_v3.repo import download_session_file

        downloaded = await download_session_file(self.config, self.session_id, file_path)
        if not downloaded or not downloaded.get("content"):
            return None
        content = downloaded["content"]
        mime_type = str(
            downloaded.get("mime_type")
            or mime_from_headers_or_name(mime_type="", filename=filename)
        )
        uploaded = await persist_bytes_to_session_downloads(
            self.config,
            self.session_id,
            filename=filename,
            content=content,
            mime_type=mime_type,
            provider=self.provider,
        )
        if not uploaded:
            return None
        return {
            **uploaded,
            "content_type": mime_type,
            "source_path": file_path,
        }


async def persist_navigation_download_via_page_fetch(
    *,
    session: Any,
    url: str,
    session_id: str,
    config: Any,
    provider: Optional[str] = None,
    trust_download: bool = False,
    user_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Credentialed in-page fetch + session write for goto ERR_ABORTED / CDP download fallback.

    When ``trust_download`` is True (Chrome ``Browser.download*`` path), skip the
    Content-Disposition / URL-extension heuristic — Chrome already decided this
    is a Downloads-folder file (e.g. TinyPNG ``inline; filename=rs.png``).
    """
    import json

    suggested = filename_from_url(url)
    expression = f"""
    (async () => {{
      const response = await fetch({json.dumps(url)}, {{ credentials: "include" }});
      if (!response.ok) {{
        return {{ ok: false, status: response.status }};
      }}
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {{
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }}
      const disposition = response.headers.get("content-disposition") || "";
      let filename = {json.dumps(suggested)};
      const match = /filename\\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
      if (match && match[1]) {{
        filename = decodeURIComponent(match[1].replace(/"/g, "").trim()) || filename;
      }}
      return {{
        ok: true,
        status: response.status,
        size: bytes.length,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        filename,
        base64: btoa(binary),
        disposition,
      }};
    }})()
    """
    cdp_session = await session.get_or_create_cdp_session(focus=True)
    evaluated = await cdp_session.cdp_client.send.Runtime.evaluate(
        params={"expression": expression, "returnByValue": True, "awaitPromise": True},
        session_id=cdp_session.session_id,
    )
    if evaluated.get("exceptionDetails"):
        return None
    payload = (evaluated.get("result") or {}).get("value") or {}
    if not payload.get("ok") or not payload.get("base64"):
        return None
    filename = str(payload.get("filename") or suggested)
    headers = {"content-disposition": str(payload.get("disposition") or "attachment")}
    if not trust_download and not (
        is_browser_attachment_download(
            url=url,
            resource_type="Document",
            mime_type=str(payload.get("contentType") or ""),
            response_headers=headers,
        )
        or looks_like_download_url(url)
    ):
        return None
    mime_type = mime_from_headers_or_name(
        mime_type=str(payload.get("contentType") or ""),
        filename=filename,
    )
    if resolve_browser_provider(provider) == "browser-use":
        native = await wait_for_browser_use_download(config, session_id, filename)
        if not native:
            if int(payload.get("size") or 0) > _MAX_PERSIST_BYTES:
                return None
            # Browser Use exposes Chrome downloads, not a session-file upload.
            # Recreate the credentialed fetch as a browser download when the
            # original navigation did not leave a native download behind.
            expression = f"""(() => {{
              const binary = atob({json.dumps(payload['base64'])});
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const blob = new Blob([bytes], {{ type: {json.dumps(mime_type)} }});
              const href = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = href;
              link.download = {json.dumps(filename)};
              document.documentElement.appendChild(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(href), 60000);
              return true;
            }})()"""
            triggered = await cdp_session.cdp_client.send.Runtime.evaluate(
                params={"expression": expression, "returnByValue": True},
                session_id=cdp_session.session_id,
            )
            if triggered.get("exceptionDetails") or not (triggered.get("result") or {}).get("value"):
                return None
            native = await wait_for_browser_use_download(config, session_id, filename)
        return {**native, "content_type": mime_type, "source_url": url} if native else None
    file_bytes = base64.b64decode(payload["base64"])
    uploaded = await persist_bytes_to_session_downloads(
        config,
        session_id,
        filename=filename,
        content=file_bytes,
        mime_type=mime_type,
        provider=provider,
        **({"user_id": user_id} if user_id else {}),
    )
    if not uploaded:
        return None
    return {
        **uploaded,
        "content_type": mime_type,
        "source_url": url,
    }
