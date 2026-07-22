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

import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

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
        patch.object(rb, "_run_seed_subprocess", side_effect=fake_run),
    ):
        rb._sync_compute_tokens(**kwargs)
    return seen["env"]


def test_default_sync_does_not_opt_into_missing_gpt_code():
    env = _captured_seed_env()
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") is None


def test_tolerant_sync_sets_the_seed_env_opt_in():
    env = _captured_seed_env(tolerate_gpt_code_unavailable=True)
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") == "1"


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


def test_blanket_preflight_uses_tolerant_sync():
    captured: dict[str, bool] = {}

    def fake_sync(*, tolerate_gpt_code_unavailable: bool = False) -> bool:
        captured["tolerant"] = tolerate_gpt_code_unavailable
        return True

    with (
        patch.object(rb, "_is_local_base_url", return_value=True),
        patch.object(rb, "_sync_compute_tokens", side_effect=fake_sync),
    ):
        rb._refresh_local_compute_tokens_for_run("http://localhost:3001")

    assert captured["tolerant"] is True


def test_live_fixture_sync_tolerates_missing_gpt_code():
    captured: dict[str, bool] = {}

    def fake_sync(*, tolerate_gpt_code_unavailable: bool = False) -> bool:
        captured["tolerant"] = tolerate_gpt_code_unavailable
        return True

    ctx = rb.LiveFixtureContext(
        base_url="http://localhost:3001",
        user_id=rb.USER_ID if hasattr(rb, "USER_ID") else "u",
        auth_realm="local",
    )
    with (
        patch.object(rb, "_is_simulate_mode", return_value=False),
        patch.object(rb, "_sync_compute_tokens", side_effect=fake_sync),
        patch.object(rb, "_sync_browser_credentials", return_value=True),
    ):
        rb._apply_live_fixture(ctx)

    # The live overlay must tolerate a missing bench-usable Codex, same as the
    # run-level pre-flight — browser/payment tasks run on claude_code, not Codex,
    # so gating them on gpt_code is a false infra failure.
    assert captured["tolerant"] is True
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
        patch.object(rb, "_sync_compute_tokens", return_value=False),
    ):
        try:
            rb._refresh_local_compute_tokens_for_run("http://localhost:3001")
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
