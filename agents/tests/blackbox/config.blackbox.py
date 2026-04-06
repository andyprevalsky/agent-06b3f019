"""Blackbox tests for config domain."""

import asyncio
import os
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    teardown_mock,
)


# Minimal env vars required to call load_config() without KeyError
_MINIMAL_ENV = {
    "TEMPORAL_API_KEY": "test-temporal-key",
    "TEMPORAL_NAMESPACE": "test-ns",
    "TEMPORAL_ADDRESS": "localhost:7233",
    "OPENROUTER_API_KEY": "test-or-key",
    "OPENAI_API_KEY": "test-openai-key",
    "PERPLEXITY_API_KEY": "test-pplx-key",
    "GEMINI_API_KEY": "test-gemini-key",
    "BROWSERBASE_API_KEY": "test-bb-key",
    "BROWSERBASE_PROJECT_ID": "test-bb-proj",
    "PARRALLEL_API_KEY": "test-parallel-key",
    "ENVIRONMENT": "development",
}


def _reset_config_cache():
    """Reset the config module's lazy-init state so each test starts fresh."""
    import config as config_mod
    config_mod._dotenv_loaded = True  # Prevent actual dotenv loading


def test_load_config_returns_app_config():
    """load_config returns an AppConfig with correct values from env."""
    _reset_config_cache()

    env = {**_MINIMAL_ENV, "BACKEND_API_URL": "http://localhost:3001", "BACKEND_API_KEY": "test-backend-key"}
    with patch.dict(os.environ, env, clear=False):
        from config import load_config, AppConfig

        result = load_config()

    assert isinstance(result, AppConfig)
    assert result.temporal.address == "localhost:7233"
    assert result.temporal.namespace == "test-ns"
    assert result.backend.api_url == "http://localhost:3001"
    assert result.backend.api_key == "test-backend-key"
    assert result.openai.api_key == "test-openai-key"


def test_load_config_backend_defaults():
    """Backend api_url defaults to production URL when BACKEND_API_URL not set."""
    _reset_config_cache()

    env = {**_MINIMAL_ENV}
    # Remove BACKEND_API_URL if it exists in the patched env
    env.pop("BACKEND_API_URL", None)

    with patch.dict(os.environ, env, clear=False):
        # Also clear BACKEND_API_URL from real env
        old_val = os.environ.pop("BACKEND_API_URL", None)
        try:
            from config import load_config

            result = load_config()
        finally:
            if old_val is not None:
                os.environ["BACKEND_API_URL"] = old_val

    assert result.backend.api_url == "https://navi-j9a9.onrender.com"


def test_load_config_temporal_defaults():
    """Temporal config reads values from env and has correct types."""
    _reset_config_cache()

    env = {**_MINIMAL_ENV}
    with patch.dict(os.environ, env, clear=False):
        from config import load_config

        result = load_config()

    # namespace comes from env
    assert result.temporal.namespace == "test-ns"
    # task_queue is a string (may be overridden by env)
    assert isinstance(result.temporal.task_queue, str)
    assert len(result.temporal.task_queue) > 0
    # Numeric fields are ints with correct types
    assert isinstance(result.temporal.max_concurrent_activities, int)
    assert isinstance(result.temporal.activity_max_attempts, int)
    assert result.temporal.activity_max_attempts >= 1


async def run_all_tests():
    print("config blackbox tests:")
    r = BlackboxResult()
    r.record("load_config_returns_app_config", test_load_config_returns_app_config)
    r.record("load_config_backend_defaults", test_load_config_backend_defaults)
    r.record("load_config_temporal_defaults", test_load_config_temporal_defaults)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
