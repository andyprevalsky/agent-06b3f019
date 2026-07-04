"""Blackbox tests for httpx_capture domain.

Tests the capture harness public API directly (not through _test_utils wrapper).
"""

import asyncio
import os

from _test_utils import (
    BlackboxResult,
    get_captured_requests,
    setup_mock,
    teardown_mock,
    assert_captured_call,
    setup_mock_fn,
)


def test_install_and_uninstall():
    """install_capture activates, uninstall_capture deactivates and restores."""
    from helpers.httpx_capture import install_capture, uninstall_capture, _installed, _original_init

    # Capture should already be installed by _test_utils import
    import helpers.httpx_capture as hc
    assert hc._installed is True, "Capture should be installed"

    # Uninstall
    uninstall_capture()
    assert hc._installed is False, "Capture should be uninstalled"
    assert hc._original_init is None, "Original init should be cleared"

    # Re-install for subsequent tests
    install_capture()
    assert hc._installed is True, "Capture should be re-installed"


def test_get_captures_empty():
    """After clear_captures, get_captures returns empty list."""
    from helpers.httpx_capture import clear_captures, get_captures

    clear_captures()
    result = get_captures()

    assert result == [], f"Expected empty list, got {result}"


def test_set_and_clear_mock_handler():
    """set_mock_handler installs handler, clear_mock_handler removes it."""
    import helpers.httpx_capture as hc
    from helpers.httpx_capture import set_mock_handler, clear_mock_handler

    def my_handler(request):
        import httpx
        return httpx.Response(200, json={"ok": True})

    set_mock_handler(my_handler)
    assert hc._mock_handler is my_handler, "Mock handler should be set"

    clear_mock_handler()
    assert hc._mock_handler is None, "Mock handler should be cleared"


def test_get_captures_after_filter():
    """get_captures(after=N) returns only captures with id > N."""
    import helpers.httpx_capture as hc
    from helpers.httpx_capture import clear_captures, get_captures, get_next_id

    clear_captures()

    # Manually insert fake captures to test filtering without making HTTP calls
    hc._captures.append({"id": hc._next_id, "url": "https://example.com/a"})
    hc._next_id += 1
    hc._captures.append({"id": hc._next_id, "url": "https://example.com/b"})
    mid_id = hc._next_id
    hc._next_id += 1
    hc._captures.append({"id": hc._next_id, "url": "https://example.com/c"})
    hc._next_id += 1

    # All captures
    all_caps = get_captures()
    assert len(all_caps) == 3

    # Filter: only captures after mid_id
    filtered = get_captures(after=mid_id)
    assert len(filtered) == 1
    assert filtered[0]["url"] == "https://example.com/c"

    # Clean up
    clear_captures()


async def test_mock_handler_wraps_proxy_mount_transports():
    """Mocked captures must intercept proxy/env mount transports, not only _transport."""
    import httpx

    old_env = {
        "HTTPS_PROXY": os.environ.get("HTTPS_PROXY"),
        "HTTP_PROXY": os.environ.get("HTTP_PROXY"),
        "ALL_PROXY": os.environ.get("ALL_PROXY"),
        "NO_PROXY": os.environ.get("NO_PROXY"),
    }
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={"ok": True})

    try:
        os.environ["HTTPS_PROXY"] = "http://127.0.0.1:9"
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        os.environ["ALL_PROXY"] = "http://127.0.0.1:9"
        os.environ["NO_PROXY"] = ""
        setup_mock_fn(handler)

        async with httpx.AsyncClient(timeout=1.0) as client:
            response = await client.get("https://wmh.example.test/world_models")

        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert calls == ["https://wmh.example.test/world_models"]
        captured = get_captured_requests()
        assert len(captured) == 1
        assert captured[0]["url"] == "https://wmh.example.test/world_models"
        assert captured[0]["responseStatus"] == 200
    finally:
        teardown_mock()
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def run_all_tests():
    print("httpx-capture blackbox tests:")
    r = BlackboxResult()
    r.record("install_and_uninstall", test_install_and_uninstall)
    r.record("get_captures_empty", test_get_captures_empty)
    r.record("set_and_clear_mock_handler", test_set_and_clear_mock_handler)
    r.record("get_captures_after_filter", test_get_captures_after_filter)
    await r.record_async("mock_handler_wraps_proxy_mount_transports", test_mock_handler_wraps_proxy_mount_transports)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
