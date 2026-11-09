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
  - benchmarks/github_rate_limit_check.py (the code-agent benchmark's check of a
    finished run) accepts exactly those behaviours and rejects duplicate sessions,
    credentials in output, a wrong reset time and a false "confirmed" claim.
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


def _check_inputs():
    from datetime import datetime, timezone

    reset = datetime(2026, 11, 6, 6, 18, 42, tzinfo=timezone.utc)
    tool_error = {
        "role": "TOOL",
        "message": LIMITED,
        "metadata": {"toolName": "spawn_claude_code_agent", "error_code": "GITHUB_RATE_LIMITED", "status": "ERROR"},
    }
    tool_ok = {"role": "TOOL", "message": "done", "metadata": {"toolName": "spawn_claude_code_agent"}}
    return reset, tool_error, tool_ok


async def test_benchmark_check_startup_outcomes():
    from benchmarks.github_rate_limit_check import GithubRateLimitExpectation, RunEvidence, evaluate

    reset, tool_error, tool_ok = _check_inputs()
    expect = GithubRateLimitExpectation(injected_reset_at=reset, phase="startup", secrets=("ghp_exact_secret_value",))

    failed = evaluate(RunEvidence(sessions=[], messages=[tool_error]), expect)
    assert failed.passed and failed.outcome == "failed_truthfully", failed

    late = {"id": "s1", "createdAt": "2026-11-06T06:18:50.000Z", "output": "ok"}
    started = evaluate(RunEvidence(sessions=[late], messages=[tool_ok]), expect)
    assert started.passed and started.outcome == "started_after_reset", started

    two = evaluate(RunEvidence(sessions=[late, {**late, "id": "s2"}], messages=[tool_ok]), expect)
    assert not two.passed and any("duplicate sessions" in f for f in two.failures), two

    early = {"id": "s1", "createdAt": "2026-11-06T06:10:00.000Z"}
    too_soon = evaluate(RunEvidence(sessions=[early], messages=[tool_ok]), expect)
    assert not too_soon.passed and any("before the limit ended" in f for f in too_soon.failures), too_soon

    wrong = {**tool_error, "message": "GitHub rate limit reached (primary); retry after 2026-11-06T09:00:00.000Z."}
    wrong_time = evaluate(RunEvidence(sessions=[], messages=[wrong]), expect)
    assert not wrong_time.passed and any("does not name the injected reset" in f for f in wrong_time.failures), wrong_time

    silent = evaluate(RunEvidence(sessions=[], messages=[tool_ok]), expect)
    assert not silent.passed and any("neither a truthful failure" in f for f in silent.failures), silent


async def test_benchmark_check_rejects_credentials_in_output():
    from benchmarks.github_rate_limit_check import GithubRateLimitExpectation, RunEvidence, evaluate

    reset, tool_error, _ = _check_inputs()
    expect = GithubRateLimitExpectation(injected_reset_at=reset, phase="startup", secrets=("ghp_exact_secret_value",))
    for leaked in (
        "clone failed: ghp_exact_secret_value",
        "token ghp_" + "A" * 36,
        "fatal: unable to access 'https://x-access-token:abc123@github.com/o/r'",
    ):
        message = {**tool_error, "message": f"{LIMITED} {leaked}"}
        result = evaluate(RunEvidence(sessions=[], messages=[message]), expect)
        assert not result.passed and any("credential in output" in f for f in result.failures), (leaked, result)
    leaky_session = {"id": "s1", "createdAt": "2026-11-06T06:19:00.000Z", "output": "ghp_exact_secret_value"}
    in_session = evaluate(RunEvidence(sessions=[leaky_session], messages=[]), expect)
    assert any("credential in output" in f for f in in_session.failures), in_session


async def test_benchmark_check_merge_lookup_phase():
    from benchmarks.github_rate_limit_check import GithubRateLimitExpectation, RunEvidence, evaluate

    reset, _, _ = _check_inputs()
    expect = GithubRateLimitExpectation(injected_reset_at=reset, phase="merge_lookup")
    unknown = {"role": "TOOL", "message": f"Merged: unknown (GitHub rate limit reached; retry after {RESET_AT})"}
    ok = evaluate(RunEvidence(sessions=[], messages=[unknown]), expect)
    assert ok.passed and ok.outcome == "merge_unknown_reported", ok

    claimed = {"role": "TOOL", "message": "Merged: no (confirmed with GitHub)"}
    bad = evaluate(RunEvidence(sessions=[], messages=[claimed]), expect)
    assert not bad.passed, bad
    assert any("confirmed with GitHub" in f for f in bad.failures), bad
    assert any("no 'Merged: unknown" in f for f in bad.failures), bad


async def run_all_tests():
    print("code-agent-github-rate-limit blackbox tests:")
    r = BlackboxResult()
    await r.record_async("repo_github_429_typed", test_repo_maps_github_429_to_non_retryable_typed_error)
    await r.record_async("tool_fails_exact_message", test_tool_fails_with_exact_message_without_soft_fail)
    await r.record_async("merge_line_unknown_when_unanswered", test_merge_line_is_unknown_when_github_never_answered)
    await r.record_async("check_startup_outcomes", test_benchmark_check_startup_outcomes)
    await r.record_async("check_rejects_credentials", test_benchmark_check_rejects_credentials_in_output)
    await r.record_async("check_merge_lookup_phase", test_benchmark_check_merge_lookup_phase)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
