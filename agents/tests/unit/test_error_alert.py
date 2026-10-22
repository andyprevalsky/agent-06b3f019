"""Unit tests for the root-agent failure record (helpers/error_alert.py).

Agent failures are owned by the backend's 24h stuck-agent bug reports, so the
worker activity must never post to Slack or dispatch a GitHub Auto RCA, even
with every legacy transport configured, and it NEVER raises.
"""

import asyncio

import pytest

from helpers import error_alert


def _run(coro):
    """Drive a coroutine to completion without depending on pytest-asyncio."""
    return asyncio.run(coro)


class RecordingLogger:
    def __init__(self):
        self.warnings: list[str] = []

    def warning(self, message, *args, **kwargs):
        self.warnings.append(message)


@pytest.fixture
def logger(monkeypatch):
    recorder = RecordingLogger()
    # No Temporal activity context in a unit test — swap the adapter for a recorder.
    monkeypatch.setattr(error_alert.activity, "logger", recorder)
    return recorder


@pytest.fixture
def legacy_transports(monkeypatch):
    for name, value in {
        "AUTO_RCA_ENABLED": "1",
        "GITHUB_DISPATCH_TOKEN": "ghp_test",
        "SLACK_BOT_TOKEN": "xoxb-test",
        "SLACK_ERROR_CHANNEL_ID": "C_TEST",
        "SLACK_ERROR_WEBHOOK_URL": "https://hooks.slack.com/services/test",
    }.items():
        monkeypatch.setenv(name, value)


def test_never_posts_slack_or_dispatches_rca(monkeypatch, logger, legacy_transports):
    import httpx

    def forbidden(*args, **kwargs):
        raise AssertionError("report_failure_activity must not make outbound requests")

    monkeypatch.setattr(httpx, "AsyncClient", forbidden)
    monkeypatch.setattr(httpx, "Client", forbidden)

    result = _run(
        error_alert.report_failure_activity(
            "11111111-2222-4333-8444-555555555555",
            "agent_workflow",
            "Verifier exhausted retries",
            {"reason": "verifier_failed"},
        )
    )

    assert result == {"alerted": False, "logged": True}


def test_logs_agent_reason_and_bounded_message(logger):
    result = _run(
        error_alert.report_failure_activity("agent-1", "agent_workflow", "x" * 1000, {"reason": "max_iterations"})
    )

    assert result == {"alerted": False, "logged": True}
    assert len(logger.warnings) == 1
    line = logger.warnings[0]
    assert "agent_id=agent-1" in line
    assert "reason=max_iterations" in line
    assert "x" * 200 in line and "x" * 201 not in line


def test_never_raises_when_logging_fails(monkeypatch):
    class BrokenLogger:
        def warning(self, *args, **kwargs):
            raise RuntimeError("log sink down")

    monkeypatch.setattr(error_alert.activity, "logger", BrokenLogger())

    result = _run(error_alert.report_failure_activity(None, "agent_workflow", "boom"))

    assert result == {"alerted": False, "error": "log sink down"}


def test_module_no_longer_carries_slack_or_dispatch_transports():
    for name in ("_dispatch_rca", "_post_slack_bot", "_slack_payload"):
        assert not hasattr(error_alert, name), name


def test_activity_keeps_registered_name():
    # In-flight workflow histories schedule this exact activity type.
    assert error_alert.report_failure_activity.__temporal_activity_definition.name == "report_failure_activity"
