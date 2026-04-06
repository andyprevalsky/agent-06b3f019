"""Blackbox tests for model-info domain."""

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
        "/models": {
            "status": 200,
            "json": {
                "data": [
                    {
                        "id": "anthropic/claude-sonnet-4.5",
                        "context_length": 200000,
                    },
                    {
                        "id": "openai/gpt-4-turbo",
                        "context_length": 128000,
                    },
                ],
            },
        },
    })


async def test_happy_path():
    """get_model_context_window returns the correct context window for a known model."""
    _setup()
    # Clear the module-level cache to ensure we hit the HTTP endpoint
    import helpers.model_info as mi
    mi._model_context_cache.clear()

    with patch("temporalio.activity.heartbeat"):
        from helpers.model_info import get_model_context_window

        result = await get_model_context_window("anthropic/claude-sonnet-4.5")

    assert result == 200000


async def test_boundary():
    """Verify GET to /models with Authorization header."""
    _setup()
    import helpers.model_info as mi
    mi._model_context_cache.clear()

    with patch("temporalio.activity.heartbeat"):
        from helpers.model_info import get_model_context_window

        await get_model_context_window("openai/gpt-4-turbo")

    call = assert_captured_call(
        url_contains="/models",
        method="GET",
        header_present="authorization",
    )


async def run_all_tests():
    print("model-info blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
