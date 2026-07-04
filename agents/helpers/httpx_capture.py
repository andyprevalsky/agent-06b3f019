"""
Outbound HTTP capture harness for blackbox testing.

Monkey-patches httpx.AsyncClient to record all outbound HTTP calls when
BLACKBOX_TEST_CAPTURE_OUTBOUND=1 is set. Zero overhead when inactive.

Modeled after back-end/src/providers/fetchCapture.ts.

Usage in tests:
    from helpers.httpx_capture import install_capture, get_captures, clear_captures

    install_capture()  # Call once before tests

    # ... run code that makes HTTP calls via httpx ...

    captures = get_captures()
    assert len(captures) == 1
    assert captures[0]["url"] == "https://api.example.com/v1/search"

    clear_captures()  # Reset between tests
"""

import os
import threading
import time
import warnings
from datetime import datetime, timezone
from typing import Any

import httpx

# ── Module state ──────────────────────────────────────────────

_captures: list[dict[str, Any]] = []
_next_id: int = 1
_installed: bool = False
_original_init: Any = None
_lock = threading.Lock()

# Sensitive headers to redact in capture output
_REDACT_HEADERS = frozenset(
    {
        "authorization",
        "apikey",
        "x-api-key",
        "x-supermemory-api-key",
        "x-perplexity-key",
    }
)

# Optional mock handler: when set, all outbound (non-localhost) calls go
# through capture → mock instead of capture → real network.
# Set via set_mock_handler(), cleared via clear_mock_handler().
_mock_handler: Any = None


# ── Public API ────────────────────────────────────────────────


def is_active() -> bool:
    """Check if capture mode is enabled via environment variable."""
    return os.environ.get("BLACKBOX_TEST_CAPTURE_OUTBOUND") == "1"


def install_capture() -> None:
    """
    Install the httpx capture monkey-patch.
    Only patches when BLACKBOX_TEST_CAPTURE_OUTBOUND=1 is set.
    Safe to call multiple times (idempotent).
    """
    global _installed, _original_init
    if _installed:
        return
    if not is_active():
        return

    _original_init = httpx.AsyncClient.__init__

    def patched_init(self: httpx.AsyncClient, *args: Any, **kwargs: Any) -> None:
        assert _original_init is not None
        _original_init(self, *args, **kwargs)
        wrapped_any = False
        if hasattr(self, "_transport") and self._transport is not None:
            # If a mock handler is set, capture wraps the mock transport
            # instead of the real transport. Requests still get recorded
            # in captures but responses come from the mock.
            if _mock_handler is not None:
                mock_transport = httpx.MockTransport(_mock_handler)
                self._transport = _CapturingTransport(mock_transport)
            else:
                self._transport = _CapturingTransport(self._transport)
            wrapped_any = True
        if hasattr(self, "_mounts") and isinstance(self._mounts, dict):
            for pattern, transport in list(self._mounts.items()):
                if transport is None or isinstance(transport, _CapturingTransport):
                    continue
                if _mock_handler is not None:
                    self._mounts[pattern] = _CapturingTransport(httpx.MockTransport(_mock_handler))
                else:
                    self._mounts[pattern] = _CapturingTransport(transport)
                wrapped_any = True
        if not wrapped_any:
            warnings.warn(
                "httpx_capture: AsyncClient transports not found — capture disabled. "
                "This may indicate an incompatible httpx version.",
                stacklevel=2,
            )

    httpx.AsyncClient.__init__ = patched_init  # type: ignore[assignment]
    _installed = True


def uninstall_capture() -> None:
    """Remove the monkey-patch and restore original httpx.AsyncClient.__init__."""
    global _installed, _original_init
    if not _installed or _original_init is None:
        return
    httpx.AsyncClient.__init__ = _original_init  # type: ignore[assignment]
    _original_init = None
    _installed = False


def get_captures(after: int = 0) -> list[dict[str, Any]]:
    """Get captured calls, optionally filtered to calls with id > after."""
    with _lock:
        if after > 0:
            return [c for c in _captures if c["id"] > after]
        return list(_captures)


def clear_captures() -> None:
    """Clear the capture buffer. IDs continue to increment for uniqueness."""
    global _captures
    with _lock:
        _captures = []


def get_next_id() -> int:
    """Get the current next-id counter (useful for after-filtering)."""
    with _lock:
        return _next_id


def set_mock_handler(
    handler: Any,  # Callable[[httpx.Request], httpx.Response]
) -> None:
    """
    Set a mock handler for all outbound HTTP calls.
    When set, the capture harness routes outbound calls through the mock
    instead of the real network. Captures are still recorded.

    The handler receives an httpx.Request and must return an httpx.Response:
        def handler(request: httpx.Request) -> httpx.Response:
            if "supermemory.ai" in str(request.url):
                return httpx.Response(200, json={"id": "doc-123"})
            return httpx.Response(404)
    """
    global _mock_handler
    _mock_handler = handler


def clear_mock_handler() -> None:
    """Remove the mock handler. Subsequent calls go to the real network."""
    global _mock_handler
    _mock_handler = None


# ── Transport wrapper ─────────────────────────────────────────


class _CapturingTransport(httpx.AsyncBaseTransport):
    """Wraps an httpx transport to record all outbound HTTP calls."""

    def __init__(self, wrapped: httpx.AsyncBaseTransport) -> None:
        self._wrapped = wrapped

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        global _next_id
        url = str(request.url)

        # Skip localhost/loopback capture when NOT using a mock handler
        # (avoids capturing calls to test infrastructure like health checks).
        # When a mock handler IS active, all calls should be captured since
        # they are test-controlled.
        if _mock_handler is None and ("localhost" in url or "127.0.0.1" in url or "0.0.0.0" in url):
            return await self._wrapped.handle_async_request(request)

        with _lock:
            capture_id = _next_id
            _next_id += 1
        start = time.monotonic()

        # Serialize request
        method = request.method
        headers = dict(request.headers)
        redacted_headers = {k: _redact_header(k, v) for k, v in headers.items()}

        request_body: str | None = None
        if request.content:
            try:
                request_body = request.content.decode("utf-8")
            except (UnicodeDecodeError, AttributeError):
                request_body = "[binary body]"

        entry: dict[str, Any] = {
            "id": capture_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "url": url,
            "method": method,
            "requestHeaders": redacted_headers,
            "requestBody": request_body,
            "responseStatus": None,
            "responseBody": None,
            "durationMs": 0,
            "error": None,
            "cached": False,
        }

        try:
            response = await self._wrapped.handle_async_request(request)

            # Buffer the response stream so we can capture the body
            body_bytes = b""
            try:
                async for chunk in response.stream:
                    body_bytes += chunk
            finally:
                await response.stream.aclose()

            entry["durationMs"] = int((time.monotonic() - start) * 1000)
            entry["responseStatus"] = response.status_code

            # Capture response body (truncated)
            try:
                resp_text = body_bytes.decode("utf-8")
            except UnicodeDecodeError:
                resp_text = "[binary response]"

            if len(resp_text) > 2000:
                entry["responseBody"] = resp_text[:2000] + "...[truncated]"
            else:
                entry["responseBody"] = resp_text

            with _lock:
                _captures.append(entry)

            # Return a new response with the buffered body
            return httpx.Response(
                status_code=response.status_code,
                headers=response.headers,
                stream=httpx.ByteStream(body_bytes),
                request=request,
            )

        except Exception as e:
            entry["durationMs"] = int((time.monotonic() - start) * 1000)
            entry["error"] = str(e)
            with _lock:
                _captures.append(entry)
            raise

    async def aclose(self) -> None:
        await self._wrapped.aclose()


# ── Helpers ───────────────────────────────────────────────────


def _redact_header(key: str, value: str) -> str:
    """Redact sensitive header values for the capture log."""
    if key.lower() in _REDACT_HEADERS:
        return "[redacted]"
    return value
