"""Blackbox tests for httpx_capture domain.

Tests the capture harness public API directly (not through _test_utils wrapper).
"""

import asyncio
import json
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


async def test_credential_exchanges_keep_wire_data_but_not_captures():
    import httpx
    from helpers.httpx_capture import clear_captures, get_captures

    secret = "fake-capture-credential-9d1c5ea72a"
    for path in (
        "/oauth/token",
        "/api/integrations/lantern-people/credentials/token",
        "/api/integrations/lantern-people/credentials/upload",
    ):
        clear_captures()
        received = []
        payload = "refresh_token=" + secret

        def handler(request):
            received.append((request.content.decode(), request.headers["authorization"]))
            return httpx.Response(200, json={"accessToken": secret, "refresh_token": secret})

        setup_mock_fn(handler)
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://credential.example.test" + path + "?refresh_hint=" + secret,
                content=payload,
                headers={"Authorization": "Bearer " + secret},
            )
        assert received == [(payload, "Bearer " + secret)]
        assert response.json()["accessToken"] == secret
        captured = get_captures()
        assert len(captured) == 1
        assert secret not in json.dumps(captured), "credential exchange leaked into capture"
        assert captured[0]["requestBody"] is None
        assert captured[0]["responseBody"] is None
        assert captured[0]["responseStatus"] == 200
        assert captured[0]["requestHeaders"] == {}
    clear_captures()
    setup_mock_fn(lambda request: httpx.Response(200, json={"results": [{"name": "Ada"}]}))
    async with httpx.AsyncClient() as client:
        await client.post("https://people.example.test/v1/operations/people_search", json={"query": "founders"})
    assert json.loads(get_captures()[0]["requestBody"]) == {"query": "founders"}
    assert json.loads(get_captures()[0]["responseBody"]) == {"results": [{"name": "Ada"}]}


async def test_local_credential_exchange_uses_real_transport_and_metadata_only_capture():
    """Real loopback credentials stay visible as safe metadata without broad localhost capture."""
    import httpx
    import helpers.httpx_capture as capture

    secret = "fixture-local-credential-never-record-this"
    wire_requests = []
    handlers = set()

    async def serve(reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        try:
            raw_headers = await reader.readuntil(b"\r\n\r\n")
            lines = raw_headers.decode().split("\r\n")
            headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
            body = await reader.readexactly(int(headers.get("Content-Length", "0")))
            wire_requests.append((lines[0], headers, body))
            response = json.dumps({"accessToken": secret, "refresh_token": secret}).encode()
            writer.write(
                b"HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(response)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + response
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)

    teardown_mock()
    assert capture._mock_handler is None, "This regression must exercise the actual wrapped transport"
    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    address = server.sockets[0].getsockname()
    origin = f"http://127.0.0.1:{address[1]}"
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
            ordinary = await client.get(origin + "/health")
            assert ordinary.status_code == 201
            assert capture.get_captures() == [], "Ordinary local infrastructure must remain uncaptured"
            for path in (
                "/oauth/token",
                "/api/integrations/lantern-people/credentials/token",
                "/api/integrations/lantern-people/credentials/upload",
            ):
                capture.clear_captures()
                payload = "refresh_token=" + secret
                response = await client.post(
                    origin + path + "?refresh_hint=" + secret,
                    content=payload,
                    headers={"Authorization": "Bearer " + secret},
                )
                assert response.status_code == 201
                assert response.json()["accessToken"] == secret
                _, received_headers, received_body = wire_requests[-1]
                assert received_headers["Authorization"] == "Bearer " + secret
                assert received_body.decode() == payload
                entries = capture.get_captures()
                assert len(entries) == 1, "A real local credential exchange must publish safe response metadata"
                entry = entries[0]
                assert entry["url"] == origin + path
                assert entry["method"] == "POST" and entry["responseStatus"] == 201
                assert entry["requestHeaders"] == {} and entry["requestBody"] is None
                assert entry["responseBody"] is None
                assert secret not in json.dumps(entries), "Local credentials leaked into capture"
    finally:
        server.close()
        await server.wait_closed()
        if handlers:
            await asyncio.gather(*list(handlers))
        teardown_mock()


async def run_all_tests():
    print("httpx-capture blackbox tests:")
    r = BlackboxResult()
    await r.record_async(
        "local_credential_exchange_metadata_real_transport",
        test_local_credential_exchange_uses_real_transport_and_metadata_only_capture,
    )
    await r.record_async(
        "credential_exchange_capture_privacy", test_credential_exchanges_keep_wire_data_but_not_captures
    )
    r.record("install_and_uninstall", test_install_and_uninstall)
    r.record("get_captures_empty", test_get_captures_empty)
    r.record("set_and_clear_mock_handler", test_set_and_clear_mock_handler)
    r.record("get_captures_after_filter", test_get_captures_after_filter)
    await r.record_async("mock_handler_wraps_proxy_mount_transports", test_mock_handler_wraps_proxy_mount_transports)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
