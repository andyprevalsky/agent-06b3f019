"""Blackbox tests: E2B's concurrent-sandbox limit fails the code agent immediately.

Observable surface (directed by Andy, 2026-10-27):
  - The backend answers session create with 503 ``{"code": "E2B_CAPACITY_EXHAUSTED"}``
    when E2B refuses a sandbox over the plan's concurrent-sandbox limit.
  - The agent-side create maps that to a non-retryable typed ApplicationError
    carrying the backend's message verbatim.
  - The tool call fails with that exact message as an ERROR: no retry, no
    "transient capacity, retry shortly" soft-fail.
"""

import asyncio

from _test_utils import BlackboxResult, setup_mock, teardown_mock
from temporalio.exceptions import ActivityError, ApplicationError, RetryState

CAPACITY = (
    "E2B concurrent-sandbox limit reached: every sandbox allowed by the current E2B plan "
    "is in use, so no new sandbox can start. Scale the E2B plan to run more code agents."
)
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

        return datetime(2026, 10, 27, tzinfo=timezone.utc)

    async def execute_activity(self, fn, args=None, **kwargs):
        if fn.__name__ == "resolve_code_agent_provider_activity":
            return args[0]
        raise AssertionError(f"unexpected activity {fn.__name__}")


class _Instance:
    def __init__(self):
        self.user_id = "u-1"
        self.agent_id = "agent-e2b-capacity"
        self.model = "rose-labs/rose-1-flash"
        self.is_paused = False


async def test_repo_maps_capacity_503_to_non_retryable_typed_error():
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    setup_mock(
        {
            "/api/claude-code-session/create": {
                "status": 503,
                "json": {"code": "E2B_CAPACITY_EXHAUSTED", "error": CAPACITY},
            }
        }
    )
    try:
        await create_e2b_session(agent_id="agent-1", goal="fix", user_id="u1")
        raise AssertionError("expected E2B_CAPACITY_EXHAUSTED")
    except ApplicationError as error:
        assert error.type == "E2B_CAPACITY_EXHAUSTED"
        assert error.non_retryable is True
        assert error.message == CAPACITY


async def test_tool_fails_with_exact_message_without_soft_fail():
    import domains.spawn_claude_code_agent.handler as handler
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager
    from tools.base import MessageStatus

    cause = ApplicationError(CAPACITY, type="E2B_CAPACITY_EXHAUSTED", non_retryable=True)
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
                _Instance(), {"goal": "fix", "output_schema": SCHEMA}, "tc-cap"
            )
        ]
    finally:
        handler.workflow = original

    terminal = events[-1]
    assert terminal.status == MessageStatus.ERROR, terminal.status
    assert terminal.message == CAPACITY
    assert terminal.metadata["error_code"] == "E2B_CAPACITY_EXHAUSTED"
    assert terminal.metadata["code_agent"]["state"] == "failed"
    # One activity start: the workflow never re-spawns the session.
    assert fake.started == ["spawn_claude_code_activity"]
    # The transient-capacity soft-fail text never reaches the agent.
    assert all("Retry spawn_claude_code_agent shortly" not in (e.message or "") for e in events)


async def run_all_tests():
    print("code-agent-e2b-capacity blackbox tests:")
    r = BlackboxResult()
    await r.record_async("repo_capacity_503_typed", test_repo_maps_capacity_503_to_non_retryable_typed_error)
    await r.record_async("tool_fails_exact_message", test_tool_fails_with_exact_message_without_soft_fail)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
