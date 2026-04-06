"""Blackbox tests for people-search domain."""

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
        "api.exa.ai/search": {
            "status": 200,
            "json": {
                "results": [
                    {
                        "title": "Jane Smith - CTO at TechCorp",
                        "url": "https://linkedin.com/in/janesmith",
                        "text": "Jane Smith is a seasoned CTO...",
                    },
                    {
                        "title": "John Doe - VP Engineering",
                        "url": "https://linkedin.com/in/johndoe",
                        "text": "John Doe leads engineering at...",
                    },
                ],
            },
        },
    })


async def test_people_search_happy_path():
    """people_search_activity returns formatted results from Exa."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.people_search import people_search_activity

        result = await people_search_activity(
            query="CTO at AI startups in SF",
            max_results=5,
        )

    assert "candidates" in result or "results" in result
    assert result.get("provider") == "exa" or result.get("query") == "CTO at AI startups in SF"


async def test_people_search_boundary():
    """Verify exact HTTP request sent to Exa search API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.people_search import people_search_activity

        await people_search_activity(
            query="Data scientists at Google",
            max_results=10,
        )

    call = assert_captured_call(
        url_contains="api.exa.ai/search",
        method="POST",
        body_contains={"query": "Data scientists at Google", "category": "people"},
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["numResults"] == 10
    assert "contents" in body


async def run_all_tests():
    print("people-search blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_people_search_happy_path)
    await r.record_async("boundary", test_people_search_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
