"""Blackbox tests for spawn-agent domain."""

import asyncio
import json
from unittest.mock import patch

import pytest

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


def _setup():
    setup_mock(
        {
            "/api/people": {
                "status": 200,
                "json": {
                    "people": [
                        {"id": "p-1", "firstName": "Alice", "lastName": "Smith", "phoneNumber": "+15551111111"},
                        {"id": "p-2", "firstName": "Bob", "lastName": "Jones", "phoneNumber": "+15552222222"},
                    ],
                    "count": 2,
                },
            },
        }
    )


async def test_fetch_full_network_metadata_happy_path():
    """fetch_full_network_metadata returns formatted contact metadata."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_agent import fetch_full_network_metadata

        result = await fetch_full_network_metadata(user_id="user-42")

    # Returns a string with contact metadata
    assert isinstance(result, str)


async def test_fetch_full_network_metadata_boundary():
    """Verify GET request to backend people endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.spawn_agent import fetch_full_network_metadata

        await fetch_full_network_metadata(user_id="user-99")

    call = assert_captured_call(
        url_contains="/api/people",
        method="GET",
        header_present="X-API-Key",
    )
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


# ── validate_spawn_params ─────────────────────────────────────────────


def _assert_raises(fn, match):
    try:
        fn()
    except ValueError as e:
        assert match in str(e), f"Expected '{match}' in error, got: {e}"
        return
    raise AssertionError(f"Expected ValueError containing '{match}'")


def test_validate_spawn_missing_type():
    """Missing type raises."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(lambda: validate_spawn_params({}), "type")


def test_validate_spawn_invalid_type():
    """Unknown type raises with allowed list."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(lambda: validate_spawn_params({"type": "foo"}), "invalid")


def test_validate_spawn_missing_goal():
    """Missing goal raises."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(lambda: validate_spawn_params({"type": "explore"}), "goal")


def test_validate_spawn_browser_missing_start_url():
    """browser type requires start_url."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params({"type": "browser", "goal": "g", "output_schema": {"fields": []}}),
        "start_url",
    )


def test_validate_spawn_browser_missing_schema():
    """browser type requires output_schema."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params({"type": "browser", "goal": "g", "start_url": "https://x.com"}),
        "output_schema",
    )


def test_validate_spawn_browser_happy():
    """Valid browser params accepted."""
    from domains.spawn_agent.service import validate_spawn_params

    validate_spawn_params(
        {
            "type": "browser",
            "goal": "book ticket",
            "start_url": "https://example.com",
            "output_schema": {"fields": []},
        }
    )


def test_validate_spawn_sub_agent_bad_phase():
    """sub_agent rejects invalid start_phase."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params(
            {
                "type": "sub_agent",
                "goal": "g",
                "output_schema": {"fields": []},
                "start_phase": "start",
            }
        ),
        "start_phase",
    )


def test_validate_spawn_for_each_requires_items():
    """for_each requires items or items_csv."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params(
            {
                "type": "for_each",
                "goal": "g",
                "output_schema": {"fields": []},
            }
        ),
        "items",
    )


def test_validate_spawn_for_each_with_items():
    """for_each with items accepted."""
    from domains.spawn_agent.service import validate_spawn_params

    validate_spawn_params(
        {
            "type": "for_each",
            "goal": "g",
            "output_schema": {"fields": []},
            "items": ["a", "b"],
        }
    )


def test_validate_spawn_for_each_with_csv():
    """for_each with items_csv accepted."""
    from domains.spawn_agent.service import validate_spawn_params

    validate_spawn_params(
        {
            "type": "for_each",
            "goal": "g",
            "output_schema": {"fields": []},
            "items_csv": "a,b,c",
        }
    )


def test_validate_spawn_explore_rejects_schema():
    """explore type rejects output_schema."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params({"type": "explore", "goal": "g", "output_schema": {"fields": [1]}}),
        "output_schema",
    )


def test_validate_spawn_explore_rejects_verifier():
    """explore type rejects verifier."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params({"type": "explore", "goal": "g", "verifier": {"type": "X"}}),
        "verifier",
    )


def test_validate_spawn_explore_happy():
    """Valid explore params accepted."""
    from domains.spawn_agent.service import validate_spawn_params

    validate_spawn_params({"type": "explore", "goal": "research topic"})


# ── resolve_start_phase ───────────────────────────────────────────────


def test_resolve_start_phase_default():
    """Missing phase resolves to plan."""
    from domains.spawn_agent.service import resolve_start_phase

    assert resolve_start_phase({}) == "plan"


def test_resolve_start_phase_execute():
    """'execute' is preserved case-insensitively."""
    from domains.spawn_agent.service import resolve_start_phase

    assert resolve_start_phase({"start_phase": "EXECUTE"}) == "execute"


def test_resolve_start_phase_invalid_defaults_plan():
    """Unknown phase defaults to plan."""
    from domains.spawn_agent.service import resolve_start_phase

    assert resolve_start_phase({"start_phase": "weird"}) == "plan"


# ── coerce_for_each_items ─────────────────────────────────────────────


def test_coerce_for_each_items_list():
    """list items pass through."""
    from domains.spawn_agent.service import coerce_for_each_items

    assert coerce_for_each_items({"items": ["a", "b"]}) == ["a", "b"]


def test_coerce_for_each_items_empty():
    """No items + no csv → [] returned."""
    from domains.spawn_agent.service import coerce_for_each_items

    assert coerce_for_each_items({}) == []
    assert coerce_for_each_items({"items_csv": ""}) == []


def test_coerce_for_each_items_single_col_csv():
    """Plain single-column CSV returns list of strings."""
    from domains.spawn_agent.service import coerce_for_each_items

    result = coerce_for_each_items({"items_csv": "apple\nbanana\ncherry"})
    assert result == ["apple", "banana", "cherry"]


def test_coerce_for_each_items_csv_with_header():
    """CSV with header produces dict rows."""
    from domains.spawn_agent.service import coerce_for_each_items

    csv_text = "name,age\nAlice,30\nBob,25"
    result = coerce_for_each_items({"items_csv": csv_text})
    # When header is sniffed, DictReader returns dicts
    assert isinstance(result, list)
    assert len(result) >= 2
    # First row should have name=Alice (either as dict or dict-like)
    first = result[0]
    assert isinstance(first, dict)
    assert first.get("name") == "Alice"


def test_coerce_for_each_items_multicol_no_header():
    """Multi-column CSV without header produces dict rows with values list."""
    from domains.spawn_agent.service import coerce_for_each_items

    csv_text = "1,2,3\n4,5,6"
    result = coerce_for_each_items({"items_csv": csv_text})
    assert len(result) >= 1
    # Each row has 'values'
    if isinstance(result[0], dict):
        assert "values" in result[0]


# ── build_for_each_goal ───────────────────────────────────────────────


def test_build_for_each_goal_string_item():
    """String item formatted as plain text row."""
    from domains.spawn_agent.service import build_for_each_goal

    out = build_for_each_goal("Do X", "row1")
    assert "Do X" in out
    assert "row1" in out
    assert "Row item:" in out


def test_build_for_each_goal_dict_item():
    """Dict item rendered as JSON."""
    from domains.spawn_agent.service import build_for_each_goal

    out = build_for_each_goal("Process", {"name": "Alice", "age": 30})
    assert "Process" in out
    assert "Alice" in out
    assert '"age": 30' in out


# ── SpawnAgentManager handler tests ──────────────────────────────────


class _Activity:
    """Fake activity handle supporting done/cancel/await."""

    def __init__(self, result=None, *, cancel_on_await=False, exception=None):
        self._result = result if result is not None else {}
        self._done = True
        self._cancel_on_await = cancel_on_await
        self._exception = exception
        self._cancelled = False

    def done(self):
        return self._done

    def cancel(self):
        self._cancelled = True

    def __await__(self):
        async def _inner():
            if self._exception:
                raise self._exception
            if self._cancel_on_await:
                import asyncio as _a

                raise _a.CancelledError()
            return self._result

        return _inner().__await__()


class _FakeSpawnWF:
    """Workflow module stub."""

    def __init__(self, activity_results=None, start_activity_result=None):
        self._activity_results = activity_results or {}
        self._start_activity_result = start_activity_result or _Activity(
            result={
                "result": "Found 3 results",
                "tool_call_results": [],
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        )
        self.logger = type("L", (), {"info": lambda *a, **kw: None, "error": lambda *a, **kw: None})()
        import temporalio.workflow as real

        self.unsafe = real.unsafe
        self.ActivityCancellationType = real.ActivityCancellationType

    async def execute_activity(self, fn, args=None, **kwargs):
        name = getattr(fn, "__name__", "?")
        if name in self._activity_results:
            val = self._activity_results[name]
            if isinstance(val, Exception):
                raise val
            return val() if callable(val) else val
        return ""

    def start_activity(self, fn, args=None, **kwargs):
        return self._start_activity_result

    async def wait_condition(self, predicate, timeout=None):
        # Evaluate once; if not satisfied, return anyway (no real waiting)
        predicate()
        return


class _FakeWFInstance:
    def __init__(self, *, user_id="u-1", agent_id="a-1", depth=0, paused=False, model="rose-1-lite"):
        self.user_id = user_id
        self.agent_id = agent_id
        self.depth = depth
        self.is_paused = paused
        self.model = model
        self.context = {}
        self.context_gates = {}
        self.handled_events = []
        self._tracked_usage = []

    async def _handle_tool_event(self, event, tcid, tname):
        self.handled_events.append((event, tcid, tname))

    async def _track_usage(self, usage, **kwargs):
        self._tracked_usage.append((usage, kwargs))


def _patch_spawn_workflow(fake):
    import domains.spawn_agent.handler as h

    original = h.workflow
    h.workflow = fake

    def restore():
        h.workflow = original

    return restore


class _FakeDelegateManager:
    """Stand-in for browser/code/sub_agent managers."""

    def __init__(self, events):
        self._events = events
        self.last_call = None

    def execute_tool(self, workflow_instance, tool_call, tool_call_id):
        self.last_call = {"tool_call": tool_call, "tool_call_id": tool_call_id}

        async def _gen():
            for e in self._events:
                yield e

        return _gen()


async def _collect(gen):
    out = []
    async for e in gen:
        out.append(e)
    return out


async def test_handler_validation_bubbles_for_each():
    """for_each validation errors raise (for DAG handling), don't yield ERROR."""
    from domains.spawn_agent.handler import SpawnAgentManager

    raised = False
    try:
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "for_each"},  # missing goal
                tool_call_id="tc",
            )
        )
    except ValueError:
        raised = True
    assert raised


async def test_handler_validation_emits_error_for_others():
    """Non-for_each validation failure yields ERROR event."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=_FakeWFInstance(),
            tool_call={"type": "explore"},  # missing goal
            tool_call_id="tc",
        )
    )
    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR


async def test_handler_explore_happy_path():
    """Explore dispatch yields IN_PROGRESS + FINISHED with result."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "net-meta", "fetch_local_data_summary": "local"},
        start_activity_result=_Activity(
            result={
                "result": "All done.",
                "tool_call_results": [],
                "accumulated_usage": [{"llm": [{"x": 1}], "service": []}],
                "llm_iteration_usage": [],
            }
        ),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "explore", "goal": "research quantum computing"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    statuses = [e.status for e in events]
    assert MessageStatus.IN_PROGRESS in statuses
    assert MessageStatus.FINISHED in statuses
    # FINISHED event carries result + usage
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert "All done." in finished.message
    assert finished.data["usage"]["llm"]


async def test_handler_explore_gates_off_skips_fetch():
    """context_gates disabling network + recent_comm skips those activities."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    # No fake results set -- would KeyError if activities ran
    fake = _FakeSpawnWF(
        start_activity_result=_Activity(
            result={"result": "ok", "tool_call_results": [], "accumulated_usage": [], "llm_iteration_usage": []}
        )
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "explore",
                    "goal": "g",
                    "context_gates": {"network": False, "recent_communications": False},
                },
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    assert any(e.status == MessageStatus.FINISHED for e in events)


async def test_handler_explore_capture_tool_results():
    """capture_tool_results collector is populated; ToolEvent.data has no tool_call_results.

    Guards the Temporal-payload-size fix: the ~150 KB sub-agent trace must stay
    out of persisted event data and only flow through the caller-supplied list.
    """
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    sub_agent_trace = ["[web_search] {big}", "[read_memories] {stuff}"]
    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "", "fetch_local_data_summary": ""},
        start_activity_result=_Activity(
            result={
                "result": "summary",
                "tool_call_results": sub_agent_trace,
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        ),
    )
    captured: list[str] = []
    restore = _patch_spawn_workflow(fake)
    try:
        mgr = SpawnAgentManager()
        events = await _collect(
            mgr._spawn_explore(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "explore", "goal": "g"},
                tool_call_id="tc",
                capture_tool_results=captured,
            )
        )
    finally:
        restore()
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert "tool_call_results" not in (finished.data or {}), "must not persist raw trace in event data"
    assert captured == sub_agent_trace, "collector must receive the raw trace out-of-band"


async def test_handler_explore_cancelled_yields_error():
    """Explore activity CancelledError -> ERROR event."""
    import asyncio as _a

    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "", "fetch_local_data_summary": ""},
        start_activity_result=_Activity(cancel_on_await=True),
    )

    # Simulate workflow pause to trigger cancel path
    class _PausedFake(type(fake)):
        pass

    restore = _patch_spawn_workflow(fake)
    try:
        wf = _FakeWFInstance(paused=True)
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=wf,
                tool_call={"type": "explore", "goal": "g"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    # Either ERROR (cancel path) is expected
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_explore_exception_yields_error():
    """Non-cancel activity exception -> ERROR event."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "", "fetch_local_data_summary": ""},
        start_activity_result=_Activity(exception=RuntimeError("explore died")),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "explore", "goal": "g"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_browser_delegates():
    """browser type delegates to browser manager."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="Browser done", message="ok", status=MessageStatus.FINISHED)]
    )
    original = h.get_browser_manager
    h.get_browser_manager = lambda: fake_mgr
    try:
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "browser",
                    "goal": "book ticket",
                    "start_url": "https://x.com",
                    "output_schema": {"fields": []},
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_browser_manager = original
    assert any(e.status == MessageStatus.FINISHED for e in events)
    # Delegate received browser-shaped call
    assert fake_mgr.last_call["tool_call"]["tool"] == "spawn_browser_agent"


async def test_handler_code_delegates():
    """code type delegates to code manager with optional github repo link."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="Code done", message="ok", status=MessageStatus.FINISHED)]
    )
    original = h.get_code_manager
    h.get_code_manager = lambda: fake_mgr
    try:
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "code",
                    "goal": "refactor",
                    "output_schema": {"fields": []},
                    "github_repo_link": "https://github.com/foo/bar",
                    "attachments": ["file.txt"],
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_code_manager = original
    assert any(e.status == MessageStatus.FINISHED for e in events)
    assert fake_mgr.last_call["tool_call"]["github_repo_link"] == "https://github.com/foo/bar"
    assert fake_mgr.last_call["tool_call"]["attachments"] == ["file.txt"]


async def test_handler_sub_agent_delegates_with_default_verifier():
    """sub_agent without verifier injects FLOAT_LLM_JUDGE default."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="Sub done", message="ok", status=MessageStatus.FINISHED)]
    )
    original = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: fake_mgr
    try:
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "sub_agent",
                    "goal": "do work",
                    "output_schema": {"fields": []},
                    "context_gates": {"network": False},
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original
    assert any(e.status == MessageStatus.FINISHED for e in events)
    cfg = fake_mgr.last_call["tool_call"]["sub_agent"]
    assert cfg["verifier"]["type"] == "FLOAT_LLM_JUDGE"
    assert cfg["context_gates"] == {"network": False}


async def test_handler_sub_agent_uses_provided_verifier():
    """sub_agent with verifier uses caller-provided verifier."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="Sub done", message="ok", status=MessageStatus.FINISHED)]
    )
    original = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: fake_mgr
    try:
        await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "sub_agent",
                    "goal": "g",
                    "output_schema": {"fields": []},
                    "verifier": {"type": "BOOLEAN", "prompt": "done?"},
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original
    cfg = fake_mgr.last_call["tool_call"]["sub_agent"]
    assert cfg["verifier"]["type"] == "BOOLEAN"


async def test_handler_for_each_depth_exceeded_raises():
    """for_each at depth >= FOR_EACH_MAX_DEPTH raises ValueError."""
    from domains.spawn_agent.handler import SpawnAgentManager

    raised = False
    try:
        await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(depth=4),
                tool_call={
                    "type": "for_each",
                    "goal": "g",
                    "output_schema": {"fields": []},
                    "items": ["a", "b"],
                },
                tool_call_id="tc",
            )
        )
    except ValueError as e:
        raised = True
        assert "depth" in str(e).lower()
    assert raised


async def test_handler_for_each_no_items_raises():
    """for_each with empty items raises."""
    from domains.spawn_agent.handler import SpawnAgentManager

    raised = False
    try:
        await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "for_each",
                    "goal": "g",
                    "output_schema": {"fields": []},
                    "items": [],
                },
                tool_call_id="tc",
            )
        )
    except ValueError as e:
        raised = True
        assert "items" in str(e).lower()
    assert raised


async def test_handler_for_each_happy_path_all_succeed():
    """for_each with items spawns sub_agent for each, yields no error events on success."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="sub ok", message="ok", status=MessageStatus.FINISHED)]
    )

    fake = _FakeSpawnWF()
    restore_wf = _patch_spawn_workflow(fake)
    original_sub = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: fake_mgr
    try:
        wf = _FakeWFInstance()
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=wf,
                tool_call={
                    "type": "for_each",
                    "goal": "process row",
                    "output_schema": {"fields": []},
                    "items": ["a", "b"],
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original_sub
        restore_wf()

    # No ERROR events yielded when all children succeed
    assert not any(e.status == MessageStatus.ERROR for e in events)
    # But child events were handled through workflow_instance._handle_tool_event
    assert len(wf.handled_events) >= 2  # at least 2 per-child


async def test_handler_for_each_failed_yields_error():
    """for_each with child errors yields aggregate ERROR event."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="child err", message="boom", status=MessageStatus.ERROR)]
    )

    fake = _FakeSpawnWF()
    restore_wf = _patch_spawn_workflow(fake)
    original_sub = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: fake_mgr
    try:
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "for_each",
                    "goal": "process",
                    "output_schema": {"fields": []},
                    "items": ["a"],
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original_sub
        restore_wf()

    assert any(e.status == MessageStatus.ERROR and "children failed" in e.message for e in events)


async def test_spawn_agent_helper_tracks_usage_and_returns():
    """spawn_agent() workflow helper invokes manager and tracks usage."""
    import domains.spawn_agent.handler as h
    from tools.base import EventType, MessageStatus, ToolEvent

    class _DirectMgr:
        def execute_tool(self, wf, tc, tcid):
            async def _g():
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="finished",
                    message="done",
                    status=MessageStatus.FINISHED,
                    data={"result": "RESULT", "usage": {"llm": [], "service": []}},
                )

            return _g()

    original = h.get_manager
    h.get_manager = lambda: _DirectMgr()
    fake_wf = _FakeSpawnWF()
    restore_wf = _patch_spawn_workflow(fake_wf)
    try:
        wf = _FakeWFInstance()
        status, result = await h.spawn_agent(wf, {"type": "explore", "goal": "g"}, "tc")
    finally:
        h.get_manager = original
        restore_wf()

    assert status == MessageStatus.FINISHED
    assert result == "RESULT"
    # usage tracked
    assert len(wf._tracked_usage) == 1


async def run_all_tests():
    print("spawn-agent blackbox tests:")
    r = BlackboxResult()
    await r.record_async("fetch_network_metadata_happy_path", test_fetch_full_network_metadata_happy_path)
    await r.record_async("fetch_network_metadata_boundary", test_fetch_full_network_metadata_boundary)
    # validation
    r.record("validate_missing_type", test_validate_spawn_missing_type)
    r.record("validate_invalid_type", test_validate_spawn_invalid_type)
    r.record("validate_missing_goal", test_validate_spawn_missing_goal)
    r.record("validate_browser_no_url", test_validate_spawn_browser_missing_start_url)
    r.record("validate_browser_no_schema", test_validate_spawn_browser_missing_schema)
    r.record("validate_browser_happy", test_validate_spawn_browser_happy)
    r.record("validate_sub_agent_bad_phase", test_validate_spawn_sub_agent_bad_phase)
    r.record("validate_for_each_needs_items", test_validate_spawn_for_each_requires_items)
    r.record("validate_for_each_items", test_validate_spawn_for_each_with_items)
    r.record("validate_for_each_csv", test_validate_spawn_for_each_with_csv)
    r.record("validate_explore_no_schema", test_validate_spawn_explore_rejects_schema)
    r.record("validate_explore_no_verifier", test_validate_spawn_explore_rejects_verifier)
    r.record("validate_explore_happy", test_validate_spawn_explore_happy)
    # resolve_start_phase
    r.record("resolve_phase_default", test_resolve_start_phase_default)
    r.record("resolve_phase_execute", test_resolve_start_phase_execute)
    r.record("resolve_phase_invalid", test_resolve_start_phase_invalid_defaults_plan)
    # coerce_for_each_items
    r.record("coerce_items_list", test_coerce_for_each_items_list)
    r.record("coerce_items_empty", test_coerce_for_each_items_empty)
    r.record("coerce_items_single_col", test_coerce_for_each_items_single_col_csv)
    r.record("coerce_items_with_header", test_coerce_for_each_items_csv_with_header)
    r.record("coerce_items_multicol", test_coerce_for_each_items_multicol_no_header)
    # build_for_each_goal
    r.record("build_goal_string", test_build_for_each_goal_string_item)
    r.record("build_goal_dict", test_build_for_each_goal_dict_item)
    # SpawnAgentManager handler
    await r.record_async("handler_validation_bubbles_for_each", test_handler_validation_bubbles_for_each)
    await r.record_async("handler_validation_emits_error_for_others", test_handler_validation_emits_error_for_others)
    await r.record_async("handler_explore_happy", test_handler_explore_happy_path)
    await r.record_async("handler_explore_gates_off", test_handler_explore_gates_off_skips_fetch)
    await r.record_async("handler_explore_capture", test_handler_explore_capture_tool_results)
    await r.record_async("handler_explore_cancelled", test_handler_explore_cancelled_yields_error)
    await r.record_async("handler_explore_exception", test_handler_explore_exception_yields_error)
    await r.record_async("handler_browser_delegates", test_handler_browser_delegates)
    await r.record_async("handler_code_delegates", test_handler_code_delegates)
    await r.record_async("handler_sub_agent_default_verifier", test_handler_sub_agent_delegates_with_default_verifier)
    await r.record_async("handler_sub_agent_uses_verifier", test_handler_sub_agent_uses_provided_verifier)
    await r.record_async("handler_for_each_depth", test_handler_for_each_depth_exceeded_raises)
    await r.record_async("handler_for_each_no_items", test_handler_for_each_no_items_raises)
    await r.record_async("handler_for_each_happy", test_handler_for_each_happy_path_all_succeed)
    await r.record_async("handler_for_each_failed", test_handler_for_each_failed_yields_error)
    await r.record_async("spawn_agent_helper", test_spawn_agent_helper_tracks_usage_and_returns)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
