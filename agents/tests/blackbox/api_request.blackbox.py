"""Blackbox tests for api_request domain."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup_success():
    setup_mock({
        "/api/external-http/request": {
            "status": 200,
            "json": {
                "ok": True,
                "status": 200,
                "status_text": "OK",
                "url": "https://api.github.com/search/repositories?q=cuda",
                "headers": {"content-type": "application/json; charset=utf-8"},
                "body": {
                    "total_count": 2,
                    "items": [
                        {"full_name": "org/cuda-kernels", "stargazers_count": 100},
                        {"full_name": "org/gpu-lib", "stargazers_count": 50},
                    ],
                },
                "body_encoding": "json",
                "content_type": "application/json; charset=utf-8",
                "elapsed_ms": 120,
                "attempts": 1,
            },
        }
    })


async def test_api_request_happy_path():
    _setup_success()
    with patch("temporalio.activity.heartbeat"):
        from tools.api_request import api_request_activity

        result = await api_request_activity(
            {
                "method": "GET",
                "url": "https://api.github.com/search/repositories",
                "query": {"q": "cuda", "sort": "stars"},
                "headers": {"Authorization": "Bearer test-token"},
            },
            user_id="user-42",
        )

    assert result["ok"] is True
    assert result["body_encoding"] == "json"
    assert result["body"]["total_count"] == 2


async def test_api_request_boundary():
    _setup_success()
    with patch("temporalio.activity.heartbeat"):
        from tools.api_request import api_request_activity

        await api_request_activity(
            {
                "method": "POST",
                "url": "https://api.example.com/search",
                "body": {"q": "cuda"},
                "headers": {"X-Api-Key": "abc123"},
            },
            user_id="user-99",
        )

    call = assert_captured_call(url_contains="/api/external-http/request")
    payload = json.loads(call["requestBody"])
    assert payload["method"] == "POST"
    assert payload["url"] == "https://api.example.com/search"
    assert payload["body"] == {"q": "cuda"}
    assert payload["headers"]["X-Api-Key"] == "abc123"


async def test_api_request_backend_error():
    setup_mock({
        "/api/external-http/request": {
            "status": 400,
            "json": {"error": "INVALID_REQUEST", "message": "bad url"},
        }
    })
    with patch("temporalio.activity.heartbeat"):
        from tools.api_request import api_request_activity

        try:
            await api_request_activity({"method": "GET", "url": "ftp://bad.example"}, user_id="user-1")
            raise AssertionError("Expected ValueError")
        except ValueError as exc:
            assert "bad url" in str(exc)


async def test_api_request_manager_posts_events():
    _setup_success()

    async def fake_execute(activity_fn, args=None, **kwargs):
        return await activity_fn(*(args or []))

    from tools.api_request import ApiRequestManager

    manager = ApiRequestManager()
    with patch("temporalio.activity.heartbeat"), patch(
        "domains.api_request.service.handle_tool_event", new=AsyncMock(return_value=None)
    ):
        result = await manager.execute_tool(
            execute_activity=fake_execute,
            tool_call={
                "tool": "api_request",
                "method": "GET",
                "url": "https://api.github.com/search/repositories",
                "headers": {"Authorization": "Bearer test-token"},
            },
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-42",
        )

    assert "result" in result
    assert result["result"]["ok"] is True


async def _run_all():
    tests = [
        ("happy_path", test_api_request_happy_path),
        ("boundary", test_api_request_boundary),
        ("backend_error", test_api_request_backend_error),
        ("manager_events", test_api_request_manager_posts_events),
    ]
    passed = 0
    for name, fn in tests:
        setup_mock({})
        try:
            await fn()
            passed += 1
            print(f"✅ api_request.{name}")
        finally:
            teardown_mock()
    return passed, len(tests)


if __name__ == "__main__":
    passed, total = asyncio.run(_run_all())
    if passed != total:
        raise SystemExit(1)
    print(f"RESULTS: {passed}/{total} passed")
