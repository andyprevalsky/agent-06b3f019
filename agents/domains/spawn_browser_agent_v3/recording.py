"""Dev-only browser-agent replay recording.

Records viewport frames from an existing Playwright page and emits a small
HTML player. This is intentionally local/dev-only; production should rely on
normal browser logs and Steel viewer URLs.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import html
import io
import json
import mimetypes
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from concurrent.futures import Future
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Mapping, Optional
from urllib.parse import unquote, unquote_to_bytes, urljoin, urlparse

import httpx
import structlog

import helpers.trace_archive as trace_archive
from helpers.trace_archive import archive_bytes, archive_enabled, archive_files
from helpers.tracing import current_root_agent_id
from utils.url_redaction import redact_url_secrets

logger = structlog.get_logger()


FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
STATIC_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"}
_BACKGROUND_RECORDING_ARCHIVE_TASKS: set[asyncio.Task[Any]] = set()
_BACKGROUND_RECORDING_ARCHIVE_SLOTS = threading.BoundedSemaphore(4)


_CLOSED_RECORDING_LOCK = threading.Lock()
_CLOSED_RECORDING_FILES: dict[tuple[str, str, str], dict[str, Future[Optional[dict[str, str]]]]] = {}
_CLOSED_RECORDING_WAITING: dict[tuple[str, str, str], list[tuple[str, tuple[str, Path, str, Optional[bool]], int, Any]]] = {}


def _initialize_archive_owner(recorder: Any) -> None:
    recorder._local_abort = threading.Event()
    recorder._archive_owner_token = object()
    recorder._archive_tasks = set()
    recorder._archive_futures = {}
    recorder._archive_waiting_keys = set()


def _archive_owner_aborted(recorder: Any) -> bool:
    event = getattr(recorder, "_local_abort", None)
    return event is not None and event.is_set()


async def _abort_recording_local(recorder: Any, tasks: list[Any], *, settle_timeout: float) -> bool:
    """Fence new owner work and settle cancellable work without provider writes."""
    with _CLOSED_RECORDING_LOCK:
        recorder._local_abort.set()
        recorder._closed = True
        for key in recorder._archive_waiting_keys:
            waiting = _CLOSED_RECORDING_WAITING.get(key)
            if waiting is not None:
                waiting[:] = [item for item in waiting if item[3] is not recorder]
                if not waiting:
                    _CLOSED_RECORDING_WAITING.pop(key, None)
        recorder._archive_waiting_keys.clear()
        exclusive_futures = [future for future, owners in recorder._archive_futures.items()
                             if owners == frozenset({recorder._archive_owner_token})]
    # Running transfers cannot be rolled back; cancel() only removes queued work.
    for future in exclusive_futures:
        future.cancel()
    owned_tasks = {task for task in [*tasks, *recorder._archive_tasks]
                   if isinstance(task, asyncio.Task) and task is not asyncio.current_task()}
    for task in owned_tasks:
        task.cancel()
        task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
    if not owned_tasks:
        return True
    _, pending = await asyncio.wait(owned_tasks, timeout=settle_timeout)
    return not pending


def _queue_closed_recording_file(
    output_dir: Path, root_agent_id: str, task_id: str, file_path: Path, *, owner: Any = None
) -> None:
    """Publish native batches during capture without queuing any source bodies."""
    if not archive_enabled():
        return
    try:
        relative = file_path.relative_to(output_dir).as_posix()
        key = (str(output_dir.resolve()), root_agent_id, task_id)
        path = f"media/browser/{task_id}/{relative}"
        reservation = trace_archive.closed_file_archive_reservation(path, file_path)
        if reservation is None or reservation > trace_archive._BATCH_MAX_BYTES:
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        descriptor = (
            path,
            file_path,
            content_type,
            False if content_type.startswith(("image/", "video/", "audio/")) else None,
        )
        with _CLOSED_RECORDING_LOCK:
            if owner is not None and _archive_owner_aborted(owner):
                return
            waiting = _CLOSED_RECORDING_WAITING.setdefault(key, [])

            def flush_waiting() -> None:
                batch = list(waiting)
                waiting.clear()
                for item in batch:
                    if item[3] is not None:
                        item[3]._archive_waiting_keys.discard(key)
                future = trace_archive.archive_closed_files_in_background(
                    root_agent_id=root_agent_id, artifacts=[item[1] for item in batch]
                )
                if future is not None:
                    owners = frozenset(getattr(item[3], "_archive_owner_token", None) for item in batch)
                    for item in batch:
                        _CLOSED_RECORDING_FILES.setdefault(key, {})[item[0]] = future
                        if item[3] is not None:
                            item[3]._archive_futures[future] = owners

            if waiting and sum(item[2] for item in waiting) + reservation > trace_archive._BATCH_MAX_BYTES:
                flush_waiting()
            waiting.append((relative, descriptor, reservation, owner))
            if owner is not None:
                owner._archive_waiting_keys.add(key)
            if len(waiting) >= trace_archive._BATCH_MAX_RECORDS:
                flush_waiting()
    except Exception:
        # Source files survive failed admission and follow the final fallback.
        pass


def _closed_recording_hash(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _archive_recording_directory(output_dir: Path, root_agent_id: str, task_id: str, *, owner: Any = None) -> bool:
    if owner is not None and _archive_owner_aborted(owner):
        return False
    key = (str(output_dir.resolve()), root_agent_id, task_id)
    with _CLOSED_RECORDING_LOCK:
        closed = dict(_CLOSED_RECORDING_FILES.get(key, {}))
        removed_waiting = _CLOSED_RECORDING_WAITING.pop(key, [])
        for item in removed_waiting:
            if item[3] is not None:
                item[3]._archive_waiting_keys.discard(key)
    acknowledged = {}
    for relative, future in closed.items():
        try:
            hashes = future.result()
            if hashes is not None:
                acknowledged[relative] = hashes.get(f"media/browser/{task_id}/{relative}")
        except Exception:
            pass

    def artifacts():
        for file_path in output_dir.rglob("*"):
            if owner is not None and _archive_owner_aborted(owner):
                return
            if file_path.is_file():
                relative = file_path.relative_to(output_dir).as_posix()
                if relative in acknowledged and acknowledged[relative] == _closed_recording_hash(file_path):
                    continue
                content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                yield (
                    f"media/browser/{task_id}/{file_path.relative_to(output_dir).as_posix()}",
                    file_path,
                    content_type,
                    False if content_type.startswith(("image/", "video/", "audio/")) else None,
                )

    try:
        return archive_files(root_agent_id=root_agent_id, artifacts=artifacts())
    finally:
        with _CLOSED_RECORDING_LOCK:
            current = _CLOSED_RECORDING_FILES.get(key, {})
            for relative, future in closed.items():
                if current.get(relative) is future:
                    current.pop(relative)
            if not current:
                _CLOSED_RECORDING_FILES.pop(key, None)


def _schedule_background_recording_archive(recorder: Any, *, cleanup_after: bool) -> bool:
    """Bound recording archive work without queueing thousands of filesystem walks."""
    if not hasattr(recorder, "_local_abort"):
        _initialize_archive_owner(recorder)
    if _archive_owner_aborted(recorder):
        return False
    if not _BACKGROUND_RECORDING_ARCHIVE_SLOTS.acquire(blocking=False):
        logger.warning(
            "Browser recording archive queue saturated",
            agent_id=recorder.agent_id,
            task_id=recorder.task_id,
        )
        return False

    async def _run() -> bool:
        if _archive_owner_aborted(recorder):
            return False
        return await recorder._archive_recording_artifacts()

    task = asyncio.create_task(_run())
    _BACKGROUND_RECORDING_ARCHIVE_TASKS.add(task)
    recorder._archive_tasks.add(task)

    def _finished(completed: asyncio.Task[Any]) -> None:
        # A cancelled coroutine may never enter its body.
        _BACKGROUND_RECORDING_ARCHIVE_SLOTS.release()
        _BACKGROUND_RECORDING_ARCHIVE_TASKS.discard(completed)
        recorder._archive_tasks.discard(completed)
        if completed.cancelled():
            return
        try:
            archived = completed.result()
        except Exception:
            return
        if cleanup_after and archived:
            recorder.cleanup_local_artifacts(persisted=True)

    task.add_done_callback(_finished)
    return True


def steel_api_url(path: str) -> str:
    base_url = os.getenv("STEEL_BASE_URL", "https://api.steel.dev").rstrip("/")
    return f"{base_url}/{path.lstrip('/')}"


def browser_recordings_enabled() -> bool:
    value = os.getenv("BROWSER_AGENT_RECORDINGS", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    if archive_enabled():
        return True

    if os.getenv("ENVIRONMENT") != "production":
        return True
    if os.getenv("CONDUCTOR_WORKSPACE_NAME"):
        return True

    api_url = os.getenv("BACKEND_API_URL", "")
    return "localhost" in api_url or "127.0.0.1" in api_url


def kernel_replay_enabled() -> bool:
    """Reuse Kernel's native session-replay recording instead of our screenshot
    capture. Defaults on wherever screenshot recordings run today (dev/benchmark/
    archive); an explicit env flag can force it (e.g. to enable in prod, where the
    replay is cheap: start/stop API + a hosted view URL, no per-frame screenshots
    and no Supabase upload)."""
    value = os.getenv("BROWSER_AGENT_KERNEL_REPLAY", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return browser_recordings_enabled()


def _kernel_api_base() -> str:
    return (os.getenv("KERNEL_API_BASE_URL") or "https://api.onkernel.com").rstrip("/")


def _kernel_replay_headers() -> Optional[Dict[str, str]]:
    api_key = os.getenv("KERNEL_API_KEY", "").strip()
    if not api_key:
        return None
    return {"Authorization": f"Bearer {api_key}"}


def _is_production_runtime() -> bool:
    return os.getenv("FLY_APP_NAME") is not None or os.getenv("ENVIRONMENT") == "production"


def cleanup_local_recording_artifacts_enabled() -> bool:
    value = os.getenv("BROWSER_AGENT_RECORDINGS_CLEANUP_LOCAL", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return _is_production_runtime() and not os.getenv("CONDUCTOR_WORKSPACE_NAME")


def _recording_root() -> Path:
    override = os.getenv("BROWSER_AGENT_RECORDINGS_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if _is_production_runtime() and not os.getenv("CONDUCTOR_WORKSPACE_NAME"):
        return Path(tempfile.gettempdir()) / "rose-browser-agent-recordings"
    return Path(__file__).resolve().parents[3] / ".context" / "browser-agent-recordings"


def _safe_task_id(task_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in task_id)[:80]


def browser_recording_output_dir(agent_id: str, task_id: str) -> Path:
    return _recording_root() / agent_id / _safe_task_id(task_id)


def _strip_url_query_fragment(value: str) -> str:
    """Remove everything from the first ``?`` or ``#`` onward."""
    return value.split("#", 1)[0].split("?", 1)[0]


def _redact_url_fallback(value: str) -> str:
    """Redact a URL without relying on a successfully parsed authority."""
    stripped = _strip_url_query_fragment(value)
    if "://" in stripped:
        scheme, remainder = stripped.split("://", 1)
        prefix = f"{scheme}://"
    elif stripped.startswith("//"):
        prefix = "//"
        remainder = stripped[2:]
    else:
        return stripped
    authority, separator, path = remainder.partition("/")
    safe_authority = authority.rsplit("@", 1)[-1]
    return f"{prefix}{safe_authority}{separator}{path}"


def _redact_url_query(url: str) -> str:
    """Drop query string + fragment from a URL, keeping scheme://host/path.

    Captured request URLs are surfaced to the agent (and its turn history) via
    read_network_requests; query strings can carry signed URLs, auth tokens, and
    PII, so only the non-secret locator is exposed. This fails CLOSED: parse
    failures and authority-less inputs still get their query/fragment stripped,
    and embedded ``user:pass@`` credentials are dropped from the authority.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return _redact_url_fallback(url)
    if not parsed.scheme or not parsed.netloc:
        return _redact_url_fallback(url)
    # netloc may carry `user:pass@host:port` — keep only host[:port].
    host = parsed.netloc.rsplit("@", 1)[-1]
    return f"{parsed.scheme}://{host}{parsed.path}"


# Headers whose values are bearer credentials for the live browser session.
# Everything else is returned verbatim: the agent needs content-type, csrf
# tokens, pagination cursors, and rate-limit headers to reason about an API.
# These four are masked because they buy the agent nothing (an in-page
# `evaluate` fetch replays them automatically) while pinning a live session
# token into turn history, LLM provider logs, and the trace archive.
_SENSITIVE_HEADERS = frozenset({"cookie", "set-cookie", "authorization", "proxy-authorization"})


def _coerce_header_map(headers: Any) -> Dict[str, str]:
    """Normalize a CDP header bag to a flat lowercase-keyed str->str map."""
    if not isinstance(headers, dict):
        return {}
    return {str(name).lower(): str(value) for name, value in headers.items()}


def _mask_sensitive_headers(headers: Any) -> Dict[str, str]:
    if not isinstance(headers, dict):
        return {}
    masked: Dict[str, str] = {}
    for name, value in headers.items():
        key = str(name).lower()
        text = str(value)
        masked[key] = f"<redacted {len(text)} chars>" if key in _SENSITIVE_HEADERS else text
    return masked


_CONSOLE_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(auth(?:orization)?|bearer|card|cookie|credential|cvv|email|key|otp|pass(?:code|word)?|"
    r"phone|secret|session|signature|token)(\s*[:=]\s*)([^\s,;]+)"
)
_CONSOLE_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_CONSOLE_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
_CONSOLE_URL_RE = re.compile(r"https?://[^\s<>'\"]+")
_DIAGNOSTIC_HEADER_SECRET_MARKERS = (
    "auth",
    "cookie",
    "credential",
    "key",
    "otp",
    "pass",
    "secret",
    "session",
    "signature",
    "token",
)


def _redact_console_text(value: Any, *, limit: int = 4096) -> str:
    """Bound and redact page-controlled console text before durable storage."""
    text = str(value or "")
    text = _CONSOLE_URL_RE.sub(lambda match: _redact_url_query(match.group(0)), text)
    text = _CONSOLE_BEARER_RE.sub("Bearer [REDACTED]", text)
    text = _CONSOLE_JWT_RE.sub("[REDACTED JWT]", text)
    text = _CONSOLE_SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text)
    return _truncate_text(text, max(0, limit)) or ""


def _diagnostic_headers(headers: Any) -> Dict[str, str]:
    """Redact and bound headers more strictly than the agent-facing live tool."""
    redacted: Dict[str, str] = {}
    for index, (name, value) in enumerate(_coerce_header_map(headers).items()):
        if index >= 100:
            break
        if any(marker in name for marker in _DIAGNOSTIC_HEADER_SECRET_MARKERS):
            redacted[name] = "[REDACTED]"
        else:
            redacted[name] = _redact_console_text(value, limit=2048)
    return redacted


def _console_remote_object_text(value: Any) -> str:
    if not isinstance(value, dict):
        return _redact_console_text(value)
    if value.get("value") is not None:
        raw = value.get("value")
        if isinstance(raw, (dict, list)):
            with contextlib.suppress(TypeError, ValueError):
                return _redact_console_text(json.dumps(raw, ensure_ascii=False, default=str))
        return _redact_console_text(raw)
    description = value.get("description")
    if description is not None:
        return _redact_console_text(description)
    subtype = value.get("subtype")
    object_type = value.get("type")
    return _redact_console_text(subtype or object_type or "unknown")


def _console_stack_frames(stack_trace: Any) -> List[Dict[str, Any]]:
    if not isinstance(stack_trace, dict):
        return []
    frames: List[Dict[str, Any]] = []
    for frame in stack_trace.get("callFrames") or []:
        if not isinstance(frame, dict):
            continue
        frames.append(
            {
                "function": _redact_console_text(frame.get("functionName") or "", limit=256),
                "url": _redact_url_query(str(frame.get("url") or "")),
                "line": frame.get("lineNumber"),
                "column": frame.get("columnNumber"),
            }
        )
        if len(frames) >= 20:
            break
    return frames


def _encoded_len(text: Any) -> int:
    """UTF-8 byte length — the unit every *_BYTES budget is denominated in."""
    if text is None:
        return 0
    value = text if isinstance(text, str) else str(text)
    return len(value.encode("utf-8"))


def _truncate_text_to_bytes(text: Any, max_bytes: int) -> Optional[str]:
    """Truncate on ENCODED bytes, not characters.

    `_max_body_bytes` (BROWSER_AGENT_NETWORK_MAX_BODY_BYTES) is a byte budget
    bounding worker heap. Slicing by character count lets a non-ASCII payload
    (unicode form fields, CJK JSON) retain up to ~4x the intended bytes, and at
    `_max_entries` retained requests that multiplies. errors="ignore" drops a
    trailing partial code point rather than raising.
    """
    if text is None:
        return None
    value = text if isinstance(text, str) else str(text)
    if max_bytes <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _truncate_text(text: Any, max_chars: int) -> Optional[str]:
    if text is None:
        return None
    value = text if isinstance(text, str) else str(text)
    if max_chars <= 0:
        return ""
    if len(value) <= max_chars:
        return value
    return value[:max_chars]


def _duration_ms(entry: Dict[str, Any]) -> Optional[int]:
    start = entry.get("request_ts_ms")
    end = entry.get("response_ts_ms")
    if start is None or end is None:
        return None
    return max(0, int(end) - int(start))


def _status_matches(status: Any, failed: Any, status_filter: str) -> bool:
    """Match a status filter: exact ('403'), class ('4xx'), or 'error'/'ok'."""
    if status_filter == "error":
        return bool(failed) or (isinstance(status, int) and status >= 400)
    if status_filter == "ok":
        return not failed and isinstance(status, int) and 200 <= status < 400
    if not isinstance(status, int):
        return False
    if status_filter.endswith("xx") and status_filter[:-2].isdigit():
        return status // 100 == int(status_filter[:-2])
    if status_filter.isdigit():
        return status == int(status_filter)
    return False


_CONSOLE_RESOURCE_STATUS_RE = re.compile(
    r"Failed to load resource: the server responded with a status of (\d+)",
    re.IGNORECASE,
)
_CONSOLE_APOLLO_STATUS_RE = re.compile(
    r"Response not successful: Received status code (\d+)",
    re.IGNORECASE,
)
_CONSOLE_STATUS_CODE_RE = re.compile(r"\bstatus code (\d+)\b", re.IGNORECASE)


def _parse_console_http_status(text: str) -> Optional[int]:
    """Extract an HTTP status code from a browser console/network error line."""
    if not text:
        return None
    for pattern in (
        _CONSOLE_RESOURCE_STATUS_RE,
        _CONSOLE_APOLLO_STATUS_RE,
        _CONSOLE_STATUS_CODE_RE,
    ):
        match = pattern.search(text)
        if match:
            try:
                return int(match.group(1))
            except (TypeError, ValueError):
                continue
    return None


def _compile_log_pattern(pattern: str) -> re.Pattern[str]:
    """Compile a user-supplied regex; invalid patterns raise ValueError."""
    stripped = (pattern or "").strip()
    if not stripped:
        return re.compile(r".*", re.DOTALL)
    try:
        return re.compile(stripped, re.IGNORECASE | re.DOTALL)
    except re.error as exc:
        raise ValueError(f"Invalid regex pattern: {exc}") from exc


def _log_row_search_text(row: Dict[str, Any]) -> str:
    parts = [
        str(row.get("source") or ""),
        str(row.get("level") or ""),
        str(row.get("text") or ""),
        str(row.get("url") or ""),
        str(row.get("method") or ""),
        str(row.get("status") or ""),
        str(row.get("status_text") or ""),
        str(row.get("failure") or ""),
    ]
    return " ".join(part for part in parts if part)


def _network_log_summary(row: Dict[str, Any]) -> str:
    method = str(row.get("method") or "GET")
    url = str(row.get("url") or "")
    status = row.get("status")
    failed = row.get("failed")
    if isinstance(status, int):
        suffix = f" -> {status}"
        if row.get("status_text"):
            suffix += f" {row['status_text']}"
    elif failed:
        suffix = f" -> FAILED {row.get('failure') or ''}".strip()
    else:
        suffix = " -> (no response status yet)"
    resource_type = row.get("resource_type")
    if resource_type:
        suffix += f" ({resource_type})"
    return f"{method} {url}{suffix}".strip()


def _media_extension(url: str, default: str) -> str:
    suffix = Path(urlparse(url).path).suffix
    if suffix and len(suffix) <= 8:
        return suffix
    return default


async def _download_media_file(client: httpx.AsyncClient, url: str, path: Path) -> None:
    response = await client.get(url)
    response.raise_for_status()
    path.write_bytes(response.content)


async def _mux_hls_to_mp4(playlist_path: Path, output_path: Path) -> bool:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        return False
    process = await asyncio.create_subprocess_exec(
        ffmpeg_path,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-allowed_extensions",
        "ALL",
        "-i",
        str(playlist_path),
        "-c",
        "copy",
        str(output_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await process.communicate()
    if process.returncode != 0:
        logger.debug("Steel HLS mux to MP4 failed", error=stderr.decode("utf-8", errors="replace")[:500])
        return False
    return output_path.exists() and output_path.stat().st_size > 0


def _cursor_svg_for_html() -> str:
    svg = """<svg width="28" height="28" viewBox="0 0 427 427" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(427, 0) scale(-1, 1)">
    <g transform="translate(-43, 470) scale(0.1, -0.1)">
      <path d="M669 4687 c-149 -42 -244 -165 -242 -312 1 -77 1202 -3705 1257 -3800 116 -198 438 -191 548 11 15 27 128 389 253 804 322 1072 177 927 1255 1250 830 249 777 231 840 281 165 131 146 408 -36 515 -59 35 -3711 1251 -3777 1258 -29 3 -72 0 -98 -7z"
            fill="#1a1a1a" stroke="#ffffff" stroke-width="40" stroke-linejoin="round"/>
    </g>
  </g>
</svg>"""
    return svg.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def _sanitize_observation_value(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: Dict[str, Any] = {}
        for key, nested in value.items():
            if key in {"screenshot", "screenshot_b64", "base64", "image_url"} and isinstance(nested, str):
                sanitized[key] = {
                    "redacted": "base64-media",
                    "bytes_estimate": int(len(nested) * 3 / 4),
                    "present": bool(nested),
                }
            else:
                sanitized[key] = _sanitize_observation_value(nested)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_observation_value(item) for item in value]
    return value


def normalize_simulated_browser_frame(value: Any) -> Optional[Dict[str, Any]]:
    """Normalize WMH visual output for scriptless live/replay rendering."""

    if isinstance(value, str):
        stripped = value.strip()
        if stripped.lower().startswith("data:text/html"):
            header, separator, encoded_html = stripped.partition(",")
            if not separator:
                return None
            try:
                if ";base64" in header.lower():
                    html_value = base64.b64decode(encoded_html, validate=True).decode("utf-8")
                else:
                    html_value = unquote_to_bytes(encoded_html).decode("utf-8")
            except (UnicodeDecodeError, ValueError):
                return None
            return {"kind": "html", "html": html_value} if html_value.strip() else None
        if stripped.startswith("data:image/") or _looks_like_static_image_url(stripped):
            return {"kind": "image", "src": stripped}
        if stripped.startswith(("https://", "http://")):
            return None
        return {"kind": "html", "html": stripped} if stripped else None
    if not isinstance(value, dict):
        return None

    dimensions = {
        key: int(number)
        for key, number in (("width", value.get("width")), ("height", value.get("height")))
        if isinstance(number, (int, float)) and not isinstance(number, bool) and number > 0
    }
    html_value = value.get("html") or value.get("srcdoc") or value.get("src_doc")
    if isinstance(html_value, str) and html_value.strip():
        return {"kind": "html", "html": html_value, **dimensions}

    source = value.get("src") or value.get("data_url") or value.get("image_url") or value.get("url")
    if isinstance(source, str) and (
        source.strip().startswith("data:image/") or _looks_like_static_image_url(source.strip())
    ):
        return {"kind": "image", "src": source.strip(), **dimensions}

    encoded = value.get("base64") or value.get("data")
    mime_type = str(value.get("mime_type") or value.get("mimeType") or "image/png")
    if (
        isinstance(encoded, str)
        and encoded.strip()
        and mime_type
        in {
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
        }
    ):
        return {"kind": "image", "src": f"data:{mime_type};base64,{encoded.strip()}", **dimensions}
    return None


def _looks_like_static_image_url(value: str) -> bool:
    """Reject ordinary page URLs so a WMH frame can never fetch a live website."""

    if not value.startswith(("https://", "http://")):
        return False
    return Path(urlparse(value).path).suffix.lower() in STATIC_IMAGE_SUFFIXES


class SimulatedBrowserRecorder:
    """Self-contained WMH frame recorder; never owns a browser or CDP session."""

    uses_kernel_replay = False

    def __init__(
        self,
        *,
        agent_id: str,
        task_id: str,
        session_id: str,
        frames: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.agent_id = agent_id
        self.task_id = task_id
        self.session_id = session_id
        self.browser_url = ""
        self.session_metadata = {"provider": "wmh", "simulated": True}
        self.output_dir = browser_recording_output_dir(agent_id, task_id)
        self.frames = list(frames or [])
        self.observations: List[Dict[str, Any]] = []
        self.cursor_events: List[Dict[str, int]] = []

    @property
    def checkpoint_path(self) -> Path:
        """Return the compact resume reference for frames persisted on shared scratch storage."""

        return self.output_dir / "frames.checkpoint.json"

    def _load_checkpoint_frames(self) -> List[Dict[str, Any]]:
        if not self.checkpoint_path.exists():
            return []
        try:
            payload = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []
        if payload.get("session_id") != self.session_id:
            return []
        checkpoint_frames = payload.get("frames")
        return list(checkpoint_frames) if isinstance(checkpoint_frames, list) else []

    def _write_checkpoint(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        temporary_path = self.checkpoint_path.with_suffix(".tmp")
        temporary_path.write_text(
            json.dumps(
                {
                    "session_id": self.session_id,
                    "frame_count": len(self.frames),
                    "frames": self.frames,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        temporary_path.replace(self.checkpoint_path)

    @classmethod
    async def create(
        cls,
        *,
        agent_id: str,
        task_id: str,
        session_id: str,
        frames: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional["SimulatedBrowserRecorder"]:
        if not browser_recordings_enabled():
            return None
        recorder = cls(agent_id=agent_id, task_id=task_id, session_id=session_id, frames=frames)
        recorder.output_dir.mkdir(parents=True, exist_ok=True)
        if not recorder.frames:
            recorder.frames = recorder._load_checkpoint_frames()
        return recorder

    async def record_frame(
        self,
        frame: Any,
        *,
        iteration: int,
        label: str,
        action: str,
        browser_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        normalized = normalize_simulated_browser_frame(frame)
        if normalized is None:
            return None
        entry = {
            **normalized,
            "ts_ms": max(0, int(iteration)) * 500,
            "label": label,
            "action": action,
            "metadata": {
                "step": iteration,
                "url": str((browser_state or {}).get("url") or ""),
                "title": str((browser_state or {}).get("title") or ""),
                "world_model_simulated": True,
            },
        }
        self.frames.append(entry)
        await asyncio.to_thread(self._write_checkpoint)
        return entry

    async def record_observation(
        self,
        *,
        iteration: int,
        browser_state: Dict[str, Any],
        action_entries: List[Dict[str, Any]],
    ) -> None:
        self.observations.append(
            {
                "iteration": iteration,
                "browser_state": _sanitize_observation_value(browser_state),
                "action_count": len(action_entries),
            }
        )

    async def close(
        self,
        *,
        include_steel_media: bool = False,
        archive_artifacts: bool = True,
    ) -> Optional[Path]:
        del include_steel_media
        if not self.frames:
            return None
        self.output_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = self.output_dir / "manifest.json"
        html_path = self.output_dir / "index.html"
        manifest_path.write_text(
            json.dumps(
                {
                    "agent_id": self.agent_id,
                    "task_id": self.task_id,
                    "session_id": self.session_id,
                    "browser_session_metadata": self.session_metadata,
                    "recording_source": "wmh_frames",
                    "frame_count": len(self.frames),
                    "frames": self.frames,
                    "observations": self.observations,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        html_path.write_bytes(self.export_inline_html_bytes() or b"")
        if archive_artifacts:
            await self._archive_recording_artifacts()
        return html_path

    def export_inline_html_bytes(self) -> Optional[bytes]:
        if not self.frames:
            return None
        frames_json = json.dumps(self.frames, ensure_ascii=False).replace("</", "<\\/")
        frame_csp_json = json.dumps(
            '<meta http-equiv="Content-Security-Policy" '
            "content=\"default-src 'none'; img-src data: blob:; "
            "style-src 'unsafe-inline'; font-src data:\">"
        )
        title = html.escape(f"Simulated browser recording {self.task_id}")
        return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>html,body{{margin:0;height:100%;background:#09090b;color:#eee;font:13px sans-serif}}#app{{display:flex;flex-direction:column;height:100%}}header{{display:flex;gap:10px;padding:10px;background:#18181b}}#timeline{{flex:1}}#stage{{position:relative;flex:1;background:white}}#stage img,#stage iframe{{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:contain}}</style></head>
<body><div id="app"><header><button id="play">Play</button><input id="timeline" type="range" min="0" value="0"><span id="meta"></span></header><div id="stage"></div></div>
<script>const frames={frames_json};let index=0,timer=null;const stage=document.getElementById('stage'),range=document.getElementById('timeline'),meta=document.getElementById('meta'),play=document.getElementById('play'),frameCsp={frame_csp_json};range.max=Math.max(0,frames.length-1);function render(i){{index=Math.max(0,Math.min(frames.length-1,Number(i)||0));range.value=String(index);stage.replaceChildren();const frame=frames[index];if(!frame)return;if(frame.kind==='html'){{const el=document.createElement('iframe');el.sandbox='';el.srcdoc=frameCsp+(frame.html||'');stage.appendChild(el)}}else{{const el=document.createElement('img');el.src=frame.src||'';stage.appendChild(el)}}meta.textContent=`${{index+1}}/${{frames.length}} · ${{frame.label||frame.action||'step'}}`;}}range.oninput=()=>render(range.value);play.onclick=()=>{{if(timer){{clearInterval(timer);timer=null;play.textContent='Play';return}}play.textContent='Pause';timer=setInterval(()=>{{if(index>=frames.length-1){{clearInterval(timer);timer=null;play.textContent='Play';return}}render(index+1)}},500)}};render(0);</script></body></html>""".encode()

    async def _archive_recording_artifacts(self) -> bool:
        if not archive_enabled():
            return True
        root_agent_id = current_root_agent_id() or self.agent_id
        return await asyncio.to_thread(self._archive_recording_artifacts_sync, root_agent_id)

    def _archive_recording_artifacts_sync(self, root_agent_id: str) -> bool:
        return _archive_recording_directory(self.output_dir, root_agent_id, self.task_id)

    def archive_recording_artifacts_in_background(self, *, cleanup_after: bool = False) -> bool:
        return _schedule_background_recording_archive(self, cleanup_after=cleanup_after)

    def cleanup_local_artifacts(self, *, persisted: bool = False, force: bool = False) -> None:
        if (persisted or force) and cleanup_local_recording_artifacts_enabled():
            shutil.rmtree(self.output_dir, ignore_errors=True)


class BrowserAgentRecorder:
    def __init__(
        self,
        *,
        page: Any,
        agent_id: str,
        task_id: str,
        session_id: str,
        browser_url: str,
        session_metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.page = page
        self.agent_id = agent_id
        self.task_id = task_id
        self.session_id = session_id
        self.browser_url = browser_url
        self.session_metadata = session_metadata or {}
        # Kernel-native replay: when the session runs on Kernel we reuse its built-in
        # video replay (start/stop API -> hosted view URL) instead of screenshotting
        # every ~2s and uploading a self-contained HTML player to Supabase. In this
        # mode the screenshot/observation capture is a no-op and the FE renders the
        # `recording_view_url` directly (see _finalize_kernel_replay_for_fe).
        self.uses_kernel_replay = (
            self.session_metadata.get("provider") == "kernel"
            and bool(session_id)
            and kernel_replay_enabled()
            and _kernel_replay_headers() is not None
        )
        self._kernel_replay_id: Optional[str] = None
        self.recording_view_url: Optional[str] = None
        # One replay per Kernel session. Challenge recovery can replace the current
        # browser session (and sometimes the provider), so a single replay would only
        # ever capture the first session. We retain every Kernel segment and, if the
        # run later moves to screenshot capture, prepend those videos to the single
        # HTML replay so the BrowserAgentChip still shows the whole tool call.
        self._replay_segments: List[Dict[str, Any]] = []
        self.output_dir = browser_recording_output_dir(agent_id, task_id)
        self.frames_dir = self.output_dir / "frames"
        self.media_dir = self.output_dir / "media"
        self.observations_dir = self.output_dir / "observations"
        self.frames: List[Dict[str, Any]] = []
        self.observations: List[Dict[str, Any]] = []
        self.cursor_events: List[Dict[str, int]] = []
        self._started_at = time.monotonic()
        # Wall-clock start of this activity's recording. A pause/resume saves one
        # recording per activity; the FE orders and places the parts by it.
        self.started_at = datetime.now(timezone.utc).isoformat()
        self._frame_index = 0
        self._closed = False
        _initialize_archive_owner(self)
        self._consecutive_failures = 0
        # Capture-health summary for the manifest/close log: idle screenshot
        # failures are otherwise silent, so a replay with a multi-minute hole
        # could not be told apart from an idle browser.
        self._capture_failure_count = 0
        self._mark_capture_drop_count = 0
        self._last_capture_error: Optional[str] = None
        self._last_frame_ms = 0
        self._longest_frame_gap_ms = 0
        self._longest_frame_gap_start_ms = 0
        self._capture_lock = asyncio.Lock()
        self._loop_task: Optional[asyncio.Task] = None
        self._mark_tasks: set[asyncio.Task] = set()
        self._cursor: Optional[Dict[str, int]] = None
        self._last_label = "idle"
        self._last_metadata: Dict[str, Any] = {}
        self._final_screenshot_path: Optional[Path] = None
        self.interval_seconds = max(1 / 30, float(os.getenv("BROWSER_AGENT_RECORDING_INTERVAL_SECONDS", "2")))
        self.render_fps = max(1, int(os.getenv("BROWSER_AGENT_RECORDING_RENDER_FPS", "30")))
        self.max_frames = max(1, int(os.getenv("BROWSER_AGENT_RECORDING_MAX_FRAMES", "900")))

    async def abort_local(self, *, settle_timeout: float) -> bool:
        """Stop only this recorder's local work; never finalize provider media."""
        return await _abort_recording_local(
            self, [self._loop_task, *self._mark_tasks], settle_timeout=settle_timeout
        )

    def set_cursor(self, x: int, y: int) -> None:
        """Update replay cursor position without forcing a screenshot capture."""
        if self.uses_kernel_replay:
            return
        cursor = {"x": int(x), "y": int(y)}
        self._cursor = cursor
        self.cursor_events.append(
            {
                "ts_ms": int((time.monotonic() - self._started_at) * 1000),
                "x": cursor["x"],
                "y": cursor["y"],
            }
        )

    @classmethod
    async def create(
        cls,
        *,
        page: Any,
        agent_id: str,
        task_id: Optional[str],
        session_id: Optional[str],
        browser_url: Optional[str],
        session_metadata: Optional[Dict[str, Any]] = None,
        register_local_owner: Optional[Callable[[Any], None]] = None,
    ) -> Optional["BrowserAgentRecorder"]:
        if not task_id or not session_id:
            return None
        replay_possible = (
            (session_metadata or {}).get("provider") == "kernel"
            and kernel_replay_enabled()
            and _kernel_replay_headers() is not None
        )
        if not browser_recordings_enabled() and not replay_possible:
            return None
        # Screenshot mode needs a screenshot-capable page; replay mode doesn't.
        if not hasattr(page, "screenshot") and not replay_possible:
            return None
        recorder = cls(
            page=page,
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            browser_url=browser_url or "",
            session_metadata=session_metadata,
        )
        if register_local_owner is not None:
            register_local_owner(recorder)
        try:
            await recorder.start()
        except Exception as exc:
            logger.warning(
                "Browser agent recording failed to start",
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                error=str(exc),
            )
            recorder.cleanup_local_artifacts(force=True)
            return None
        return recorder

    async def start(self) -> None:
        if self.uses_kernel_replay:
            await self._start_kernel_replay()
            return
        self.frames_dir.mkdir(parents=True, exist_ok=True)
        await self.capture("recording started", action="start", force=True)
        self._loop_task = asyncio.create_task(self._capture_loop())
        logger.info(
            "Browser agent recording started",
            agent_id=self.agent_id,
            task_id=self.task_id,
            output_dir=str(self.output_dir),
        )

    async def _start_kernel_replay(self) -> None:
        """Start Kernel's native session replay. On any failure we raise so
        ``create()`` returns None and emits no recording — we do NOT fall back to
        the half-initialized screenshot+Supabase path this change intentionally
        drops (finalization would otherwise try to write frames to a directory
        that was never created)."""
        headers = _kernel_replay_headers()
        if headers is None:
            raise RuntimeError("Kernel replay requested but KERNEL_API_KEY is unavailable")
        framerate = max(1, int(os.getenv("BROWSER_AGENT_KERNEL_REPLAY_FRAMERATE", "10")))
        url = f"{_kernel_api_base()}/browsers/{self.session_id}/replays"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(url, headers=headers, json={"framerate": framerate})
                response.raise_for_status()
                data = response.json()
            self._kernel_replay_id = data.get("replay_id")
            self.recording_view_url = data.get("replay_view_url")
            # Record this session's segment. The start-time view URL is valid even
            # before stop and survives session eviction, so a segment stays playable
            # after rotate_ip tears its session down. Segment order == rotation order.
            if self.recording_view_url:
                self._replay_segments.append(
                    {
                        "session_id": self.session_id,
                        "replay_id": self._kernel_replay_id,
                        "view_url": self.recording_view_url,
                    }
                )
            logger.info(
                "Kernel replay recording started",
                agent_id=self.agent_id,
                task_id=self.task_id,
                session_id=self.session_id,
                replay_id=self._kernel_replay_id,
                segment_index=len(self._replay_segments) - 1,
            )
        except Exception as exc:  # noqa: BLE001 — surface to create(), which returns None
            logger.warning(
                "Kernel replay start failed; run will have no recording",
                agent_id=self.agent_id,
                task_id=self.task_id,
                session_id=self.session_id,
                error=str(exc)[:300],
            )
            self.uses_kernel_replay = False
            self._kernel_replay_id = None
            self.recording_view_url = None
            raise

    async def rotate_kernel_replay(self, new_session_id: str) -> None:
        """Follow a Kernel session swap: finalize the current session's replay
        segment and start a fresh one on the rotated session.

        rotate_ip evicts the current Kernel session and stands up a new one on a
        different exit IP. A single replay pinned to the original session would
        only ever show the first IP — the recording would look like the IP never
        changed. We therefore keep one replay per session: the old segment's
        start-time view URL is already captured (and survives eviction), so we just
        start a new replay on ``new_session_id`` and append its segment. Best-effort
        throughout — recording must never break the browser run."""
        if not self.uses_kernel_replay or not new_session_id or new_session_id == self.session_id:
            return
        # Best-effort stop of the outgoing session's replay so Kernel finalizes it
        # promptly. The session is usually already evicted by the backend rotation;
        # its persisted replay (and the start-time URL we saved) survive regardless.
        headers = _kernel_replay_headers()
        if headers is not None and self._kernel_replay_id:
            with contextlib.suppress(Exception):
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{_kernel_api_base()}/browsers/{self.session_id}/replays/{self._kernel_replay_id}/stop",
                        headers=headers,
                    )
        # Rebind to the new session and start a fresh replay segment.
        self.session_id = new_session_id
        self._kernel_replay_id = None
        self.recording_view_url = None
        try:
            await self._start_kernel_replay()
        except Exception as exc:  # noqa: BLE001 — a failed segment must not break the run
            logger.warning(
                "Kernel replay failed to start on rotated session; recording will miss this segment",
                agent_id=self.agent_id,
                task_id=self.task_id,
                session_id=new_session_id,
                error=str(exc)[:300],
            )
            # Keep uses_kernel_replay True: earlier segments are still valid and must
            # be finalized. _start_kernel_replay flipped it off on failure; restore.
            self.uses_kernel_replay = True

    async def transition_browser(
        self,
        *,
        page: Any,
        session_id: str,
        browser_url: str,
        session_metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Move one task recording onto a promoted recovery session.

        Kernel -> Kernel starts another native replay segment. Kernel -> Steel
        finalizes the outgoing native segment, then resumes screenshot capture on
        the promoted page; the HTML player prepends the retained Kernel video(s).
        Once screenshot capture has begun, later Steel/Kernel transitions stay in
        screenshot mode so one frame timeline remains continuous.

        The handoff is deliberately best-effort at the caller: recording must never
        break challenge recovery, but a provider transition must not silently close
        an otherwise healthy recorder.
        """
        next_metadata = dict(session_metadata or {})
        next_provider = next_metadata.get("provider")

        if self.uses_kernel_replay and next_provider == "kernel":
            self.page = page
            self.browser_url = browser_url
            self.session_metadata = next_metadata
            await self.rotate_kernel_replay(session_id)
            return

        if self.uses_kernel_replay:
            # Finalize only the outgoing provider-native segment. The logical task
            # recorder remains open and changes capture mode exactly once; terminal
            # closure is owned by close()/the FE finalizer.
            await self._finalize_kernel_replay_segment()
            self.uses_kernel_replay = False
            self._kernel_replay_id = None
            self.recording_view_url = None
            # Screenshot capture starts here; the Kernel video covers the rest.
            self._last_frame_ms = self._elapsed_ms()
        elif self._closed:
            logger.warning(
                "Ignoring browser recording transition after finalization",
                agent_id=self.agent_id,
                task_id=self.task_id,
                session_id=session_id,
            )
            return

        # Queued marks carry the outgoing session's label/metadata; let them
        # capture the outgoing page before it is replaced.
        await self.flush_marks()
        self.page = page
        self.session_id = session_id
        self.browser_url = browser_url
        self.session_metadata = next_metadata
        self.frames_dir.mkdir(parents=True, exist_ok=True)
        await self.capture("browser session changed", action="recovery", force=True)
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._capture_loop())

    @property
    def replay_view_urls(self) -> List[str]:
        """All per-session replay view URLs in rotation order (baseline first)."""
        return [seg["view_url"] for seg in self._replay_segments if seg.get("view_url")]

    async def _run_ffmpeg_concat(self, ffmpeg_path: str, list_file: Path, out_path: Path, *, copy: bool) -> bool:
        args = [
            ffmpeg_path,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_file),
        ]
        # -c copy is instant but needs uniform codecs across segments; the re-encode
        # fallback guarantees one clean stream regardless of per-segment timebase.
        args += ["-c", "copy"] if copy else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an"]
        args += ["-movflags", "+faststart", str(out_path)]
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(list_file.parent),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await process.communicate()
        if process.returncode != 0:
            logger.debug(
                "ffmpeg replay concat failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                copy=copy,
                error=stderr.decode("utf-8", errors="replace")[:500],
            )
            return False
        return out_path.exists() and out_path.stat().st_size > 0

    async def stitch_segments_to_mp4(self) -> Optional[bytes]:
        """Concatenate every per-session replay segment into ONE continuous MP4.

        rotate_ip records one Kernel replay per session (baseline + one per
        rotation), each on a different exit IP. This downloads them all and stitches
        them into a single video so the FE plays one continuous recording of the IP
        changing — not a playlist. Returns the stitched bytes, or None (ffmpeg
        missing / a download or concat failure) so the caller can fall back to the
        per-segment URL list."""
        urls = self.replay_view_urls
        if len(urls) < 2:
            return None
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            logger.warning(
                "ffmpeg unavailable; cannot stitch replay segments into one video",
                agent_id=self.agent_id,
                task_id=self.task_id,
                segment_count=len(urls),
            )
            return None
        with tempfile.TemporaryDirectory(prefix="rose-replay-stitch-") as tmp:
            tmp_dir = Path(tmp)
            seg_paths: List[Path] = []
            try:
                async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
                    for index, url in enumerate(urls):
                        # The freshly-stopped last segment can lag S3 availability;
                        # retry briefly so the final rotation isn't dropped.
                        last_exc: Optional[Exception] = None
                        for attempt in range(3):
                            try:
                                response = await client.get(url)
                                response.raise_for_status()
                                if not response.content:
                                    raise RuntimeError("empty replay body")
                                break
                            except Exception as exc:  # noqa: BLE001 — retry transient S3 lag
                                last_exc = exc
                                await asyncio.sleep(1.5 * (attempt + 1))
                        else:
                            raise last_exc or RuntimeError("segment download failed")
                        seg_path = tmp_dir / f"seg_{index:03d}.mp4"
                        seg_path.write_bytes(response.content)
                        seg_paths.append(seg_path)
            except Exception as exc:  # noqa: BLE001 — fall back to the segment URL list
                logger.warning(
                    "Replay segment download failed; skipping stitch",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    error=str(exc)[:300],
                )
                return None
            list_file = tmp_dir / "segments.txt"
            list_file.write_text("".join(f"file '{p.name}'\n" for p in seg_paths), encoding="utf-8")
            out_path = tmp_dir / "stitched.mp4"
            stitched = await self._run_ffmpeg_concat(ffmpeg_path, list_file, out_path, copy=True)
            if not stitched:
                stitched = await self._run_ffmpeg_concat(ffmpeg_path, list_file, out_path, copy=False)
            if not stitched:
                return None
            data = out_path.read_bytes()
            logger.info(
                "Replay segments stitched into one video",
                agent_id=self.agent_id,
                task_id=self.task_id,
                segment_count=len(seg_paths),
                bytes=len(data),
            )
            return data

    async def _finalize_kernel_replay_segment(self) -> Optional[str]:
        """Finalize the current Kernel-native segment without closing the task recorder.

        Tolerant of the browser session already being torn down: the persisted
        replay survives session deletion, so we stop best-effort, then re-read the
        view URL from list(); on any failure we fall back to the start-time URL
        (which is valid even pre-stop)."""
        headers = _kernel_replay_headers()
        if headers is None or not self.session_id:
            return self.recording_view_url
        base = _kernel_api_base()
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                if self._kernel_replay_id:
                    try:
                        stop_response = await client.post(
                            f"{base}/browsers/{self.session_id}/replays/{self._kernel_replay_id}/stop",
                            headers=headers,
                        )
                        stop_response.raise_for_status()
                    except Exception as exc:  # noqa: BLE001 — best-effort stop
                        logger.warning(
                            "Kernel replay stop failed; reading persisted replay anyway",
                            agent_id=self.agent_id,
                            task_id=self.task_id,
                            error=str(exc)[:300],
                        )
                response = await client.get(f"{base}/browsers/{self.session_id}/replays", headers=headers)
                response.raise_for_status()
                replays = response.json() or []
            # Match ONLY this run's replay by id — never substitute replays[0], which
            # could publish an unrelated (older session) replay's JWT URL as ours. If
            # our id isn't in the list, keep the start-time view URL (valid pre-stop).
            match = next(
                (item for item in replays if item.get("replay_id") == self._kernel_replay_id),
                None,
            )
            if match and match.get("replay_view_url"):
                self.recording_view_url = match["replay_view_url"]
                # Keep the current (last) segment's URL in sync with the finalized one.
                for seg in reversed(self._replay_segments):
                    if seg.get("replay_id") == self._kernel_replay_id:
                        seg["view_url"] = match["replay_view_url"]
                        break
        except Exception as exc:  # noqa: BLE001 — fall back to start-time view URL
            logger.warning(
                "Kernel replay list failed; using start-time view URL",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc)[:300],
            )
        logger.info(
            "Kernel replay recording stopped",
            agent_id=self.agent_id,
            task_id=self.task_id,
            replay_id=self._kernel_replay_id,
            has_view_url=bool(self.recording_view_url),
        )
        return self.recording_view_url

    async def stop_kernel_replay(self) -> Optional[str]:
        """Terminally close the logical recorder after its final Kernel segment."""
        if self._closed:
            return self.recording_view_url
        self._closed = True
        return await self._finalize_kernel_replay_segment()

    async def _active_page(self):
        """Return the foreground/active tab so the recording FOLLOWS tab switches
        (e.g. an "order ahead" link that opens the merchant in a NEW tab). The
        fixed self.page reference would otherwise pin the recording to tab 1 and
        every multi-tab flow would look stuck on the first page."""
        try:
            pages = list(self.page.context.pages)
        except Exception:
            return self.page
        if not pages:
            return self.page
        if len(pages) == 1:
            return pages[0]
        # Prefer the visible (non-hidden) tab; check newest-first since a freshly
        # opened tab (the usual active one) is appended at the end. Bounded evals
        # so a frozen renderer can't stall the capture loop.
        for candidate in reversed(pages):
            try:
                hidden = await asyncio.wait_for(candidate.evaluate("document.hidden"), timeout=1.0)
                if not hidden:
                    return candidate
            except Exception:
                continue
        return pages[-1]

    def _elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started_at) * 1000)

    def _note_frame_gap(self, ts_ms: int) -> None:
        if ts_ms - self._last_frame_ms > self._longest_frame_gap_ms:
            self._longest_frame_gap_ms = ts_ms - self._last_frame_ms
            self._longest_frame_gap_start_ms = self._last_frame_ms
        self._last_frame_ms = ts_ms

    async def _capture_loop(self) -> None:
        while not self._closed:
            # Back off when the renderer is frozen by a bot-challenge: each failed
            # screenshot already blocks ~5s (Playwright timeout), so hammering every
            # interval just spams failures and contends on the frozen CDP channel.
            # Grow the gap exponentially while failing (cap ~16x), snap back on success.
            backoff = min(2**self._consecutive_failures, 16)
            await asyncio.sleep(self.interval_seconds * backoff)
            await self.capture(self._last_label, action="idle")

    async def mark(
        self,
        label: str,
        *,
        action: str = "action",
        cursor: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        force: bool = True,
    ) -> None:
        if cursor and cursor.get("x") is not None and cursor.get("y") is not None:
            self.set_cursor(int(cursor["x"]), int(cursor["y"]))
        self._last_label = label
        next_metadata = dict(metadata or {})
        if self._cursor and "cursor" not in next_metadata:
            next_metadata["cursor"] = dict(self._cursor)
        self._last_metadata = next_metadata
        if self.uses_kernel_replay or self._closed:
            return
        # Marks run twice per browser step. Awaiting even a bounded screenshot
        # here added up to ~400ms to every step on screenshot-replay sessions,
        # so the frame is captured alongside the action; the capture lock keeps
        # frames in mark order and close() drains in-flight marks.
        task = asyncio.create_task(self._bounded_mark_capture(label, action, next_metadata, force))
        self._mark_tasks.add(task)
        task.add_done_callback(self._mark_tasks.discard)

    async def flush_marks(self) -> None:
        if self._mark_tasks:
            await asyncio.gather(*list(self._mark_tasks), return_exceptions=True)

    async def _bounded_mark_capture(self, label: str, action: str, metadata: Dict[str, Any], force: bool) -> None:
        # A slow diagnostic screenshot is dropped; the background loop and
        # observations cover those gaps. Count the drops: on a slow provider
        # every per-step frame lands here.
        try:
            await asyncio.wait_for(
                self.capture(label, action=action, metadata=metadata, force=force),
                timeout=0.2,
            )
        except asyncio.TimeoutError:
            self._mark_capture_drop_count += 1
        except Exception:
            pass

    async def _screenshot_bytes(self, *, allow_slow_fallback: bool) -> tuple[bytes, str]:
        # Forced lifecycle frames get the full budget; best-effort idle frames use
        # a short timeout so a slow page.screenshot (fonts/stability wait) can't
        # stall the capture loop and block a later forced frame behind the lock.
        timeout_ms = 2500 if allow_slow_fallback else 1200
        active_page = await self._active_page()
        image_bytes = await active_page.screenshot(
            type="jpeg",
            quality=55,
            full_page=False,
            timeout=timeout_ms,
        )
        try:
            active_url = active_page.url or ""
        except Exception:
            active_url = ""
        return image_bytes, active_url

    async def capture(
        self,
        label: str,
        *,
        action: str,
        metadata: Optional[Dict[str, Any]] = None,
        force: bool = False,
    ) -> None:
        # Recording is best-effort diagnostics. A missing /tmp scratch dir,
        # mid-run cleanup, or write failure must NEVER abort the browser agent
        # (prod purchase fleet died on FileNotFoundError during post-click mark).
        if self.uses_kernel_replay or self._closed or len(self.frames) >= self.max_frames:
            return
        async with self._capture_lock:
            if self._closed or len(self.frames) >= self.max_frames:
                return
            active_url = ""
            try:
                image_bytes, active_url = await self._screenshot_bytes(allow_slow_fallback=force)
                self._consecutive_failures = 0
            except Exception as exc:
                self._consecutive_failures += 1
                self._capture_failure_count += 1
                self._last_capture_error = str(exc)[:300]
                if force:
                    logger.warning(
                        "Browser agent recording frame capture failed",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        error=str(exc),
                    )
                return

            self._frame_index += 1
            filename = f"frame_{self._frame_index:05d}.jpg"
            frame_path = self.frames_dir / filename
            try:
                self.frames_dir.mkdir(parents=True, exist_ok=True)
                frame_path.write_bytes(image_bytes)
            except OSError as exc:
                self._consecutive_failures += 1
                self._capture_failure_count += 1
                self._last_capture_error = str(exc)[:300]
                logger.warning(
                    "Browser agent recording frame write failed",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    frame=filename,
                    error=str(exc),
                )
                return
            ts_ms = self._elapsed_ms()
            self._note_frame_gap(ts_ms)
            self.frames.append(
                {
                    "src": f"frames/{filename}",
                    "ts_ms": ts_ms,
                    "label": label,
                    "action": action,
                    "cursor": self._cursor,
                    "tab_url": active_url,
                    "metadata": dict(metadata if metadata is not None else self._last_metadata),
                    "size": len(image_bytes),
                }
            )

    async def record_observation(
        self,
        *,
        iteration: int,
        browser_state: Dict[str, Any],
        action_entries: List[Dict[str, Any]],
    ) -> Optional[Path]:
        if self.uses_kernel_replay or self._closed:
            return None
        self.observations_dir.mkdir(parents=True, exist_ok=True)
        filename = f"iteration_{int(iteration):04d}.json"
        path = self.observations_dir / filename
        payload = {
            "iteration": int(iteration),
            "ts_ms": int((time.monotonic() - self._started_at) * 1000),
            "browser_state": _sanitize_observation_value(browser_state),
            "action_entries": _sanitize_observation_value(action_entries),
        }
        path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        self.observations.append({"iteration": int(iteration), "path": f"observations/{filename}"})
        return path

    async def write_final_screenshot(self, screenshot_b64: str) -> Optional[Path]:
        if self.uses_kernel_replay or self._closed or not screenshot_b64:
            return None
        try:
            data = screenshot_b64.split(",", 1)[1] if "," in screenshot_b64[:80] else screenshot_b64
            image_bytes = base64.b64decode(data)
            path = self.output_dir / "final-screenshot.png"
            path.write_bytes(image_bytes)
            self._final_screenshot_path = path
            return path
        except Exception as exc:  # noqa: BLE001 - screenshot archive is best-effort
            logger.debug(
                "Browser agent final screenshot artifact failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc)[:300],
            )
            return None

    async def close(
        self,
        *,
        include_steel_media: bool = True,
        archive_artifacts: bool = True,
    ) -> Optional[Path]:
        # Kernel replay mode never produces a local HTML player; finalization goes
        # through stop_kernel_replay() + recording_view_url instead. Guard here so a
        # generic close() caller can't trigger screenshot/Steel finalization.
        if self.uses_kernel_replay:
            await self.stop_kernel_replay()
            return None
        if self._closed:
            existing_path = self.output_dir / "index.html"
            return existing_path if existing_path.exists() else None
        await self.flush_marks()
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await asyncio.wait_for(self._loop_task, timeout=3)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        try:
            # A short task may finish before the background loop samples its
            # final action; keep that label on the terminal frame.
            final_label = self._last_label if self._last_label != "idle" else "recording stopped"
            await asyncio.wait_for(self.capture(final_label, action="stop", force=True), timeout=7)
        except asyncio.TimeoutError:
            self._capture_failure_count += 1
            self._last_capture_error = "final frame capture timed out after 7s"
            logger.warning(
                "Browser agent recording final frame capture timed out",
                agent_id=self.agent_id,
                task_id=self.task_id,
                existing_frames=len(self.frames),
            )
        self._closed = True
        frame_cap_reached = len(self.frames) >= self.max_frames
        if self.frames and not frame_cap_reached:
            # The tail after the last frame is a capture hole too; measure it
            # before the optional Steel media download. After the frame cap,
            # capture stops by design, so that tail is not a hole.
            self._note_frame_gap(self._elapsed_ms())
        steel_media = await self._download_steel_hls_recording() if include_steel_media else None
        if not self.frames and not steel_media and not self.replay_view_urls:
            return None
        source_frame_count = len(self.frames)
        playback_frames = self._build_playback_frames() if self.frames else []
        manifest_path = self.output_dir / "manifest.json"
        html_path = self.output_dir / "index.html"
        final_dom_path = await self._write_final_dom_artifact()
        recording_source = "steel_hls" if steel_media else "screenshot_replay" if self.frames else "kernel_replay"
        manifest_path.write_text(
            json.dumps(
                {
                    "agent_id": self.agent_id,
                    "task_id": self.task_id,
                    "session_id": self.session_id,
                    "browser_url": redact_url_secrets(self.browser_url),
                    "browser_session_metadata": self.session_metadata,
                    "recording_source": recording_source,
                    "steel_recording": steel_media,
                    "final_dom_path": "final-dom.html" if final_dom_path else None,
                    "final_screenshot_path": "final-screenshot.png" if self._final_screenshot_path else None,
                    "observation_count": len(self.observations),
                    "observations": self.observations,
                    "frame_count": len(playback_frames),
                    "source_frame_count": source_frame_count,
                    "capture_failure_count": self._capture_failure_count,
                    "mark_capture_drop_count": self._mark_capture_drop_count,
                    "frame_cap_reached": frame_cap_reached,
                    "last_capture_error": self._last_capture_error,
                    "longest_frame_gap_ms": self._longest_frame_gap_ms,
                    "longest_frame_gap_start_ms": self._longest_frame_gap_start_ms,
                    "render_fps": self.render_fps,
                    "frames": playback_frames,
                    "cursor_events": self.cursor_events,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        # Use the real captured frames (self.frames) for the screenshot replay —
        # _build_playback_frames currently collapses every entry to frame_00001,
        # which made recordings show only the pre-nav splash. The player plays
        # frames uniformly (skip-idle), so real per-frame timing isn't required.
        html_path.write_text(
            self._build_steel_video_html(steel_media) if steel_media else self._build_html(self.frames),
            encoding="utf-8",
        )
        logger.info(
            "Browser agent recording saved",
            agent_id=self.agent_id,
            task_id=self.task_id,
            html_path=str(html_path),
            frame_count=len(playback_frames),
            source_frame_count=source_frame_count,
            recording_source=recording_source,
            capture_failure_count=self._capture_failure_count,
            mark_capture_drop_count=self._mark_capture_drop_count,
            frame_cap_reached=frame_cap_reached,
            last_capture_error=self._last_capture_error,
            longest_frame_gap_ms=self._longest_frame_gap_ms,
            longest_frame_gap_start_ms=self._longest_frame_gap_start_ms,
        )
        if archive_artifacts:
            await self._archive_recording_artifacts()
        return html_path

    async def _write_final_dom_artifact(self) -> Optional[Path]:
        if not hasattr(self.page, "content"):
            return None
        try:
            dom = await asyncio.wait_for(self.page.content(), timeout=5)
            path = self.output_dir / "final-dom.html"
            path.write_text(dom, encoding="utf-8")
            return path
        except Exception as exc:  # noqa: BLE001 - recording must not fail browser runs
            logger.debug(
                "Browser agent final DOM capture failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc)[:300],
            )
            return None

    async def _archive_recording_artifacts(self) -> bool:
        if _archive_owner_aborted(self):
            return False
        if not archive_enabled():
            return True
        archive_root_agent_id = current_root_agent_id() or self.agent_id
        return await asyncio.to_thread(self._archive_recording_artifacts_sync, archive_root_agent_id)

    def _archive_recording_artifacts_sync(self, archive_root_agent_id: str) -> bool:
        try:
            return _archive_recording_directory(self.output_dir, archive_root_agent_id, self.task_id, owner=self)
        except Exception as exc:  # noqa: BLE001 - archive is best-effort
            logger.warning(
                "Browser agent recording archive failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc)[:300],
            )
            return False

    def archive_recording_artifacts_in_background(self, *, cleanup_after: bool = False) -> bool:
        """Copy trace artifacts only after the FE pointer is durable."""
        return _schedule_background_recording_archive(self, cleanup_after=cleanup_after)

    def cleanup_local_artifacts(self, *, persisted: bool = False, force: bool = False) -> None:
        if not persisted and not force:
            return
        if not cleanup_local_recording_artifacts_enabled():
            return
        try:
            shutil.rmtree(self.output_dir, ignore_errors=False)
            logger.info(
                "Browser agent local recording scratch cleaned up",
                agent_id=self.agent_id,
                task_id=self.task_id,
                output_dir=str(self.output_dir),
            )
        except FileNotFoundError:
            return
        except Exception as exc:  # noqa: BLE001 - cleanup must not fail browser runs
            logger.warning(
                "Browser agent local recording scratch cleanup failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                output_dir=str(self.output_dir),
                error=str(exc)[:300],
            )

    def export_inline_html_bytes(self) -> Optional[bytes]:
        """Build a SINGLE self-contained replay HTML with every frame inlined as a
        base64 data URI, so it can be uploaded to Supabase Storage and iframed by
        the front-end without any sibling assets. Retained Kernel replay URLs
        also remain playable when a promoted session captures no frames."""
        if not self.frames and not self.replay_view_urls:
            return None
        # Inline the REAL captured frames (self.frames), NOT _build_playback_frames()
        # — the latter collapses every entry to frame_00001, so inlining it produced
        # ~frame_count base64 copies of ONE image (e.g. 900 dupes → ~90MB HTML) which
        # blew past the storage upload and failed silently. Dedupe by src so each
        # distinct jpg is base64'd once; the frame-based player stays compact + plays
        # frame-by-frame in the FE (no 132MB Steel-MP4 decode dependency).
        cache: Dict[str, str] = {}
        inlined: List[Dict[str, Any]] = []
        # Upload the real captured frames once each. _build_playback_frames()
        # expands sparse screenshots to video-rate playback, which can duplicate
        # a handful of frames hundreds of times and allocate huge base64 HTML.
        for frame in self.frames:
            src = frame.get("src", "")
            frame_copy = dict(frame)
            if isinstance(src, str) and src.startswith("frames/"):
                data_uri = cache.get(src)
                if data_uri is None:
                    try:
                        raw = (self.output_dir / src).read_bytes()
                        data_uri = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
                    except Exception:  # noqa: BLE001 — keep relative src if a frame file is missing
                        data_uri = src
                    cache[src] = data_uri
                frame_copy["src"] = data_uri
            inlined.append(frame_copy)
        return self._build_html(inlined).encode("utf-8")

    async def _download_steel_hls_recording(self) -> Optional[Dict[str, Any]]:
        if self.session_metadata.get("provider") != "steel":
            return None
        api_key = os.getenv("STEEL_API_KEY")
        if not api_key or not self.session_id:
            return None

        hls_url = steel_api_url(f"v1/sessions/{self.session_id}/hls")
        self.media_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = self.media_dir / "recording.m3u8"
        mp4_path = self.media_dir / "recording.mp4"
        hls_js_source = Path(__file__).resolve().parents[3] / "node_modules" / "hls.js" / "dist" / "hls.min.js"
        hls_js_path = self.media_dir / "hls.min.js"
        if hls_js_source.exists() and not hls_js_path.exists():
            shutil.copyfile(hls_js_source, hls_js_path)

        max_wait_seconds = max(0.0, float(os.getenv("BROWSER_AGENT_STEEL_HLS_WAIT_SECONDS", "12")))
        deadline = time.monotonic() + max_wait_seconds
        playlist_text: Optional[str] = None
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            while True:
                try:
                    response = await client.get(hls_url, headers={"steel-api-key": api_key})
                    if response.status_code == 200 and "#EXTM3U" in response.text:
                        playlist_text = response.text
                        break
                    logger.debug(
                        "Steel HLS recording not ready",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        session_id=self.session_id,
                        status=response.status_code,
                        body=response.text[:160],
                    )
                except Exception as exc:
                    logger.debug(
                        "Steel HLS recording fetch failed",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        session_id=self.session_id,
                        error=str(exc),
                    )
                if time.monotonic() >= deadline:
                    return None
                await asyncio.sleep(1)

            assert playlist_text is not None
            rewritten_lines: List[str] = []
            download_index = 0
            for line in playlist_text.splitlines():
                stripped = line.strip()
                if not stripped:
                    rewritten_lines.append(line)
                    continue
                map_match = re.search(r'URI="([^"]+)"', line)
                if map_match:
                    map_url = urljoin(hls_url, map_match.group(1))
                    local_name = f"part_{download_index:05d}{_media_extension(map_url, '.mp4')}"
                    download_index += 1
                    await _download_media_file(client, map_url, self.media_dir / local_name)
                    rewritten_lines.append(line.replace(map_match.group(1), local_name))
                    continue
                if stripped.startswith("#"):
                    rewritten_lines.append(line)
                    continue
                media_url = urljoin(hls_url, stripped)
                local_name = f"part_{download_index:05d}{_media_extension(media_url, '.m4s')}"
                download_index += 1
                await _download_media_file(client, media_url, self.media_dir / local_name)
                rewritten_lines.append(local_name)

        playlist_path.write_text("\n".join(rewritten_lines) + "\n", encoding="utf-8")
        mp4_created = await _mux_hls_to_mp4(playlist_path, mp4_path)
        return {
            "kind": "steel_hls",
            "hls_path": str(playlist_path),
            "hls_src": f"media/{playlist_path.name}",
            "mp4_path": str(mp4_path) if mp4_created else None,
            "mp4_src": f"media/{mp4_path.name}" if mp4_created else None,
            "hls_js_src": f"media/{hls_js_path.name}" if hls_js_path.exists() else None,
            "segment_count": download_index,
        }

    def _cursor_at_time(self, ts_ms: int) -> Optional[Dict[str, int]]:
        if not self.cursor_events:
            return None
        previous = self.cursor_events[0]
        for event in self.cursor_events[1:]:
            if event["ts_ms"] >= ts_ms:
                span = max(1, event["ts_ms"] - previous["ts_ms"])
                t = max(0.0, min(1.0, (ts_ms - previous["ts_ms"]) / span))
                return {
                    "x": int(round(previous["x"] + (event["x"] - previous["x"]) * t)),
                    "y": int(round(previous["y"] + (event["y"] - previous["y"]) * t)),
                }
            previous = event
        return {"x": int(previous["x"]), "y": int(previous["y"])}

    def _build_playback_frames(self) -> List[Dict[str, Any]]:
        if len(self.frames) < 2:
            return list(self.frames)
        frame_step_ms = max(1, int(round(1000 / self.render_fps)))
        last_ts = max(frame["ts_ms"] for frame in self.frames)
        if last_ts < frame_step_ms:
            return list(self.frames)
        playback_frames: List[Dict[str, Any]] = []
        source_index = 0
        ts_ms = 0
        while ts_ms <= last_ts and len(playback_frames) < self.max_frames:
            while source_index + 1 < len(self.frames) and self.frames[source_index + 1]["ts_ms"] <= ts_ms:
                source_index += 1
            source = self.frames[source_index]
            frame = dict(source)
            frame["ts_ms"] = ts_ms
            frame["source_ts_ms"] = source["ts_ms"]
            frame["source_frame_index"] = source_index
            frame["playback_frame"] = True
            cursor = self._cursor_at_time(ts_ms)
            if cursor:
                frame["cursor"] = cursor
                metadata = dict(frame.get("metadata") or {})
                metadata["cursor"] = cursor
                frame["metadata"] = metadata
            playback_frames.append(frame)
            ts_ms += frame_step_ms
        if playback_frames and playback_frames[-1]["ts_ms"] < last_ts and len(playback_frames) < self.max_frames:
            source = self.frames[-1]
            frame = dict(source)
            frame["source_ts_ms"] = source["ts_ms"]
            frame["source_frame_index"] = len(self.frames) - 1
            frame["playback_frame"] = True
            playback_frames.append(frame)
        return playback_frames or list(self.frames)

    def _build_html(self, frames: Optional[List[Dict[str, Any]]] = None) -> str:
        playback_frames = frames if frames is not None else self._build_playback_frames()
        cursor_events = list(self.cursor_events)
        # Kernel videos already account for elapsed time before screenshot capture
        # begins. Rebase the screenshot half to zero or real-time playback would
        # hold its first frame for the entire Kernel duration a second time.
        if self.replay_view_urls and playback_frames:
            frame_offset_ms = min(int(frame.get("ts_ms") or 0) for frame in playback_frames)
            playback_frames = [
                {**frame, "ts_ms": max(0, int(frame.get("ts_ms") or 0) - frame_offset_ms)} for frame in playback_frames
            ]
            cursor_events = [
                {**event, "ts_ms": max(0, int(event.get("ts_ms") or 0) - frame_offset_ms)} for event in cursor_events
            ]
        frames_json = json.dumps(playback_frames)
        cursor_events_json = json.dumps(cursor_events)
        prefix_video_urls_json = json.dumps(self.replay_view_urls)
        title = html.escape(f"Browser recording {self.task_id}")
        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    html, body {{ margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0b0c; color: #e8e8ea; }}
    #app {{ display: flex; flex-direction: column; height: 100vh; }}
    header {{ display: flex; gap: 14px; align-items: center; padding: 10px 14px; background: #161618; border-bottom: 1px solid #232327; }}
    button, select {{ font: inherit; background: #232327; color: #fff; border: 1px solid #34343a; border-radius: 8px; padding: 6px 12px; cursor: pointer; }}
    button:hover, select:hover {{ background: #2c2c31; }}
    label {{ font-size: 13px; color: #b5b5bd; display: flex; align-items: center; gap: 6px; }}
    #play {{ min-width: 76px; font-weight: 600; }}
    #timeline {{ flex: 1; accent-color: #6aa7ff; }}
    #time {{ font-variant-numeric: tabular-nums; font-size: 12px; color: #9a9aa3; min-width: 58px; text-align: right; }}
    #stage {{ flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 4px; background: #050506; }}
    canvas, #prefixVideo {{ max-width: 100%; max-height: 100%; }}
    #prefixVideo {{ width: 100%; height: 100%; background: #050506; }}
  </style>
</head>
<body>
  <div id="app">
    <header>
      <button id="play">Play</button>
      <label>Speed <select id="speed"><option>1</option><option>2</option><option selected>4</option><option>8</option></select>x</label>
      <label><input id="skipIdle" type="checkbox" checked> skip idle</label>
      <input id="timeline" type="range" min="0" max="0" value="0">
      <span id="time"></span>
    </header>
    <div id="stage"><video id="prefixVideo" controls muted playsinline hidden></video><canvas id="canvas"></canvas></div>
  </div>
<script>
const frames = {frames_json};
const cursorEvents = {cursor_events_json};
const prefixVideoUrls = {prefix_video_urls_json};
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const prefixVideo = document.getElementById('prefixVideo');
const playBtn = document.getElementById('play');
const speed = document.getElementById('speed');
const skipIdle = document.getElementById('skipIdle');
const timeline = document.getElementById('timeline');
const time = document.getElementById('time');
// skip-idle: play one frame at a time (uniform), dropping the dead gaps — e.g.
// the ~90s bot-challenge freeze where the renderer holds a single frame. Off =
// real capture timestamps.
const FRAME_MS = 500;
function buildEff(skip) {{ return skip ? frames.map((_, i) => i * FRAME_MS) : frames.map((f) => f.ts_ms || 0); }}
let eff = buildEff(skipIdle.checked);
let totalMs = eff.length ? eff[eff.length - 1] : 0;
timeline.max = totalMs;
timeline.step = 1;
let playheadMs = 0;
let playing = false;
let rafId = null;
let lastRafMs = null;
let prefixIndex = 0;
let showingPrefix = false;
const images = frames.map(f => {{ const img = new Image(); img.src = f.src; return img; }});
function normalizeCursor(cursor) {{
  if (!cursor || cursor.x == null || cursor.y == null) return null;
  const x = Number(cursor.x), y = Number(cursor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {{ x, y }};
}}
function frameCursor(frame) {{
  return normalizeCursor(frame.cursor)
    || normalizeCursor(frame.metadata && frame.metadata.cursor)
    || normalizeCursor(frame.metadata && frame.metadata.coordinates);
}}
const firstCursor = cursorEvents[0] || frames.map(frameCursor).find(Boolean) || null;
const cursorByFrame = [];
let lastCursor = firstCursor;
frames.forEach(frame => {{
  const nextCursor = frameCursor(frame);
  if (nextCursor) lastCursor = nextCursor;
  cursorByFrame.push(lastCursor);
}});
function cursorAtTime(tsMs) {{
  if (!cursorEvents.length) return null;
  let lo = 0, hi = cursorEvents.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (cursorEvents[mid].ts_ms <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  if (hi < 0) return cursorEvents[0];
  if (hi >= cursorEvents.length - 1) return cursorEvents[cursorEvents.length - 1];
  const a = cursorEvents[hi], b = cursorEvents[hi + 1];
  const span = Math.max(1, b.ts_ms - a.ts_ms);
  const t = Math.max(0, Math.min(1, (tsMs - a.ts_ms) / span));
  return {{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }};
}}
function frameIndexAtTime(tsMs) {{
  if (!eff.length) return 0;
  let lo = 0, hi = eff.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (eff[mid] <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  return Math.max(0, Math.min(frames.length - 1, hi));
}}
function drawCursor(c) {{
  if (!c) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(6, 17); ctx.lineTo(10, 28); ctx.lineTo(15, 26); ctx.lineTo(11, 15); ctx.lineTo(20, 15); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}}
function renderAt(tsMs) {{
  if (!frames.length) return;
  playheadMs = Math.max(0, Math.min(totalMs, tsMs));
  const idx = frameIndexAtTime(playheadMs);
  const img = images[idx], f = frames[idx];
  const frameEffTs = eff[idx] || 0;
  const nextEffTs = eff[Math.min(frames.length - 1, idx + 1)] || frameEffTs;
  const frameRealTs = f && f.ts_ms != null ? f.ts_ms : playheadMs;
  const nextFrame = frames[Math.min(frames.length - 1, idx + 1)];
  const nextRealTs = nextFrame && nextFrame.ts_ms != null ? nextFrame.ts_ms : frameRealTs;
  const frameSpan = Math.max(1, nextEffTs - frameEffTs);
  const frameT = Math.max(0, Math.min(1, (playheadMs - frameEffTs) / frameSpan));
  const cursorTs = frameRealTs + (nextRealTs - frameRealTs) * frameT;
  const paint = () => {{
    canvas.width = img.naturalWidth || 1280;
    canvas.height = img.naturalHeight || 800;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // Animate the cursor from the captured humanized path (cursorEvents, keyed on
    // each frame's REAL timestamp) rather than the static per-frame snapshot — the
    // per-frame cursor is a single capture-time position and never moves.
    drawCursor(cursorAtTime(cursorTs) || cursorByFrame[idx]);
    // Active-tab indicator: show which tab this frame was captured from, so
    // multi-tab flows are legible (the recording now follows the active tab).
    if (f && f.tab_url) {{
      ctx.save();
      ctx.font = '13px ui-monospace, Menlo, monospace';
      const label = ('◯ ' + f.tab_url).slice(0, 96);
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = 'rgba(10,10,12,.72)';
      ctx.fillRect(8, 8, w, 24);
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText(label, 15, 25);
      ctx.restore();
    }}
    timeline.value = Math.round(playheadMs);
    time.textContent = `${{(playheadMs / 1000).toFixed(2)}}s`;
  }};
  if (img.complete) paint(); else img.onload = paint;
}}
function tick(nowMs) {{
  if (!playing) return;
  if (lastRafMs == null) lastRafMs = nowMs;
  const deltaMs = Math.max(0, nowMs - lastRafMs) * Number(speed.value || 1);
  lastRafMs = nowMs;
  renderAt(playheadMs + deltaMs);
  if (playheadMs >= totalMs) {{
    playing = false;
    playBtn.textContent = 'Play';
    lastRafMs = null;
    return;
  }}
  rafId = requestAnimationFrame(tick);
}}
function beginFrameReplay(autoPlay) {{
  showingPrefix = false;
  prefixVideo.hidden = true;
  canvas.hidden = false;
  timeline.disabled = false;
  renderAt(0);
  if (autoPlay) {{
    playing = true;
    playBtn.textContent = 'Pause';
    lastRafMs = null;
    rafId = requestAnimationFrame(tick);
  }}
}}
function startPrefix(index) {{
  prefixIndex = index;
  showingPrefix = true;
  playing = false;
  canvas.hidden = true;
  prefixVideo.hidden = false;
  timeline.disabled = true;
  prefixVideo.src = prefixVideoUrls[prefixIndex];
  time.textContent = `session ${{prefixIndex + 1}}/${{prefixVideoUrls.length}}`;
  playBtn.textContent = 'Pause';
  prefixVideo.play().catch(() => {{ playBtn.textContent = 'Play'; }});
}}
prefixVideo.onplay = () => {{ if (showingPrefix) playBtn.textContent = 'Pause'; }};
prefixVideo.onpause = () => {{ if (showingPrefix && !prefixVideo.ended) playBtn.textContent = 'Play'; }};
prefixVideo.onended = () => {{
  if (prefixIndex + 1 < prefixVideoUrls.length) startPrefix(prefixIndex + 1);
  else if (frames.length) beginFrameReplay(true);
  else playBtn.textContent = 'Play';
}};
playBtn.onclick = () => {{
  if (showingPrefix) {{
    if (prefixVideo.paused) prefixVideo.play().catch(() => {{}});
    else prefixVideo.pause();
    return;
  }}
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
  if (rafId) cancelAnimationFrame(rafId);
  lastRafMs = null;
  if (playing) rafId = requestAnimationFrame(tick);
}};
timeline.oninput = e => {{
  playing = false;
  playBtn.textContent = 'Play';
  if (rafId) cancelAnimationFrame(rafId);
  lastRafMs = null;
  renderAt(Number(e.target.value));
}};
skipIdle.onchange = () => {{
  const cur = frameIndexAtTime(playheadMs);
  eff = buildEff(skipIdle.checked);
  totalMs = eff.length ? eff[eff.length - 1] : 0;
  timeline.max = totalMs;
  renderAt(eff[cur] || 0);
}};
if (prefixVideoUrls.length) startPrefix(0); else beginFrameReplay(false);
</script>
</body>
</html>
"""

    def _build_steel_video_html(self, media: Dict[str, Any]) -> str:
        cursor_events_json = json.dumps(self.cursor_events)
        title = html.escape(f"Browser recording {self.task_id}")
        mp4_src = json.dumps(media.get("mp4_src"))
        hls_src = json.dumps(media.get("hls_src"))
        hls_js_src = json.dumps(media.get("hls_js_src"))
        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111; color: #f5f5f5; }}
    header {{ display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: #1e1e1e; position: sticky; top: 0; z-index: 2; }}
    button, select, label {{ font: inherit; }}
    button, select {{ background: #2b2b2b; color: #fff; border: 1px solid #555; border-radius: 6px; padding: 5px 8px; }}
    #stage {{ position: relative; width: min(100vw, 1288px); margin: 0 auto; background: #050505; }}
    video {{ display: block; width: 100%; height: auto; background: #050505; }}
    #cursor {{ position: absolute; width: 28px; height: 28px; pointer-events: none; z-index: 3; filter: drop-shadow(2px 3px 3px rgba(0,0,0,.5)); transform: translateX(-28px); }}
    #meta {{ max-width: 1288px; margin: 10px auto; color: #bdbdbd; font-size: 12px; }}
  </style>
</head>
<body>
  <header>
    <button id="play">Play</button>
    <label>Speed <select id="speed"><option>1</option><option>2</option><option selected>4</option><option>8</option></select>x</label>
    <span id="time"></span>
  </header>
  <div id="stage">
    <video id="video" controls playsinline preload="metadata"></video>
    <div id="cursor" aria-hidden="true"></div>
  </div>
  <div id="meta">
    <div><strong>{html.escape(self.task_id)}</strong></div>
    <div>Source: Steel MP4/HLS debug recording</div>
    <div>Session: {html.escape(self.session_id)}</div>
  </div>
  <script>
const cursorEvents = {cursor_events_json};
const mp4Src = {mp4_src};
const hlsSrc = {hls_src};
const hlsJsSrc = {hls_js_src};
const video = document.getElementById('video');
const playBtn = document.getElementById('play');
const speed = document.getElementById('speed');
const time = document.getElementById('time');
const cursor = document.getElementById('cursor');
cursor.innerHTML = `{_cursor_svg_for_html()}`;
const BROWSER_WINDOW_WIDTH = 1288;
const BROWSER_WINDOW_HEIGHT = 891;
const CONTENT_OFFSET_X = 4;
const CONTENT_OFFSET_Y = 91;
function cursorAtTime(tsMs) {{
  if (!cursorEvents.length) return null;
  let lo = 0, hi = cursorEvents.length - 1;
  while (lo <= hi) {{
    const mid = Math.floor((lo + hi) / 2);
    if (cursorEvents[mid].ts_ms <= tsMs) lo = mid + 1;
    else hi = mid - 1;
  }}
  if (hi < 0) return cursorEvents[0];
  if (hi >= cursorEvents.length - 1) return cursorEvents[cursorEvents.length - 1];
  const a = cursorEvents[hi], b = cursorEvents[hi + 1];
  const span = Math.max(1, b.ts_ms - a.ts_ms);
  const t = Math.max(0, Math.min(1, (tsMs - a.ts_ms) / span));
  return {{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }};
}}
function placeCursor() {{
  const c = cursorAtTime(video.currentTime * 1000);
  if (c) {{
    const scaleX = video.clientWidth / BROWSER_WINDOW_WIDTH;
    const scaleY = video.clientHeight / BROWSER_WINDOW_HEIGHT;
    cursor.style.left = `${{(CONTENT_OFFSET_X + c.x) * scaleX}}px`;
    cursor.style.top = `${{(CONTENT_OFFSET_Y + c.y) * scaleY}}px`;
  }}
  time.textContent = `${{video.currentTime.toFixed(2)}}s`;
  requestAnimationFrame(placeCursor);
}}
function loadVideo() {{
  if (mp4Src) {{
    video.src = mp4Src;
    return;
  }}
  if (video.canPlayType('application/vnd.apple.mpegurl')) {{
    video.src = hlsSrc;
    return;
  }}
  if (hlsJsSrc) {{
    const script = document.createElement('script');
    script.src = hlsJsSrc;
    script.onload = () => {{
      const hls = new Hls();
      hls.loadSource(hlsSrc);
      hls.attachMedia(video);
    }};
    document.head.appendChild(script);
  }}
}}
playBtn.onclick = () => {{
  video.playbackRate = Number(speed.value || 1);
  if (video.paused) {{ video.play(); playBtn.textContent = 'Pause'; }}
  else {{ video.pause(); playBtn.textContent = 'Play'; }}
}};
speed.onchange = () => {{ video.playbackRate = Number(speed.value || 1); }};
video.onplay = () => {{ playBtn.textContent = 'Pause'; }};
video.onpause = () => {{ playBtn.textContent = 'Play'; }};
loadVideo();
requestAnimationFrame(placeCursor);
  </script>
</body>
</html>
"""


def browser_network_recording_enabled() -> bool:
    value = os.getenv("BROWSER_AGENT_NETWORK_RECORDING", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return browser_recordings_enabled()


def provider_exit_monitoring_enabled() -> bool:
    """Keep the lightweight rejection signal active outside local recordings."""
    value = os.getenv("BROWSER_AGENT_PROVIDER_EXIT_MONITORING", "").strip().lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return True


_FINGERPRINT_POISON_REASON = "ip has used many different fingerprints"
# Kept for log/search continuity; new exits use CRITICAL_RESOURCE_BLOCK_REASON.
_PAYMENT_TUNNEL_FAILURE_REASON = "payment CDN blocked by proxy tunnel"
_CRITICAL_RESOURCE_BLOCK_REASON = "critical third-party resource blocked"
_API_CHALLENGE_HTML_REASON = "same-origin API returned Cloudflare challenge HTML"
_FIRST_PARTY_TUNNEL_FAILURE_REASON = "first-party request blocked by proxy tunnel"
# Network failures that mean "this exit cannot fetch the resource" — includes
# ORB and classic proxy tunnel deaths.
_RESOURCE_BLOCK_MARKERS = (
    "err_tunnel_connection_failed",
    "err_proxy_connection_failed",
    "err_proxy_connection_refused",
    "err_blocked_by_orb",
    "err_blocked_by_response",
    "err_blocked_by_client",
)
# Alias used by older call sites / tests.
_TUNNEL_FAILURE_MARKERS = _RESOURCE_BLOCK_MARKERS
# Optional noise: blocked analytics must not rotate the browser exit.
_OPTIONAL_THIRD_PARTY_HOST_FRAGMENTS = (
    "google-analytics.com",
    "googletagmanager.com",
    "googleadservices.com",
    "doubleclick.net",
    "facebook.net",
    "facebook.com",
    "hotjar.com",
    "segment.com",
    "segment.io",
    "mixpanel.com",
    "amplitude.com",
    "sentry.io",
    "newrelic.com",
    "nr-data.net",
    "clarity.ms",
)
_API_CHALLENGE_HTML_MARKERS = (
    "access denied",
    "attention required",
    "just a moment",
    "cf-chl-",
    "/cdn-cgi/challenge-platform",
    "challenges.cloudflare.com/turnstile",
)
_API_CHALLENGE_RESOURCE_TYPES = {"xhr", "fetch", "document"}
# Cap automatic API-challenge exits so cookie-stage loops cannot be replaced by
# an unbounded config-search thrash on a permanently blocked endpoint.
_MAX_API_CHALLENGE_PROVIDER_EXITS = 2
# Cap automatic critical-resource exit rotations per recorder so a bad proxy
# cannot thrash recover_from_challenge forever.
_MAX_CRITICAL_RESOURCE_PROVIDER_EXITS = 2
# Backward-compat alias (tests + older call sites).
_MAX_PAYMENT_CDN_PROVIDER_EXITS = _MAX_CRITICAL_RESOURCE_PROVIDER_EXITS
_MAX_GENERIC_SCRIPT_PROVIDER_EXITS = 1
# A repeat failure on the page itself is strong evidence that the browser exit
# cannot reach it. Bound rotations independently of third-party script exits.
_MAX_FIRST_PARTY_TUNNEL_PROVIDER_EXITS = 1
_FIRST_PARTY_TUNNEL_FAILURE_MARKERS = (
    "err_tunnel_connection_failed",
    "err_proxy_connection_failed",
    "err_proxy_connection_refused",
)


def _host_looks_like_script_cdn(url: str) -> bool:
    """Shape heuristic: ``js.*`` hosts (no vendor allowlists, no path markers)."""
    host = (urlparse(url).hostname or "").lower()
    if host and host.split(".", 1)[0] == "js":
        return True
    return False


def _same_origin(a: str, b: str) -> bool:
    """True when both URLs share scheme, host, and effective port."""
    left = urlparse(a or "")
    right = urlparse(b or "")
    if not left.scheme or not right.scheme or not left.hostname or not right.hostname:
        return False
    try:
        left_port = left.port or {"http": 80, "https": 443}.get(left.scheme.lower())
        right_port = right.port or {"http": 80, "https": 443}.get(right.scheme.lower())
    except ValueError:
        return False
    return (left.scheme.lower(), left.hostname.lower(), left_port) == (
        right.scheme.lower(),
        right.hostname.lower(),
        right_port,
    )


def _is_payment_cdn_tunnel_failure(url: str, error_text: str) -> bool:
    """Backward-compatible critical script-CDN tunnel check (no vendor hosts)."""
    err = (error_text or "").lower()
    if not any(marker in err for marker in _RESOURCE_BLOCK_MARKERS):
        return False
    return _host_looks_like_script_cdn(url or "")


def _is_critical_resource_block(
    url: str,
    error_text: str,
    *,
    resource_type: str = "",
    document_url: str | None = None,
) -> bool:
    """True when a page-critical third-party request is blocked on this exit.

    Shape-based only: js.*/script-like hosts OR cross-origin ``script`` resources
    that die with tunnel/ORB/client-block errors. Soft third-parties (analytics)
    never rotate. No vendor host allowlists.
    """
    err = (error_text or "").lower()
    if not any(marker in err for marker in _RESOURCE_BLOCK_MARKERS):
        return False
    host = (urlparse(url).hostname or "").lower()
    if any(fragment in host for fragment in _OPTIONAL_THIRD_PARTY_HOST_FRAGMENTS):
        return False
    if _host_looks_like_script_cdn(url or ""):
        # First-party script failures stay on the page; only third-party CDNs rotate.
        if document_url and _same_origin(url or "", document_url):
            return False
        return True
    if (resource_type or "").lower() != "script":
        return False
    if document_url:
        return not _same_origin(url or "", document_url)
    return True


_API_CHALLENGE_LARGE_HTML_BYTES = 20_000
_STATIC_ASSET_SUFFIXES = (
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".webp",
    ".mp4",
    ".webm",
    ".map",
)


def _url_looks_like_static_asset(url: str) -> bool:
    path = (urlparse(url).path or "").lower()
    return any(path.endswith(suffix) for suffix in _STATIC_ASSET_SUFFIXES)


def _resource_type_is_api_challenge_candidate(resource_type: str) -> bool:
    resource = (resource_type or "").lower()
    return not resource or resource in _API_CHALLENGE_RESOURCE_TYPES


def _normalize_http_method(method: Any) -> str:
    return str(method or "").strip().upper()


def _api_challenge_locator(url: str) -> str:
    """Scheme/host/path identity for matching a challenge to its superseding 2xx."""
    return _redact_url_query(url or "")


def _api_challenge_success_matches(
    *,
    challenge_url: str,
    challenge_method: Any,
    challenge_resource_type: Any,
    success_url: str,
    success_method: Any,
    success_resource_type: Any,
) -> bool:
    """True when a 2xx is the same endpoint (locator + method) as the challenge.

    Document navigations must not clear XHR/fetch challenges — pages routinely
    emit same-origin document/config 2xx traffic between browser-loop steps.
    """
    if not challenge_url or not success_url:
        return False
    if _api_challenge_locator(challenge_url) != _api_challenge_locator(success_url):
        return False
    challenge_method_norm = _normalize_http_method(challenge_method)
    success_method_norm = _normalize_http_method(success_method)
    if challenge_method_norm and success_method_norm and challenge_method_norm != success_method_norm:
        return False
    challenge_resource = str(challenge_resource_type or "").lower()
    success_resource = str(success_resource_type or "").lower()
    if challenge_resource in {"xhr", "fetch"} and success_resource == "document":
        return False
    return True


def _status_is_http_success(status: Any) -> bool:
    try:
        code = int(status)
    except (TypeError, ValueError):
        return False
    return 200 <= code < 300


def _is_api_challenge_html_response(
    *,
    status: Any,
    url: str,
    resource_type: str,
    mime_type: str,
    body_bytes: bytes,
    document_url: str | None = None,
) -> bool:
    """True when a same-tab XHR/fetch/document returns CF challenge HTML.

    Document GET can look clean while same-origin POSTs 403 with a large
    challenge page. Cookie-stage recovery only GET-probes the document URL and
    false-succeeds; treat the API challenge as a provider-exit signal instead.
    When ``document_url`` is provided, require same-origin with ``url`` so a
    third-party 403 HTML body cannot rotate the exit.

    No cart/checkout path allowlists. Large HTML 403s count unless the URL is a
    static asset (fonts/css/images) — those are not API challenge pages.
    """
    try:
        code = int(status)
    except (TypeError, ValueError):
        return False
    if code != 403:
        return False
    if not _resource_type_is_api_challenge_candidate(resource_type):
        return False
    if not (url or "").startswith("http"):
        return False
    if document_url and not _same_origin(url, document_url):
        return False
    sample = body_bytes[:12_000].decode("utf-8", errors="ignore").lower()
    mime = (mime_type or "").lower()
    looks_html = "html" in mime or "<html" in sample[:800] or "<!doctype html" in sample[:800]
    if not looks_html:
        return False
    if any(marker in sample for marker in _API_CHALLENGE_HTML_MARKERS):
        return True
    if _url_looks_like_static_asset(url):
        return False
    return len(body_bytes) >= _API_CHALLENGE_LARGE_HTML_BYTES


def _document_warrants_payment_cdn_exit(document_url: str) -> bool:
    """Rotate on critical third-party blocks for any real document URL.

    No payment/checkout path allowlists and no inventory-path exclusions —
    exit caps bound thrash instead.
    """
    return bool((document_url or "").strip())


def _contains_actionable_fingerprint_poison_detection(value: Any) -> bool:
    """Treat a poison warning as an exit only when its enclosing verdict did not pass."""
    if isinstance(value, dict):
        recommendation = " ".join(str(value.get("recommendation") or "").strip().lower().split())
        accepted_detections = value.get("success") is True and recommendation == "allow"
        category = str(value.get("category") or "").strip().lower()
        reason = " ".join(str(value.get("reason") or "").strip().lower().split())
        if category == "fingerprint" and reason == _FINGERPRINT_POISON_REASON:
            return True
        return any(
            _contains_actionable_fingerprint_poison_detection(item)
            for key, item in value.items()
            if not (accepted_detections and key == "detections")
        )
    if isinstance(value, list):
        return any(_contains_actionable_fingerprint_poison_detection(item) for item in value)
    return False


def _captured_request_body(
    post_data: Any,
    *,
    content_type: str,
    max_bytes: int,
    placeholder: str,
) -> Dict[str, Any]:
    """Build the request-body fields for one entry, redacting secrets first."""
    if not isinstance(post_data, str) or not post_data:
        return {}
    # Cap before redacting: parsing and re-serializing a multi-megabyte payload
    # just to throw most of it away is wasted work and an easy memory spike.
    if _encoded_len(post_data) > max_bytes:
        return {"request_body": placeholder, "request_body_truncated": True}
    redacted = _redact_request_body(post_data, content_type)
    return {
        "request_body": _truncate_text_to_bytes(redacted, max_bytes),
        "request_body_truncated": _encoded_len(redacted) > max_bytes,
    }


def _redact_request_body(post_data: str, content_type: str = "") -> str:
    """Strip secret-bearing values from a captured request body.

    JSON and explicitly form-encoded payloads are walked and their sensitive
    values replaced. Anything else is dropped entirely rather than persisted:
    an opaque format cannot be inspected, so it cannot be shown to be
    secret-free, and retaining it is the risk this guard exists to remove. A
    lone "=" is NOT treated as form encoding -- binary payloads contain "=" too.
    """

    def scrub(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: (
                    BrowserNetworkRecorder.REDACTED_PLACEHOLDER
                    if any(marker in str(key).lower() for marker in BrowserNetworkRecorder.REDACT_KEY_MARKERS)
                    else scrub(item)
                )
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    stripped = post_data.strip()
    if stripped.startswith(("{", "[")):
        try:
            return json.dumps(scrub(json.loads(stripped)), separators=(",", ":"))
        except (ValueError, TypeError):
            return BrowserNetworkRecorder.REDACTED_PLACEHOLDER
    if "x-www-form-urlencoded" in content_type.lower():
        pairs = []
        for pair in stripped.split("&"):
            key, sep, raw = pair.partition("=")
            if not sep:
                return BrowserNetworkRecorder.REDACTED_PLACEHOLDER
            sensitive = any(marker in unquote(key).lower() for marker in BrowserNetworkRecorder.REDACT_KEY_MARKERS)
            pairs.append(f"{key}={BrowserNetworkRecorder.REDACTED_PLACEHOLDER if sensitive else raw}")
        return "&".join(pairs)
    return BrowserNetworkRecorder.REDACTED_PLACEHOLDER


class BrowserNetworkRecorder:
    """CDP network observer with optional local body-log persistence.

    Metadata (url, method, status, headers, timing, redirect chain) is captured
    for EVERY http(s) request the page makes, regardless of resource type, so the
    agent's ``read_network_requests`` tool can answer "what did this page
    actually call" the way DevTools' Network panel does. Response *bodies* are a
    separate, narrower capture: only text-ish payloads are downloaded, each is
    capped at ``_max_body_bytes``, and the in-memory body cache is bounded by
    ``_max_total_body_bytes`` with oldest-first eviction so a long-lived page
    cannot grow the worker's heap without bound.
    """

    BODY_SKIP_EXTENSIONS = (
        ".css",
        ".js",
        ".mjs",
        ".map",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".woff",
        ".woff2",
        ".ttf",
        ".mp4",
        ".webm",
        ".mp3",
        ".wav",
    )
    # Bodies worth one getResponseBody round trip. Scripts/stylesheets/fonts are
    # deliberately absent: their metadata is captured like everything else, but
    # an agent that wants a bundle can `evaluate` or web_fetch it, and pulling
    # them for every page would cost CDP round trips on every browser session.
    BODY_RESOURCE_TYPES = {"XHR", "Fetch", "Document", "EventSource", "Other"}

    # Secret-bearing keys are redacted in EVERY retained request body. Bodies stay
    # available because read_network_requests exists to let an agent debug real
    # traffic; redaction removes the credential risk without removing the answer.
    # Substring match, so this also covers api_key/sessionToken and
    # the challenge-response credentials (g-recaptcha-response, WebAuthn
    # assertion) that anti-bot endpoints legitimately carry.
    REDACT_KEY_MARKERS = (
        "assertion",
        "auth",
        "card",
        "cookie",
        "credential",
        "cvv",
        "email",
        "iban",
        "key",
        "otp",
        "passw",
        "phone",
        "response",
        "secret",
        "session",
        "signature",
        "ssn",
        "token",
    )
    REDACTED_PLACEHOLDER = "[REDACTED]"

    def __init__(
        self,
        *,
        browser_session: Any,
        agent_id: str,
        task_id: str,
        session_id: str,
        output_dir: Path,
        persist_network_log: bool = True,
    ) -> None:
        self.browser_session = browser_session
        self.agent_id = agent_id
        self.task_id = task_id
        self.session_id = session_id
        self.output_dir = output_dir
        self.network_dir = self.output_dir / "network"
        self.console_dir = self.output_dir / "console"
        self.network_index_path = self.network_dir / "index.json"
        self.console_index_path = self.console_dir / "index.json"
        self.persists_network_log = persist_network_log
        self.entries: Dict[str, Dict[str, Any]] = {}
        self._diagnostic_entries: List[Dict[str, Any]] = []
        self.console_entries: List[Dict[str, Any]] = []
        # Request IDs that were in flight when the agent last cleared the buffer
        # (read_network_requests clear=True). Their late response events must NOT
        # resurrect a pre-clear entry, or the next read would leak old traffic.
        self._ignored_request_ids: set[str] = set()
        # Track every request observed by CDP, including requests dropped when the
        # capture buffer is full. A clear must ignore all pre-clear traffic, not
        # only the subset that had room in ``entries``.
        self._active_request_ids: set[str] = set()
        self._started_at = time.monotonic()
        self._closed = False
        _initialize_archive_owner(self)
        self._tasks: set[asyncio.Task] = set()
        self._provider_exit_rejections: List[Dict[str, Any]] = []
        self._rejected_network_generations: set[int] = set()
        self._payment_cdn_provider_exits = 0
        self._generic_script_provider_exits = 0
        self._api_challenge_provider_exits = 0
        self._first_party_tunnel_provider_exits = 0
        self._first_party_tunnel_failures: Dict[tuple[int, str, str, str], int] = {}
        self._cdp_client: Any = None
        self._network_cdp_session_id: str | None = None
        # CDP requestId values are scoped to one remote browser connection and
        # can repeat after challenge recovery promotes another provider/session.
        # Namespace every internal request key by the connection generation so
        # late events from the outgoing browser cannot corrupt the winner's log.
        self._network_generation = 0
        self._body_index = 0
        self._max_entries = max(1, int(os.getenv("BROWSER_AGENT_NETWORK_MAX_ENTRIES", "600")))
        self._max_console_entries = max(1, int(os.getenv("BROWSER_AGENT_CONSOLE_MAX_ENTRIES", "500")))
        self._max_body_bytes = max(1024, int(os.getenv("BROWSER_AGENT_NETWORK_MAX_BODY_BYTES", "262144")))
        if not self.persists_network_log:
            self._max_body_bytes = min(self._max_body_bytes, 65_536)
        # Lightweight classification fields for in-flight requests. Survives
        # bounded ``entries`` eviction so loadingFailed can still reject a
        # provider exit (Stripe/critical script) after the capture row is gone.
        self._active_request_meta: Dict[str, Dict[str, Any]] = {}
        self._max_active_request_meta = max(self._max_entries * 2, 256)
        # Response bodies the agent can read back via read_network_requests.
        # Kept separate from `entries` so the byte budget is enforced on the only
        # unbounded axis: one browser session must not hold tens of MB of page
        # payloads while thousands of agents share a worker.
        self._bodies: Dict[str, str] = {}
        # Encoded size per cached body, so the budget is charged in real bytes
        # and eviction is O(1) instead of re-encoding each candidate.
        self._body_byte_sizes: Dict[str, int] = {}
        self._body_bytes = 0
        self._max_total_body_bytes = max(
            self._max_body_bytes,
            int(
                os.getenv(
                    "BROWSER_AGENT_NETWORK_MAX_TOTAL_BODY_BYTES",
                    "8388608" if self.persists_network_log else "2097152",
                )
            ),
        )
        self._patterns = [
            item.strip().lower()
            for item in os.getenv("BROWSER_AGENT_NETWORK_CAPTURE_URL_PATTERNS", "").split(",")
            if item.strip()
        ]

    @classmethod
    async def create(
        cls,
        *,
        browser_session: Any,
        agent_id: str,
        task_id: Optional[str],
        session_id: Optional[str],
        output_dir: Path,
        register_local_owner: Optional[Callable[[Any], None]] = None,
    ) -> Optional["BrowserNetworkRecorder"]:
        persist_network_log = browser_network_recording_enabled()
        if (not persist_network_log and not provider_exit_monitoring_enabled()) or not task_id or not session_id:
            return None
        if not hasattr(browser_session, "get_or_create_cdp_session"):
            logger.warning(
                "Browser network response-body recording unavailable: no CDP session API",
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
            )
            return None
        recorder = cls(
            browser_session=browser_session,
            agent_id=agent_id,
            task_id=task_id,
            session_id=session_id,
            output_dir=output_dir,
            persist_network_log=persist_network_log,
        )
        if register_local_owner is not None:
            register_local_owner(recorder)
        try:
            await recorder.start()
        except Exception as exc:
            logger.warning(
                "Browser network response-body recording failed to start",
                agent_id=agent_id,
                task_id=task_id,
                session_id=session_id,
                error=str(exc),
            )
            return None
        return recorder

    async def start(self) -> None:
        # Metadata + console diagnostics are always persisted. The flag only
        # controls response-body files, which are much larger and may contain
        # page data unsuitable for the attached redacted bundle.
        self.network_dir.mkdir(parents=True, exist_ok=True)
        self.console_dir.mkdir(parents=True, exist_ok=True)
        if self._cdp_client is not None and self._network_cdp_session_id:
            with contextlib.suppress(Exception):
                await self._cdp_client.send.Network.disable(session_id=self._network_cdp_session_id)
        # Attach to the focused page target so Network.responseReceived events
        # arrive on the same CDP session as requestWillBeSent. Without focus=True
        # Kernel sessions often capture outbound requests but never response status.
        cdp_session = await self.browser_session.get_or_create_cdp_session(focus=True)
        cdp_client = getattr(self.browser_session, "cdp_client", None) or cdp_session.cdp_client
        self._cdp_client = cdp_client
        self._network_cdp_session_id = cdp_session.session_id
        self._network_generation += 1
        generation = self._network_generation
        self._first_party_tunnel_failures.clear()
        cdp = cdp_client.register
        cdp.Network.requestWillBeSent(
            lambda event, session_id: self._on_request_will_be_sent(event, session_id, generation)
        )
        cdp.Network.responseReceived(
            lambda event, session_id: self._on_response_received(event, session_id, generation)
        )
        cdp.Network.loadingFinished(
            lambda event, session_id: self._on_loading_finished(event, session_id, generation, cdp_client)
        )
        cdp.Network.loadingFailed(lambda event, session_id: self._on_loading_failed(event, session_id, generation))

        await cdp_client.send.Network.enable(session_id=cdp_session.session_id)
        await self._start_console_capture(cdp_client, cdp_session.session_id, generation)
        logger.info(
            (
                "Browser network response-body recording started"
                if self.persists_network_log
                else "Browser provider-exit monitoring started"
            ),
            agent_id=self.agent_id,
            task_id=self.task_id,
            session_id=self.session_id,
            **({"output_dir": str(self.network_dir)} if self.persists_network_log else {}),
        )

    async def _start_console_capture(self, cdp_client: Any, session_id: str, generation: int) -> None:
        """Capture page console, uncaught exceptions, and browser log entries."""
        register = getattr(cdp_client, "register", None)
        send = getattr(cdp_client, "send", None)
        runtime_register = getattr(register, "Runtime", None) if register is not None else None
        runtime_send = getattr(send, "Runtime", None) if send is not None else None
        log_register = getattr(register, "Log", None) if register is not None else None
        log_send = getattr(send, "Log", None) if send is not None else None
        webauthn_register = getattr(register, "WebAuthn", None) if register is not None else None

        try:
            if runtime_register is not None and runtime_send is not None:
                runtime_register.consoleAPICalled(
                    lambda event, event_session_id: self._on_console_api_called(event, event_session_id, generation)
                )
                runtime_register.exceptionThrown(
                    lambda event, event_session_id: self._on_exception_thrown(event, event_session_id, generation)
                )
                await runtime_send.enable(session_id=session_id)
        except Exception as exc:
            logger.warning(
                "Browser console Runtime capture failed to start",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc),
            )

        try:
            if log_register is not None and log_send is not None:
                log_register.entryAdded(
                    lambda event, event_session_id: self._on_log_entry_added(event, event_session_id, generation)
                )
                await log_send.enable(session_id=session_id)
        except Exception as exc:
            logger.warning(
                "Browser console Log capture failed to start",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc),
            )

        try:
            if webauthn_register is not None:
                webauthn_register.credentialAsserted(
                    lambda event, event_session_id: self._on_webauthn_credential_asserted(
                        event, event_session_id, generation
                    )
                )
        except Exception as exc:
            logger.warning(
                "Browser WebAuthn assertion capture failed to start",
                agent_id=self.agent_id,
                task_id=self.task_id,
                error=str(exc),
            )

    def _append_console_entry(self, entry: Dict[str, Any]) -> None:
        self.console_entries.append(entry)
        overflow = len(self.console_entries) - self._max_console_entries
        if overflow > 0:
            del self.console_entries[:overflow]
        self._correlate_console_http_status(entry)

    def _correlate_console_http_status(self, console_entry: Dict[str, Any]) -> None:
        """Backfill network status from console lines when CDP responses are missing."""
        text = str(console_entry.get("text") or "")
        status = _parse_console_http_status(text)
        if status is None:
            return
        page_url = str(console_entry.get("url") or "")
        resource_match = _CONSOLE_RESOURCE_STATUS_RE.search(text)
        if resource_match and page_url:
            self._apply_console_status_to_url(status=status, url=page_url)
            return
        self._apply_console_status_to_recent_graphql(status=status, page_url=page_url)

    def _apply_console_status_to_url(self, *, status: int, url: str) -> None:
        target = url.split("?", 1)[0].rstrip("/").lower()
        for entry in reversed(list(self.entries.values())):
            if entry.get("status") is not None:
                continue
            entry_url = str(entry.get("url") or "")
            if not entry_url:
                continue
            normalized = entry_url.split("?", 1)[0].rstrip("/").lower()
            if normalized == target or target.endswith(normalized) or normalized.endswith(target):
                entry["status"] = status
                entry["status_text"] = f"HTTP {status}"
                entry["status_source"] = "console"
                entry["terminal"] = True
                return

    def _apply_console_status_to_recent_graphql(self, *, status: int, page_url: str) -> None:
        host_hint = ""
        if page_url:
            host_hint = (urlparse(page_url).hostname or "").lower()
        candidates: List[tuple[int, Dict[str, Any]]] = []
        for entry in self.entries.values():
            if entry.get("status") is not None:
                continue
            url = str(entry.get("url") or "").lower()
            if "graphql" not in url:
                continue
            if host_hint and host_hint not in url:
                continue
            ts = int(entry.get("response_ts_ms") or entry.get("request_ts_ms") or 0)
            candidates.append((ts, entry))
        if not candidates:
            return
        candidates.sort(key=lambda item: item[0], reverse=True)
        entry = candidates[0][1]
        entry["status"] = status
        entry["status_text"] = f"HTTP {status}"
        entry["status_source"] = "console"
        entry["terminal"] = True

    def replay_console_status_hints(self) -> None:
        """Re-run console→network status correlation over the full console buffer."""
        for entry in getattr(self, "console_entries", []):
            self._correlate_console_http_status(entry)

    @classmethod
    def from_diagnostic_indexes(
        cls,
        *,
        network_index_path: Path,
        console_index_path: Path,
        agent_id: str = "fixture-agent",
        task_id: str = "fixture-task",
        output_dir: Optional[Path] = None,
    ) -> "BrowserNetworkRecorder":
        """Rehydrate a recorder from persisted production/dev diagnostic indexes."""
        network_payload = json.loads(network_index_path.read_text(encoding="utf-8"))
        console_payload = json.loads(console_index_path.read_text(encoding="utf-8"))
        root_dir = output_dir or network_index_path.parent.parent
        recorder = cls(
            browser_session=SimpleNamespace(),
            agent_id=str(network_payload.get("agent_id") or agent_id),
            task_id=str(network_payload.get("task_id") or task_id),
            session_id=str(network_payload.get("session_id") or "fixture-session"),
            output_dir=root_dir,
            persist_network_log=True,
        )
        recorder.entries = {}
        for entry in network_payload.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            request_id = str(entry.get("request_id") or "")
            if not request_id:
                continue
            generation = int(entry.get("browser_generation") or 0)
            request_key = request_id if generation == 0 else f"{generation}:{request_id}"
            recorder.entries[request_key] = dict(entry)
        recorder.console_entries = [
            dict(item) for item in (console_payload.get("entries") or []) if isinstance(item, dict)
        ]
        recorder.replay_console_status_hints()
        return recorder

    def _on_console_api_called(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        try:
            self._append_console_entry(
                {
                    "kind": "console",
                    "level": str(event.get("type") or "log"),
                    "text": " ".join(_console_remote_object_text(arg) for arg in (event.get("args") or [])),
                    "timestamp": event.get("timestamp"),
                    "session_id": session_id,
                    "browser_generation": generation,
                    "execution_context_id": event.get("executionContextId"),
                    "stack": _console_stack_frames(event.get("stackTrace")),
                }
            )
        except Exception as exc:
            logger.warning("Browser console event capture failed", error=str(exc))

    def _on_exception_thrown(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        try:
            details = event.get("exceptionDetails") or {}
            exception = details.get("exception") or {}
            text = exception.get("description") or exception.get("value") or details.get("text") or "Uncaught exception"
            self._append_console_entry(
                {
                    "kind": "exception",
                    "level": "error",
                    "text": _redact_console_text(text),
                    "url": _redact_url_query(str(details.get("url") or "")),
                    "line": details.get("lineNumber"),
                    "column": details.get("columnNumber"),
                    "timestamp": event.get("timestamp"),
                    "session_id": session_id,
                    "browser_generation": generation,
                    "stack": _console_stack_frames(details.get("stackTrace")),
                }
            )
        except Exception as exc:
            logger.warning("Browser exception capture failed", error=str(exc))

    def _on_log_entry_added(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        try:
            entry = event.get("entry") or {}
            self._append_console_entry(
                {
                    "kind": "browser_log",
                    "source": str(entry.get("source") or ""),
                    "level": str(entry.get("level") or "log"),
                    "text": _redact_console_text(entry.get("text") or ""),
                    "url": _redact_url_query(str(entry.get("url") or "")),
                    "line": entry.get("lineNumber"),
                    "timestamp": entry.get("timestamp"),
                    "session_id": session_id,
                    "browser_generation": generation,
                }
            )
        except Exception as exc:
            logger.warning("Browser log entry capture failed", error=str(exc))

    def _on_webauthn_credential_asserted(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        """Record proof of assertion without persisting credential/user material."""
        try:
            credential = event.get("credential") or {}
            credential_id = str(credential.get("credentialId") or "")
            authenticator_id = str(event.get("authenticatorId") or "")
            self._append_console_entry(
                {
                    "kind": "webauthn_credential_asserted",
                    "rp_id": _redact_console_text(credential.get("rpId") or "", limit=512),
                    "sign_count": credential.get("signCount"),
                    "is_resident_credential": credential.get("isResidentCredential"),
                    "backup_eligibility": credential.get("backupEligibility"),
                    "backup_state": credential.get("backupState"),
                    "credential_id_sha256": (
                        hashlib.sha256(credential_id.encode("utf-8")).hexdigest() if credential_id else None
                    ),
                    "authenticator_id_sha256": (
                        hashlib.sha256(authenticator_id.encode("utf-8")).hexdigest() if authenticator_id else None
                    ),
                    "session_id": session_id,
                    "browser_generation": generation,
                }
            )
        except Exception as exc:
            logger.warning("Browser WebAuthn assertion capture failed", error=str(exc))

    async def transition_browser(self, *, browser_session: Any, session_id: str) -> None:
        """Attach the same logical network log to a promoted browser session."""
        if self._closed:
            return
        self.browser_session = browser_session
        self.session_id = session_id
        await self.start()

    def _should_capture(self, url: str, resource_type: str, mime_type: str = "") -> bool:
        """Metadata capture predicate: every http(s) request the page issues.

        The agent asks read_network_requests questions like "did anything 403?"
        and "what endpoint backs this page?" — both are unanswerable if whole
        resource classes are invisible, so nothing is filtered out here beyond
        non-http schemes (data:, blob:, chrome-extension:). Body download is
        gated separately by `_should_capture_body`.
        """
        _ = (resource_type, mime_type)
        if not url.startswith(("http://", "https://")):
            return False
        if self._patterns:
            lower_url = url.lower()
            return any(pattern in lower_url for pattern in self._patterns)
        return True

    def _should_capture_body(self, url: str, resource_type: str, mime_type: str = "") -> bool:
        """Body-download predicate: text-ish payloads worth reading back."""
        lower_url = url.lower()
        if any(lower_url.split("?", 1)[0].endswith(ext) for ext in self.BODY_SKIP_EXTENSIONS):
            return False
        if self._patterns:
            return any(pattern in lower_url for pattern in self._patterns)
        if resource_type and resource_type not in self.BODY_RESOURCE_TYPES:
            return False
        lower_mime = (mime_type or "").lower()
        return not lower_mime or any(
            marker in lower_mime for marker in ("json", "text/", "html", "xml", "x-www-form-urlencoded", "javascript")
        )

    def _evict_overflow_entries(self) -> None:
        """Drop oldest entries once the buffer is full (dict preserves order).

        The tool reads newest-first, so overflow must evict the OLDEST request —
        the previous behaviour refused to record NEW requests once full, which
        made every API call after a heavy page load invisible to the agent.

        Eviction must NOT clear ``_active_request_meta``: an in-flight Stripe or
        critical-script request may still emit loadingFailed after its capture
        row is gone, and provider-exit classification needs those fields.
        """
        while len(self.entries) > self._max_entries:
            oldest_key = next(iter(self.entries))
            evicted = self.entries.pop(oldest_key, None)
            if evicted:
                self._append_diagnostic_entry(evicted)
            self._discard_body(oldest_key)

    def _remember_active_request_meta(
        self,
        request_key: str,
        *,
        url: str,
        document_url: str = "",
        resource_type: str = "",
        method: str = "",
        browser_generation: int | None = None,
    ) -> None:
        """Retain classification fields for an in-flight request outside ``entries``."""
        meta = getattr(self, "_active_request_meta", None)
        if meta is None:
            meta = {}
            self._active_request_meta = meta
        meta[request_key] = {
            "url": url,
            "document_url": document_url or "",
            "resource_type": resource_type or "",
            "method": method or "",
            "browser_generation": browser_generation,
        }
        self._prune_active_request_meta()

    def _clear_active_request_meta(self, request_key: str | None) -> None:
        if not request_key:
            return
        meta = getattr(self, "_active_request_meta", None)
        if meta is not None:
            meta.pop(request_key, None)

    def _prune_active_request_meta(self) -> None:
        """Bound the meta map so abandoned CDP ids cannot grow without limit."""
        meta = getattr(self, "_active_request_meta", None)
        if not meta:
            return
        max_meta = int(getattr(self, "_max_active_request_meta", 0) or 0)
        if max_meta <= 0:
            max_meta = max(int(getattr(self, "_max_entries", 600) or 600) * 2, 256)
            self._max_active_request_meta = max_meta
        if len(meta) <= max_meta:
            return
        active_ids = getattr(self, "_active_request_ids", set())
        # Prefer dropping metadata for requests no longer considered in-flight.
        for key in list(meta):
            if key not in active_ids:
                meta.pop(key, None)
                if len(meta) <= max_meta:
                    return
        # Still over: drop oldest keys (dict insertion order) to protect heap.
        while len(meta) > max_meta:
            oldest_key = next(iter(meta))
            meta.pop(oldest_key, None)

    def _redacted_network_entry(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        """Return the bounded, secret-safe network row used for durable diagnostics."""
        scalar_fields = (
            "request_id",
            "browser_generation",
            "session_id",
            "method",
            "resource_type",
            "has_post_data",
            "initiator",
            "request_ts_ms",
            "status",
            "status_text",
            "mime_type",
            "protocol",
            "remote_address",
            "from_cache",
            "response_ts_ms",
            "encoded_data_length",
            "terminal",
            "body_size",
            "body_truncated",
            "body_base64_encoded",
            "body_captured_at_ms",
            "body_file",
            "failed",
        )
        redacted = {field: entry.get(field) for field in scalar_fields if entry.get(field) is not None}
        redacted["url"] = _redact_url_query(str(entry.get("url") or ""))
        redacted["request_headers"] = _diagnostic_headers(entry.get("request_headers"))
        redacted["response_headers"] = _diagnostic_headers(entry.get("response_headers"))
        redirects = []
        for hop in entry.get("redirects") or []:
            if not isinstance(hop, dict):
                continue
            redirects.append(
                {
                    "url": _redact_url_query(str(hop.get("url") or "")),
                    "status": hop.get("status"),
                    "location": _redact_url_query(str(hop.get("location") or "")),
                }
            )
        if redirects:
            redacted["redirects"] = redirects
        if entry.get("failure"):
            redacted["failure"] = _redact_console_text(entry.get("failure"), limit=1024)
        if entry.get("body_error"):
            redacted["body_error"] = _redact_console_text(entry.get("body_error"), limit=1024)
        return redacted

    def _append_diagnostic_entry(self, entry: Dict[str, Any]) -> None:
        diagnostic_entries = getattr(self, "_diagnostic_entries", None)
        if diagnostic_entries is None:
            diagnostic_entries = []
            self._diagnostic_entries = diagnostic_entries
        diagnostic_entries.append(self._redacted_network_entry(entry))
        overflow = len(diagnostic_entries) - getattr(self, "_max_entries", 600)
        if overflow > 0:
            del diagnostic_entries[:overflow]

    def _discard_body(self, request_key: str) -> None:
        self._bodies.pop(request_key, None)
        self._body_bytes = max(0, self._body_bytes - self._body_byte_sizes.pop(request_key, 0))

    def _store_body(self, request_key: str, body_text: str) -> None:
        """Cache a decoded response body under the shared byte budget.

        The budget is accounted in ENCODED bytes, not characters: a JSON API
        returning non-ASCII text costs up to 4 bytes per character, so charging
        len(str) would let the cache grow several times past
        _max_total_body_bytes — defeating the heap bound it exists to enforce.
        The size is measured once here and remembered, so eviction never has to
        re-encode a payload it is about to drop.
        """
        self._discard_body(request_key)
        body_bytes = len(body_text.encode("utf-8", errors="replace"))
        self._bodies[request_key] = body_text
        self._body_byte_sizes[request_key] = body_bytes
        self._body_bytes += body_bytes
        while self._body_bytes > self._max_total_body_bytes and self._bodies:
            oldest_key = next(iter(self._bodies))
            if oldest_key == request_key and len(self._bodies) == 1:
                break
            self._discard_body(oldest_key)

    def _request_key(self, request_id: str, generation: int | None = None) -> str:
        effective_generation = generation if generation is not None else getattr(self, "_network_generation", 0)
        # Keep direct, unstarted unit fixtures readable while production
        # connections always use a generation-prefixed key.
        return request_id if effective_generation == 0 else f"{effective_generation}:{request_id}"

    def _on_request_will_be_sent(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        try:
            request_id = event.get("requestId")
            request = event.get("request") or {}
            url = request.get("url") or ""
            resource_type = event.get("type") or ""
            if not request_id:
                return
            request_key = self._request_key(request_id, generation)
            self._active_request_ids.add(request_key)
            if request_key in self._ignored_request_ids:
                return
            if not self._should_capture(url, resource_type):
                return
            post_data = request.get("postData")
            existing = self.entries.get(request_key)
            # CDP reuses one requestId across a redirect chain and re-fires
            # requestWillBeSent with the previous hop in `redirectResponse`.
            # Keep the chain so the agent can see "POST /login -> 302 -> /2fa"
            # instead of only the final hop.
            redirects = list(existing.get("redirects") or []) if existing else []
            redirect_response = event.get("redirectResponse") or {}
            if redirect_response:
                redirects.append(
                    {
                        "url": (existing or {}).get("url") or redirect_response.get("url") or "",
                        "status": redirect_response.get("status"),
                        # CDP preserves the server's header casing, and real
                        # servers send "Location". Coerce to lowercase keys
                        # first or this silently reads None on every redirect.
                        "location": _coerce_header_map(redirect_response.get("headers")).get("location"),
                    }
                )
            self.entries[request_key] = {
                "request_id": request_id,
                "browser_generation": generation,
                "session_id": session_id,
                "method": request.get("method"),
                "url": url,
                "document_url": str(event.get("documentURL") or ""),
                "resource_type": resource_type,
                "request_headers": _coerce_header_map(request.get("headers")),
                # Default-deny: only allowlisted anti-bot endpoints retain a body,
                # and even those are redacted first. Oversized bodies are capped
                # BEFORE redaction so a huge payload is never parsed/reserialized.
                **_captured_request_body(
                    post_data,
                    content_type=_coerce_header_map(request.get("headers")).get("content-type", ""),
                    max_bytes=self._max_body_bytes,
                    placeholder=self.REDACTED_PLACEHOLDER,
                ),
                "has_post_data": bool(request.get("hasPostData") or post_data),
                "initiator": (event.get("initiator") or {}).get("type"),
                "redirects": redirects,
                "request_ts_ms": int((time.monotonic() - self._started_at) * 1000),
            }
            self._remember_active_request_meta(
                request_key,
                url=url,
                document_url=str(event.get("documentURL") or ""),
                resource_type=resource_type,
                method=str(request.get("method") or ""),
                browser_generation=generation,
            )
            self._evict_overflow_entries()
        except Exception as exc:
            logger.warning("Browser network request capture failed", error=str(exc))

    def _on_response_received(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        try:
            request_id = event.get("requestId")
            response = event.get("response") or {}
            url = response.get("url") or ""
            resource_type = event.get("type") or ""
            mime_type = response.get("mimeType") or ""
            if not request_id:
                return
            request_key = self._request_key(request_id, generation)
            self._active_request_ids.add(request_key)
            if request_key in self._ignored_request_ids:
                return
            # Only gate NEW requests on the capture predicate. An already-tracked
            # request must still receive its status/response update even when the
            # response is non-capturable, otherwise it keeps status=None and
            # 403/challenge detection via read_network_requests fails.
            if request_key not in self.entries and not self._should_capture(url, resource_type, mime_type):
                return
            entry = self.entries.setdefault(
                request_key,
                {
                    "request_id": request_id,
                    "browser_generation": generation,
                    "session_id": session_id,
                    "url": url,
                    "resource_type": resource_type,
                },
            )
            entry.update(
                {
                    "session_id": session_id,
                    "url": url,
                    "resource_type": resource_type or entry.get("resource_type"),
                    "status": response.get("status"),
                    "status_text": response.get("statusText") or None,
                    "mime_type": mime_type,
                    "response_headers": _coerce_header_map(response.get("headers")),
                    "protocol": response.get("protocol"),
                    "remote_address": response.get("remoteIPAddress"),
                    "from_cache": bool(response.get("fromDiskCache") or response.get("fromPrefetchCache")),
                    "response_ts_ms": int((time.monotonic() - self._started_at) * 1000),
                }
            )
            self._remember_active_request_meta(
                request_key,
                url=str(entry.get("url") or url),
                document_url=str(entry.get("document_url") or ""),
                resource_type=str(entry.get("resource_type") or resource_type or ""),
                method=str(entry.get("method") or ""),
                browser_generation=entry.get("browser_generation", generation),
            )
            if _status_is_http_success(entry.get("status")):
                self._clear_first_party_tunnel_failure(entry)
            self._evict_overflow_entries()
        except Exception as exc:
            logger.warning("Browser network response capture failed", error=str(exc))

    def _on_loading_finished(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
        cdp_client: Any = None,
    ) -> None:
        request_id = event.get("requestId")
        request_key = self._request_key(request_id, generation) if request_id else None
        if request_id:
            self._ignored_request_ids.discard(request_key)
            self._active_request_ids.discard(request_key)
            self._clear_active_request_meta(request_key)
        if not request_id or request_key not in self.entries:
            return
        entry = self.entries[request_key]
        entry["encoded_data_length"] = event.get("encodedDataLength")
        entry["terminal"] = True
        # Metadata is captured for every resource, but downloading every image
        # and font body would be pure waste — only text-ish payloads are pulled.
        if not self._should_capture_body(
            str(entry.get("url") or ""),
            str(entry.get("resource_type") or ""),
            str(entry.get("mime_type") or ""),
        ):
            return
        # Bind the client at event time. A provider handoff can replace
        # self._cdp_client while an outgoing response body is still in flight.
        task = asyncio.create_task(
            self._fetch_response_body(
                request_key,
                request_id,
                session_id,
                cdp_client or self._cdp_client,
            )
        )
        self._tasks.add(task)
        task.add_done_callback(lambda done: self._tasks.discard(done))

    def _on_loading_failed(
        self,
        event: Dict[str, Any],
        session_id: str | None,
        generation: int | None = None,
    ) -> None:
        request_id = event.get("requestId")
        request_key = self._request_key(request_id, generation) if request_id else None
        if request_id:
            self._ignored_request_ids.discard(request_key)
            self._active_request_ids.discard(request_key)
        entry = self.entries.get(request_key) if request_id and request_key else None
        meta = None
        if request_id and request_key:
            active_meta = getattr(self, "_active_request_meta", None)
            if active_meta is not None:
                meta = active_meta.pop(request_key, None)
        if entry is not None:
            entry["failed"] = True
            entry["failure"] = event.get("errorText")
            entry["terminal"] = True
        # Prefer the capture row; fall back to meta retained across entry eviction
        # so provider-exit classification still runs for in-flight critical scripts.
        source = entry if entry is not None else meta
        if not request_id or source is None:
            return
        # Critical third-party script/CDN died with tunnel/ORB — rotate the
        # provider exit so recovery searches a fresh IP before the agent loops.
        entry_generation = int(source.get("browser_generation") or generation or 0)
        current_generation = int(getattr(self, "_network_generation", entry_generation))
        rejected_generations = getattr(self, "_rejected_network_generations", set())
        document_url = str(source.get("document_url") or "")
        if (
            entry_generation == current_generation
            and entry_generation not in rejected_generations
            and _is_critical_resource_block(
                str(source.get("url") or ""),
                str(event.get("errorText") or ""),
                resource_type=str(source.get("resource_type") or ""),
                document_url=document_url or None,
            )
        ):
            if not _document_warrants_payment_cdn_exit(document_url):
                logger.info(
                    "Ignoring critical resource block on empty document URL",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    browser_generation=entry_generation,
                    document_url=_redact_url_query(document_url),
                    url=_redact_url_query(str(source.get("url") or "")),
                )
            else:
                blocked_url = str(source.get("url") or "")
                blocked_url_is_script_cdn = _host_looks_like_script_cdn(blocked_url)
                payment_exits = int(getattr(self, "_payment_cdn_provider_exits", 0))
                generic_exits = int(getattr(self, "_generic_script_provider_exits", 0))
                if blocked_url_is_script_cdn and payment_exits >= _MAX_PAYMENT_CDN_PROVIDER_EXITS:
                    logger.warning(
                        "Critical resource block ignored: provider-exit cap reached",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        browser_generation=entry_generation,
                        document_url=_redact_url_query(document_url),
                        url=_redact_url_query(blocked_url),
                        cap=_MAX_PAYMENT_CDN_PROVIDER_EXITS,
                    )
                elif not blocked_url_is_script_cdn and generic_exits >= _MAX_GENERIC_SCRIPT_PROVIDER_EXITS:
                    logger.warning(
                        "Critical resource block ignored: generic-script exit cap reached",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        browser_generation=entry_generation,
                        document_url=_redact_url_query(document_url),
                        url=_redact_url_query(blocked_url),
                        cap=_MAX_GENERIC_SCRIPT_PROVIDER_EXITS,
                    )
                else:
                    rejected_generations.add(entry_generation)
                    self._rejected_network_generations = rejected_generations
                    if blocked_url_is_script_cdn:
                        self._payment_cdn_provider_exits = payment_exits + 1
                    else:
                        self._generic_script_provider_exits = generic_exits + 1
                    rejections = getattr(self, "_provider_exit_rejections", [])
                    rejections.append(
                        {
                            "reason": _CRITICAL_RESOURCE_BLOCK_REASON,
                            "url": _redact_url_query(blocked_url),
                            "browser_generation": entry_generation,
                            "document_url": _redact_url_query(document_url),
                        }
                    )
                    self._provider_exit_rejections = rejections
                    logger.warning(
                        "Browser provider exit rejected: critical third-party resource blocked",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        browser_generation=entry_generation,
                        document_url=_redact_url_query(document_url),
                        url=_redact_url_query(str(source.get("url") or "")),
                        error=event.get("errorText"),
                    )
        self._record_first_party_tunnel_failure(
            source,
            error_text=str(event.get("errorText") or ""),
            generation=entry_generation,
        )

    def _record_first_party_tunnel_failure(
        self,
        source: Mapping[str, Any],
        *,
        error_text: str,
        generation: int,
    ) -> None:
        """Rotate after repeated transport failures on one page or its own API."""
        if not hasattr(self, "_first_party_tunnel_failures"):
            return
        if not any(marker in error_text.lower() for marker in _FIRST_PARTY_TUNNEL_FAILURE_MARKERS):
            return
        if generation != self._network_generation or generation in self._rejected_network_generations:
            return
        resource_type = str(source.get("resource_type") or "").lower()
        url = str(source.get("url") or "")
        document_url = str(source.get("document_url") or "")
        if resource_type == "document":
            # A cross-origin frame is not evidence that the page's exit failed.
            if document_url and not _same_origin(url, document_url):
                return
        elif resource_type not in {"fetch", "xhr"} or not _same_origin(url, document_url):
            return
        locator = _api_challenge_locator(url)
        if not locator:
            return
        method = _normalize_http_method(source.get("method"))
        kind = "document" if resource_type == "document" else "api"
        key = (generation, locator, method, kind)
        failures = self._first_party_tunnel_failures.get(key, 0) + 1
        self._first_party_tunnel_failures[key] = failures
        if failures < 2 or self._first_party_tunnel_provider_exits >= _MAX_FIRST_PARTY_TUNNEL_PROVIDER_EXITS:
            return
        self._first_party_tunnel_provider_exits += 1
        self._rejected_network_generations.add(generation)
        self._provider_exit_rejections.append(
            {
                "reason": _FIRST_PARTY_TUNNEL_FAILURE_REASON,
                "url": _redact_url_query(url),
                "browser_generation": generation,
                "method": method,
                "resource_type": resource_type,
                "failure_ts_ms": int((time.monotonic() - self._started_at) * 1000),
            }
        )
        logger.warning(
            "Browser provider exit rejected: repeated first-party tunnel failure",
            agent_id=self.agent_id,
            task_id=self.task_id,
            browser_generation=generation,
            url=_redact_url_query(url),
            resource_type=resource_type,
            failures=failures,
        )

    def _clear_first_party_tunnel_failure(self, entry: Mapping[str, Any]) -> None:
        """A later 2xx on the same endpoint makes a queued exit obsolete."""
        if not hasattr(self, "_first_party_tunnel_failures"):
            return
        if not self._first_party_tunnel_failures:
            return
        generation = int(entry.get("browser_generation") or self._network_generation)
        resource_type = str(entry.get("resource_type") or "").lower()
        if resource_type not in {"document", "fetch", "xhr"}:
            return
        url = str(entry.get("url") or "")
        kind = "document" if resource_type == "document" else "api"
        key = (generation, _api_challenge_locator(url), _normalize_http_method(entry.get("method")), kind)
        self._first_party_tunnel_failures.pop(key, None)
        success_ts_ms = entry.get("response_ts_ms")
        kept = []
        for rejection in self._provider_exit_rejections:
            superseded = (
                rejection.get("reason") == _FIRST_PARTY_TUNNEL_FAILURE_REASON
                and rejection.get("browser_generation") == generation
                and _api_challenge_locator(str(rejection.get("url") or "")) == key[1]
                and _normalize_http_method(rejection.get("method")) == key[2]
                and ("document" if rejection.get("resource_type") == "document" else "api") == kind
            )
            if superseded:
                try:
                    superseded = int(success_ts_ms) > int(rejection.get("failure_ts_ms"))
                except (TypeError, ValueError):
                    superseded = False
            if superseded:
                self._first_party_tunnel_provider_exits = max(0, self._first_party_tunnel_provider_exits - 1)
                self._rejected_network_generations.discard(generation)
            else:
                kept.append(rejection)
        self._provider_exit_rejections = kept

    async def _fetch_response_body(
        self,
        request_key: str,
        request_id: str,
        session_id: str | None,
        cdp_client: Any,
    ) -> None:
        entry = self.entries.get(request_key)
        if not entry or self._closed:
            return
        try:
            response = await cdp_client.send.Network.getResponseBody(
                params={"requestId": request_id},
                session_id=session_id,
            )
            body = response.get("body", "")
            if response.get("base64Encoded"):
                body_bytes = base64.b64decode(body)
            else:
                body_bytes = body.encode("utf-8", errors="replace") if isinstance(body, str) else bytes(body or b"")
            original_size = len(body_bytes)
            truncated = original_size > self._max_body_bytes
            if truncated:
                body_bytes = body_bytes[: self._max_body_bytes]

            generation = int(entry.get("browser_generation") or 0)
            current_generation = int(getattr(self, "_network_generation", generation))
            rejected_generations = getattr(self, "_rejected_network_generations", set())
            if "json" in str(entry.get("mime_type", "")).lower():
                with contextlib.suppress(json.JSONDecodeError, UnicodeDecodeError):
                    payload = json.loads(body_bytes.decode("utf-8"))
                    if (
                        generation == current_generation
                        and generation not in rejected_generations
                        and _contains_actionable_fingerprint_poison_detection(payload)
                    ):
                        rejected_generations.add(generation)
                        self._rejected_network_generations = rejected_generations
                        rejections = getattr(self, "_provider_exit_rejections", [])
                        rejections.append(
                            {
                                "reason": _FINGERPRINT_POISON_REASON,
                                "url": _redact_url_query(str(entry.get("url") or "")),
                                "browser_generation": generation,
                            }
                        )
                        self._provider_exit_rejections = rejections
                        logger.warning(
                            "Browser provider exit explicitly rejected by fingerprint detector",
                            agent_id=self.agent_id,
                            task_id=self.task_id,
                            browser_generation=generation,
                        )
            entry_url = str(entry.get("url") or "")
            entry_resource_type = str(entry.get("resource_type") or "")
            entry_mime_type = str(entry.get("mime_type") or "")
            if (
                generation == current_generation
                and generation not in rejected_generations
                and _is_api_challenge_html_response(
                    status=entry.get("status"),
                    url=entry_url,
                    resource_type=entry_resource_type,
                    mime_type=entry_mime_type,
                    body_bytes=body_bytes,
                    document_url=entry.get("document_url"),
                )
            ):
                if self._same_origin_api_succeeded_after(
                    entry_url,
                    entry.get("response_ts_ms"),
                    generation=generation,
                    method=entry.get("method"),
                    resource_type=entry_resource_type,
                ):
                    # Delayed body capture of an earlier soft-block must not
                    # rotate the browser after the same endpoint already
                    # succeeded (AMC createOrder retry → live checkout).
                    logger.info(
                        "API challenge HTML provider-exit ignored: superseded by later same-endpoint success",
                        agent_id=self.agent_id,
                        task_id=self.task_id,
                        browser_generation=generation,
                        url=_redact_url_query(entry_url),
                        status=entry.get("status"),
                    )
                else:
                    api_exits = int(getattr(self, "_api_challenge_provider_exits", 0))
                    if api_exits >= _MAX_API_CHALLENGE_PROVIDER_EXITS:
                        logger.warning(
                            "API challenge HTML provider-exit ignored: cap reached",
                            agent_id=self.agent_id,
                            task_id=self.task_id,
                            browser_generation=generation,
                            url=_redact_url_query(entry_url),
                            cap=_MAX_API_CHALLENGE_PROVIDER_EXITS,
                        )
                    else:
                        rejected_generations.add(generation)
                        self._rejected_network_generations = rejected_generations
                        self._api_challenge_provider_exits = api_exits + 1
                        rejections = getattr(self, "_provider_exit_rejections", [])
                        rejections.append(
                            {
                                "reason": _API_CHALLENGE_HTML_REASON,
                                "url": _redact_url_query(entry_url),
                                "method": _normalize_http_method(entry.get("method")) or None,
                                "resource_type": entry_resource_type or None,
                                "browser_generation": generation,
                                "status": entry.get("status"),
                                "response_ts_ms": entry.get("response_ts_ms"),
                            }
                        )
                        self._provider_exit_rejections = rejections
                        logger.warning(
                            "Browser provider exit rejected: API returned challenge HTML",
                            agent_id=self.agent_id,
                            task_id=self.task_id,
                            browser_generation=generation,
                            url=_redact_url_query(entry_url),
                            status=entry.get("status"),
                        )
            elif (
                _status_is_http_success(entry.get("status"))
                and _resource_type_is_api_challenge_candidate(entry_resource_type)
                and not _is_api_challenge_html_response(
                    status=entry.get("status"),
                    url=entry_url,
                    resource_type=entry_resource_type,
                    mime_type=entry_mime_type,
                    body_bytes=body_bytes,
                    document_url=entry.get("document_url"),
                )
            ):
                self._clear_api_challenge_rejections_for_origin(
                    entry_url,
                    success_ts_ms=entry.get("response_ts_ms"),
                    success_generation=generation,
                    success_method=entry.get("method"),
                    success_resource_type=entry_resource_type,
                )

            entry.update(
                {
                    "body_size": original_size,
                    "body_truncated": truncated,
                    "body_base64_encoded": bool(response.get("base64Encoded")),
                    "body_captured_at_ms": int((time.monotonic() - self._started_at) * 1000),
                }
            )
            # Keep the decoded body in memory so read_network_requests can hand
            # it to the agent. Local persistence is a separate dev-only concern:
            # gating in-memory retention on it is what made the tool return
            # metadata-only rows and forced agents to re-fetch APIs by hand.
            if not response.get("base64Encoded"):
                self._store_body(request_key, body_bytes.decode("utf-8", errors="replace"))

            if getattr(self, "persists_network_log", True):
                self._body_index += 1
                index = self._body_index
                extension = ".json" if "json" in str(entry.get("mime_type", "")).lower() else ".txt"
                body_path = self.network_dir / f"{index:04d}_{request_id.replace('.', '_')}{extension}"
                body_path.write_bytes(body_bytes)
                _queue_closed_recording_file(
                    self.output_dir, current_root_agent_id() or self.agent_id, self.task_id, body_path, owner=self
                )
                entry["body_file"] = body_path.name
                logger.info(
                    "Browser network response body captured",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    status=entry.get("status"),
                    url=entry.get("url"),
                    body_file=str(body_path),
                    body_size=original_size,
                    body_truncated=truncated,
                )
        except Exception as exc:
            entry["body_error"] = str(exc)
            logger.warning(
                "Browser network response body capture failed",
                agent_id=self.agent_id,
                task_id=self.task_id,
                request_id=request_id,
                url=entry.get("url"),
                error=str(exc),
            )

    def _same_origin_api_succeeded_after(
        self,
        url: str,
        challenge_response_ts_ms: Any,
        generation: int | None = None,
        method: Any = None,
        resource_type: Any = None,
    ) -> bool:
        """True when a later same-endpoint XHR/fetch/document already returned 2xx."""
        try:
            challenge_ts = int(challenge_response_ts_ms) if challenge_response_ts_ms is not None else None
        except (TypeError, ValueError):
            challenge_ts = None
        for other in (getattr(self, "entries", None) or {}).values():
            if not isinstance(other, Mapping):
                continue
            if generation is not None and int(other.get("browser_generation") or 0) != generation:
                continue
            other_url = str(other.get("url") or "")
            if not other_url or not _same_origin(other_url, url):
                continue
            if not _resource_type_is_api_challenge_candidate(str(other.get("resource_type") or "")):
                continue
            if not _status_is_http_success(other.get("status")):
                continue
            if not _api_challenge_success_matches(
                challenge_url=url,
                challenge_method=method,
                challenge_resource_type=resource_type,
                success_url=other_url,
                success_method=other.get("method"),
                success_resource_type=other.get("resource_type"),
            ):
                continue
            other_ts = other.get("response_ts_ms")
            # Require both timestamps (same contract as
            # _clear_api_challenge_rejections_for_origin). A console-derived
            # 403 without response_ts_ms must not be suppressed by any 2xx.
            if challenge_ts is None or other_ts is None:
                continue
            try:
                if int(other_ts) <= challenge_ts:
                    continue
            except (TypeError, ValueError):
                continue
            return True
        return False

    def _clear_api_challenge_rejections_for_origin(
        self,
        url: str,
        *,
        success_ts_ms: Any = None,
        success_generation: int | None = None,
        success_method: Any = None,
        success_resource_type: Any = None,
    ) -> None:
        """Drop API-challenge exits only when a later same-endpoint 2xx supersedes them."""
        rejections = list(getattr(self, "_provider_exit_rejections", []) or [])
        if not rejections:
            return
        kept: List[Dict[str, Any]] = []
        cleared_generations: set[int] = set()
        for rejection in rejections:
            if not isinstance(rejection, Mapping):
                continue
            if str(rejection.get("reason") or "") != _API_CHALLENGE_HTML_REASON:
                kept.append(dict(rejection))
                continue
            rejection_url = str(rejection.get("url") or "")
            superseded = _api_challenge_success_matches(
                challenge_url=rejection_url,
                challenge_method=rejection.get("method"),
                challenge_resource_type=rejection.get("resource_type"),
                success_url=url,
                success_method=success_method,
                success_resource_type=success_resource_type,
            )
            if superseded and success_generation is not None:
                superseded = rejection.get("browser_generation") == success_generation
            if superseded:
                try:
                    superseded = int(success_ts_ms) > int(rejection.get("response_ts_ms"))
                except (TypeError, ValueError):
                    superseded = False
            if superseded:
                with contextlib.suppress(TypeError, ValueError):
                    cleared_generations.add(int(rejection.get("browser_generation")))
                continue
            kept.append(dict(rejection))
        cleared = len(rejections) - len(kept)
        if cleared <= 0:
            return
        self._provider_exit_rejections = kept
        # Discarded challenges never became provider exits — free the cap slots.
        api_exits = int(getattr(self, "_api_challenge_provider_exits", 0))
        self._api_challenge_provider_exits = max(0, api_exits - cleared)
        if cleared_generations:
            rejected_generations = set(getattr(self, "_rejected_network_generations", set()) or set())
            self._rejected_network_generations = rejected_generations - cleared_generations
        logger.info(
            "Cleared superseded API challenge HTML provider-exit rejection(s)",
            agent_id=getattr(self, "agent_id", None),
            task_id=getattr(self, "task_id", None),
            url=_redact_url_query(url),
            cleared=cleared,
        )

    def pop_provider_exit_rejection(self) -> Optional[Dict[str, Any]]:
        """Consume one explicit rejection verdict for the active browser exit.

        API-challenge HTML exits that were already superseded by a later
        same-endpoint 2xx are dropped here too — the success clear can race the
        next browser-loop ``pop`` after a soft-block retries cleanly.
        """
        rejections = getattr(self, "_provider_exit_rejections", [])
        while rejections:
            rejection = rejections.pop(0)
            rejection_generation: int | None = None
            if isinstance(rejection, Mapping):
                with contextlib.suppress(TypeError, ValueError):
                    rejection_generation = int(rejection.get("browser_generation"))
            if (
                isinstance(rejection, Mapping)
                and str(rejection.get("reason") or "") == _API_CHALLENGE_HTML_REASON
                and self._same_origin_api_succeeded_after(
                    str(rejection.get("url") or ""),
                    rejection.get("response_ts_ms"),
                    generation=rejection_generation,
                    method=rejection.get("method"),
                    resource_type=rejection.get("resource_type"),
                )
            ):
                api_exits = int(getattr(self, "_api_challenge_provider_exits", 0))
                self._api_challenge_provider_exits = max(0, api_exits - 1)
                with contextlib.suppress(TypeError, ValueError):
                    generation = int(rejection.get("browser_generation"))
                    rejected_generations = set(getattr(self, "_rejected_network_generations", set()) or set())
                    rejected_generations.discard(generation)
                    self._rejected_network_generations = rejected_generations
                logger.info(
                    "Dropped superseded API challenge HTML provider-exit on pop",
                    agent_id=getattr(self, "agent_id", None),
                    task_id=getattr(self, "task_id", None),
                    url=_redact_url_query(str(rejection.get("url") or "")),
                )
                continue
            self._provider_exit_rejections = rejections
            return rejection
        self._provider_exit_rejections = rejections
        return None

    def query_requests(  # noqa: C901
        self,
        *,
        url_pattern: str = "",
        method: str = "",
        status: str = "",
        resource_type: str = "",
        limit: int = 100,
        clear: bool = False,
        include_query: bool = False,
        include_headers: bool = False,
        include_bodies: bool = False,
        max_body_chars: int = 4000,
    ) -> List[Dict[str, Any]]:
        """Return captured network requests for the agent's `read_network_requests` tool.

        Newest-first, filterable by URL substring / method / status / resource
        type. Every row carries the DevTools-grade summary (url, method, status,
        mime, timing, size, redirect chain, failure). The three opt-in flags
        widen a row to the full record:

        - ``include_query``  -> unredacted URL (query string + fragment)
        - ``include_headers``-> request + response headers (credential headers masked)
        - ``include_bodies`` -> request post data + response body, capped at
          ``max_body_chars`` characters each

        They are opt-in because a bare listing goes into the agent's turn history
        every step; bodies and query strings are only worth that context when the
        agent actually asked for them.
        """
        self.replay_console_status_hints()
        pattern = (url_pattern or "").lower().strip()
        method_filter = (method or "").upper().strip()
        status_filter = (status or "").lower().strip()
        resource_filter = (resource_type or "").lower().strip()
        capped_limit = max(1, min(int(limit or 100), self._max_entries))
        body_chars = max(0, min(int(max_body_chars or 0), self._max_body_bytes))
        scored: List[tuple[int, Dict[str, Any]]] = []
        for key, entry in self.entries.items():
            url = entry.get("url") or ""
            if pattern and pattern not in url.lower():
                continue
            if method_filter and str(entry.get("method") or "").upper() != method_filter:
                continue
            if resource_filter and str(entry.get("resource_type") or "").lower() != resource_filter:
                continue
            if status_filter and not _status_matches(entry.get("status"), entry.get("failed"), status_filter):
                continue
            # Query strings can carry signed URLs, auth tokens, and PII, so the
            # default row exposes only the locator. include_query is the agent's
            # explicit opt-in when it needs the real request URL.
            row: Dict[str, Any] = {
                "id": entry.get("request_id"),
                "url": url if include_query else _redact_url_query(url),
                "method": entry.get("method"),
                "status": entry.get("status"),
                "resource_type": entry.get("resource_type"),
            }
            if entry.get("status_text"):
                row["status_text"] = entry.get("status_text")
            if entry.get("status_source"):
                row["status_source"] = entry.get("status_source")
            if entry.get("mime_type"):
                row["mime_type"] = entry.get("mime_type")
            duration_ms = _duration_ms(entry)
            if duration_ms is not None:
                row["duration_ms"] = duration_ms
            if entry.get("request_ts_ms") is not None:
                row["request_ts_ms"] = entry.get("request_ts_ms")
            if entry.get("response_ts_ms") is not None:
                row["response_ts_ms"] = entry.get("response_ts_ms")
            if entry.get("encoded_data_length") is not None:
                row["size_bytes"] = entry.get("encoded_data_length")
            if entry.get("redirects"):
                row["redirects"] = [
                    {
                        "url": hop.get("url") if include_query else _redact_url_query(str(hop.get("url") or "")),
                        "status": hop.get("status"),
                        "location": hop.get("location") if include_query else None,
                    }
                    for hop in entry.get("redirects") or []
                ]
            if entry.get("failed"):
                row["failed"] = True
                row["failure"] = entry.get("failure")
            body_text = self._bodies.get(key)
            row["body_available"] = body_text is not None
            if include_headers:
                row["request_headers"] = _mask_sensitive_headers(entry.get("request_headers"))
                row["response_headers"] = _mask_sensitive_headers(entry.get("response_headers"))
            if include_bodies:
                request_body = entry.get("request_body")
                if request_body:
                    capped_request_body = len(request_body) > body_chars
                    row["request_body"] = _truncate_text(request_body, body_chars)
                    row["request_body_truncated"] = bool(entry.get("request_body_truncated")) or capped_request_body
                elif entry.get("has_post_data"):
                    row["request_body"] = None
                    row["request_body_note"] = "post data not exposed by CDP for this request"
                if body_text is not None:
                    row["response_body"] = _truncate_text(body_text, body_chars)
                    row["response_body_truncated"] = bool(entry.get("body_truncated")) or len(body_text) > body_chars
                    row["response_body_size"] = entry.get("body_size")
                elif entry.get("body_error"):
                    row["response_body_error"] = entry.get("body_error")
                elif not entry.get("terminal"):
                    row["response_body_note"] = "request still in flight"
                else:
                    row["response_body_note"] = "body not captured (binary or non-text resource)"
            ts = entry.get("response_ts_ms") or entry.get("request_ts_ms") or 0
            scored.append((int(ts), row))
        scored.sort(key=lambda item: item[0], reverse=True)
        rows = [row for _, row in scored[:capped_limit]]
        if clear:
            # Remember every request still in flight, including requests dropped
            # while the buffer was full, so late response events cannot resurrect
            # pre-clear traffic. Terminal events remove IDs from both sets.
            self._ignored_request_ids.update(self._active_request_ids)
            for entry in self.entries.values():
                self._append_diagnostic_entry(entry)
            self.entries.clear()
            self._bodies.clear()
            self._body_byte_sizes.clear()
            self._body_bytes = 0
        return rows

    def query_logs(  # noqa: C901
        self,
        *,
        pattern: str = "",
        limit: int = 100,
        clear: bool = False,
        sources: Optional[List[str]] = None,
        level: str = "",
        status: str = "",
        url_pattern: str = "",
        method: str = "",
        resource_type: str = "",
        include_query: bool = False,
        include_headers: bool = False,
        include_bodies: bool = False,
        max_body_chars: int = 4000,
    ) -> List[Dict[str, Any]]:
        """Return merged console + network log rows, newest first, regex-filterable."""
        compiled = _compile_log_pattern(pattern)
        source_filter = {item.lower() for item in (sources or ["console", "network"])}
        level_filter = (level or "").lower().strip()
        rows: List[tuple[int, Dict[str, Any]]] = []

        if "console" in source_filter:
            for entry in self.console_entries:
                if not isinstance(entry, dict):
                    continue
                entry_level = str(entry.get("level") or entry.get("kind") or "log").lower()
                if (
                    level_filter
                    and entry_level != level_filter
                    and str(entry.get("kind") or "").lower() != level_filter
                ):
                    continue
                text = str(entry.get("text") or "")
                url = str(entry.get("url") or "")
                row = {
                    "source": "console",
                    "timestamp_ms": entry.get("timestamp"),
                    "level": entry_level,
                    "text": text,
                    "url": _redact_url_query(url) if url and not include_query else url or None,
                    "kind": entry.get("kind"),
                }
                if not compiled.search(_log_row_search_text(row)):
                    continue
                ts = int(entry.get("timestamp") or 0)
                rows.append((ts, row))

        if "network" in source_filter:
            network_rows = self.query_requests(
                url_pattern=url_pattern,
                method=method,
                status=status,
                resource_type=resource_type,
                limit=self._max_entries,
                clear=False,
                include_query=include_query,
                include_headers=include_headers,
                include_bodies=include_bodies,
                max_body_chars=max_body_chars,
            )
            for entry in network_rows:
                summary = _network_log_summary(entry)
                row = {
                    "source": "network",
                    "timestamp_ms": entry.get("response_ts_ms") or entry.get("request_ts_ms"),
                    "level": "error"
                    if entry.get("failed") or (isinstance(entry.get("status"), int) and entry.get("status") >= 400)
                    else "info",
                    "text": summary,
                    "url": entry.get("url"),
                    "status": entry.get("status"),
                    "method": entry.get("method"),
                    "resource_type": entry.get("resource_type"),
                    "request_id": entry.get("id"),
                }
                if entry.get("status_source"):
                    row["status_source"] = entry.get("status_source")
                if entry.get("failed"):
                    row["failed"] = True
                    row["failure"] = entry.get("failure")
                if include_headers:
                    row["request_headers"] = entry.get("request_headers")
                    row["response_headers"] = entry.get("response_headers")
                if include_bodies:
                    for key in (
                        "request_body",
                        "response_body",
                        "request_body_truncated",
                        "response_body_truncated",
                        "response_body_note",
                        "body_available",
                    ):
                        if key in entry:
                            row[key] = entry[key]
                if not compiled.search(_log_row_search_text(row)):
                    continue
                ts = int(row.get("timestamp_ms") or 0)
                rows.append((ts, row))

        rows.sort(key=lambda item: item[0], reverse=True)
        selected = [row for _, row in rows[: max(1, min(int(limit or 100), self._max_entries))]]
        if clear:
            if "network" in source_filter:
                self.query_requests(clear=True, limit=1)
            if "console" in source_filter:
                self.console_entries.clear()
        return selected

    def _diagnostics_payloads(
        self,
        *,
        include_response_body_metadata: bool = True,
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        current_entries = [self._redacted_network_entry(entry) for entry in self.entries.values()]
        durable_entries = (list(getattr(self, "_diagnostic_entries", [])) + current_entries)[
            -getattr(self, "_max_entries", 600) :
        ]
        if not include_response_body_metadata:
            body_metadata_fields = {
                "body_size",
                "body_truncated",
                "body_base64_encoded",
                "body_captured_at_ms",
                "body_file",
                "body_error",
            }
            durable_entries = [
                {key: value for key, value in entry.items() if key not in body_metadata_fields}
                for entry in durable_entries
            ]
        network_payload = {
            "agent_id": self.agent_id,
            "task_id": self.task_id,
            "session_id": self.session_id,
            "entry_count": len(durable_entries),
            "redacted": True,
            "response_bodies_included": False,
            "entries": durable_entries,
        }
        console_payload = {
            "agent_id": self.agent_id,
            "task_id": self.task_id,
            "session_id": self.session_id,
            "entry_count": len(getattr(self, "console_entries", [])),
            "redacted": True,
            "entries": list(getattr(self, "console_entries", [])),
        }
        return network_payload, console_payload

    def _write_diagnostics_indexes(self) -> None:
        self.network_dir.mkdir(parents=True, exist_ok=True)
        self.console_dir.mkdir(parents=True, exist_ok=True)
        network_payload, console_payload = self._diagnostics_payloads()
        self.network_index_path.write_text(
            json.dumps(network_payload, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        self.console_index_path.write_text(
            json.dumps(console_payload, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )

    def export_diagnostics_bundle_bytes(self) -> Optional[bytes]:
        """Build the small attachment used by post-run debuggers.

        Raw response body files are deliberately excluded. The two indexes are
        already redacted and bounded per browser task.
        """
        if not self.network_index_path.exists() or not self.console_index_path.exists():
            return None
        network_payload, console_payload = self._diagnostics_payloads(include_response_body_metadata=False)
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "network/index.json",
                json.dumps(network_payload, indent=2, ensure_ascii=False, default=str).encode("utf-8"),
            )
            archive.writestr(
                "console/index.json",
                json.dumps(console_payload, indent=2, ensure_ascii=False, default=str).encode("utf-8"),
            )
        return output.getvalue()

    async def archive_diagnostics_artifacts(self) -> Dict[str, str]:
        """Archive each redacted index and return stable trace references."""
        if _archive_owner_aborted(self) or not archive_enabled():
            return {}
        root_agent_id = current_root_agent_id() or self.agent_id
        refs: Dict[str, str] = {}
        network_payload, console_payload = self._diagnostics_payloads(include_response_body_metadata=False)
        for kind, path, payload in (
            ("network", self.network_index_path, network_payload),
            ("console", self.console_index_path, console_payload),
        ):
            if _archive_owner_aborted(self):
                break
            if not path.exists():
                continue
            result = archive_bytes(
                root_agent_id=root_agent_id,
                path=f"diagnostics/browser/{self.task_id}/{kind}/index.json",
                body=json.dumps(payload, indent=2, ensure_ascii=False, default=str).encode("utf-8"),
                content_type="application/json",
            )
            if isinstance(result, dict) and isinstance(result.get("ref"), str):
                refs[kind] = result["ref"]
        return refs

    async def abort_local(self, *, settle_timeout: float) -> bool:
        """Fence only this instance's capture/archive work and settle its tasks."""
        return await _abort_recording_local(self, list(self._tasks), settle_timeout=settle_timeout)

    async def close(self) -> Optional[Path]:
        if self._closed:
            return self.network_index_path if self.network_index_path.exists() else None
        if self._tasks:
            done, pending = await asyncio.wait(self._tasks, timeout=3)
            for task in pending:
                task.cancel()
            if pending:
                logger.warning(
                    "Browser network response body recorder closed with pending captures",
                    agent_id=self.agent_id,
                    task_id=self.task_id,
                    pending=len(pending),
                    completed=len(done),
                )
        self._closed = True
        self._write_diagnostics_indexes()
        # Terminal cleanup: drop in-flight meta so a closed recorder cannot retain
        # unbounded request classification state after CDP detach.
        active_meta = getattr(self, "_active_request_meta", None)
        if active_meta is not None:
            active_meta.clear()
        logger.info(
            "Browser console and network diagnostics saved",
            agent_id=self.agent_id,
            task_id=self.task_id,
            network_index_path=str(self.network_index_path),
            console_index_path=str(self.console_index_path),
            entry_count=len(self.entries),
            console_entry_count=len(self.console_entries),
        )
        return self.network_index_path


def blocked_resource_requires_payment_cdn(url: str | None) -> bool:
    """True when the blocked resource should latch sticky require_payment_cdn.

    Any absolute http(s) critical-resource URL qualifies — no vendor host
    allowlists. The URL that failed is the URL recovery re-verifies.
    """
    if not url:
        return False
    trimmed = str(url).strip()
    return trimmed.startswith("http://") or trimmed.startswith("https://")


def blocked_resource_url_for_recovery(rejection: Mapping[str, Any] | None) -> str | None:
    """URL to re-verify after promote, or None when CF-clear alone is enough.

    Only critical third-party resource blocks (CDN/script ORB/tunnel) carry a
    re-verify URL. Same-origin API-challenge exits (e.g. Eventim
    ``checkaddtocart``) must NOT — GET-probing that path false-fails recovery
    after a good Steel promote.
    """
    if not isinstance(rejection, Mapping):
        return None
    if str(rejection.get("reason") or "") != _CRITICAL_RESOURCE_BLOCK_REASON:
        return None
    url = str(rejection.get("url") or "").strip()
    return url or None
