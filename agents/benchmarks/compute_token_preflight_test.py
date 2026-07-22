"""Compute-token pre-flight tolerance wiring.

Both the blanket local pre-flight (`_refresh_local_compute_tokens_for_run`) AND
the live-fixture overlay (`_apply_live_fixture`) must tolerate a quota-blocked
Codex (gpt_code) when claude_code is healthy, because the agent runtime drives
claude_code. They opt in via the seed's ``SEED_ALLOW_MISSING_GPT_CODE`` env var
(owned by seed-local.ts). Codex-dependent tasks fail closed at their own strict
credential gate downstream, not at this shared compute-token sync.

Regression: the live-fixture path used to sync STRICT, so an exhausted org-wide
Codex quota ("No usable gpt_code integrations after sync") failed every browser
task at the fixture before an agent was created — 0/8 on the ecommerce slice.
These tests pin the tolerance on both paths without needing a live DB.
"""

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import benchmarks.run_benchmark as rb


class _Result:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


def _captured_seed_env(**kwargs) -> dict[str, str]:
    seen: dict[str, dict[str, str]] = {}

    def fake_run(_cmd, **kw):
        seen["env"] = kw.get("env", {})
        return _Result(0)

    with (
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(rb, "_shared_workspace_database_url", return_value=None),
        patch.object(
            rb,
            "_production_compute_token_database_url",
            return_value="postgresql://prod/victoria",
        ),
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
    ):
        rb._sync_compute_tokens(**kwargs)
    return seen["env"]


def test_default_sync_does_not_opt_into_missing_gpt_code():
    env = _captured_seed_env()
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") is None
    assert env.get("SEED_ALLOW_MISSING_CLAUDE_CODE") is None


def test_tolerant_sync_sets_the_seed_env_opt_in():
    env = _captured_seed_env(
        tolerate_gpt_code_unavailable=True,
        tolerate_claude_code_unavailable=True,
    )
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") == "1"
    assert env.get("SEED_ALLOW_MISSING_CLAUDE_CODE") == "1"


def test_sync_uses_verified_shared_workspace_as_compute_token_source():
    seen: dict[str, dict[str, str]] = {}

    def fake_run(_cmd, **kw):
        seen["env"] = kw.get("env", {})
        return _Result(0)

    with (
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(rb, "_shared_workspace_database_url", return_value="postgresql://shared/victoria"),
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
    ):
        assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert seen["env"]["DATABASE_URL"] == "postgresql://local/victoria"
    assert seen["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == "postgresql://shared/victoria"


def test_shared_workspace_source_requires_usable_claude_code(tmp_path: Path):
    shared_context = tmp_path / ".context"
    shared_context.mkdir()
    (shared_context / "services.json").write_text(
        '{"status":"running","database":{"port":55135,"use_system_postgres":false}}'
    )
    isolated_context = shared_context / "benchmarks" / "isolated"
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        sql = command[-1]
        stdout = "f\n" if 'FROM "Integration"' in sql else "1\n"
        return subprocess.CompletedProcess(command, 0, stdout, "")

    with (
        patch.object(rb, "REPO_ROOT", tmp_path),
        patch.object(rb, "_benchmark_context_path", return_value=isolated_context),
        patch.object(rb.subprocess, "run", side_effect=fake_run),
    ):
        assert rb._shared_workspace_database_url() is None

    assert any('FROM "Integration"' in command[-1] for command in commands)


def test_sync_prefers_verified_shared_source_and_clears_ambient_source():
    seen: dict[str, dict[str, str]] = {}

    def fake_run(_cmd, **kw):
        seen["env"] = kw["env"]
        return _Result(0)

    with (
        patch.dict(
            os.environ,
            {
                "DATABASE_URL": "postgresql://ambient/local",
                "SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL": "postgresql://stale/source",
            },
        ),
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(rb, "_shared_workspace_database_url", return_value="postgresql://shared/victoria"),
        patch.object(rb, "load_env_var", return_value="postgresql://prod/rose"),
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
    ):
        assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert (
        seen["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"]
        == "postgresql://shared/victoria"
    )


def test_seed_source_file_lookup_can_ignore_local_process_database(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("DATABASE_URL=postgresql://prod/rose\n")

    with patch.dict(os.environ, {"DATABASE_URL": "postgresql://local/victoria"}):
        assert (
            rb.load_env_var(
                "DATABASE_URL",
                str(env_file),
                include_process_env=False,
            )
            == "postgresql://prod/rose"
        )


def test_database_url_equivalence_normalizes_postgres_spelling_and_client_options():
    assert rb._database_urls_equivalent(
        "postgres://source:one@LOCALHOST/victoria?pgbouncer=true&sslmode=require",
        "postgresql://target:two@localhost:5432/victoria?application_name=benchmark",
    )


def test_cloud_source_selection_remains_explicit_across_10000_runs():
    calls = 0
    iteration = -1

    def local_database_url():
        nonlocal iteration
        iteration += 1
        return f"postgresql://local/victoria-{iteration}"

    def source_database_url(*_args, **_kwargs):
        return f"postgresql://prod/rose-{iteration}?pgbouncer=true"

    def fake_run(_cmd, **kw):
        nonlocal calls
        calls += 1
        assert kw["env"]["DATABASE_URL"] == f"postgresql://local/victoria-{iteration}"
        assert (
            kw["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"]
            == f"postgresql://prod/rose-{iteration}?pgbouncer=true"
        )
        return _Result(0)

    with (
        patch.object(rb, "_local_victoria_database_url", side_effect=local_database_url),
        patch.object(rb, "_shared_workspace_database_url", return_value=None),
        patch.object(
            rb,
            "_production_compute_token_database_url",
            side_effect=source_database_url,
        ),
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
        patch("builtins.print"),
    ):
        for _ in range(10_000):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert calls == 10_000


def test_cloud_sync_uses_explicit_production_compute_token_source():
    env = _captured_seed_env(tolerate_gpt_code_unavailable=True)
    assert env["DATABASE_URL"] == "postgresql://local/victoria"
    assert env["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == "postgresql://prod/victoria"


def test_production_compute_source_preserves_prisma_pooler_parameters():
    source = "postgresql://prod/db?pgbouncer=true&connection_limit=1"
    with patch.object(
        rb,
        "load_env_var",
        side_effect=lambda name, _path, **_kwargs: source if name == "DATABASE_URL" else None,
    ):
        assert rb._production_compute_token_database_url("postgresql://local/victoria") == source


def test_production_compute_source_ignores_isolated_process_database(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("DATABASE_URL=postgresql://prod/rose\n")

    with (
        patch.dict(os.environ, {"DATABASE_URL": "postgresql://local/victoria"}),
        patch.object(rb, "_BACKEND_ENV", str(env_file)),
    ):
        assert rb._production_compute_token_database_url("postgresql://local/victoria") == "postgresql://prod/rose"


def test_sync_fails_before_seed_when_no_explicit_source_exists():
    calls = []
    with (
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(rb, "_shared_workspace_database_url", return_value=None),
        patch.object(rb, "_production_compute_token_database_url", return_value=None),
        patch.object(rb, "_run_seed_subprocess", side_effect=lambda *_args, **_kwargs: calls.append(True)),
    ):
        assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False
    assert calls == []


def test_blanket_preflight_uses_tolerant_sync():
    captured: dict[str, bool] = {}

    def fake_sync(
        *,
        tolerate_gpt_code_unavailable: bool = False,
        tolerate_claude_code_unavailable: bool = False,
    ) -> bool:
        captured["gpt"] = tolerate_gpt_code_unavailable
        captured["claude"] = tolerate_claude_code_unavailable
        return True

    with (
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(
            rb,
            "_has_usable_anthropic_api_key_fallback",
            new=AsyncMock(return_value=True),
        ),
        patch.object(rb, "_sync_compute_tokens", side_effect=fake_sync),
    ):
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))

    assert captured == {"gpt": True, "claude": True}


def test_simulation_preflight_uses_restored_seed_without_prod_sync():
    """Cloud simulation has a fresh restored seed DB but no second source DB endpoint."""
    calls = []
    with (
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(rb, "_is_simulate_mode", return_value=True),
        patch.object(rb, "_sync_compute_tokens", side_effect=lambda **_kwargs: calls.append(True)),
    ):
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))

    assert calls == []


def test_live_fixture_sync_tolerates_missing_gpt_code():
    captured: dict[str, bool] = {}

    def fake_sync(
        *,
        tolerate_gpt_code_unavailable: bool = False,
        tolerate_claude_code_unavailable: bool = False,
    ) -> bool:
        captured["gpt"] = tolerate_gpt_code_unavailable
        captured["claude"] = tolerate_claude_code_unavailable
        return True

    ctx = rb.LiveFixtureContext(
        base_url="http://localhost:3001",
        user_id=rb.USER_ID if hasattr(rb, "USER_ID") else "u",
        auth_realm="local",
        tolerate_claude_code_unavailable=True,
    )
    with (
        patch.object(rb, "_is_simulate_mode", return_value=False),
        patch.object(rb, "_sync_compute_tokens", side_effect=fake_sync),
        patch.object(rb, "_sync_browser_credentials", return_value=True),
    ):
        rb._apply_live_fixture(ctx)

    # The live overlay serves browser/credential tasks (claude_code); an exhausted
    # Codex quota must NOT fail them here. Was strict → 0/8 ecommerce slice.
    assert captured == {"gpt": True, "claude": True}


def test_live_fixture_still_fails_closed_when_claude_code_sync_fails():
    # Tolerance is only about gpt_code; a genuine sync failure (claude_code missing,
    # DB unreachable, etc.) still aborts the fixture so we never run a token-starved agent.
    ctx = rb.LiveFixtureContext(
        base_url="http://localhost:3001",
        user_id=rb.USER_ID if hasattr(rb, "USER_ID") else "u",
        auth_realm="local",
    )
    with (
        patch.object(rb, "_is_simulate_mode", return_value=False),
        patch.object(rb, "_sync_compute_tokens", return_value=False),
    ):
        try:
            rb._apply_live_fixture(ctx)
            raise AssertionError("expected RuntimeError when compute-token sync fails")
        except RuntimeError as exc:
            assert "compute tokens" in str(exc).lower()


def test_preflight_raises_when_sync_fails():
    with (
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(
            rb,
            "_has_usable_anthropic_api_key_fallback",
            new=AsyncMock(return_value=False),
        ),
        patch.object(rb, "_sync_compute_tokens", return_value=False),
    ):
        try:
            asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))
            raise AssertionError("expected RuntimeError when compute-token sync fails")
        except RuntimeError as exc:
            assert "compute tokens" in str(exc).lower()


def test_timed_out_seed_kills_its_process_group_and_preserves_partial_output(
    tmp_path: Path,
):
    started = tmp_path / "child-started"
    escaped_marker = repr(str(tmp_path / "orphan-finished"))
    escaped_started = repr(str(started))
    child = (
        "import pathlib,time; "
        f"pathlib.Path({escaped_started}).write_text('started'); "
        "time.sleep(3); "
        f"pathlib.Path({escaped_marker}).write_text('survived')"
    )
    parent = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child!r}]); "
        "print('credential-step-before-timeout', flush=True); "
        "print('npx-warning-before-timeout', file=sys.stderr, flush=True); "
        "time.sleep(10)"
    )

    with pytest.raises(subprocess.TimeoutExpired) as caught:
        rb._run_seed_subprocess(
            [sys.executable, "-c", parent],
            cwd=tmp_path,
            env=None,
            timeout=2,
        )

    output = caught.value.stdout or ""
    if isinstance(output, bytes):
        output = output.decode()
    assert "credential-step-before-timeout" in output
    detail = rb._seed_sync_error_detail(caught.value)
    assert "credential-step-before-timeout" in detail
    assert "npx-warning-before-timeout" in detail
    assert started.exists()
    time.sleep(3.2)
    assert not (tmp_path / "orphan-finished").exists()
