"""Blackbox tests: a GitHub rate limit is reported truthfully to the Rose agent.

Observable surface (rose-builds-rose C18, 2026-11-06):
  - The backend answers session create with 429 ``{"code": "GITHUB_RATE_LIMITED",
    "error": "...retry after <ISO>.", "reset_at": <ISO>}`` when GitHub's rate limit
    stopped the repo access check. The 429 body shape is asserted by the backend
    blackbox ``github-rate-limit``.
  - The agent-side create maps that to a non-retryable typed ApplicationError that
    carries the backend's message (with the reset time) verbatim: retrying inside the
    limit only spends more of it.
  - The tool call fails with that exact message as an ERROR; it is not soft-failed
    as a transient sandbox flake and not reported as an access denial.
  - A merge lookup that GitHub never answered (rate limited, or unreachable) is
    reported as unknown. The tool result never says "no (confirmed with GitHub)".
"""

import asyncio

from _test_utils import BlackboxResult, setup_mock, teardown_mock
from temporalio.exceptions import ActivityError, ApplicationError, RetryState

RESET_AT = "2026-11-06T06:18:42.000Z"
LIMITED = f"GitHub rate limit reached (primary, core); retry after {RESET_AT}."
SCHEMA = {"fields": [{"name": "summary", "type": "str", "description": "What changed", "required": True}]}


class _Handle:
    def __init__(self, raise_exc):
        self._raise_exc = raise_exc

    def done(self):
        return True

    def cancel(self):
        pass

    def __await__(self):
        async def _inner():
            raise self._raise_exc

        return _inner().__await__()


class _Workflow:
    class ActivityCancellationType:
        TRY_CANCEL = "TRY_CANCEL"
        WAIT_CANCELLATION_COMPLETED = "WAIT_CANCELLATION_COMPLETED"

    def __init__(self, handle):
        self._handle = handle
        self.started = []

    def start_activity(self, fn, args=None, **kwargs):
        self.started.append(fn.__name__)
        return self._handle

    async def wait_condition(self, predicate):
        return None

    @staticmethod
    def now():
        from datetime import datetime, timezone

        return datetime(2026, 11, 6, tzinfo=timezone.utc)

    async def execute_activity(self, fn, args=None, **kwargs):
        if fn.__name__ == "resolve_code_agent_provider_activity":
            return args[0]
        raise AssertionError(f"unexpected activity {fn.__name__}")


class _Instance:
    def __init__(self):
        self.user_id = "u-1"
        self.agent_id = "agent-github-rate-limit"
        self.model = "rose-labs/rose-1-flash"
        self.is_paused = False


async def test_repo_maps_github_429_to_non_retryable_typed_error():
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    setup_mock(
        {
            "/api/claude-code-session/create": {
                "status": 429,
                "json": {
                    "code": "GITHUB_RATE_LIMITED",
                    "error": LIMITED,
                    "reset_at": RESET_AT,
                    "retry_after_seconds": 3600,
                },
            }
        }
    )
    try:
        await create_e2b_session(agent_id="agent-1", goal="fix", user_id="u1")
        raise AssertionError("expected GITHUB_RATE_LIMITED")
    except ApplicationError as error:
        assert error.type == "GITHUB_RATE_LIMITED"
        assert error.non_retryable is True
        assert error.message == LIMITED
        assert RESET_AT in error.message


async def test_tool_fails_with_exact_message_without_soft_fail():
    import domains.spawn_claude_code_agent.handler as handler
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    cause = ApplicationError(LIMITED, type="GITHUB_RATE_LIMITED", non_retryable=True)
    error = ActivityError(
        "Activity task failed",
        scheduled_event_id=1,
        started_event_id=2,
        identity="w",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=RetryState.NON_RETRYABLE_FAILURE,
    )
    error.__cause__ = cause
    fake = _Workflow(_Handle(error))
    original = handler.workflow
    handler.workflow = fake
    try:
        events = [
            e
            async for e in SpawnClaudeCodeAgentManager().execute_tool(
                _Instance(), {"goal": "fix", "output_schema": SCHEMA}, "tc-gh-limit"
            )
        ]
    finally:
        handler.workflow = original

    terminal = events[-1]
    assert terminal.status == MessageStatus.ERROR, terminal.status
    assert terminal.message == LIMITED
    assert terminal.metadata["error_code"] == "GITHUB_RATE_LIMITED"
    assert terminal.metadata["code_agent"]["state"] == "failed"
    # One activity start: the workflow never re-spawns the session into the limit.
    assert fake.started == ["spawn_claude_code_activity"]
    # Never an access denial, never the transient-capacity soft-fail.
    text = " ".join((e.message or "") for e in events)
    assert "permission" not in text.lower() and "Retry spawn_claude_code_agent shortly" not in text


def _summary(merge):
    from domains.spawn_claude_code_agent.service import (
        _merge_close_code_session_facts,
        format_code_session_summary,
    )

    close = {
        "code_session": {
            "code_session_id": "cs-1",
            "state": "paused",
            "branch": "rose/ui-header",
            "merge_target": "main",
            "repo": {"head": "d" * 40, "pushed": True, "localCommits": 0, "dirtyFiles": 0},
            "merge": {"head": "d" * 40, "pushed": True, "local_commits": 0, **merge},
        }
    }
    return format_code_session_summary(_merge_close_code_session_facts(None, close))


async def test_merge_line_is_unknown_when_github_never_answered():
    limited = _summary(
        {
            "source": "github_rate_limited",
            "rate_limited_until": RESET_AT,
            "merged": False,
            "merge_target_contains_head": None,
        }
    )
    assert f"Merged: unknown (GitHub rate limit reached; retry after {RESET_AT})" in limited, limited
    assert "confirmed with GitHub" not in limited

    unreachable = _summary({"source": "github_unavailable", "merged": False})
    assert "Merged: unknown (GitHub could not be reached)" in unreachable, unreachable
    assert "confirmed with GitHub" not in unreachable

    # GitHub did answer: the confirmed wording stays.
    answered = _summary({"source": "github", "merged": False, "merge_target_contains_head": False})
    assert "Merged: no (confirmed with GitHub)" in answered, answered
    confirmed = _summary({"source": "github", "merged": True, "merge_target_contains_head": True})
    assert "Merged: yes (confirmed with GitHub)" in confirmed, confirmed


async def run_all_tests():
    print("code-agent-github-rate-limit blackbox tests:")
    r = BlackboxResult()
    await r.record_async("repo_github_429_typed", test_repo_maps_github_429_to_non_retryable_typed_error)
    await r.record_async("tool_fails_exact_message", test_tool_fails_with_exact_message_without_soft_fail)
    await r.record_async("merge_line_unknown_when_unanswered", test_merge_line_is_unknown_when_github_never_answered)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
