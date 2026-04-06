"""Blackbox tests for x402-bazaar domain."""

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
        "api.cdp.coinbase.com/platform/v2/x402/discovery/resources": {
            "status": 200,
            "json": {
                "resources": [
                    {
                        "url": "https://api.example.com/premium/data",
                        "description": "Premium data feed",
                        "price": {"amount": 100, "currency": "USD"},
                    },
                ],
            },
        },
    })


async def test_search_bazaar_happy_path():
    """search_x402_bazaar_activity returns available resources."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.x402_bazaar import search_x402_bazaar_activity

        result = await search_x402_bazaar_activity(
            max_price_cents=500,
            keyword="data",
        )

    assert isinstance(result, dict) and "resources" in result


async def test_search_bazaar_boundary():
    """Verify GET request to Coinbase x402 discovery endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.x402_bazaar import search_x402_bazaar_activity

        await search_x402_bazaar_activity(keyword="premium")

    call = assert_captured_call(
        url_contains="api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
        method="GET",
    )


async def run_all_tests():
    print("x402-bazaar blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_search_bazaar_happy_path)
    await r.record_async("boundary", test_search_bazaar_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
