"""Compute-token tolerance wiring.

Both compute-token sync paths must tolerate a missing bench-usable Codex
(gpt_code) when claude_code is healthy, because the agent runtime for these
tasks drives claude_code, not Codex:
  - the run-level pre-flight (`_refresh_local_compute_tokens_for_run`), and
  - the per-task live fixture (`_apply_live_fixture`).
They opt in via the seed's ``SEED_ALLOW_MISSING_GPT_CODE`` env var (owned by
seed-local.ts). Gating the live overlay on gpt_code was a FALSE infra failure:
prod can have zero bench-usable Codex (usable rows non-DEV / pooling-off, or
Codex quota-blocked), and it dropped every live task (browser/payment) even
though the pre-flight for the same run already tolerated the exact same absence.
Regression: the live-fixture path used to sync STRICT, so an exhausted org-wide
Codex quota ("No usable gpt_code integrations after sync") failed every browser
task at the fixture before an agent was created — 0/8 on the ecommerce slice.
These tests pin the tolerance on both paths without needing a live DB.
"""

import asyncio
import os
import subprocess
import sys
import tempfile
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


class _JsonResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


def _fake_async_client_with(*responses: _JsonResponse):
    pending = list(responses)

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

        async def get(self, *_args, **_kwargs):
            if not pending:
                raise AssertionError("unexpected extra HTTP request")
            return pending.pop(0)

    return _FakeAsyncClient


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


def test_gpt_only_sync_requires_gpt_without_missing_gpt_opt_in():
    with patch.dict(os.environ, {"SEED_ALLOW_MISSING_GPT_CODE": "1"}):
        env = _captured_seed_env(required_token_types=("gpt",))
    assert env.get("SEED_REQUIRE_COMPUTE_TOKEN_TYPES") == "gpt"
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") is None
    assert env.get("SEED_ALLOW_MISSING_CLAUDE_CODE") is None


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


def test_guest_sync_uses_configured_remote_source_not_restored_target():
    seen: dict[str, dict[str, str]] = {}
    isolated = "postgresql://postgres:postgres@localhost:5432/victoria"
    remote = "postgresql://prod.example.test:6543/postgres?pgbouncer=true"

    def fake_run(_cmd, **kw):
        seen["env"] = kw.get("env", {})
        return _Result(0)

    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(f'DATABASE_URL="{remote}"\n', encoding="utf-8")
        with (
            patch.object(rb, "_BACKEND_ENV", str(backend_env)),
            patch.object(rb, "_local_victoria_database_url", return_value=isolated),
            patch.object(rb, "_shared_workspace_database_url", return_value=None),
            patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
        ):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert seen["env"]["DATABASE_URL"] == isolated
    assert seen["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == remote


def test_guest_sync_fails_closed_when_restored_target_is_only_source():
    isolated = "postgresql://postgres:postgres@localhost:5432/victoria"
    seed_called = False

    def fake_run(_cmd, **_kw):
        nonlocal seed_called
        seed_called = True
        return _Result(0)

    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(f"DATABASE_URL={isolated}\n", encoding="utf-8")
        with (
            patch.object(rb, "_BACKEND_ENV", str(backend_env)),
            patch.object(rb, "_local_victoria_database_url", return_value=isolated),
            patch.object(rb, "_shared_workspace_database_url", return_value=None),
            patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
        ):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False

    assert seed_called is False


@pytest.mark.parametrize(
    "source",
    [
        "postgresql://other:secret@localhost:5432/victoria?sslmode=require",
        "postgresql://other:secret@127.0.0.1:5432/victoria",
        "postgresql://other:secret@[::1]:5432/victoria",
        "postgresql://other:secret@localhost:5432/vict%6Fria",
    ],
)
def test_guest_sync_rejects_semantically_identical_target_source(source: str):
    target = "postgresql://postgres:postgres@localhost:5432/victoria"

    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(f"DATABASE_URL={source}\n", encoding="utf-8")
        with (
            patch.object(rb, "_BACKEND_ENV", str(backend_env)),
            patch.object(rb, "_local_victoria_database_url", return_value=target),
            patch.object(rb, "_shared_workspace_database_url", return_value=None),
            patch.object(rb, "_run_seed_subprocess") as seed,
        ):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False

    seed.assert_not_called()


def test_guest_sync_fails_closed_when_target_identity_is_malformed():
    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(
            "DATABASE_URL=postgresql://prod.example.test:5432/victoria\n",
            encoding="utf-8",
        )
        with (
            patch.object(rb, "_BACKEND_ENV", str(backend_env)),
            patch.object(rb, "_local_victoria_database_url", return_value="not-a-database-url"),
            patch.object(rb, "_shared_workspace_database_url", return_value=None),
            patch.object(rb, "_run_seed_subprocess") as seed,
        ):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False

    seed.assert_not_called()


def test_guest_sync_ignores_malformed_shared_source_and_uses_configured_source():
    seen: dict[str, dict[str, str]] = {}
    target = "postgresql://postgres:postgres@localhost:5432/victoria"
    configured = "postgresql://prod.example.test:6543/postgres"

    def fake_run(_cmd, **kw):
        seen["env"] = kw.get("env", {})
        return _Result(0)

    with tempfile.TemporaryDirectory() as temp_dir:
        backend_env = Path(temp_dir, "backend.env")
        backend_env.write_text(f"DATABASE_URL={configured}\n", encoding="utf-8")
        with (
            patch.object(rb, "_BACKEND_ENV", str(backend_env)),
            patch.object(rb, "_local_victoria_database_url", return_value=target),
            patch.object(rb, "_shared_workspace_database_url", return_value="malformed"),
            patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
        ):
            assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is True

    assert seen["env"]["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == configured


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
        patch.object(rb, "_refresh_local_claude_token_from_keychain", return_value=True),
    ):
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))

    assert captured == {"gpt": True, "claude": True}


def test_keychain_refresh_targets_only_the_isolated_database():
    seen: dict[str, object] = {}

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["cwd"] = kwargs["cwd"]
        seen["env"] = kwargs["env"]
        return _Result(0)

    with (
        patch.object(rb.sys, "platform", "darwin"),
        patch.object(rb.shutil, "which", return_value="/usr/bin/security"),
        patch.object(
            rb,
            "load_env_var",
            return_value="test-only-credential-encryption-key",
        ),
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
        patch("builtins.print"),
    ):
        assert (
            rb._refresh_local_claude_token_from_keychain(
                "postgresql://postgres:postgres@localhost:55005/victoria"
            )
            is True
        )

    assert seen["command"] == [
        "npx",
        "tsx",
        "scripts/seed-claude-code-token-from-keychain.ts",
    ]
    assert seen["cwd"] == rb.REPO_ROOT / "back-end"
    env = seen["env"]
    assert isinstance(env, dict)
    assert env["DATABASE_URL"] == "postgresql://postgres:postgres@localhost:55005/victoria"
    assert env["DIRECT_URL"] == "postgresql://postgres:postgres@localhost:55005/victoria"
    assert env["CLAUDE_CREDENTIAL_DECRYPTION_KEY"] == "test-only-credential-encryption-key"


def test_keychain_refresh_is_inert_without_macos_security():
    with (
        patch.object(rb.sys, "platform", "linux"),
        patch.object(rb, "_run_seed_subprocess") as seed,
    ):
        assert rb._refresh_local_claude_token_from_keychain("postgresql://local/victoria") is False
    seed.assert_not_called()


def test_blanket_preflight_overlays_fresh_local_claude_credentials_after_source_sync():
    calls: list[str] = []

    with (
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(
            rb,
            "_has_usable_anthropic_api_key_fallback",
            new=AsyncMock(return_value=False),
        ),
        patch.object(
            rb,
            "_sync_compute_tokens",
            side_effect=lambda **_kwargs: calls.append("source-sync") or True,
        ),
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(
            rb,
            "_refresh_local_claude_token_from_keychain",
            side_effect=lambda _url: calls.append("keychain-overlay") or True,
        ),
    ):
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))

    assert calls == ["source-sync", "keychain-overlay"]


def test_anthropic_excluded_preflight_requires_gpt_only_sync():
    captured: dict[str, tuple[str, ...] | None] = {}

    def fake_sync(
        *,
        tolerate_gpt_code_unavailable: bool = False,
        tolerate_claude_code_unavailable: bool = False,
        required_token_types: tuple[str, ...] | None = None,
    ) -> bool:
        captured["required"] = required_token_types
        assert tolerate_gpt_code_unavailable is False
        assert tolerate_claude_code_unavailable is False
        return True

    with (
        patch.dict(os.environ, {"ROSE_EXCLUDE_ANTHROPIC_FAMILY": "1"}),
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(
            rb,
            "_has_usable_anthropic_api_key_fallback",
            new=AsyncMock(side_effect=AssertionError("Anthropic fallback must not be checked")),
        ),
        patch.object(rb, "_sync_compute_tokens", side_effect=fake_sync),
    ):
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://localhost:3001"))

    assert captured == {"required": ("gpt",)}


def test_anthropic_excluded_compute_preflight_requests_gpt_token():
    calls: list[dict] = []

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

        async def get(self, *_args, **kwargs):
            calls.append(kwargs)
            return _JsonResponse(200, {"type": "gpt", "accessToken": "codex-token"})

    with (
        patch.dict(os.environ, {"ROSE_EXCLUDE_ANTHROPIC_FAMILY": "1"}),
        patch.object(rb, "_api_headers", new=AsyncMock(return_value={})),
        patch.object(rb.httpx, "AsyncClient", _FakeAsyncClient),
    ):
        assert asyncio.run(rb._check_compute_code_credentials("http://localhost:3001")) is True

    assert calls[0]["params"] == {"tokenType": "gpt"}


def test_claude_code_preflight_rejects_gpt_only_token_without_anthropic_fallback():
    with (
        patch.object(rb, "_api_headers", new=AsyncMock(return_value={})),
        patch.object(
            rb.httpx,
            "AsyncClient",
            _fake_async_client_with(
                _JsonResponse(200, {"type": "gpt", "accessToken": "codex-token"}),
                _JsonResponse(200, {"configured": True, "onCooldown": True}),
            ),
        ),
    ):
        assert asyncio.run(rb._check_claude_code_credentials("http://localhost:3001")) is False


def test_claude_code_preflight_accepts_claude_token():
    with (
        patch.object(rb, "_api_headers", new=AsyncMock(return_value={})),
        patch.object(
            rb.httpx,
            "AsyncClient",
            _fake_async_client_with(_JsonResponse(200, {"type": "claude", "accessToken": "claude-token"})),
        ),
    ):
        assert asyncio.run(rb._check_claude_code_credentials("http://localhost:3001")) is True


def test_claude_code_preflight_rejects_anthropic_fallback_without_claude_token():
    with (
        patch.object(rb, "_api_headers", new=AsyncMock(return_value={})),
        patch.object(
            rb.httpx,
            "AsyncClient",
            _fake_async_client_with(
                _JsonResponse(200, {"type": "gpt", "accessToken": "codex-token"}),
            ),
        ),
    ):
        assert asyncio.run(rb._check_claude_code_credentials("http://localhost:3001")) is False


def test_ci_allows_only_claude_code_credential_skips():
    skipped = rb.TaskResult(
        name="claude-code-agent",
        passed=False,
        agent_id="",
        status="SKIPPED",
        progress_score=0,
        duration_seconds=0,
        cost_cents=0,
        message_count=0,
        failure_reason=rb.CLAUDE_CODE_CREDENTIAL_SKIP_REASON,
    )
    summary = {"failed": 0, "skipped": 1}
    assert rb._ci_should_fail(summary, [skipped]) is False


def test_ci_still_fails_other_skips():
    skipped = rb.TaskResult(
        name="chat-mode",
        passed=False,
        agent_id="",
        status="SKIPPED",
        progress_score=0,
        duration_seconds=0,
        cost_cents=0,
        message_count=0,
        failure_reason=rb.CLAUDE_CODE_CREDENTIAL_SKIP_REASON,
    )
    summary = {"failed": 0, "skipped": 1}
    assert rb._ci_should_fail(summary, [skipped]) is True


def test_cache_ratchet_ignores_skipped_tasks():
    skipped = rb.TaskResult(
        name="claude-code-agent",
        passed=False,
        agent_id="",
        status="SKIPPED",
        progress_score=0,
        duration_seconds=0,
        cost_cents=0,
        message_count=0,
        failure_reason=rb.CLAUDE_CODE_CREDENTIAL_SKIP_REASON,
    )
    assert rb.cache_ratchet_failures([skipped], {"claude-code-agent": 40.0}) == []


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
