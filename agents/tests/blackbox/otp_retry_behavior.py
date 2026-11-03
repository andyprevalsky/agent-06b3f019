"""Offline owning controls for independent OTP delivery and durable references."""
import asyncio
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from domains.spawn_browser_agent_v3.service_crypto import ExtractedOTP


async def assert_otp_reference_retries_after_unaccepted_write(owning_fixture, cancelled=False):
    with _offline_activity_edges():
        await owning_fixture("persistence_cancelled" if cancelled else "persistence_false")


def assert_unexecuted_action_refund_is_bounded():
    from domains.spawn_browser_agent_v3.config import (
        MAX_ITERATIONS, MAX_CONSECUTIVE_BUDGET_FREE_ACTIONS, adjust_iteration_after_action,
    )
    iteration, consecutive = MAX_ITERATIONS, 0
    for _ in range(MAX_CONSECUTIVE_BUDGET_FREE_ACTIONS):
        before = iteration
        iteration, consecutive, _ = adjust_iteration_after_action(
            iteration=iteration, action_name="request_user_assistance_for_authentication",
            consecutive_budget_free=consecutive, action_executed=False,
        )
        assert iteration == before - 1
    before = iteration
    iteration, consecutive, _ = adjust_iteration_after_action(
        iteration=iteration, action_name="request_user_assistance_for_authentication",
        consecutive_budget_free=consecutive, action_executed=False,
    )
    assert iteration == before, "superseded actions must not create unlimited free turns"


@contextmanager
def _offline_activity_edges():
    """Fail even when an unexpected external attempt is swallowed by activity code."""
    attempts = []

    def deny(*args, **kwargs):
        attempts.append("external attempt")
        raise AssertionError("OTP owning control forbids network")

    async def scripted_progress(*args, **kwargs):
        return {"progress": 0, "output": None, "usage": {}}

    try:
        with (
            patch("httpx.AsyncClient.send", side_effect=deny),
            patch("httpx.Client.send", side_effect=deny),
            patch("requests.Session.request", side_effect=deny),
            patch("socket.socket.connect", deny),
            patch("socket.socket.connect_ex", deny),
            patch("domains.spawn_browser_agent_v3.handler.activity_drain_reason", AsyncMock(return_value=None)),
            patch("helpers.llm.check_progress", AsyncMock(side_effect=scripted_progress)),
            # JEV model scheduling is covered by its owning suite, not OTP controls.
            patch("helpers.jev_progress.predict_jev_progress", AsyncMock(return_value=None)),
            patch("domains.spawn_browser_agent_v3.repo.list_session_files", AsyncMock(return_value=[])),
            patch("domains.spawn_browser_agent_v3.service.list_session_files", AsyncMock(return_value=[])),
        ):
            yield
    finally:
        assert not attempts, f"Unexpected network attempts, including swallowed errors: {attempts}"


async def assert_last_unexecuted_handoff_action_is_refunded(owning_fixture):
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS
    with _offline_activity_edges():
        await owning_fixture("fresh", MAX_ITERATIONS - 1)


async def assert_otp_at_exhausted_budget_does_not_run_more_actions(owning_fixture):
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS
    with _offline_activity_edges():
        await owning_fixture("fresh", MAX_ITERATIONS, expected_exhaustion=True)


async def assert_duplicate_otp_keeps_first_provenance():
    from domains.spawn_browser_agent_v3.handler import _append_new_otp_user_messages
    messages, refs, seen = [], {}, set()
    def otp(credential):
        return ExtractedOTP(code="123456", sender="Fixture", received_at="now", age_seconds=1,
                            ttl_seconds=299, credential_id=credential, source_message_id=credential)
    args = dict(seen_otp_codes=seen, otp_user_messages=messages,
                credential_refs_by_secret_ref=refs, agent_id="fixture", task_id="fixture")
    with _offline_activity_edges(), patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_credential_ref_message", AsyncMock(return_value=True)
    ) as writer:
        assert await _append_new_otp_user_messages(otps=[otp("first")], **args) == 1
        assert await _append_new_otp_user_messages(otps=[otp("first"), otp("other")], **args) == 0
        assert writer.await_count == 1 and len(messages) == 1
        assert refs == {"123456": {"kind": "email_otp", "id": "first"}}


async def assert_false_ack_keeps_otp_input_usable(fake_session_factory):
    from domains.spawn_browser_agent_v3.handler import _append_new_otp_user_messages
    from domains.spawn_browser_agent_v3.service_actions import _execute_input_text
    refs, messages = {}, []
    otp = ExtractedOTP(code="123456", sender="Fixture", received_at="now", age_seconds=1,
                       ttl_seconds=299, credential_id="fixture-credential", source_message_id="fixture-message")
    with _offline_activity_edges(), patch(
        "domains.spawn_browser_agent_v3.handler.save_browser_credential_ref_message", AsyncMock(return_value=False)
    ):
        assert await _append_new_otp_user_messages(
            otps=[otp], seen_otp_codes=set(), otp_user_messages=messages,
            credential_refs_by_secret_ref=refs, agent_id="fixture-agent", task_id="fixture-task",
        ) == 1
        history = MagicMock()
        history.record_action = AsyncMock()
        with patch("browser_tools.write_lock.is_payment_field", AsyncMock(return_value=False)):
            result = await _execute_input_text(
                session=fake_session_factory(), dom_service=MagicMock(), action_history=history,
                element=None, index=None, coords=None, params={"text": otp.code}, thinking=None,
                humanizer=None, secret_refs=None, password_origins=None,
                credential_refs_by_secret_ref=refs, current_url="https://shop.example/login",
                write_lock_enabled=True, write_lock_approvals=None, system_name="Rose",
            )
    assert len(messages) == 1 and result["success"] is True
    assert result["credential_ref"] == {"kind": "email_otp", "id": "fixture-credential"}
    assert result["typed_text"] == otp.code


async def assert_sealed_otp_poll_stops_activity(owning_fixture, path="settled_drain"):
    case = {"settled_drain": "sealed_harvest", "during_drain": "sealed_during_drain", "loop_harvest": "sealed_loop_harvest", "foreground_held_poll": "foreground_sealed_held_poll"}[path]
    loop = asyncio.get_running_loop()
    original_handler, callback_errors = loop.get_exception_handler(), []
    loop.set_exception_handler(lambda _loop, context: callback_errors.append(context))
    try:
        with _offline_activity_edges():
            await owning_fixture(case)
            await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(original_handler)
    assert not callback_errors, "sealed signal escaped only into an event-loop callback"


async def assert_repeated_supersession_is_bounded(owning_fixture, case="repeated_fresh"):
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS
    with _offline_activity_edges():
        await owning_fixture(case, MAX_ITERATIONS - 1)
