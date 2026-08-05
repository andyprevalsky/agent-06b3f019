"""Blackbox tests for config domain."""

import asyncio
import os
from pathlib import Path
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
    "TEMPORAL_TASK_QUEUE": "test-task-queue",
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
    with patch.dict(os.environ, env, clear=True):
        from config import load_config

        result = load_config()

    # namespace comes from env
    assert result.temporal.namespace == "test-ns"
    # task_queue is a string (may be overridden by env)
    assert isinstance(result.temporal.task_queue, str)
    assert len(result.temporal.task_queue) > 0
    # Numeric fields are ints with correct types
    assert isinstance(result.temporal.max_concurrent_activities, int)
    assert result.temporal.max_concurrent_activities == 100
    assert result.temporal.activity_admission_close_memory_percent == 80.0
    assert result.temporal.activity_admission_open_memory_percent == 75.0
    assert isinstance(result.temporal.activity_max_attempts, int)
    assert result.temporal.activity_max_attempts >= 1
    assert result.temporal.sticky_queue_schedule_to_start_timeout_seconds == 10


def test_load_config_temporal_activity_slot_overrides():
    """Temporal activity slot settings are env-configurable."""
    _reset_config_cache()

    env = {
        **_MINIMAL_ENV,
        "MAX_CONCURRENT_ACTIVITIES": "800",
        "ACTIVITY_ADMISSION_CLOSE_MEMORY_PERCENT": "82.5",
        "ACTIVITY_ADMISSION_OPEN_MEMORY_PERCENT": "74.5",
    }
    with patch.dict(os.environ, env, clear=True):
        from config import load_config

        result = load_config()

    assert result.temporal.max_concurrent_activities == 800
    assert result.temporal.activity_admission_close_memory_percent == 82.5
    assert result.temporal.activity_admission_open_memory_percent == 74.5


def test_load_config_temporal_sticky_timeout_override():
    """Temporal sticky queue schedule-to-start timeout is env-configurable."""
    _reset_config_cache()

    env = {**_MINIMAL_ENV, "STICKY_QUEUE_SCHEDULE_TO_START_TIMEOUT_SECONDS": "2"}
    with patch.dict(os.environ, env, clear=True):
        from config import load_config

        result = load_config()

    assert result.temporal.sticky_queue_schedule_to_start_timeout_seconds == 2


def test_temporal_connect_options_support_local_and_cloud_servers():
    """Local benchmarks disable TLS/auth without weakening Temporal Cloud."""
    from temporal_connection import is_local_temporal_address, temporal_connect_options

    assert is_local_temporal_address("localhost:7233")
    assert is_local_temporal_address("127.0.0.1:7233")
    assert is_local_temporal_address("[::1]:7233")
    assert not is_local_temporal_address("rose.tmprl.cloud:7233")

    local = temporal_connect_options("127.0.0.1:7233", "default", "")
    assert local == {"namespace": "default", "tls": False}

    cloud = temporal_connect_options("rose.tmprl.cloud:7233", "rose", "secret")
    assert cloud["namespace"] == "rose"
    assert cloud["tls"] is not False
    assert cloud["rpc_metadata"] == {
        "temporal-namespace": "rose",
        "Authorization": "Bearer secret",
    }


def test_load_config_temporal_balances_sticky_and_nonsticky_pollers():
    """Default workflow pollers must preserve capacity for cached workflow tasks."""
    _reset_config_cache()

    with patch.dict(os.environ, _MINIMAL_ENV, clear=True):
        from config import load_config

        temporal = load_config().temporal

    pollers = temporal.max_concurrent_workflow_task_polls
    nonsticky_pollers = max(int(pollers * temporal.nonsticky_to_sticky_poll_ratio), 1)
    sticky_pollers = max(pollers - nonsticky_pollers, 1)

    assert nonsticky_pollers >= pollers // 2
    assert sticky_pollers >= pollers // 2

    run_script = (Path(__file__).resolve().parents[3] / "scripts" / "run.sh").read_text()
    assert "NONSTICKY_TO_STICKY_POLL_RATIO:-0.5" in run_script
    assert "NONSTICKY_TO_STICKY_POLL_RATIO:-1.0" not in run_script


def test_load_config_parallel_accepts_correct_spelling():
    """PARALLEL_API_KEY is accepted when the legacy misspelled key is absent."""
    _reset_config_cache()

    env = {**_MINIMAL_ENV, "PARALLEL_API_KEY": "correct-parallel-key"}
    env.pop("PARRALLEL_API_KEY", None)
    with patch.dict(os.environ, env, clear=True):
        from config import load_config

        result = load_config()

    assert result.parallel.api_key == "correct-parallel-key"


def test_load_config_parallel_keeps_legacy_spelling_precedence():
    """Existing Render PARRALLEL_API_KEY remains the preferred key when present."""
    _reset_config_cache()

    env = {
        **_MINIMAL_ENV,
        "PARRALLEL_API_KEY": "legacy-parallel-key",
        "PARALLEL_API_KEY": "correct-parallel-key",
    }
    with patch.dict(os.environ, env, clear=True):
        from config import load_config

        result = load_config()

    assert result.parallel.api_key == "legacy-parallel-key"


async def run_all_tests():
    print("config blackbox tests:")
    r = BlackboxResult()
    r.record("load_config_returns_app_config", test_load_config_returns_app_config)
    r.record("load_config_backend_defaults", test_load_config_backend_defaults)
    r.record("load_config_temporal_defaults", test_load_config_temporal_defaults)
    r.record("load_config_temporal_activity_slot_overrides", test_load_config_temporal_activity_slot_overrides)
    r.record("load_config_temporal_sticky_timeout_override", test_load_config_temporal_sticky_timeout_override)
    r.record(
        "temporal_connect_options_local_and_cloud",
        test_temporal_connect_options_support_local_and_cloud_servers,
    )
    r.record(
        "load_config_temporal_balances_sticky_and_nonsticky_pollers",
        test_load_config_temporal_balances_sticky_and_nonsticky_pollers,
    )
    r.record("parallel_correct_spelling", test_load_config_parallel_accepts_correct_spelling)
    r.record("parallel_legacy_spelling_precedence", test_load_config_parallel_keeps_legacy_spelling_precedence)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
