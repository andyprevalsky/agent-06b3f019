"""Unit tests for WebDecoy FCaptcha PoW recovery helpers."""

from domains.spawn_browser_agent_v3.fcaptcha_pow_recovery import (
    FCAPTCHA_MAX_POW_RECOVERY_WAITS,
    click_targets_fcaptcha_submit,
    dom_has_reportable_fcaptcha_progress,
    dom_indicates_fcaptcha_pow_blocked,
    fcaptcha_pow_exhausted_completion_guidance,
    fcaptcha_pow_retry_guidance,
    is_webdecoy_fcaptcha_url,
    pow_recovery_wait_seconds,
    should_force_fcaptcha_completion,
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
    assert pow_recovery_wait_seconds(pow_blocked=True) >= pow_recovery_wait_seconds(pre_submit=True)


def test_fcaptcha_max_recovery_waits_is_single_shot():
    assert FCAPTCHA_MAX_POW_RECOVERY_WAITS == 1


def test_should_reload_page_on_first_pow_recovery_only():
    assert should_reload_page_on_pow_recovery(1) is True
    assert should_reload_page_on_pow_recovery(2) is False


def test_dom_has_reportable_fcaptcha_progress_requires_score_and_verified():
    assert dom_has_reportable_fcaptcha_progress(
        "Risk Score (lower = human): 0.11\nCheckbox: Verified!"
    )
    assert not dom_has_reportable_fcaptcha_progress("Risk Score: 0.11")
    assert not dom_has_reportable_fcaptcha_progress("Verified!")


def test_should_force_fcaptcha_completion_on_reportable_or_exhausted():
    assert should_force_fcaptcha_completion(
        blocked=True, recovery_waits=0, reportable_progress=True
    )
    assert should_force_fcaptcha_completion(
        blocked=True, recovery_waits=1, reportable_progress=False
    )
    assert not should_force_fcaptcha_completion(
        blocked=True, recovery_waits=0, reportable_progress=False
    )
    assert not should_force_fcaptcha_completion(
        blocked=False, recovery_waits=1, reportable_progress=True
    )


def test_fcaptcha_pow_guidance_mentions_reload_and_completion():
    retry = fcaptcha_pow_retry_guidance(recovery_seconds=12.0, reloaded=True)
    assert "12s" in retry
    assert "Reloaded" in retry
    assert "attempt_completion" in retry
    exhausted = fcaptcha_pow_exhausted_completion_guidance()
    assert "attempt_completion" in exhausted
    assert "Do NOT keep retrying" in exhausted
