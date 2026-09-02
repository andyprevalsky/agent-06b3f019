"""Unit tests for WebDecoy FCaptcha PoW recovery helpers."""

from domains.spawn_browser_agent_v3.fcaptcha_pow_recovery import (
    FCAPTCHA_MAX_POW_RECOVERY_WAITS,
    click_targets_fcaptcha_submit,
    dom_indicates_fcaptcha_pow_blocked,
    fcaptcha_pow_retry_guidance,
    is_webdecoy_fcaptcha_url,
    pow_recovery_wait_seconds,
    should_reload_page_on_pow_recovery,
)


def test_is_webdecoy_fcaptcha_url_matches_demo_page():
    assert is_webdecoy_fcaptcha_url("https://webdecoy.com/product/fcaptcha-demo/")
    assert not is_webdecoy_fcaptcha_url("https://example.com/")


def test_dom_indicates_fcaptcha_pow_blocked_detects_pow_not_satisfied():
    assert dom_indicates_fcaptcha_pow_blocked(
        'Bot detected - form blocked with reason "pow_not_satisfied"'
    )
    assert not dom_indicates_fcaptcha_pow_blocked("Risk Score: 0.12")


def test_click_targets_fcaptcha_submit_matches_submit_labels():
    assert click_targets_fcaptcha_submit("button: Submit message")
    assert not click_targets_fcaptcha_submit("checkbox: I am human")


def test_pow_recovery_wait_seconds_phases():
    assert pow_recovery_wait_seconds() > 0
    assert pow_recovery_wait_seconds(pre_submit=True) >= pow_recovery_wait_seconds()
    assert pow_recovery_wait_seconds(pow_blocked=True) >= pow_recovery_wait_seconds(
        pre_submit=True
    )


def test_fcaptcha_max_recovery_waits_allows_multiple_retries():
    assert FCAPTCHA_MAX_POW_RECOVERY_WAITS >= 3


def test_should_reload_page_on_pow_recovery_is_disabled():
    assert should_reload_page_on_pow_recovery(1) is False
    assert should_reload_page_on_pow_recovery(2) is False


def test_fcaptcha_pow_retry_guidance_preserves_verified_without_nudge():
    retry = fcaptcha_pow_retry_guidance(recovery_seconds=15.0, reloaded=False)
    assert "15s" in retry
    assert "without reloading" in retry
    assert "attempt_completion" not in retry
    assert "Reloaded" not in retry
