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

from unittest.mock import patch

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
        patch.object(rb.subprocess, "run", side_effect=fake_run),
    ):
        rb._sync_compute_tokens(**kwargs)
    return seen["env"]


def test_default_sync_does_not_opt_into_missing_gpt_code():
    env = _captured_seed_env()
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") is None


def test_tolerant_sync_sets_the_seed_env_opt_in():
    env = _captured_seed_env(tolerate_gpt_code_unavailable=True)
    assert env.get("SEED_ALLOW_MISSING_GPT_CODE") == "1"


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

    # The live overlay serves browser/credential tasks (claude_code); an exhausted
    # Codex quota must NOT fail them here. Was strict → 0/8 ecommerce slice.
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
