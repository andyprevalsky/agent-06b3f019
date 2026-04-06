"""Blackbox tests for web-fetch domain."""

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
        "api.parallel.ai/v1beta/extract": {
            "status": 200,
            "json": {
                "text": "This is the extracted content from the webpage.",
                "title": "Example Page",
                "url": "https://example.com/article",
            },
        },
    })


async def test_web_fetch_happy_path():
    """web_fetch_activity returns extracted content from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        result = await web_fetch_activity(
            url="https://example.com/article",
            objective="Extract the main content",
        )

    assert "text" in result or "content" in result or "title" in result


async def test_web_fetch_boundary():
    """Verify HTTP request sent to Parallel AI extract endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_fetch import web_fetch_activity

        await web_fetch_activity(
            url="https://example.com/research",
            objective="Get research findings",
            excerpts=True,
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/extract",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert "https://example.com/research" in json.dumps(body)


async def run_all_tests():
    print("web-fetch blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_web_fetch_happy_path)
    await r.record_async("boundary", test_web_fetch_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
