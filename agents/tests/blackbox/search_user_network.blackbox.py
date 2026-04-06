"""Blackbox tests for search-user-network domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock({
        "/api/people/search": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "id": "person-1",
                        "firstName": "Alice",
                        "lastName": "Smith",
                        "company": "TechCorp",
                        "score": 0.95,
                    },
                    {
                        "id": "person-2",
                        "firstName": "Bob",
                        "lastName": "Jones",
                        "company": "StartupInc",
                        "score": 0.82,
                    },
                ],
                "count": 2,
            },
        },
    })


async def test_search_user_network_happy_path():
    """search_user_network_activity returns matching people."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.search_user_network import search_user_network_activity

        result = await search_user_network_activity(
            user_id="user-42",
            tool_call={"first_name": "Alice"},
        )

    assert result["count"] == 2
    assert len(result["results"]) == 2


async def test_search_user_network_boundary():
    """Verify exact HTTP request sent to backend people search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.search_user_network import search_user_network_activity

        await search_user_network_activity(
            user_id="user-99",
            tool_call={
                "first_name": "Jane",
                "last_name": "Doe",
                "company": "Google",
                "profession": "Engineer",
            },
        )

    call = assert_captured_call(
        url_contains="/api/people/search",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body.get("first_name") == "Jane"
    assert body.get("last_name") == "Doe"
    assert body.get("company") == "Google"

    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


async def run_all_tests():
    print("search-user-network blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_search_user_network_happy_path)
    await r.record_async("boundary", test_search_user_network_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
