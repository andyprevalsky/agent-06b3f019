"""Blackbox tests for tests.e2e.test_helpers assertion behavior."""

import asyncio
from collections.abc import Callable

from _test_utils import BlackboxResult, teardown_mock
from tests.e2e.test_helpers import (
    AgentResult,
    CredentialBackpropExpectation,
    _assert_automation_value_observed,
    _assert_single_live_auth_handoff_request,
    assert_credential_backprop_final_state,
    assert_credential_backprop_initial_state,
    assert_same_steel_session_auth_handoff,
)


def _result(messages: list[dict]) -> AgentResult:
    return AgentResult(
        agent_id="agent-auth-handoff",
        status="COMPLETED",
        messages=messages,
        progress=1.0,
        duration_seconds=1.0,
    )


def _auth_handoff_messages(
    *,
    final_resume_mode: str | None = "same_steel_session",
    include_post_assistance_navigation: bool = False,
) -> list[dict]:
    messages = [
        {
            "role": "ASSISTANT",
            "title": "Requesting User Assistance for example.com Login",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "action_type": "auth_assistance",
                "requestUserAuthentication": {
                    "requestId": "auth-request-1",
                    "authRealm": "example.com",
                    "steelSessionId": "steel-session-1",
                    "handoffMode": "same_steel_session_live_view",
                    "browserUrl": "https://steel.example/debug",
                    "liveViewUrl": (
                        "https://steel.example/live?"
                        "session=steel-session-1&interactive=true&showControls=true"
                    ),
                },
            },
        },
        {
            "role": "ASSISTANT",
            "title": "User Assistance Received",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "action_type": "auth_assistance",
                "requestUserAuthentication": {
                    "requestId": "auth-request-1",
                    "authRealm": "example.com",
                    "steelSessionId": "steel-session-1",
                    "handoffMode": "same_steel_session_live_view",
                },
            },
        },
    ]

    if include_post_assistance_navigation:
        messages.append(
            {
                "role": "ASSISTANT",
                "title": "Navigating to https://example.com/account",
                "metadata": {
                    "toolName": "spawn_browser_agent",
                    "action_type": "navigation.navigate",
                    "steelSessionId": "steel-session-1",
                    "url": "https://example.com/account",
                },
            }
        )

    final_auth_metadata = {"steelSessionId": "steel-session-1"}
    if final_resume_mode is not None:
        final_auth_metadata["resumeMode"] = final_resume_mode

    messages.append(
        {
            "role": "ASSISTANT",
            "title": "Browser automation complete",
            "metadata": {
                "toolName": "spawn_browser_agent",
                "requestUserAuthentication": final_auth_metadata,
            },
        }
    )
    return messages


def _assert_raises_assertion(fn: Callable[[], None]) -> None:
    try:
        fn()
    except AssertionError:
        return
    raise AssertionError("expected AssertionError")


def test_same_steel_session_auth_handoff_passes_with_request_assistance_and_final_resume() -> None:
    assert_same_steel_session_auth_handoff(_result(_auth_handoff_messages()))


def test_same_steel_session_auth_handoff_fails_with_post_assistance_navigation() -> None:
    _assert_raises_assertion(
        lambda: assert_same_steel_session_auth_handoff(
            _result(_auth_handoff_messages(include_post_assistance_navigation=True))
        )
    )


def test_same_steel_session_auth_handoff_fails_when_final_resume_mode_missing() -> None:
    _assert_raises_assertion(
        lambda: assert_same_steel_session_auth_handoff(
            _result(_auth_handoff_messages(final_resume_mode=None))
        )
    )


def test_same_steel_session_auth_handoff_fails_when_final_resume_mode_is_not_same_session() -> None:
    _assert_raises_assertion(
        lambda: assert_same_steel_session_auth_handoff(
            _result(_auth_handoff_messages(final_resume_mode="cookie_bundle"))
        )
    )


def test_automation_value_matcher_accepts_exact_and_trailing_whitespace_only() -> None:
    _assert_automation_value_observed("rose-auth-handoff-auto-20260522", "rose-auth-handoff-auto-20260522")
    _assert_automation_value_observed("rose-auth-handoff-auto-20260522", "rose-auth-handoff-auto-20260522 \t\r\n")
    _assert_raises_assertion(
        lambda: _assert_automation_value_observed(
            "rose-auth-handoff-auto-20260522",
            " rose-auth-handoff-auto-20260522",
        )
    )
    _assert_raises_assertion(
        lambda: _assert_automation_value_observed(
            "rose-auth-handoff-auto-20260522",
            "rose-auth-handoff-auto-20260522x",
        )
    )
    _assert_raises_assertion(
        lambda: _assert_automation_value_observed(
            "rose-auth-handoff-auto-20260522",
            "rose-auth-handoff-auto-2026052",
        )
    )


def test_live_auth_handoff_driver_rejects_second_request() -> None:
    _assert_single_live_auth_handoff_request("auth-request-1", set())
    _assert_raises_assertion(
        lambda: _assert_single_live_auth_handoff_request("auth-request-2", {"auth-request-1"})
    )


def _credential_snapshot(
    *,
    disabled_at: str | None,
    disabled_reason: str | None,
    agent_status: str = "COMPLETED",
    propagation_applied: bool = True,
    failure_reason: str | None = None,
    outcome: str | None = None,
) -> dict:
    classifier_messages = []
    if failure_reason is not None or outcome is not None:
        classifier_messages.append(
            {
                "failureReason": failure_reason,
                "credentialPropagationOutcome": outcome,
                "rawError": "Login failed: invalid password",
            }
        )
    return {
        "credential": {
            "kind": "password",
            "id": "password-1",
            "exists": True,
            "disabledAt": disabled_at,
            "disabledReason": disabled_reason,
        },
        "agent": {
            "id": "agent-1",
            "status": agent_status,
            "propagationApplied": propagation_applied,
            "credentialRefs": [{"kind": "password", "id": "password-1"}],
            "classifierMessages": classifier_messages,
        },
    }


def test_credential_backprop_initial_state_requires_expected_disabled_state() -> None:
    expectation = CredentialBackpropExpectation(
        credential_ref_kind="password",
        credential_ref_id="password-1",
        expected_terminal_status="COMPLETED",
        expected_before_disabled=True,
        expected_after_disabled=False,
        expected_propagation_outcome="success",
    )
    assert_credential_backprop_initial_state(
        _credential_snapshot(disabled_at="2026-05-22T00:00:00.000Z", disabled_reason="old"),
        expectation,
    )
    _assert_raises_assertion(
        lambda: assert_credential_backprop_initial_state(
            _credential_snapshot(disabled_at=None, disabled_reason=None),
            expectation,
        )
    )


def test_credential_backprop_success_final_state_requires_cleared_liveness_and_marker() -> None:
    expectation = CredentialBackpropExpectation(
        credential_ref_kind="password",
        credential_ref_id="password-1",
        expected_terminal_status="COMPLETED",
        expected_before_disabled=True,
        expected_after_disabled=False,
        expected_propagation_outcome="success",
    )
    assert_credential_backprop_final_state(
        _credential_snapshot(disabled_at=None, disabled_reason=None),
        expectation,
    )
    _assert_raises_assertion(
        lambda: assert_credential_backprop_final_state(
            _credential_snapshot(disabled_at=None, disabled_reason=None, propagation_applied=False),
            expectation,
        )
    )


def test_credential_backprop_auth_failure_final_state_requires_failure_reason_surface() -> None:
    expectation = CredentialBackpropExpectation(
        credential_ref_kind="password",
        credential_ref_id="password-1",
        expected_terminal_status="FAILED",
        expected_before_disabled=False,
        expected_after_disabled=True,
        expected_propagation_outcome="auth_failed",
        expected_failure_reason="auth_exhausted",
    )
    assert_credential_backprop_final_state(
        _credential_snapshot(
            disabled_at="2026-05-22T00:00:00.000Z",
            disabled_reason="auth_exhausted: Login failed",
            agent_status="FAILED",
            failure_reason="auth_exhausted",
            outcome="auth_failed",
        ),
        expectation,
    )
    _assert_raises_assertion(
        lambda: assert_credential_backprop_final_state(
            _credential_snapshot(
                disabled_at="2026-05-22T00:00:00.000Z",
                disabled_reason="auth_exhausted: Login failed",
                agent_status="FAILED",
                failure_reason=None,
                outcome="auth_failed",
            ),
            expectation,
        )
    )


async def run_all_tests():
    print("e2e-helper blackbox tests:")
    r = BlackboxResult()
    r.record(
        "same_steel_session_auth_handoff_passes_with_request_assistance_and_final_resume",
        test_same_steel_session_auth_handoff_passes_with_request_assistance_and_final_resume,
    )
    r.record(
        "same_steel_session_auth_handoff_fails_with_post_assistance_navigation",
        test_same_steel_session_auth_handoff_fails_with_post_assistance_navigation,
    )
    r.record(
        "same_steel_session_auth_handoff_fails_when_final_resume_mode_missing",
        test_same_steel_session_auth_handoff_fails_when_final_resume_mode_missing,
    )
    r.record(
        "same_steel_session_auth_handoff_fails_when_final_resume_mode_is_not_same_session",
        test_same_steel_session_auth_handoff_fails_when_final_resume_mode_is_not_same_session,
    )
    r.record(
        "automation_value_matcher_accepts_exact_and_trailing_whitespace_only",
        test_automation_value_matcher_accepts_exact_and_trailing_whitespace_only,
    )
    r.record(
        "live_auth_handoff_driver_rejects_second_request",
        test_live_auth_handoff_driver_rejects_second_request,
    )
    r.record(
        "credential_backprop_initial_state_requires_expected_disabled_state",
        test_credential_backprop_initial_state_requires_expected_disabled_state,
    )
    r.record(
        "credential_backprop_success_final_state_requires_cleared_liveness_and_marker",
        test_credential_backprop_success_final_state_requires_cleared_liveness_and_marker,
    )
    r.record(
        "credential_backprop_auth_failure_final_state_requires_failure_reason_surface",
        test_credential_backprop_auth_failure_final_state_requires_failure_reason_surface,
    )
    teardown_mock()
    return r.summary() if hasattr(r, "summary") else r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
