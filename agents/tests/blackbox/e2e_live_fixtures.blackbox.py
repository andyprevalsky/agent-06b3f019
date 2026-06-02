"""Blackbox tests for e2e live fixture cache resolution."""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from _test_utils import BlackboxResult, teardown_mock


def _cache_env(tmpdir: str) -> dict[str, str]:
    return {
        "E2E_FIXTURE_CACHE_PATH": str(Path(tmpdir) / "fixtures.json"),
    }


async def test_live_fixture_cache_miss_generates_and_writes_cache():
    from tests.e2e.live_fixtures import LiveFixtureSpec, resolve_live_fixture

    with tempfile.TemporaryDirectory() as tmpdir:
        producer = AsyncMock(
            return_value=(
                {"E2E_TARGET_URL": "https://fixture.example/auth", "E2E_ACCOUNT": "fixture@example.com"},
                60,
                "test",
            )
        )
        with patch.dict(os.environ, _cache_env(tmpdir), clear=True), patch(
            "tests.e2e.live_fixtures._generate_live_fixture",
            producer,
        ):
            values = await resolve_live_fixture(
                LiveFixtureSpec(
                    test_name="fixture-test",
                    fixture_name="browser_auth.fixture_test",
                    required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                    ttl_seconds=300,
                )
            )

        assert values["E2E_TARGET_URL"] == "https://fixture.example/auth"
        assert values["E2E_ACCOUNT"] == "fixture@example.com"
        producer.assert_awaited_once()

        cache = json.loads((Path(tmpdir) / "fixtures.json").read_text())
        entry = cache["fixtures"]["browser_auth.fixture_test"]
        assert entry["source"] == "test"
        assert entry["ttlSeconds"] == 60
        assert entry["values"]["E2E_ACCOUNT"] == "fixture@example.com"


async def test_live_fixture_cache_hit_skips_generator():
    from tests.e2e.live_fixtures import LiveFixtureSpec, resolve_live_fixture

    with tempfile.TemporaryDirectory() as tmpdir:
        cache_path = Path(tmpdir) / "fixtures.json"
        cache_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "fixtures": {
                        "browser_auth.cached": {
                            "schemaVersion": 1,
                            "source": "test",
                            "createdAt": 1000,
                            "expiresAt": 4_000_000_000,
                            "ttlSeconds": 300,
                            "values": {
                                "E2E_TARGET_URL": "https://cached.example/auth",
                                "E2E_ACCOUNT": "cached@example.com",
                            },
                        }
                    },
                }
            )
        )
        producer = AsyncMock()
        with patch.dict(os.environ, _cache_env(tmpdir), clear=True), patch(
            "tests.e2e.live_fixtures._generate_live_fixture",
            producer,
        ):
            values = await resolve_live_fixture(
                LiveFixtureSpec(
                    test_name="cached-test",
                    fixture_name="browser_auth.cached",
                    required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                    ttl_seconds=300,
                )
            )

        assert values["E2E_TARGET_URL"] == "https://cached.example/auth"
        assert values["E2E_ACCOUNT"] == "cached@example.com"
        producer.assert_not_awaited()


async def test_live_fixture_stale_cache_regenerates():
    from tests.e2e.live_fixtures import LiveFixtureSpec, resolve_live_fixture

    with tempfile.TemporaryDirectory() as tmpdir:
        cache_path = Path(tmpdir) / "fixtures.json"
        cache_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "fixtures": {
                        "browser_auth.stale": {
                            "schemaVersion": 1,
                            "source": "test",
                            "createdAt": 1000,
                            "expiresAt": 1001,
                            "ttlSeconds": 300,
                            "values": {
                                "E2E_TARGET_URL": "https://stale.example/auth",
                                "E2E_ACCOUNT": "stale@example.com",
                            },
                        }
                    },
                }
            )
        )
        producer = AsyncMock(
            return_value=(
                {"E2E_TARGET_URL": "https://fresh.example/auth", "E2E_ACCOUNT": "fresh@example.com"},
                None,
                "test",
            )
        )
        with patch.dict(os.environ, _cache_env(tmpdir), clear=True), patch(
            "tests.e2e.live_fixtures._generate_live_fixture",
            producer,
        ):
            values = await resolve_live_fixture(
                LiveFixtureSpec(
                    test_name="stale-test",
                    fixture_name="browser_auth.stale",
                    required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                    ttl_seconds=300,
                )
            )

        assert values["E2E_TARGET_URL"] == "https://fresh.example/auth"
        assert values["E2E_ACCOUNT"] == "fresh@example.com"
        producer.assert_awaited_once()


async def test_live_fixture_env_values_override_cache_and_generator():
    from tests.e2e.live_fixtures import LiveFixtureSpec, resolve_live_fixture

    with tempfile.TemporaryDirectory() as tmpdir:
        producer = AsyncMock()
        env = {
            **_cache_env(tmpdir),
            "E2E_TARGET_URL": "https://env.example/auth",
            "E2E_ACCOUNT": "env@example.com",
        }
        with patch.dict(os.environ, env, clear=True), patch(
            "tests.e2e.live_fixtures._generate_live_fixture",
            producer,
        ):
            values = await resolve_live_fixture(
                LiveFixtureSpec(
                    test_name="env-test",
                    fixture_name="browser_auth.env",
                    required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                    ttl_seconds=300,
                )
            )

        assert values["E2E_TARGET_URL"] == "https://env.example/auth"
        assert values["E2E_ACCOUNT"] == "env@example.com"
        producer.assert_not_awaited()


async def test_resolve_runtime_env_uses_fixture_values_without_mutating_os_environ():
    from tests.e2e.live_fixtures import resolve_test_runtime_env

    with tempfile.TemporaryDirectory() as tmpdir:
        producer = AsyncMock(
            return_value=(
                {"E2E_TARGET_URL": "https://runtime.example/auth", "E2E_ACCOUNT": "runtime@example.com"},
                None,
                "test",
            )
        )
        with patch.dict(os.environ, _cache_env(tmpdir), clear=True), patch(
            "tests.e2e.live_fixtures._generate_live_fixture",
            producer,
        ):
            runtime_env = await resolve_test_runtime_env(
                test_name="runtime-test",
                live_fixture="browser_auth.runtime",
                required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                live_fixture_ttl_seconds=300,
            )
            assert "E2E_TARGET_URL" not in os.environ

        assert runtime_env["E2E_TARGET_URL"] == "https://runtime.example/auth"
        assert runtime_env["E2E_ACCOUNT"] == "runtime@example.com"


async def test_live_fixture_provider_command_receives_request_and_returns_values():
    from tests.e2e.live_fixtures import LiveFixtureSpec, resolve_live_fixture

    command_code = (
        "import json,sys;"
        "req=json.load(sys.stdin);"
        "assert req['fixture']=='browser_auth.command';"
        "print(json.dumps({'values': {"
        "'E2E_TARGET_URL': 'https://command.example/auth',"
        "'E2E_ACCOUNT': 'command@example.com'"
        "}, 'ttlSeconds': 45}))"
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        env = {
            **_cache_env(tmpdir),
            "E2E_FIXTURE_PROVIDER_COMMAND": f"{sys.executable} -c {json.dumps(command_code)}",
        }
        with patch.dict(os.environ, env, clear=True):
            values = await resolve_live_fixture(
                LiveFixtureSpec(
                    test_name="command-test",
                    fixture_name="browser_auth.command",
                    required_env=["E2E_TARGET_URL", "E2E_ACCOUNT"],
                    ttl_seconds=300,
                )
            )

        assert values["E2E_TARGET_URL"] == "https://command.example/auth"
        assert values["E2E_ACCOUNT"] == "command@example.com"
        cache = json.loads((Path(tmpdir) / "fixtures.json").read_text())
        entry = cache["fixtures"]["browser_auth.command"]
        assert entry["source"] == "command"
        assert entry["ttlSeconds"] == 45


async def test_live_fixture_missing_provider_fails_before_legacy_missing_env():
    from tests.e2e.live_fixtures import FixtureResolutionError, LiveFixtureSpec, resolve_live_fixture

    with tempfile.TemporaryDirectory() as tmpdir:
        with patch.dict(os.environ, _cache_env(tmpdir), clear=True):
            try:
                await resolve_live_fixture(
                    LiveFixtureSpec(
                        test_name="missing-provider-test",
                        fixture_name="browser_auth.missing_provider",
                        required_env=["E2E_TARGET_URL"],
                        ttl_seconds=300,
                    )
                )
            except FixtureResolutionError as exc:
                assert "Missing live fixture generator" in str(exc)
            else:
                raise AssertionError("expected missing provider to raise")


async def run_all_tests():
    print("e2e-live-fixtures blackbox tests:")
    r = BlackboxResult()
    await r.record_async("cache_miss_generates_and_writes_cache", test_live_fixture_cache_miss_generates_and_writes_cache)
    await r.record_async("cache_hit_skips_generator", test_live_fixture_cache_hit_skips_generator)
    await r.record_async("stale_cache_regenerates", test_live_fixture_stale_cache_regenerates)
    await r.record_async("env_values_override_cache_and_generator", test_live_fixture_env_values_override_cache_and_generator)
    await r.record_async(
        "runtime_env_uses_fixture_values_without_mutating_os_environ",
        test_resolve_runtime_env_uses_fixture_values_without_mutating_os_environ,
    )
    await r.record_async(
        "provider_command_receives_request_and_returns_values",
        test_live_fixture_provider_command_receives_request_and_returns_values,
    )
    await r.record_async(
        "missing_provider_fails_before_legacy_missing_env",
        test_live_fixture_missing_provider_fails_before_legacy_missing_env,
    )
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
