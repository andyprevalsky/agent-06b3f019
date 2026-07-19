"""Compute-token pre-flight tolerance wiring.

The blanket local pre-flight (`_refresh_local_compute_tokens_for_run`) must
tolerate a quota-blocked Codex (gpt_code) when claude_code is healthy, because
the agent runtime drives claude_code. Live-fixture syncs (`_apply_live_fixture`)
must stay strict so Codex-dependent tasks still fail closed. These tests pin the
CLI-flag threading that enforces that split without needing a live DB.
"""

from unittest.mock import patch

import benchmarks.run_benchmark as rb


class _Result:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


def _captured_seed_cmd(**kwargs) -> list[str]:
    seen: dict[str, list[str]] = {}

    def fake_run(cmd, **_kw):
        seen["cmd"] = cmd
        return _Result(0)

    with (
        patch.object(rb, "_local_victoria_database_url", return_value="postgresql://local/victoria"),
        patch.object(rb.subprocess, "run", side_effect=fake_run),
    ):
        rb._sync_compute_tokens(**kwargs)
    return seen["cmd"]


def test_default_sync_does_not_tolerate_gpt_code_unavailable():
    cmd = _captured_seed_cmd()
    assert "--compute-tokens-only" in cmd
    assert "--tolerate-gpt-code-unavailable" not in cmd


def test_tolerant_sync_passes_the_flag():
    cmd = _captured_seed_cmd(tolerate_gpt_code_unavailable=True)
    assert "--compute-tokens-only" in cmd
    assert "--tolerate-gpt-code-unavailable" in cmd


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


def test_live_fixture_sync_stays_strict():
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

    # Live fixtures must NOT tolerate a missing Codex token — default (strict).
    assert captured["tolerant"] is False


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
