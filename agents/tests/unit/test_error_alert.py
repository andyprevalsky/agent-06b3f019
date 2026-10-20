"""Unit tests for the direct-to-Slack failure emitter (helpers/error_alert.py).

Auto RCA never dispatches to GitHub (the Slack card drives the Rose RCA agent),
alerts keep direct Slack fallbacks, the throttle never merges distinct agents,
and the activity NEVER raises.
"""

import asyncio
import logging

import pytest

from helpers import error_alert


def _run(coro):
    """Drive a coroutine to completion without depending on pytest-asyncio."""
    return asyncio.run(coro)


class FakeResponse:
    def __init__(self, status_code=200, json_body=None, text="ok", is_json=True):
        self.status_code = status_code
        self._json = json_body if json_body is not None else {}
        self.text = text
        self.headers = {"content-type": "application/json"} if is_json else {"content-type": "text/plain"}

    def json(self):
        return self._json


class FakeClient:
    """Records outbound calls; answers chat.postMessage with a resolved handle."""

    calls: list = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None, timeout=None):
        FakeClient.calls.append({"url": url, "json": json})
        if "chat.postMessage" in url:
            return FakeResponse(200, {"ok": True, "ts": "1700000000.000100", "channel": "C_RESOLVED"})
        return FakeResponse(200, {}, text="ok")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    # No Temporal activity context in a unit test — swap the adapter for a plain logger.
    monkeypatch.setattr(error_alert.activity, "logger", logging.getLogger("test-error-alert"))
    error_alert._last_sent.clear()
    error_alert._in_flight.clear()
    FakeClient.calls = []
    monkeypatch.setattr(error_alert.httpx, "AsyncClient", FakeClient)
    for k in (
        "SLACK_BOT_TOKEN",
        "SLACK_ERROR_CHANNEL_ID",
        "SLACK_ERROR_WEBHOOK_URL",
        "AUTO_RCA_ENABLED",
        "GITHUB_DISPATCH_TOKEN",
        "GITHUB_DISPATCH_REPO",
    ):
        monkeypatch.delenv(k, raising=False)
    yield


def test_fingerprint_collapses_uuids_numbers_hex():
    a = error_alert._fingerprint(
        "agent_workflow", "db pool timeout after 42ms for 550e8400-e29b-41d4-a716-446655440000"
    )
    b = error_alert._fingerprint(
        "agent_workflow", "db pool timeout after 9001ms for 550e8400-e29b-41d4-a716-446655440001"
    )
    assert a == b, "numbers + uuids normalize to the same signature"
    assert error_alert._fingerprint("chat", "db pool timeout after 42ms") != a


def test_throttle_dedups_within_window():
    now = 1000.0
    assert error_alert._acquire_alert_slot("k", now) is True
    assert error_alert._acquire_alert_slot("k", now + 1) is False
    error_alert._finish_alert_slot("k", True, now + 1)
    assert error_alert._acquire_alert_slot("k", now + 2) is False
    assert error_alert._acquire_alert_slot("k", now + error_alert._THROTTLE_WINDOW_S + 2) is True
    error_alert._finish_alert_slot("k", False, now + error_alert._THROTTLE_WINDOW_S + 2)


def test_throttle_map_stays_bounded(monkeypatch):
    monkeypatch.setattr(error_alert, "_MAX_THROTTLE_ENTRIES", 2)
    for index in range(3):
        key = f"key-{index}"
        assert error_alert._acquire_alert_slot(key, 1000.0 + index) is True
        error_alert._finish_alert_slot(key, True, 1000.0 + index)
    assert len(error_alert._last_sent) == 2
    assert "key-0" not in error_alert._last_sent


def test_auto_rca_posts_bot_card_and_never_dispatches_to_github(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_ERROR_CHANNEL_ID", "C_INPUT")
    monkeypatch.setenv("AUTO_RCA_ENABLED", "1")
    monkeypatch.setenv("GITHUB_DISPATCH_TOKEN", "ghp_test")

    result = _run(error_alert.report_failure_activity("agent-1", "agent_workflow", "boom failed"))

    assert result == {"alerted": True}
    assert not any("api.github.com" in c["url"] for c in FakeClient.calls)
    card = next(c for c in FakeClient.calls if "chat.postMessage" in c["url"])
    assert card["json"]["channel"] == "C_INPUT"
    assert "thread_ts" not in card["json"], "the alert card must be top-level"
    assert "boom failed" in card["json"]["text"]


def test_context_is_included_in_slack_payload(monkeypatch):
    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")
    result = _run(
        error_alert.report_failure_activity(
            "agent-context",
            "agent_workflow",
            "context please",
            {"reason": "verifier rejected", "steps_taken": 4},
        )
    )
    assert result["alerted"] is True
    post = next(c for c in FakeClient.calls if c["url"] == "https://hooks.slack.test/xxx")
    rendered = str(post["json"]["blocks"])
    assert "*Context:*" in rendered
    assert "verifier rejected" in rendered


def test_webhook_fallback_when_no_bot_token(monkeypatch):
    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")
    result = _run(error_alert.report_failure_activity("agent-2", "chat", "webhook path"))
    assert result["alerted"] is True
    assert any(c["url"] == "https://hooks.slack.test/xxx" for c in FakeClient.calls)
    assert not any("chat.postMessage" in c["url"] for c in FakeClient.calls)


def test_no_sink_no_alert_no_raise():
    result = _run(error_alert.report_failure_activity("agent-3", "sms", "no sink configured"))
    assert result["alerted"] is False
    assert FakeClient.calls == []


def test_flag_off_never_dispatches(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_ERROR_CHANNEL_ID", "C_INPUT")
    _run(error_alert.report_failure_activity("agent-4", "agent_workflow", "no rca"))
    assert not any("api.github.com" in c["url"] for c in FakeClient.calls)


def test_second_identical_signature_is_throttled(monkeypatch):
    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")
    r1 = _run(error_alert.report_failure_activity("a", "sms", "same failure text"))
    r2 = _run(error_alert.report_failure_activity("a", "sms", "same failure text"))
    assert r1["alerted"] is True
    assert r2.get("throttled") is True


def test_same_incident_text_does_not_throttle_distinct_agents(monkeypatch):
    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")
    r1 = _run(error_alert.report_failure_activity("a", "sms", "same failure text"))
    r2 = _run(error_alert.report_failure_activity("b", "sms", "same failure text"))
    assert r1["alerted"] is True
    assert r2["alerted"] is True
    assert len([c for c in FakeClient.calls if "hooks.slack.test" in c["url"]]) == 2


def test_same_incident_alerts_every_agent_without_github(monkeypatch):
    monkeypatch.setenv("AUTO_RCA_ENABLED", "1")
    monkeypatch.setenv("GITHUB_DISPATCH_TOKEN", "ghp_test")
    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")

    first = _run(error_alert.report_failure_activity("agent-a", "sms", "provider outage 42"))
    second = _run(error_alert.report_failure_activity("agent-b", "sms", "provider outage 99"))

    assert first["alerted"] is True
    assert second["alerted"] is True
    assert not any("api.github.com" in c["url"] for c in FakeClient.calls)
    assert len([c for c in FakeClient.calls if "hooks.slack.test" in c["url"]]) == 2


def test_never_raises_on_transport_error(monkeypatch):
    class BoomClient(FakeClient):
        async def post(self, *a, **k):
            raise RuntimeError("network down")

    monkeypatch.setenv("SLACK_ERROR_WEBHOOK_URL", "https://hooks.slack.test/xxx")
    monkeypatch.setattr(error_alert.httpx, "AsyncClient", BoomClient)
    result = _run(error_alert.report_failure_activity("a", "sms", "explodes on send"))
    assert result["alerted"] is False  # swallowed, not raised

    monkeypatch.setattr(error_alert.httpx, "AsyncClient", FakeClient)
    retry = _run(error_alert.report_failure_activity("a", "sms", "explodes on send"))
    assert retry["alerted"] is True, "failed delivery must remain immediately retryable"
