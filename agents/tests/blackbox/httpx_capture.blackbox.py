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
                "/api/iphone/leases/" + secret + "/operations",
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
                assert entry["url"] == ("https://private.invalid/api/iphone" if path.startswith("/api/iphone/") else origin + path)
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
    await r.record_async("phone_transport_capture_privacy", test_phone_transport_captures_metadata_only_and_preserves_wire)
    await r.record_async(
        "phone_mixed_case_transport_privacy", test_phone_mixed_case_transport_privacy
    )
    await r.record_async(
        "phone_mixed_case_never_enters_browser_cache", test_phone_mixed_case_never_enters_browser_cache
    )
    return r.all_passed





async def test_phone_transport_captures_metadata_only_and_preserves_wire():
    import httpx
    import helpers.httpx_capture as hc
    canary='CANARY-PHONE-INPUT-OBSERVATION'
    from providers.demo_cache.browser_http import should_cache
    for private_url in ('https://backend.test/api/iphone', 'https://backend.test/api/iphone/leases/private/frame'):
        assert not should_cache('GET', 'fetch', private_url), 'phone bodies must not become replay fixtures'
    paths=('/api/iphone','/api/iphone/','/api/iphone/capability','/api/iphone/interactions/'+canary,
           '/api/iphone/leases/'+canary+'/operations','/api/iphone/leases/'+canary+'/frame')
    def backend(request):
        assert canary in request.content.decode()
        return httpx.Response(200,json={'result':canary},headers={'x-private':canary})
    hc.set_mock_handler(backend)
    try:
        async with httpx.AsyncClient() as client:
            for path in paths:
                hc.clear_captures()
                response=await client.post('https://backend.test'+path+'?opaque='+canary,json={'args':{'s':canary}},headers={'x-api-key':canary,'x-private':canary})
                assert response.json()['result']==canary
                entry=hc.get_captures()[0]
                assert canary not in json.dumps(entry), 'phone wire data leaked into capture'
                assert entry['url']=='https://private.invalid/api/iphone'
                assert entry['requestHeaders']=={} and entry['requestBody'] is None and entry['responseBody'] is None
                assert entry['responseStatus']==200
        def failure(request):
            raise httpx.ReadError('echo '+canary+' '+str(request.url))
        hc.set_mock_handler(failure)
        hc.clear_captures()
        async with httpx.AsyncClient() as client:
            try:
                await client.get('https://backend.test/api/iphone/leases/'+canary)
            except httpx.ReadError as error:
                assert canary not in str(error)
            else:
                raise AssertionError('expected failure')
        assert hc.get_captures()[0]['error']=='Private phone request failed'
        assert canary not in json.dumps(hc.get_captures())
        # A similarly named, unrelated API must retain ordinary capture behavior.
        hc.set_mock_handler(lambda request:httpx.Response(200,json={'ordinary':'visible'}))
        hc.clear_captures()
        async with httpx.AsyncClient() as client:
            await client.get('https://backend.test/api/iphone-other')
        assert 'visible' in hc.get_captures()[0]['responseBody']
    finally:
        hc.clear_mock_handler()
        hc.clear_captures()


async def test_phone_mixed_case_transport_privacy():
    """Route-equivalent spelling must not opt a private exchange into capture."""
    import traceback

    import httpx
    import helpers.httpx_capture as hc

    canary = "Unregistered-Phone-Secret-CaSe-6a"
    payload = {"args": {"s": canary}, "unchanged": "MiXeD-BODY"}
    paths = (
        "/API/IPHONE",
        "/API/IPHONE/",
        f"/Api/Iphone/leases/{canary}/operations",
        f"/aPi/iPhOnE/leases/{canary}/frame",
    )
    seen = []

    def backend(request):
        assert request.url.path == paths[len(seen)]
        assert request.url.username == canary
        assert request.url.password == canary
        assert request.url.query == f"opaque={canary}".encode()
        assert request.url.fragment == canary
        assert request.headers["x-private"] == canary
        assert request.headers["x-api-key"] == canary
        assert json.loads(request.content) == payload
        seen.append(request.url.path)
        return httpx.Response(503, json=payload, headers={"x-private": canary})

    try:
        hc.set_mock_handler(backend)
        async with httpx.AsyncClient() as client:
            for path in paths:
                hc.clear_captures()
                response = await client.post(
                    f"https://{canary}:{canary}@Backend.test{path}?opaque={canary}#{canary}",
                    json=payload,
                    headers={"x-private": canary, "x-api-key": canary},
                )
                assert response.status_code == 503
                assert response.json() == payload
                assert response.headers["x-private"] == canary
                entries = hc.get_captures()
                assert len(entries) == 1
                entry = entries[0]
                assert canary not in json.dumps(entry), "Mixed-case phone capture leaked unregistered secret"
                assert entry["url"] == "https://private.invalid/api/iphone"
                assert entry["requestHeaders"] == {}
                assert entry["requestBody"] is None and entry["responseBody"] is None
                assert entry["responseStatus"] == 503 and entry["error"] is None
        assert seen == list(paths)

        def failure(request):
            raise httpx.ReadError(f"echo {canary} {request.url}", request=request)

        hc.set_mock_handler(failure)
        async with httpx.AsyncClient() as client:
            for path in paths:
                hc.clear_captures()
                try:
                    await client.get(
                        f"https://{canary}:{canary}@Backend.test{path}?opaque={canary}#{canary}",
                        headers={"x-private": canary},
                    )
                except httpx.ReadError as error:
                    assert str(error) == "Private phone request failed"
                    assert canary not in "".join(traceback.format_exception(error))
                else:
                    raise AssertionError("Expected transport failure")
                entry = hc.get_captures()[0]
                assert entry["error"] == "Private phone request failed"
                assert entry["url"] == "https://private.invalid/api/iphone"
                assert canary not in json.dumps(entry)

        # Prefix lookalikes retain normal URL, body, response and error semantics.
        ordinary = {"public": "Ordinary-CaSe-Sensitive-Body"}
        hc.set_mock_handler(lambda request: httpx.Response(200, json=json.loads(request.content)))
        async with httpx.AsyncClient() as client:
            for path in ("/api/iphone-other", "/API/IPHONE-other"):
                hc.clear_captures()
                response = await client.post(f"https://backend.test{path}", json=ordinary)
                assert response.json() == ordinary
                entry = hc.get_captures()[0]
                assert entry["url"] == f"https://backend.test{path}"
                assert json.loads(entry["requestBody"]) == ordinary
                assert json.loads(entry["responseBody"]) == ordinary
    finally:
        hc.clear_mock_handler()
        hc.clear_captures()


async def test_phone_mixed_case_never_enters_browser_cache():
    """Neither cache read, write, key construction nor logging may see secrets."""
    from unittest.mock import AsyncMock, patch

    from providers.demo_cache import browser_http

    canary = "Unregistered-Cache-Secret-CaSe-6a"
    paths = ("/API/IPHONE", f"/Api/Iphone/leases/{canary}/operations", "/aPi/iPhOnE/frame")
    cache = browser_http.BrowserHttpCache("synthetic phone privacy")
    with (
        patch.object(browser_http.cache_client, "cache_get", new_callable=AsyncMock) as get,
        patch.object(browser_http.cache_client, "cache_set", new_callable=AsyncMock) as put,
        patch.object(browser_http.normalize, "browser_http_key") as key,
        patch.object(browser_http, "logger") as logger,
    ):
        for path in paths:
            url = f"https://{canary}:{canary}@Backend.test{path}?opaque={canary}#{canary}"
            for method, resource in (("GET", "fetch"), ("HEAD", "document"), ("POST", "xhr")):
                assert not browser_http.should_cache(method, resource, url), "Mixed-case phone traffic remains replayable"
                assert await cache.lookup(method, url, resource, {"x-private": canary}, canary) is None
                assert not await cache.record(method, url, resource, 200, {"x-private": canary}, canary.encode(), {"x-private": canary}, canary)
        get.assert_not_awaited()
        put.assert_not_awaited()
        key.assert_not_called()
        assert not logger.mock_calls
    for path in ("/api/iphone-other", "/API/IPHONE-other"):
        url = f"https://backend.test{path}"
        assert browser_http.should_cache("GET", "fetch", url)
        assert browser_http.should_cache("POST", "xhr", url)
        assert not browser_http.should_cache("POST", "document", url)


if __name__ == "__main__":
    asyncio.run(run_all_tests())
