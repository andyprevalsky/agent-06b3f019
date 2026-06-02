"""
TTL-backed live fixture resolution for e2e tests.

System context:
  run_e2e_tests.py
      -> resolve_test_runtime_env()
          -> fresh .context cache hit: reuse fixture values
          -> stale/miss: call live fixture provider/command
      -> spawn real agent with resolved prompt values
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


DEFAULT_FIXTURE_TTL_SECONDS = 24 * 60 * 60
FIXTURE_SCHEMA_VERSION = 1
REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CACHE_PATH = REPO_ROOT / ".context" / "e2e-fixtures" / "live-fixtures.json"


class FixtureResolutionError(Exception):
    """Raised when a live fixture cannot be generated or loaded."""


@dataclass(frozen=True)
class LiveFixtureSpec:
    test_name: str
    fixture_name: str
    required_env: list[str]
    ttl_seconds: int = DEFAULT_FIXTURE_TTL_SECONDS


def _now_seconds() -> int:
    return int(time.time())


def _cache_path() -> Path:
    configured = os.environ.get("E2E_FIXTURE_CACHE_PATH")
    if configured:
        return Path(configured)
    return DEFAULT_CACHE_PATH


def _read_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": FIXTURE_SCHEMA_VERSION, "fixtures": {}}
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return {"version": FIXTURE_SCHEMA_VERSION, "fixtures": {}}
    fixtures = data.get("fixtures")
    if not isinstance(fixtures, dict):
        data["fixtures"] = {}
    return data


def _write_cache(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    tmp_path.replace(path)


def _ttl_seconds(default_ttl_seconds: int) -> int:
    raw = os.environ.get("E2E_FIXTURE_TTL_SECONDS")
    if raw is None or raw == "":
        return default_ttl_seconds
    try:
        ttl = int(raw)
    except ValueError as exc:
        raise FixtureResolutionError("E2E_FIXTURE_TTL_SECONDS must be an integer") from exc
    if ttl < 0:
        raise FixtureResolutionError("E2E_FIXTURE_TTL_SECONDS must be >= 0")
    return ttl


def _force_refresh() -> bool:
    return os.environ.get("E2E_FIXTURE_FORCE_REFRESH") == "1"


def _values_from_env(required_env: list[str]) -> dict[str, str]:
    return {name: os.environ[name] for name in required_env if os.environ.get(name)}


def _entry_values_if_fresh(
    entry: object,
    required_env: list[str],
    now_seconds: int,
) -> dict[str, str] | None:
    if not isinstance(entry, dict):
        return None
    if entry.get("schemaVersion") != FIXTURE_SCHEMA_VERSION:
        return None
    expires_at = entry.get("expiresAt")
    if not isinstance(expires_at, int) or expires_at <= now_seconds:
        return None
    values = entry.get("values")
    if not isinstance(values, dict):
        return None

    resolved: dict[str, str] = {}
    for name in required_env:
        value = values.get(name)
        if not isinstance(value, str) or value == "":
            return None
        resolved[name] = value
    return resolved


def _normalize_provider_values(payload: object) -> tuple[dict[str, str], int | None]:
    if not isinstance(payload, dict):
        raise FixtureResolutionError("Live fixture provider returned non-object JSON")

    raw_values = payload.get("values", payload)
    if not isinstance(raw_values, dict):
        raise FixtureResolutionError("Live fixture provider returned invalid values")

    values: dict[str, str] = {}
    for key, value in raw_values.items():
        if isinstance(key, str) and isinstance(value, str) and value != "":
            values[key] = value

    ttl = payload.get("ttlSeconds")
    if ttl is None:
        return values, None
    if not isinstance(ttl, int) or ttl < 0:
        raise FixtureResolutionError("Live fixture provider returned invalid ttlSeconds")
    return values, ttl


def _assert_required_values(values: dict[str, str], required_env: list[str]) -> None:
    missing = [name for name in required_env if not values.get(name)]
    if missing:
        raise FixtureResolutionError(
            "Live fixture provider did not return required values: " + ", ".join(missing)
        )


async def _generate_with_provider_url(spec: LiveFixtureSpec) -> tuple[dict[str, str], int | None]:
    provider_url = os.environ.get("E2E_FIXTURE_PROVIDER_URL")
    if not provider_url:
        raise FixtureResolutionError("E2E_FIXTURE_PROVIDER_URL is not configured")

    headers = {"Content-Type": "application/json"}
    api_key = os.environ.get("E2E_FIXTURE_PROVIDER_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = {
        "fixture": spec.fixture_name,
        "testName": spec.test_name,
        "requiredEnv": spec.required_env,
        "schemaVersion": FIXTURE_SCHEMA_VERSION,
    }
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(provider_url, headers=headers, json=body)

    if response.status_code >= 400:
        raise FixtureResolutionError(
            f"Live fixture provider failed: HTTP {response.status_code} - {response.text[:500]}"
        )
    return _normalize_provider_values(response.json())


async def _generate_with_provider_command(spec: LiveFixtureSpec) -> tuple[dict[str, str], int | None]:
    command = os.environ.get("E2E_FIXTURE_PROVIDER_COMMAND")
    if not command:
        raise FixtureResolutionError("E2E_FIXTURE_PROVIDER_COMMAND is not configured")

    request = json.dumps(
        {
            "fixture": spec.fixture_name,
            "testName": spec.test_name,
            "requiredEnv": spec.required_env,
            "schemaVersion": FIXTURE_SCHEMA_VERSION,
        }
    ).encode("utf-8")
    process = await asyncio.create_subprocess_exec(
        *shlex.split(command),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(request)
    if process.returncode != 0:
        raise FixtureResolutionError(
            "Live fixture provider command failed: " + stderr.decode("utf-8", errors="replace")[:500]
        )
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise FixtureResolutionError("Live fixture provider command returned invalid JSON") from exc
    return _normalize_provider_values(payload)


async def _generate_live_fixture(spec: LiveFixtureSpec) -> tuple[dict[str, str], int | None, str]:
    if os.environ.get("E2E_FIXTURE_PROVIDER_COMMAND"):
        values, ttl = await _generate_with_provider_command(spec)
        return values, ttl, "command"
    if os.environ.get("E2E_FIXTURE_PROVIDER_URL"):
        values, ttl = await _generate_with_provider_url(spec)
        return values, ttl, "url"
    raise FixtureResolutionError(
        "Missing live fixture generator. Set E2E_FIXTURE_PROVIDER_URL or "
        "E2E_FIXTURE_PROVIDER_COMMAND, or provide the required values directly."
    )


async def resolve_live_fixture(spec: LiveFixtureSpec) -> dict[str, str]:
    """Resolve fixture values from env, cache, or a real fixture provider."""
    env_values = _values_from_env(spec.required_env)
    if all(env_values.get(name) for name in spec.required_env) and not _force_refresh():
        return env_values

    now = _now_seconds()
    cache_path = _cache_path()
    cache = _read_cache(cache_path)
    fixtures = cache.setdefault("fixtures", {})
    if not isinstance(fixtures, dict):
        fixtures = {}
        cache["fixtures"] = fixtures

    ttl_seconds = _ttl_seconds(spec.ttl_seconds)
    entry = fixtures.get(spec.fixture_name)
    cached_values = None if _force_refresh() else _entry_values_if_fresh(entry, spec.required_env, now)
    if cached_values is not None:
        return {**cached_values, **env_values}

    generated_values, provider_ttl, source = await _generate_live_fixture(spec)
    merged_values = {**generated_values, **env_values}
    _assert_required_values(merged_values, spec.required_env)

    effective_ttl = provider_ttl if provider_ttl is not None else ttl_seconds
    fixtures[spec.fixture_name] = {
        "schemaVersion": FIXTURE_SCHEMA_VERSION,
        "source": source,
        "createdAt": now,
        "expiresAt": now + effective_ttl,
        "ttlSeconds": effective_ttl,
        "values": merged_values,
    }
    _write_cache(cache_path, cache)
    return merged_values


async def resolve_test_runtime_env(
    *,
    test_name: str,
    live_fixture: str | None,
    required_env: list[str],
    live_fixture_ttl_seconds: int | None,
) -> dict[str, str]:
    """Return os.environ plus any generated e2e fixture values."""
    runtime_env = dict(os.environ)
    if live_fixture:
        spec = LiveFixtureSpec(
            test_name=test_name,
            fixture_name=live_fixture,
            required_env=required_env,
            ttl_seconds=live_fixture_ttl_seconds or DEFAULT_FIXTURE_TTL_SECONDS,
        )
        runtime_env.update(await resolve_live_fixture(spec))
    return runtime_env
