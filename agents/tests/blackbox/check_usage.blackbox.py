"""Blackbox tests for check-usage domain."""

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
        "/api/credits/usage": {
            "status": 200,
            "json": {
                "remaining": 100.0,
                "used": 50.0,
                "total": 150.0,
            },
        },
    })


async def test_happy_path():
    """check_user_usage returns dict with has_credits=True when remaining > 0."""
    _setup()
    with patch("temporalio.activity.heartbeat"), \
         patch("temporalio.activity.logger"):
        from helpers.check_usage import check_user_usage

        result = await check_user_usage("user-42")

    assert result is not None
    assert result["has_credits"] is True
    assert result["remaining"] == 100.0
    assert result["used"] == 50.0
    assert result["total"] == 150.0


async def test_boundary():
    """Verify GET to /api/credits/usage with userId param and X-API-Key header."""
    _setup()
    with patch("temporalio.activity.heartbeat"), \
         patch("temporalio.activity.logger"):
        from helpers.check_usage import check_user_usage

        await check_user_usage("user-99")

    call = assert_captured_call(
        url_contains="/api/credits/usage",
        method="GET",
        header_present="X-API-Key",
    )
    assert "userId=user-99" in call["url"]


async def run_all_tests():
    print("check-usage blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
