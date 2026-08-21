"""Persist browser attachment downloads into Kernel session_files (/tmp/downloads).

Kernel's CDP SetDownloadBehavior + downloads_path does not reliably materialize
files that ``listFiles(/tmp/downloads)`` can see. When the network stack receives
``Content-Disposition: attachment`` (or goto hits ``net::ERR_ABORTED`` on a
download URL), capture bytes via CDP ``Network.getResponseBody`` (or an in-page
credentialed fetch) and write them through the browser-session upload API under
``/tmp/downloads`` so ``extract_session_files`` / attempt_completion can pass.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from typing import Any, Dict, Optional, Set
from urllib.parse import unquote, urlparse

import structlog

logger = structlog.get_logger()

KERNEL_DOWNLOADS_DIR = "/tmp/downloads"
_MAX_PERSIST_BYTES = 25 * 1024 * 1024
_ATTACHMENT_RESOURCE_TYPES = frozenset({"Document", "Fetch", "XHR", "Other"})
_FILENAME_RE = re.compile(
    r"filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)|filename\s*=\s*\"([^\"]+)\"|filename\s*=\s*([^;]+)",
    re.IGNORECASE,
)


def is_kernel_browser_provider(provider: Optional[str] = None) -> bool:
    value = (provider or os.getenv("BROWSER_PROVIDER") or "").strip().lower()
    return value == "kernel"


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
    lower = (url or "").lower()
    if not lower.startswith(("http://", "https://")):
        return False
    path = urlparse(lower).path
    if any(marker in path for marker in ("/download", "/downloads", "/export", "/attachment")):
        return True
    basename = path.rsplit("/", 1)[-1]
    if "." in basename:
        ext = basename.rsplit(".", 1)[-1]
        if ext in {
            "zip",
            "pdf",
            "csv",
            "xlsx",
            "xls",
            "doc",
            "docx",
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "svg",
            "mp4",
            "mp3",
            "gz",
            "tgz",
            "tar",
            "7z",
            "rar",
            "json",
            "txt",
            "bin",
        }:
            return True
    return False


def is_browser_attachment_download(
    *,
    url: str,
    resource_type: str = "",
    mime_type: str = "",
    response_headers: Optional[Dict[str, Any]] = None,
) -> bool:
    """True for real file attachments; false for ad/script attachment false-positives."""
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
    # No Content-Disposition: only trust download-shaped navigations/fetches.
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
) -> Optional[Dict[str, Any]]:
    """Write bytes into the session downloads root via the provider-neutral API."""
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
    uploaded = await upload_file_to_session(
        config,
        session_id,
        safe_name,
        content,
        mime_type,
        directory=KERNEL_DOWNLOADS_DIR,
    )
    if not uploaded:
        return None
    return {
        "path": uploaded.get("path") or f"{KERNEL_DOWNLOADS_DIR}/{safe_name}",
        "size": uploaded.get("size") or len(content),
        "filename": safe_name,
        "mime_type": mime_type,
    }


class BrowserDownloadPersister:
    """CDP Network observer that materializes attachment bodies under /tmp/downloads."""

    def __init__(
        self,
        *,
        browser_session: Any,
        session_id: str,
        config: Any,
        agent_id: str = "",
        task_id: str = "",
    ) -> None:
        self.browser_session = browser_session
        self.session_id = session_id
        self.config = config
        self.agent_id = agent_id
        self.task_id = task_id
        self._closed = False
        self._cdp_client: Any = None
        self._tasks: Set[asyncio.Task] = set()
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._persisted_keys: Set[str] = set()
        self._generation = 0

    @classmethod
    async def create(
        cls,
        *,
        browser_session: Any,
        session_id: Optional[str],
        config: Any,
        agent_id: str = "",
        task_id: str = "",
    ) -> Optional["BrowserDownloadPersister"]:
        if not session_id or config is None:
            return None
        if not is_kernel_browser_provider():
            return None
        if not hasattr(browser_session, "get_or_create_cdp_session"):
            return None
        persister = cls(
            browser_session=browser_session,
            session_id=session_id,
            config=config,
            agent_id=agent_id,
            task_id=task_id or "",
        )
        try:
            await persister.start()
        except Exception as exc:
            logger.warning(
                "[DownloadPersist] Failed to start",
                agent_id=agent_id,
                session_id=session_id,
                error=str(exc),
            )
            return None
        return persister

    async def start(self) -> None:
        cdp_session = await self.browser_session.get_or_create_cdp_session()
        cdp_client = getattr(self.browser_session, "cdp_client", None) or cdp_session.cdp_client
        self._cdp_client = cdp_client
        self._generation += 1
        generation = self._generation
        register = cdp_client.register
        register.Network.responseReceived(
            lambda event, session_id: self._on_response_received(event, session_id, generation)
        )
        register.Network.loadingFinished(
            lambda event, session_id: self._on_loading_finished(
                event, session_id, generation, cdp_client
            )
        )
        register.Network.loadingFailed(
            lambda event, session_id: self._on_loading_failed(
                event, session_id, generation, cdp_client
            )
        )
        await cdp_client.send.Network.enable(session_id=cdp_session.session_id)
        logger.info(
            "[DownloadPersist] Listening for attachment downloads",
            agent_id=self.agent_id,
            task_id=self.task_id,
            session_id=self.session_id,
            downloads_dir=KERNEL_DOWNLOADS_DIR,
        )

    async def transition_browser(self, *, browser_session: Any, session_id: str) -> None:
        if self._closed:
            return
        self.browser_session = browser_session
        self.session_id = session_id
        await self.start()

    async def close(self) -> None:
        self._closed = True
        pending = list(self._tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()
        self._pending.clear()

    def _request_key(self, request_id: str, generation: int) -> str:
        return f"{generation}:{request_id}"

    def _on_response_received(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int,
    ) -> None:
        if self._closed:
            return
        try:
            request_id = event.get("requestId")
            response = event.get("response") or {}
            url = str(response.get("url") or "")
            resource_type = str(event.get("type") or "")
            mime_type = str(response.get("mimeType") or "")
            headers = response.get("headers") or {}
            if not request_id:
                return
            if not is_browser_attachment_download(
                url=url,
                resource_type=resource_type,
                mime_type=mime_type,
                response_headers=headers if isinstance(headers, dict) else {},
            ):
                return
            key = self._request_key(str(request_id), generation)
            self._pending[key] = {
                "request_id": str(request_id),
                "cdp_session_id": session_id,
                "url": url,
                "resource_type": resource_type,
                "mime_type": mime_type,
                "response_headers": headers if isinstance(headers, dict) else {},
                "status": response.get("status"),
            }
        except Exception as exc:
            logger.warning("[DownloadPersist] responseReceived handler failed", error=str(exc))

    def _on_loading_finished(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int,
        cdp_client: Any,
    ) -> None:
        if self._closed:
            return
        request_id = event.get("requestId")
        if not request_id:
            return
        key = self._request_key(str(request_id), generation)
        meta = self._pending.pop(key, None)
        if not meta:
            return
        task = asyncio.create_task(
            self._persist_from_cdp(
                meta=meta,
                cdp_client=cdp_client,
                cdp_session_id=session_id or meta.get("cdp_session_id"),
            )
        )
        self._tasks.add(task)
        task.add_done_callback(lambda done: self._tasks.discard(done))

    def _on_loading_failed(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int,
        cdp_client: Any,
    ) -> None:
        if self._closed:
            return
        request_id = event.get("requestId")
        if not request_id:
            return
        key = self._request_key(str(request_id), generation)
        meta = self._pending.pop(key, None)
        if not meta:
            return
        error_text = str(event.get("errorText") or "")
        # Attachment navigations commonly abort after headers; body may still be readable.
        if "ERR_ABORTED" not in error_text and "ERR_ABORTED" not in str(meta.get("status") or ""):
            if not error_text:
                return
            if "ABORT" not in error_text.upper():
                return
        task = asyncio.create_task(
            self._persist_from_cdp(
                meta=meta,
                cdp_client=cdp_client,
                cdp_session_id=session_id or meta.get("cdp_session_id"),
            )
        )
        self._tasks.add(task)
        task.add_done_callback(lambda done: self._tasks.discard(done))

    async def _persist_from_cdp(
        self,
        *,
        meta: Dict[str, Any],
        cdp_client: Any,
        cdp_session_id: Any,
    ) -> Optional[Dict[str, Any]]:
        if self._closed:
            return None
        url = str(meta.get("url") or "")
        headers = meta.get("response_headers") or {}
        filename = resolve_attachment_filename(url=url, response_headers=headers)
        mime_type = mime_from_headers_or_name(
            mime_type=str(meta.get("mime_type") or ""),
            response_headers=headers,
            filename=filename,
        )
        dedupe = f"{url}|{filename}"
        if dedupe in self._persisted_keys:
            return None
        body = await self._fetch_response_body(
            request_id=str(meta.get("request_id") or ""),
            cdp_client=cdp_client,
            cdp_session_id=cdp_session_id,
        )
        if not body:
            return None
        result = await persist_bytes_to_session_downloads(
            self.config,
            self.session_id,
            filename=filename,
            content=body,
            mime_type=mime_type,
        )
        if result:
            self._persisted_keys.add(dedupe)
            logger.info(
                "[DownloadPersist] Saved attachment to session downloads",
                agent_id=self.agent_id,
                session_id=self.session_id,
                path=result.get("path"),
                size=result.get("size"),
                url=url[:200],
            )
        return result

    async def _fetch_response_body(
        self,
        *,
        request_id: str,
        cdp_client: Any,
        cdp_session_id: Any,
    ) -> Optional[bytes]:
        if not request_id or cdp_client is None:
            return None
        try:
            response = await cdp_client.send.Network.getResponseBody(
                params={"requestId": request_id},
                session_id=cdp_session_id,
            )
            body = response.get("body", "")
            if response.get("base64Encoded"):
                return base64.b64decode(body)
            if isinstance(body, str):
                return body.encode("utf-8", errors="replace")
            return bytes(body or b"")
        except Exception as exc:
            logger.info(
                "[DownloadPersist] getResponseBody unavailable",
                request_id=request_id,
                error=str(exc)[:160],
            )
            return None


async def persist_navigation_download_via_page_fetch(
    *,
    session: Any,
    url: str,
    session_id: str,
    config: Any,
) -> Optional[Dict[str, Any]]:
    """Credentialed in-page fetch + session write for goto ERR_ABORTED downloads."""
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
    file_bytes = base64.b64decode(payload["base64"])
    filename = str(payload.get("filename") or suggested)
    headers = {"content-disposition": str(payload.get("disposition") or "attachment")}
    if not (
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
    uploaded = await persist_bytes_to_session_downloads(
        config,
        session_id,
        filename=filename,
        content=file_bytes,
        mime_type=mime_type,
    )
    if not uploaded:
        return None
    return {
        **uploaded,
        "content_type": mime_type,
        "source_url": url,
    }
