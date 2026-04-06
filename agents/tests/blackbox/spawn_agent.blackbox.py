"""Blackbox tests for spawn-agent domain."""

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
        "/api/people": {
            "status": 200,
            "json": {
                "people": [
                    {"id": "p-1", "firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551111111"},
                    {"id": "p-2", "firstName": "Bob", "lastName": "Jones", "phoneNumber": "+15552222222"},
                ],
                "count": 2,
            },
        },
    })


async def test_fetch_full_network_metadata_happy_path():
    """fetch_full_network_metadata returns formatted contact metadata."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_agent import fetch_full_network_metadata

        result = await fetch_full_network_metadata(user_id="user-42")

    # Returns a string with contact metadata
    assert isinstance(result, str)


async def test_fetch_full_network_metadata_boundary():
    """Verify GET request to backend people endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_agent import fetch_full_network_metadata

        await fetch_full_network_metadata(user_id="user-99")

    call = assert_captured_call(
        url_contains="/api/people",
        method="GET",
        header_present="X-API-Key",
    )
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


async def run_all_tests():
    print("spawn-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_network_metadata_happy_path", test_fetch_full_network_metadata_happy_path)
    await r.record_async("fetch_network_metadata_boundary", test_fetch_full_network_metadata_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
