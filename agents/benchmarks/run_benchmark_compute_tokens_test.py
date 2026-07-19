"""A benchmark must NEVER be blocked from running because gpt_code (Codex) is
rate-limited/quota-exhausted upstream — that is an external condition, not a
harness regression, and browser/non-Codex tasks never spawn Codex. These tests
cement that the harness always tells seed-local.ts to tolerate 0 usable gpt_code
(while claude_code sync still hard-fails), so a Codex quota outage can't turn the
whole ecommerce/browser slice into NORESULT.
"""

import benchmarks.run_benchmark as rb


class _FakeCompleted:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


def _capture_sync(monkeypatch, *, returncode: int = 0):
    """Run _sync_compute_tokens with subprocess + DB stubbed; return the env
    that would have been handed to seed-local.ts."""
    monkeypatch.setattr(rb, "_local_victoria_database_url", lambda: "postgresql://x/victoria")
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env", {})
        return _FakeCompleted(returncode)

    monkeypatch.setattr(rb.subprocess, "run", fake_run)
    return captured


def test_benchmark_sync_tolerates_missing_gpt_code_by_default(monkeypatch):
    captured = _capture_sync(monkeypatch)
    ok = rb._sync_compute_tokens()
    assert ok is True
    # The whole point: seed-local.ts is told to proceed on 0 usable gpt_code.
    assert captured["env"].get("SEED_ALLOW_MISSING_GPT_CODE") == "1"
    # It still targets the isolated DB, not prod.
    assert captured["env"].get("DATABASE_URL") == "postgresql://x/victoria"
    assert "--compute-tokens-only" in captured["cmd"]


def test_strict_mode_available_for_explicit_codex_callers(monkeypatch):
    captured = _capture_sync(monkeypatch)
    rb._sync_compute_tokens(allow_missing_gpt_code=False)
    # Opt-in strictness leaves the flag unset so seed-local.ts fails closed.
    assert "SEED_ALLOW_MISSING_GPT_CODE" not in captured["env"]


def test_sync_reports_failure_on_nonzero_exit(monkeypatch):
    _capture_sync(monkeypatch, returncode=1)
    monkeypatch.setattr(rb, "_seed_sync_error_detail", lambda *_: "boom")
    assert rb._sync_compute_tokens() is False


def test_refresh_local_compute_tokens_tolerates_missing_gpt_code(monkeypatch):
    """The generic pre-run refresh (hit by every local task, incl. browser)
    must not raise when only gpt_code is missing."""
    calls: dict = {}

    def fake_sync(*, allow_missing_gpt_code: bool = True) -> bool:
        calls["allow_missing_gpt_code"] = allow_missing_gpt_code
        return True

    monkeypatch.setattr(rb, "_is_local_base_url", lambda _url: True)
    monkeypatch.setattr(rb, "_sync_compute_tokens", fake_sync)
    # Should not raise.
    rb._refresh_local_compute_tokens_for_run("http://localhost:3001")
    assert calls["allow_missing_gpt_code"] is True
