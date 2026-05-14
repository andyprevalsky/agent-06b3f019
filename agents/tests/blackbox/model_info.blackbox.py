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


async def test_rose_pool_returns_200k_from_seed():
    """Rose pool ids resolve to 200k without hitting OpenRouter."""
    # Don't call _setup() — we want to prove no HTTP is made.
    import helpers.model_info as mi
    # Restore the seeded cache (other tests may have cleared it).
    mi._model_context_cache.clear()
    mi._model_context_cache.update(mi._ROSE_POOL_CONTEXT_WINDOWS)
    initial_request_count = len(get_captured_requests() or [])

    with patch("temporalio.activity.heartbeat"):
        from helpers.model_info import get_model_context_window
        for pool_id in ("rose-labs/rose-1-lite", "rose-labs/rose-1-ultra", "rose-labs/rose-1-browser-use"):
            assert await get_model_context_window(pool_id) == 200_000, pool_id

    # Cache hits, no new HTTP calls.
    assert len(get_captured_requests() or []) == initial_request_count


async def test_unknown_model_default_is_200k():
    """Unknown model falls back to 200k (not 100k) — every routed model is ≥200k."""
    _setup()
    import helpers.model_info as mi
    mi._model_context_cache.clear()

    with patch("temporalio.activity.heartbeat"):
        from helpers.model_info import get_model_context_window

        result = await get_model_context_window("not/a/real-model")

    assert result == 200_000


async def run_all_tests():
    print("model-info blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_happy_path)
    await r.record_async("boundary", test_boundary)
    await r.record_async("rose_pool_returns_200k_from_seed", test_rose_pool_returns_200k_from_seed)
    await r.record_async("unknown_model_default_is_200k", test_unknown_model_default_is_200k)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
