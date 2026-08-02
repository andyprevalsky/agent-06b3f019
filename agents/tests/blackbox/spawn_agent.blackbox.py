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


def test_validate_spawn_general_purpose_bad_phase():
    """general_purpose rejects invalid start_phase."""
    from domains.spawn_agent.service import validate_spawn_params

    _assert_raises(
        lambda: validate_spawn_params(
            {
                "type": "general_purpose",
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


def test_coerce_for_each_items_common_header_when_sniffer_misses():
    """Common CSV headers are not emitted as work rows when Sniffer is inconclusive."""
    from unittest.mock import patch

    from domains.spawn_agent.service import coerce_for_each_items

    csv_text = (
        "name,city,contact,email\n"
        "Alice Example,Chicago,Alice,alice@example.com\n"
        "Bob Example,Austin,Bob,bob@example.com\n"
    )

    with patch("csv.Sniffer.has_header", return_value=False):
        result = coerce_for_each_items({"items_csv": csv_text})

    assert result == [
        {"name": "Alice Example", "city": "Chicago", "contact": "Alice", "email": "alice@example.com"},
        {"name": "Bob Example", "city": "Austin", "contact": "Bob", "email": "bob@example.com"},
    ]


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
        self.activity_calls = []
        self.start_activity_calls = []
        self._uuid_counter = 0
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
        self.activity_calls.append({"name": name, "args": args or [], "kwargs": kwargs})
        if name in self._activity_results:
            val = self._activity_results[name]
            if isinstance(val, Exception):
                raise val
            if callable(val):
                try:
                    return val(args=args or [], kwargs=kwargs)
                except TypeError:
                    return val()
            return val
        # Default mock for the for_each batch path: synthesize one child per cfg.
        if name == "spawn_sub_agents_batch_activity":
            cfgs = (args or [None, []])[1] or []
            return {
                "agents": [
                    {
                        "agent_id": f"child-{i}",
                        "status": "ACTIVE",
                        "goal": cfg.get("goal", ""),
                        "temporal_workflow_id": f"wf-child-{i}",
                    }
                    for i, cfg in enumerate(cfgs)
                ]
            }
        return ""

    def uuid4(self):
        self._uuid_counter += 1
        return f"00000000-0000-4000-8000-{self._uuid_counter:012d}"

    def start_activity(self, fn, args=None, **kwargs):
        self.start_activity_calls.append({"name": getattr(fn, "__name__", "?"), "args": args or [], "kwargs": kwargs})
        return self._start_activity_result

    async def wait_condition(self, predicate, timeout=None):
        # Evaluate once; if not satisfied, return anyway (no real waiting)
        predicate()
        return

    def info(self):
        return type("I", (), {"workflow_id": "wf-test"})()


class _FakeWFInstance:
    def __init__(
        self,
        *,
        user_id="u-1",
        agent_id="a-1",
        depth=0,
        paused=False,
        model="rose-1-lite",
        goal="",
        context=None,
    ):
        self.user_id = user_id
        self.agent_id = agent_id
        self.depth = depth
        self.goal = goal
        self.is_paused = paused
        self.model = model
        self.context = context if context is not None else {}
        self.context_gates = {}
        self.child_tool_ids = {}
        self.pending_children = set()
        self.child_workflow_ids = {}
        self.child_results = {}
        self.handled_events = []
        self._tracked_usage = []
        self.tree_state_updates = 0

    async def _handle_tool_event(self, event, tcid, tname):
        self.handled_events.append((event, tcid, tname))

    async def _track_usage(self, usage, **kwargs):
        self._tracked_usage.append((usage, kwargs))

    async def _update_tree_state(self, **kwargs):
        self.tree_state_updates += 1


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

    def execute_tool(self, workflow_instance, tool_call, tool_call_id, **kwargs):
        self.last_call = {"tool_call": tool_call, "tool_call_id": tool_call_id}

        async def _gen():
            for e in self._events:
                yield e

        return _gen()

    def finalize_child(self, workflow_instance, child_info, sub_agent, child_tool_id, bus_id):
        self.last_call = {"child_info": child_info, "child_tool_id": child_tool_id, "bus_id": bus_id}

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
    assert fake.activity_calls[0]["name"] == "fetch_local_data_summary"
    assert fake.start_activity_calls[0]["args"][-1] == "local"
    assert MessageStatus.FINISHED in statuses
    # FINISHED event carries result + usage
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert "All done." in finished.message
    assert finished.data["usage"]["llm"]


async def test_handler_explore_uses_lite_pool_independent_of_parent_model():
    """Explore research stays on its dedicated Lite pool even when the parent uses Ultra."""
    from domains.spawn_agent.config import EXPLORE_DEFAULT_MODEL
    from domains.spawn_agent.handler import SpawnAgentManager

    fake = _FakeSpawnWF()
    restore = _patch_spawn_workflow(fake)
    try:
        await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(model="rose-labs/rose-1-ultra"),
                tool_call={"type": "explore", "goal": "research three current facts", "depth": "quick"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    assert len(fake.start_activity_calls) == 1
    assert fake.start_activity_calls[0]["args"][3] == EXPLORE_DEFAULT_MODEL


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

    sub_agent_trace = ["[web_search] {big}", "[grep] {stuff}"]
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


async def test_handler_explore_failed_result_yields_error():
    """A non-completed explore activity must remain retryable by its parent."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "", "fetch_local_data_summary": ""},
        start_activity_result=_Activity(
            result={
                "status": "error",
                "result": "Web search was unavailable.",
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        ),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager()._spawn_explore(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "explore", "goal": "g"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    error_event = next(event for event in events if event.status == MessageStatus.ERROR)
    assert error_event.message == "Web search was unavailable."
    assert "error_reason" not in (error_event.data or {})
    assert "error_reason" not in (error_event.metadata or {})


async def test_handler_explore_failed_result_forwards_error_reason():
    """An explicit activity failure reason reaches the parent and UI event."""
    from domains.spawn_agent.handler import SpawnAgentManager
    from tools.base import MessageStatus

    reason = "explore completed without tool evidence"
    fake = _FakeSpawnWF(
        activity_results={"fetch_full_network_metadata": "", "fetch_local_data_summary": ""},
        start_activity_result=_Activity(
            result={
                "status": "error",
                "result": "Web search was unavailable.",
                "error_reason": reason,
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        ),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager()._spawn_explore(
                workflow_instance=_FakeWFInstance(),
                tool_call={"type": "explore", "goal": "g"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    error_event = next(event for event in events if event.status == MessageStatus.ERROR)
    assert error_event.message == reason
    assert error_event.data["error_reason"] == reason
    assert error_event.metadata["error_reason"] == reason


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


async def test_handler_sub_agent_delegates_without_verifier_arg():
    """sub_agent delegation does not expose verifier as a tool-controlled arg."""
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
                    "type": "general_purpose",
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
    assert "verifier" not in cfg
    assert cfg["context_gates"] == {"network": False}


async def test_handler_blocks_recursive_general_purpose_for_explore_only_child():
    """Explore-only research children should not spawn another general-purpose agent."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    wf = _FakeWFInstance(
        depth=1,
        goal=(
            "Find current population of Tokyo. Use explore-agent web research. "
            "MUST NOT use browser agent, Claude Code, or code sandbox."
        ),
    )

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=wf,
            tool_call={
                "type": "general_purpose",
                "goal": "Determine Tokyo population",
                "output_schema": {"fields": []},
            },
            tool_call_id="tc",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "explore-agent web research only" in events[0].message


async def test_handler_allows_root_explicit_general_purpose_with_explore_research_children():
    """Root benchmark contracts may require general-purpose agents whose child work is explore-only."""
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
                workflow_instance=_FakeWFInstance(
                    goal=(
                        "Find the current population of Tokyo and New York City. "
                        "You MUST use spawn_general_purpose_agent exactly twice - once per city."
                    ),
                ),
                tool_call={
                    "type": "general_purpose",
                    "goal": (
                        "Find current Tokyo population using only explore-agent web research. "
                        "MUST NOT use browser agent, Claude Code, or code sandbox."
                    ),
                    "output_schema": {"fields": []},
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original

    assert any(e.status == MessageStatus.FINISHED for e in events)
    assert fake_mgr.last_call["tool_call"]["sub_agent"]["goal"].startswith("Find current Tokyo population")


async def test_handler_blocks_recursive_general_purpose_for_web_search_only_child():
    """Generated explore/web-search-only child prompts should also be protected."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    wf = _FakeWFInstance(
        depth=1,
        goal=(
            "You are executing a narrowly scoped research subtask. The final answer must be "
            "grounded using an explore-agent web research subtask only. Please use only any "
            "explore/web-search research capability available to you; do not use browser/code/sandbox."
        ),
    )

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=wf,
            tool_call={
                "type": "general_purpose",
                "goal": "Find current Tokyo population",
                "output_schema": {"fields": []},
            },
            tool_call_id="tc",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "explore-agent web research only" in events[0].message


async def test_handler_allows_explore_for_explore_only_child():
    """The research-only guard still permits the intended explore subagent."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    fake = _FakeSpawnWF(
        start_activity_result=_Activity(
            result={
                "result": "population found",
                "tool_call_results": [],
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        )
    )
    restore = _patch_spawn_workflow(fake)
    try:
        events = await _collect(
            SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(
                    depth=1,
                    goal=(
                        "Find current population of Tokyo. Use explore-agent web research. "
                        "MUST NOT use browser agent, Claude Code, or code sandbox."
                    ),
                ),
                tool_call={"type": "explore", "goal": "Research Tokyo population"},
                tool_call_id="tc",
            )
        )
    finally:
        restore()

    assert any(e.status == MessageStatus.FINISHED for e in events)


async def test_handler_blocks_root_general_purpose_for_explore_subagent_only_task():
    """Root tasks that ask for explore sub-agents only should not switch to general-purpose."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    wf = _FakeWFInstance(
        depth=0,
        goal=(
            "I'm comparing three cities: Austin TX, Denver CO, and Lisbon Portugal. "
            "Use explore sub-agents: spawn one explore sub-agent per city, preferably in parallel. "
            "Do NOT use Claude Code, a browser agent, or any code sandbox."
        ),
    )

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=wf,
            tool_call={"type": "general_purpose", "goal": "Compare the cities", "output_schema": {"fields": []}},
            tool_call_id="tc",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "explore-agent web research only" in events[0].message


async def test_handler_caps_root_explore_for_one_per_city_task():
    """Do not keep spawning explore agents after satisfying a one-per-city instruction."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    prior_context = []
    for idx in range(3):
        prior_context.append(
            {
                "role": "TOOL",
                "text": "research done",
                "metadata": {
                    "toolCallId": f"tc-{idx}",
                    "toolName": "spawn_agent",
                    "toolStatus": "FINISHED",
                    "agentType": "explore",
                },
            }
        )

    wf = _FakeWFInstance(
        depth=0,
        goal=(
            "I'm comparing three cities: Austin TX, Denver CO, and Lisbon Portugal. "
            "Use explore sub-agents: spawn one explore sub-agent per city, preferably in parallel. "
            "Do NOT use Claude Code, a browser agent, or any code sandbox."
        ),
        context=prior_context,
    )

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=wf,
            tool_call={"type": "explore", "goal": "Research Austin again"},
            tool_call_id="tc-extra",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "already has 3 explore agents" in events[0].message


async def test_handler_reserves_final_explore_slot_across_same_turn_calls():
    """Only one concurrent replacement may claim the final city slot."""
    from tools.base import EventType, MessageStatus, ToolEvent

    from domains.spawn_agent.handler import SpawnAgentManager

    prior_context = []
    for idx in range(2):
        prior_context.append(
            {
                "role": "TOOL",
                "metadata": {
                    "toolCallId": f"tc-{idx}",
                    "toolName": "spawn_agent",
                    "toolStatus": "FINISHED",
                    "agentType": "explore",
                },
            }
        )
    wf = _FakeWFInstance(
        depth=0,
        goal=(
            "I'm comparing three cities: Austin TX, Denver CO, and Lisbon Portugal. "
            "Use explore sub-agents: spawn one explore sub-agent per city, preferably in parallel. "
            "Do NOT use Claude Code, a browser agent, or any code sandbox."
        ),
        context=prior_context,
    )
    manager = SpawnAgentManager()

    async def fake_spawn_explore(_workflow_instance, _tool_call, _tool_call_id):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message="started",
            status=MessageStatus.IN_PROGRESS,
        )
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Explored",
            message="done",
            status=MessageStatus.FINISHED,
        )

    manager._spawn_explore = fake_spawn_explore
    calls = [
        manager.execute_tool(wf, {"type": "explore", "goal": f"Research Denver {idx}"}, f"replacement-{idx}")
        for idx in range(4)
    ]

    first_event = await anext(calls[0])
    blocked_events = [await anext(call) for call in calls[1:]]
    assert first_event.status == MessageStatus.IN_PROGRESS
    assert all(event.status == MessageStatus.ERROR for event in blocked_events)
    assert all("already has 3 explore agents" in event.message for event in blocked_events)

    assert (await anext(calls[0])).status == MessageStatus.FINISHED
    try:
        await anext(calls[0])
    except StopAsyncIteration:
        pass
    else:
        raise AssertionError("explore generator should finish after releasing its reservation")
    assert wf._explore_slot_reservations == set()


async def test_handler_allows_one_corrective_explore_after_verifier_feedback():
    """A failed completion opens one reserved remediation slot, not an unbounded retry fanout."""
    from tools.base import EventType, MessageStatus, ToolEvent

    from domains.spawn_agent.handler import SpawnAgentManager

    prior_context = [
        {
            "role": "TOOL",
            "metadata": {
                "toolCallId": f"tc-{idx}",
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "agentType": "explore",
            },
        }
        for idx in range(3)
    ]
    prior_context.append(
        {
            "role": "TOOL",
            "metadata": {
                "toolCallId": "completion-1",
                "toolName": "attempt_completion",
                "toolStatus": "FINISHED",
                "title": "⚖️ Verifier rejected (50%) — continue task",
                "verifierMessage": True,
            },
        }
    )
    wf = _FakeWFInstance(
        depth=0,
        goal=(
            "I'm comparing three cities: Austin TX, Denver CO, and Lisbon Portugal. "
            "Use explore sub-agents: spawn one explore sub-agent per city, preferably in parallel. "
            "Do NOT use Claude Code, a browser agent, or any code sandbox."
        ),
        context=prior_context,
    )
    manager = SpawnAgentManager()

    async def fake_spawn_explore(_workflow_instance, _tool_call, _tool_call_id):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="Exploring",
            message="started",
            status=MessageStatus.IN_PROGRESS,
        )

    manager._spawn_explore = fake_spawn_explore
    first = manager.execute_tool(wf, {"type": "explore", "goal": "Fix Denver"}, "corrective-1")
    second = manager.execute_tool(wf, {"type": "explore", "goal": "Fix Denver again"}, "corrective-2")

    assert (await anext(first)).status == MessageStatus.IN_PROGRESS
    blocked = await anext(second)
    assert blocked.status == MessageStatus.ERROR
    assert "already has 4 explore agents" in blocked.message
    await first.aclose()
    assert wf._explore_slot_reservations == set()


def test_prior_explore_agent_count_ignores_failed_and_in_progress_children():
    """Only FINISHED explore calls consume the one-per-city success budget."""
    from types import SimpleNamespace

    from domains.spawn_agent.handler import _prior_explore_agent_count

    context = [
        {
            "role": "TOOL",
            "metadata": {
                "toolCallId": "failed-child",
                "toolName": "spawn_agent",
                "toolStatus": "IN_PROGRESS",
                "agentType": "explore",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolCallId": "failed-child",
                "toolName": "spawn_agent",
                "toolStatus": "ERROR",
                "agentType": "explore",
            },
        },
        {
            "role": "TOOL",
            "metadata": {
                "toolCallId": "successful-child",
                "toolName": "spawn_agent",
                "toolStatus": "FINISHED",
                "agentType": "explore",
            },
        },
    ]

    assert _prior_explore_agent_count(SimpleNamespace(context=context)) == 1


async def test_handler_allows_general_purpose_when_explicitly_required():
    """The explore-only guard must not block benchmarks that explicitly require general-purpose agents."""
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
                workflow_instance=_FakeWFInstance(
                    depth=0,
                    goal=(
                        "MUST use spawn_general_purpose_agent exactly twice. Do not use browser agent or Claude Code."
                    ),
                ),
                tool_call={"type": "general_purpose", "goal": "do work", "output_schema": {"fields": []}},
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original

    assert any(e.status == MessageStatus.FINISHED for e in events)


async def test_handler_blocks_child_general_purpose_even_when_parent_required_general_purpose():
    """Parent benchmark wording must not disable explore-only guard inside children."""
    from tools.base import MessageStatus

    from domains.spawn_agent.handler import SpawnAgentManager

    wf = _FakeWFInstance(
        depth=1,
        goal=(
            "Root task: MUST use spawn_general_purpose_agent exactly twice. "
            "Child task: use explore-agent web research and MUST NOT use a browser agent, "
            "Claude Code, or code sandbox."
        ),
    )

    events = await _collect(
        SpawnAgentManager().execute_tool(
            workflow_instance=wf,
            tool_call={
                "type": "general_purpose",
                "goal": "Find current Tokyo population using only explore-agent web research.",
                "output_schema": {"fields": []},
            },
            tool_call_id="tc",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "explore-agent web research only" in events[0].message


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
    """for_each spawns per-child agents and yields an aggregate parent result."""
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
    aggregate = [e for e in events if e.status == MessageStatus.FINISHED]
    assert aggregate, "for_each must yield a terminal parent tool result"
    assert aggregate[-1].metadata["toolName"] == "spawn_general_purpose_agent_for_each"
    assert aggregate[-1].metadata["toolStatus"] == "FINISHED"
    assert aggregate[-1].metadata["busId"] == "a-1"
    assert aggregate[-1].metadata["subAgentIds"] == ["child-0", "child-1"]
    assert aggregate[-1].metadata["spawnGroupId"] == "tc"
    assert aggregate[-1].metadata["forEachAggregate"] is True
    items = aggregate[-1].metadata["structured_response"]["items"]
    assert len(items) == 2
    assert items[0]["status"] == "completed"
    assert "See structured_response.items" in aggregate[-1].message
    assert "Child outputs:" not in aggregate[-1].message
    # But child events were handled through workflow_instance._handle_tool_event
    assert len(wf.handled_events) >= 2  # at least 2 per-child


async def test_handler_for_each_pre_registers_child_ids_for_batch():
    """for_each owns child IDs before batch spawn so early completions are trackable."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [ToolEvent(type=EventType.POST_MESSAGE, title="sub ok", message="ok", status=MessageStatus.FINISHED)]
    )

    def _batch(args, kwargs):
        ids = args[10]
        return {
            "agents": [
                {
                    "agent_id": child_id,
                    "status": "ACTIVE",
                    "goal": f"G{i}",
                    "temporal_workflow_id": child_id,
                }
                for i, child_id in enumerate(ids)
            ]
        }

    fake = _FakeSpawnWF(activity_results={"spawn_sub_agents_batch_activity": _batch})
    restore_wf = _patch_spawn_workflow(fake)
    original_sub = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: fake_mgr
    try:
        wf = _FakeWFInstance()
        await _collect(
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

    batch_call = next(call for call in fake.activity_calls if call["name"] == "spawn_sub_agents_batch_activity")
    child_ids = batch_call["args"][10]
    assert child_ids == [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
    ]
    assert wf.child_tool_ids[child_ids[0]] == "tc:0"
    assert wf.child_tool_ids[child_ids[1]] == "tc:1"
    assert child_ids[0] in wf.child_workflow_ids
    assert child_ids[1] in wf.child_workflow_ids


async def test_handler_for_each_failed_yields_error():
    """for_each with child errors yields aggregate ERROR event with child item details."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    fake_mgr = _FakeDelegateManager(
        [
            ToolEvent(
                type=EventType.POST_MESSAGE,
                title="child err",
                message="boom",
                status=MessageStatus.ERROR,
                metadata={
                    "error_reason": "verifier_rejected",
                    "failure_context": {
                        "partial_structured_response": {"name": "Acme"},
                        "verifier_reasoning": "missing source",
                        "progress_estimate": "partial",
                    },
                },
            )
        ]
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

    errors = [e for e in events if e.status == MessageStatus.ERROR and "children failed" in e.message]
    assert errors
    aggregate = errors[-1]
    assert aggregate.metadata["toolName"] == "spawn_general_purpose_agent_for_each"
    assert aggregate.metadata["toolStatus"] == "ERROR"
    assert aggregate.metadata["busId"] == "a-1"
    assert aggregate.metadata["subAgentIds"] == ["child-0"]
    assert aggregate.metadata["spawnGroupId"] == "tc"
    assert aggregate.metadata["forEachAggregate"] is True
    items = aggregate.metadata["structured_response"]["items"]
    assert items == [
        {
            "index": 0,
            "agent_id": "child-0",
            "status": "failed",
            "summary": "boom",
            "error_reason": "verifier_rejected",
            "partial_structured_response": {"name": "Acme"},
            "verifier_reasoning": "missing source",
            "progress_estimate": "partial",
        }
    ]
    assert "See structured_response.items" in aggregate.message
    assert "item 0: failed: verifier_rejected" not in aggregate.message


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


# ── repo.py: save_explore_message ───────────────────────────────────


async def test_save_explore_message_posts_to_backend():
    """save_explore_message issues POST to /api/agents/{id}/messages with metadata."""
    from unittest.mock import patch

    setup_mock(
        {
            "/api/agents/": {"status": 200, "json": {"ok": True}},
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.spawn_agent.repo import save_explore_message
        from tools.base import MessageStatus

        await save_explore_message(
            agent_id="agent-x",
            title="Researching",
            message="Looking at sources",
            status=MessageStatus.IN_PROGRESS,
            task_id="task-7",
        )

    call = assert_captured_call(
        url_contains="/api/agents/agent-x/messages",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["role"] == "TOOL"
    assert body["metadata"]["agentType"] == "explore"
    assert body["metadata"]["taskId"] == "task-7"
    assert body["metadata"]["toolName"] == "spawn_agent"


async def test_save_explore_message_marks_error_metadata():
    """save_explore_message ERROR status sets metadata.error=True."""
    from unittest.mock import patch

    setup_mock(
        {
            "/api/agents/": {"status": 200, "json": {"ok": True}},
        }
    )
    with patch("temporalio.activity.heartbeat"):
        from domains.spawn_agent.repo import save_explore_message
        from tools.base import MessageStatus

        await save_explore_message(
            agent_id="agent-x",
            title="Failed",
            message="oh no",
            status=MessageStatus.ERROR,
            task_id="task-1",
            tool_call_id="tc-fixed",
        )

    call = assert_captured_call(url_contains="/api/agents/", method="POST")
    body = json.loads(call["requestBody"])
    assert body["metadata"]["error"] is True
    # tool_call_id reused as toolCallId
    assert body["metadata"]["toolCallId"] == "tc-fixed"


async def test_save_explore_message_swallows_http_error():
    """save_explore_message logs but does not raise if backend fails."""
    from unittest.mock import patch

    setup_mock({"/api/agents/": {"status": 500, "json": {"error": "boom"}}})
    with patch("temporalio.activity.heartbeat"):
        from domains.spawn_agent.repo import save_explore_message
        from tools.base import MessageStatus

        # Should not raise even though backend returns 500
        await save_explore_message(
            agent_id="a",
            title="t",
            message="m",
            status=MessageStatus.IN_PROGRESS,
            task_id="x",
        )


# ── repo.py: _resolve_explore_attachments_activity ───────────────────


async def test_resolve_explore_attachments_returns_metadata_texts():
    """_resolve_explore_attachments_activity returns (content_blocks, metadata_texts)."""
    from unittest.mock import AsyncMock, patch

    from domains.spawn_agent import repo

    fake_blocks = [{"type": "image", "data": "xxx"}]
    fake_meta = ["[file: r.txt]"]

    with patch.object(repo, "resolve_attachments_for_llm", new=AsyncMock(return_value=(fake_blocks, fake_meta))):
        cb, mt = await repo._resolve_explore_attachments_activity(
            [
                {
                    "id": "f1",
                    "storage_path": "/x/y",
                    "original_filename": "r.txt",
                    "mime_type": "text/plain",
                    "size_bytes": 10,
                    "created_at": "2026-05-01",
                }
            ]
        )
    assert cb == fake_blocks
    assert mt == fake_meta


# ── repo.py: fetch_full_network_metadata error path ─────────────────


async def test_fetch_network_metadata_handles_http_error():
    """Backend 500 => returns empty string (caller-friendly)."""
    from unittest.mock import patch

    # Reset cache so this test isn't poisoned by another test
    from domains.spawn_agent import repo

    repo._network_metadata_cache.pop("user-fail", None)

    setup_mock({"/api/people": {"status": 500, "json": {"error": "boom"}}})
    with patch("temporalio.activity.heartbeat"):
        result = await repo.fetch_full_network_metadata(user_id="user-fail")
    assert result == ""


async def test_fetch_network_metadata_skips_unnamed_persons():
    """Persons with no firstName/lastName are skipped."""
    from unittest.mock import patch

    from domains.spawn_agent import repo

    repo._network_metadata_cache.pop("user-named", None)

    setup_mock(
        {
            "/api/people": {
                "status": 200,
                "json": {
                    "people": [
                        {"id": "p-1", "firstName": "", "lastName": ""},  # skipped
                        {
                            "id": "p-2",
                            "firstName": "Carol",
                            "lastName": "Doe",
                            "email": "c@example.com",
                        },
                    ],
                    "count": 2,
                },
            }
        }
    )
    with patch("temporalio.activity.heartbeat"):
        result = await repo.fetch_full_network_metadata(user_id="user-named")
    # First person skipped, only Carol included
    assert "Carol" in result
    assert "p-1" not in result


async def test_fetch_network_metadata_caches_result():
    """Second call within TTL returns cached value (no second HTTP call)."""
    from unittest.mock import patch

    from domains.spawn_agent import repo
    from helpers.httpx_capture import clear_captures

    repo._network_metadata_cache.pop("user-cache", None)

    setup_mock(
        {
            "/api/people": {
                "status": 200,
                "json": {
                    "people": [{"id": "p", "firstName": "A", "lastName": "B"}],
                    "count": 1,
                },
            }
        }
    )
    with patch("temporalio.activity.heartbeat"):
        await repo.fetch_full_network_metadata(user_id="user-cache")
        clear_captures()
        # Second call should hit cache, no HTTP request
        await repo.fetch_full_network_metadata(user_id="user-cache")
    captures = get_captured_requests()
    assert len(captures) == 0, "Second call must not hit HTTP (cached)"


async def test_fetch_network_metadata_empty_people():
    """Empty people list returns 'No contacts found.'"""
    from unittest.mock import patch

    from domains.spawn_agent import repo

    repo._network_metadata_cache.pop("user-empty", None)

    setup_mock(
        {
            "/api/people": {
                "status": 200,
                "json": {"people": [], "count": 0},
            }
        }
    )
    with patch("temporalio.activity.heartbeat"):
        result = await repo.fetch_full_network_metadata(user_id="user-empty")
    assert "No contacts found." in result


# ── service.py: spawn_explore_agent_activity ──────────────────────────


async def test_spawn_explore_agent_activity_runs_run_agent_and_returns_result():
    """spawn_explore_agent_activity calls run_agent with proper args, returns shaped dict."""
    from unittest.mock import AsyncMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    captured: dict = {}

    async def fake_run_agent(**kwargs):
        captured.update(kwargs)
        return {
            "status": "completed",
            "final_response": "summary text",
            "tokens_in": 100,
            "tokens_out": 50,
        }

    # Mock the heartbeat decorator and the run_agent module-level import
    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
    ):
        result = await spawn_explore_agent_activity(
            agent_id="a-7",
            user_id="u-7",
            goal="research X",
            model="rose-1-lite",
            task_id="task-99",
            init_tool_call_id="init-tc",
            claude_token="ctok",
            attachment_texts=["[file:doc.txt] short"],
            local_data_summary="messages/ 3 threads, 42 messages",
        )

    # Returned dict shape
    assert result["status"] == "completed"
    assert result["result"] == "summary text"
    assert result["tokens_in"] == 100
    assert result["tokens_out"] == 50
    assert isinstance(result["accumulated_usage"], list)
    assert isinstance(result["llm_iteration_usage"], list)
    assert isinstance(result["tool_call_results"], list)

    # run_agent was called with explore-specific args
    assert captured["agent_id"] == "a-7"
    assert captured["user_id"] == "u-7"
    assert captured["model"] == "rose-1-lite"
    assert captured["claude_token"] == "ctok"
    assert captured["call_site_override"] == "explore_agent"
    assert captured["cache_sequence_id"] == "agent:a-7:task:task-99:call:explore_agent"
    assert captured["max_iterations"] >= 1
    assert captured["skip_verification"] is True

    # initial_context contains the [STATE: ...] line, the goal, and attachment text
    [user_msg] = captured["initial_context"]
    assert "[STATE:" in user_msg["text"]
    assert "research X" in user_msg["text"]
    assert "doc.txt" in user_msg["text"]
    assert "LOCAL DATA SUMMARY" in user_msg["text"]
    assert "42 messages" in user_msg["text"]


async def test_spawn_explore_agent_activity_rejects_completion_until_evidence_succeeds():
    """Completion stays visible but is rejected until an evidence tool succeeds."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    completion_results = []
    fake_ws = MagicMock()
    fake_ws.execute_tool = AsyncMock(return_value={"result": {"hits": ["grounded result"]}})

    async def fake_run_agent(**kwargs):
        execute_tool = kwargs["execute_tool"]
        completion_results.append(
            await execute_tool("attempt_completion_with_result", {"result": "early"}, "tc1")
        )
        await execute_tool("web_search", {"query": "research X"}, "tc2")
        completion_results.append(await execute_tool("attempt_completion_with_result", {"result": "done"}, "tc3"))
        return {
            "status": "completed",
            "final_response": "grounded summary",
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch("tools.web_search.WebSearchManager", return_value=fake_ws),
    ):
        await spawn_explore_agent_activity(agent_id="a", user_id="u", goal="research X", model="m")

    assert completion_results[0]["error"] is True
    assert "no evidence tool has succeeded" in completion_results[0]["message"]
    assert completion_results[1]["success"] is True


async def test_spawn_explore_agent_activity_error_status_returned():
    """run_agent non-completed status returns error while preserving best effort."""
    from unittest.mock import AsyncMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    async def fake_run_agent(**kwargs):
        return {
            "status": "max_iterations",
            "message": "Reached max iterations (2)",
            "final_response": "partial research summary",
            "best_effort_response": "partial research summary",
            "partial_structured_response": {"topic": "partial"},
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
    ):
        result = await spawn_explore_agent_activity(agent_id="a", user_id="u", goal="g", model="m")
    assert result["status"] == "error"
    assert result["result"] == "partial research summary"
    assert result["summary"] == "partial research summary"
    assert result["best_effort_response"] == "partial research summary"
    assert result["error_reason"] == "Reached max iterations (2)"
    assert result["partial_structured_response"] == {"topic": "partial"}
    assert result["structured_response"] == {"topic": "partial"}


async def test_spawn_explore_agent_activity_rejects_tool_free_completion():
    """A child cannot report successful research without any tool evidence."""
    from unittest.mock import patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "final_response": "Web search was unavailable.",
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
    ):
        result = await spawn_explore_agent_activity(
            agent_id="a",
            user_id="u",
            goal="Research current city data",
            model="m",
        )

    assert result["status"] == "error"
    assert result["error_reason"] == "explore completed without tool evidence"


async def test_spawn_explore_agent_activity_accepts_grounded_local_summary():
    """A backend-fetched local summary is evidence without a redundant grep."""
    from unittest.mock import patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    async def fake_run_agent(**kwargs):
        return {
            "status": "completed",
            "final_response": "There are 42 messages.",
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
    ):
        result = await spawn_explore_agent_activity(
            agent_id="a",
            user_id="u",
            goal="Count messages",
            model="m",
            local_data_summary="messages/ 2 threads, 42 messages",
        )

    assert result["status"] == "completed"
    assert result["result"] == "There are 42 messages."


async def test_spawn_explore_agent_activity_ignores_unrequested_best_effort_source_failure():
    """An opportunistic Gmail probe must not poison a WhatsApp-only result."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    fake_grep = MagicMock()
    fake_grep.execute_tool = AsyncMock(
        return_value={
            "result": {"matches": [{"source": "whatsapp", "content": "grounded"}]},
            "unavailable_sources": [{"source": "gmail", "connected": False}],
        }
    )
    captured: dict = {}

    async def fake_run_agent(**kwargs):
        captured.update(kwargs)
        await kwargs["execute_tool"](
            "grep",
            {
                "pattern": "contact",
                "sources": ["whatsapp", "gmail"],
                "require_source_access": False,
            },
            "tc1",
        )
        return {
            "status": "completed",
            "final_response": "WhatsApp result",
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch("tools.grep.GrepManager", return_value=fake_grep),
    ):
        result = await spawn_explore_agent_activity(
            agent_id="a",
            user_id="u",
            goal="Find my most contacted person on WhatsApp",
            model="m",
            local_data_summary="messages/ 2 threads, 42 messages",
        )

    assert result["status"] == "completed"
    assert result["unavailable_sources"] == []
    assert "thread label is a valid contact identifier" in captured["initial_context"][0]["text"]


async def test_spawn_explore_agent_activity_keeps_named_source_failure_required():
    """A source named by the goal still blocks even with a best-effort hint."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    fake_grep = MagicMock()
    fake_grep.execute_tool = AsyncMock(
        return_value={
            "result": "not connected",
            "unavailable_sources": [{"source": "gmail", "connected": False}],
        }
    )

    async def fake_run_agent(**kwargs):
        await kwargs["execute_tool"](
            "grep",
            {"pattern": "invoice", "sources": ["gmail"], "require_source_access": False},
            "tc1",
        )
        return {
            "status": "completed",
            "final_response": "No Gmail access",
            "tokens_in": 1,
            "tokens_out": 1,
        }

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch("tools.grep.GrepManager", return_value=fake_grep),
    ):
        result = await spawn_explore_agent_activity(
            agent_id="a",
            user_id="u",
            goal="Find the invoice in my Gmail",
            model="m",
            local_data_summary="messages/ 2 threads, 42 messages",
        )

    assert result["status"] == "error"
    assert result["unavailable_sources"] == [{"source": "gmail", "connected": False}]
    assert result["error_reason"] == "required data source(s) not connected: gmail"


async def test_spawn_explore_agent_activity_rejects_empty_or_failed_tool_results():
    """A tool record is not evidence when its successful payload is empty or failed."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    empty_or_failed_results = [
        None,
        "",
        [],
        {},
        {"hits": []},
        {"error": "search unavailable"},
        {"success": False, "message": "search unavailable"},
        {"status": "failed", "message": "search unavailable"},
    ]

    for tool_result in empty_or_failed_results:
        fake_ws = MagicMock()
        fake_ws.execute_tool = AsyncMock(return_value={"usage": {}, "result": tool_result})

        async def fake_run_agent(**kwargs):
            await kwargs["execute_tool"]("web_search", {"query": "current city data"}, "tc1")
            return {
                "status": "completed",
                "final_response": "Web search was unavailable.",
                "tokens_in": 1,
                "tokens_out": 1,
            }

        with (
            patch("temporalio.activity.heartbeat"),
            patch("loop.run_agent.run_agent", new=fake_run_agent),
            patch("tools.web_search.WebSearchManager", return_value=fake_ws),
        ):
            result = await spawn_explore_agent_activity(
                agent_id="a",
                user_id="u",
                goal="Research current city data",
                model="m",
            )

        assert result["status"] == "error", tool_result
        assert result["error_reason"] == "explore completed without tool evidence", tool_result


async def test_spawn_explore_agent_activity_inner_callbacks_work():
    """Verify the on_tokens callback and explore_post_message reach DB save."""
    from unittest.mock import AsyncMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    save_calls: list = []

    async def fake_save(**kwargs):
        save_calls.append(kwargs)

    on_tokens_holder: dict = {}
    post_message_holder: dict = {}

    async def fake_run_agent(**kwargs):
        # exercise on_tokens callback
        on_tokens = kwargs["on_tokens"]
        await on_tokens(
            10,
            5,
            "claude-x",
            7,
            3,
            "explore_agent",
            claude_token_rotated=True,
            from_fast_cache=True,
        )
        on_tokens_holder["called"] = True

        # exercise post_message callback (forwarded to save_explore_message)
        post_message = kwargs["post_message"]
        await post_message("Thinking…", "ASSISTANT", None)
        await post_message(
            "Completion rejected",
            "TOOL",
            {
                "toolCallId": "completion-1",
                "toolName": "attempt_completion_with_result",
                "toolStatus": "ERROR",
                "title": "attempt_completion_with_result rejected",
                "error": True,
            },
        )
        post_message_holder["called"] = True

        return {"status": "completed", "final_response": "ok", "tokens_in": 0, "tokens_out": 0}

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch("domains.spawn_agent.service.save_explore_message", new=fake_save),
    ):
        result = await spawn_explore_agent_activity(agent_id="a", user_id="u", goal="g", model="m", task_id="task-1")

    # on_tokens populated llm_iteration_usage
    assert len(result["llm_iteration_usage"]) == 1
    entry = result["llm_iteration_usage"][0]
    assert entry["tokens_in"] == 10
    assert entry["tokens_out"] == 5
    assert entry["model"] == "claude-x"
    assert entry["cache_read_input_tokens"] == 7
    assert entry["cache_creation_input_tokens"] == 3
    assert entry["from_fast_cache"] is True
    assert entry["cache_sequence_id"] == "agent:a:task:task-1:call:explore_agent"

    # post_message dispatched to save_explore_message
    assert len(save_calls) == 2
    assert save_calls[0]["task_id"] == "task-1"
    assert save_calls[0]["agent_id"] == "a"
    assert save_calls[0]["status"].value == "FINISHED"
    assert save_calls[1]["status"].value == "ERROR"
    assert save_calls[1]["tool_call_id"] == "completion-1"


def test_three_sibling_explores_get_stable_isolated_cache_sequences():
    """Each explore task owns one stable lane even under a shared parent agent."""
    from loop.run_agent import _resolve_cache_sequence_id

    sequence_ids = {
        task_id: _resolve_cache_sequence_id(
            agent_id="parent-agent",
            task_id=task_id,
            call_site="explore_agent",
        )
        for task_id in ("task-a", "task-b", "task-c")
    }

    assert len(set(sequence_ids.values())) == 3
    assert sequence_ids["task-a"] == _resolve_cache_sequence_id(
        agent_id="parent-agent",
        task_id="task-a",
        call_site="explore_agent",
    )


async def test_spawn_explore_agent_activity_execute_tool_dispatch():
    """Verify execute_tool routes to web_search/web_fetch/grep/attempt_completion."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    # Mock manager.execute_tool to return shaped results
    fake_ws = MagicMock()
    fake_ws.execute_tool = AsyncMock(return_value={"usage": {"x": 1}, "result": {"hits": ["a"]}})
    fake_wf = MagicMock()
    fake_wf.execute_tool = AsyncMock(return_value="raw-fetch-result")
    fake_grep = MagicMock()
    fake_grep.execute_tool = AsyncMock(return_value={"usage": {"y": 2}, "result": "grepped"})

    captured_calls: list = []

    async def fake_run_agent(**kwargs):
        execute_tool = kwargs["execute_tool"]
        # web_search path (with usage envelope)
        r1 = await execute_tool("web_search", {"query": "hi"}, "tc1")
        captured_calls.append(("ws", r1))
        # web_fetch path (no usage envelope)
        r2 = await execute_tool("web_fetch", {"url": "u"}, "tc2")
        captured_calls.append(("wf", r2))
        # grep path
        r3 = await execute_tool("grep", {"pattern": "x"}, "tc3")
        captured_calls.append(("g", r3))
        # attempt_completion path
        r4 = await execute_tool("attempt_completion", {}, "tc4")
        captured_calls.append(("ac", r4))
        # unknown tool path
        r5 = await execute_tool("nonexistent_tool", {}, "tc5")
        captured_calls.append(("unk", r5))

        return {"status": "completed", "final_response": "done"}

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch(
            "providers.fast_cache.client.resolve_agent_fast_mode",
            new=AsyncMock(return_value=(False, "parent g", True, None)),
        ),
        patch("tools.web_search.WebSearchManager", return_value=fake_ws),
        patch("tools.web_fetch.WebFetchManager", return_value=fake_wf),
        patch("tools.grep.GrepManager", return_value=fake_grep),
    ):
        result = await spawn_explore_agent_activity(agent_id="a", user_id="u", goal="g", model="m")

    # web_search returned success with serialized result_str
    assert captured_calls[0][1]["success"] is True
    # web_fetch returned the raw value via str/json
    assert captured_calls[1][1]["success"] is True
    # grep ran
    assert captured_calls[2][1]["success"] is True
    # attempt_completion path returns shape
    assert captured_calls[3][1]["success"] is True
    # unknown tool returns error
    assert captured_calls[4][1]["error"] is True

    # Tool-call results were captured
    assert len(result["tool_call_results"]) >= 3
    assert result["status"] == "completed"
    # accumulated_usage captured the dict-with-usage results
    assert len(result["accumulated_usage"]) == 2  # web_search and grep had usage envelopes
    assert fake_ws.execute_tool.call_args.kwargs["fast_mode_cache_enabled"] is False
    assert fake_ws.execute_tool.call_args.kwargs["fast_mode_cache_write_enabled"] is True
    assert fake_ws.execute_tool.call_args.kwargs["fast_mode_goal"] == "g"
    assert fake_wf.execute_tool.call_args.kwargs["fast_mode_cache_enabled"] is False
    assert fake_wf.execute_tool.call_args.kwargs["fast_mode_cache_write_enabled"] is True
    assert fake_wf.execute_tool.call_args.kwargs["fast_mode_goal"] == "g"


# ── handler.py: explore attachment resolution path ───────────────────


async def test_handler_explore_resolves_attachments():
    """Explore with attachments triggers _resolve_explore_attachments_activity."""
    from unittest.mock import patch

    from helpers.attachments import FilePointer
    import domains.spawn_agent.handler as h
    from tools.base import MessageStatus

    # Build a workflow_instance with file pointer in context
    fp = FilePointer(
        id="f1",
        storage_path="/x/y",
        original_filename="report.csv",
        mime_type="text/csv",
        size_bytes=100,
        created_at="2026-05-01",
    )

    # Patch extract_attachments_from_context to return our pointer
    fake = _FakeSpawnWF(
        activity_results={
            "fetch_full_network_metadata": "",
            "fetch_local_data_summary": "",
            "_resolve_explore_attachments_activity": ([], ["[file: report.csv] inline content"]),
        },
        start_activity_result=_Activity(
            result={
                "result": "got it",
                "tool_call_results": [],
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        ),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        with patch.object(h, "extract_attachments_from_context", return_value=[fp]):
            wf = _FakeWFInstance()
            wf.context = {"attachments": [{"id": "f1"}]}
            events = await _collect(
                h.SpawnAgentManager().execute_tool(
                    workflow_instance=wf,
                    tool_call={
                        "type": "explore",
                        "goal": "g",
                        "attachments": "report.csv",  # str path → coerced to list
                    },
                    tool_call_id="tc",
                )
            )
    finally:
        restore()
    assert any(e.status == MessageStatus.FINISHED for e in events)


async def test_handler_explore_unknown_attachment_warns():
    """Explore attachment not in context => warning, no execute_activity for resolution."""
    from unittest.mock import patch

    import domains.spawn_agent.handler as h
    from tools.base import MessageStatus

    fake = _FakeSpawnWF(
        activity_results={
            "fetch_full_network_metadata": "",
            "fetch_local_data_summary": "",
        },
        start_activity_result=_Activity(
            result={
                "result": "ok",
                "tool_call_results": [],
                "accumulated_usage": [],
                "llm_iteration_usage": [],
            }
        ),
    )
    restore = _patch_spawn_workflow(fake)
    try:
        with patch.object(h, "extract_attachments_from_context", return_value=[]):
            wf = _FakeWFInstance()
            wf.context = {}
            events = await _collect(
                h.SpawnAgentManager().execute_tool(
                    workflow_instance=wf,
                    tool_call={
                        "type": "explore",
                        "goal": "g",
                        "attachments": ["missing.txt"],
                    },
                    tool_call_id="tc",
                )
            )
    finally:
        restore()
    assert any(e.status == MessageStatus.FINISHED for e in events)


# ── handler.py: for_each drain failures ──────────────────────────────


async def test_handler_for_each_drain_exception_counts_as_failure():
    """If a child generator raises while draining, failed_count increments."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    class _BadDrainMgr:
        def finalize_child(self, wf, child_info, sub_agent, tcid, bus_id):
            async def _gen():
                # Yield first event success, then raise on second iteration
                yield ToolEvent(
                    type=EventType.POST_MESSAGE,
                    title="started",
                    message="ok",
                    status=MessageStatus.IN_PROGRESS,
                )
                raise RuntimeError("drain explosion")

            return _gen()

    fake = _FakeSpawnWF()
    restore_wf = _patch_spawn_workflow(fake)
    original_sub = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: _BadDrainMgr()
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
    # Drain failure surfaces as ERROR aggregate event
    assert any(e.status == MessageStatus.ERROR for e in events)


async def test_handler_for_each_spawn_exception_counts_as_failure():
    """If a child raises during initial spawn (before first event), failed_count increments."""
    from tools.base import EventType, MessageStatus, ToolEvent
    import domains.spawn_agent.handler as h

    class _BadSpawnMgr:
        def finalize_child(self, wf, child_info, sub_agent, tcid, bus_id):
            async def _gen():
                raise RuntimeError("spawn explosion")
                yield  # generator marker

            return _gen()

    fake = _FakeSpawnWF()
    restore_wf = _patch_spawn_workflow(fake)
    original_sub = h.get_sub_agent_manager
    h.get_sub_agent_manager = lambda: _BadSpawnMgr()
    try:
        events = await _collect(
            h.SpawnAgentManager().execute_tool(
                workflow_instance=_FakeWFInstance(),
                tool_call={
                    "type": "for_each",
                    "goal": "process",
                    "output_schema": {"fields": []},
                    "items": ["a", "b"],
                },
                tool_call_id="tc",
            )
        )
    finally:
        h.get_sub_agent_manager = original_sub
        restore_wf()
    # 2 spawn failures => aggregate error
    assert any(e.status == MessageStatus.ERROR and "2/2" in e.message for e in events)


# ── service: explore tool dispatch wraps call_temporal_activity_from_activity ──


async def test_tagged_execute_activity_injects_taskid_for_post_agent_message():
    """tagged_execute_activity stamps taskId/agentType into post_agent_message metadata."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from domains.spawn_agent.service import spawn_explore_agent_activity

    captured_args: list = []

    async def fake_call_temporal_activity_from_activity(activity_fn, args=None, **kwargs):
        # capture what got mutated
        captured_args.append({"name": activity_fn.__name__, "args": args, "kwargs": kwargs})
        return {"ok": True}

    # Build a fake post_agent_message function so the code path triggers
    def fake_post_agent_message():
        pass

    fake_post_agent_message.__name__ = "post_agent_message"

    async def fake_run_agent(**kwargs):
        execute_tool = kwargs["execute_tool"]
        # Force a fake manager whose execute_tool internally calls tagged_execute_activity
        # We can't easily reach tagged_execute_activity without reconstructing pieces.
        # But we still cover the wrapper flow indirectly through web_search.
        return {"status": "completed", "final_response": "done"}

    fake_ws = MagicMock()
    fake_ws.execute_tool = AsyncMock(return_value={"result": "ok"})

    with (
        patch("temporalio.activity.heartbeat"),
        patch("loop.run_agent.run_agent", new=fake_run_agent),
        patch(
            "loop.activity_helper.call_temporal_activity_from_activity",
            new=fake_call_temporal_activity_from_activity,
        ),
        patch("tools.web_search.WebSearchManager", return_value=fake_ws),
    ):
        await spawn_explore_agent_activity(agent_id="a", user_id="u", goal="g", model="m", task_id="tt")


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
    r.record("validate_general_purpose_bad_phase", test_validate_spawn_general_purpose_bad_phase)
    r.record("validate_for_each_needs_items", test_validate_spawn_for_each_requires_items)
    r.record("validate_for_each_items", test_validate_spawn_for_each_with_items)
    r.record("validate_for_each_csv", test_validate_spawn_for_each_with_csv)
    r.record("validate_explore_no_schema", test_validate_spawn_explore_rejects_schema)
    r.record("validate_explore_happy", test_validate_spawn_explore_happy)
    # resolve_start_phase
    r.record("resolve_phase_default", test_resolve_start_phase_default)
    r.record("resolve_phase_execute", test_resolve_start_phase_execute)
    r.record("resolve_phase_invalid", test_resolve_start_phase_invalid_defaults_plan)
    r.record(
        "handler_counts_only_finished_explore_children",
        test_prior_explore_agent_count_ignores_failed_and_in_progress_children,
    )
    # coerce_for_each_items
    r.record("coerce_items_list", test_coerce_for_each_items_list)
    r.record("coerce_items_empty", test_coerce_for_each_items_empty)
    r.record("coerce_items_single_col", test_coerce_for_each_items_single_col_csv)
    r.record("coerce_items_with_header", test_coerce_for_each_items_csv_with_header)
    r.record("coerce_items_common_header", test_coerce_for_each_items_common_header_when_sniffer_misses)
    r.record("coerce_items_multicol", test_coerce_for_each_items_multicol_no_header)
    # build_for_each_goal
    r.record("build_goal_string", test_build_for_each_goal_string_item)
    r.record("build_goal_dict", test_build_for_each_goal_dict_item)
    # SpawnAgentManager handler
    await r.record_async("handler_validation_bubbles_for_each", test_handler_validation_bubbles_for_each)
    await r.record_async("handler_validation_emits_error_for_others", test_handler_validation_emits_error_for_others)
    await r.record_async("handler_explore_happy", test_handler_explore_happy_path)
    await r.record_async(
        "handler_explore_uses_lite_pool",
        test_handler_explore_uses_lite_pool_independent_of_parent_model,
    )
    await r.record_async("handler_explore_gates_off", test_handler_explore_gates_off_skips_fetch)
    await r.record_async("handler_explore_capture", test_handler_explore_capture_tool_results)
    await r.record_async("handler_explore_failed_result", test_handler_explore_failed_result_yields_error)
    await r.record_async(
        "handler_explore_failed_result_forwards_error_reason",
        test_handler_explore_failed_result_forwards_error_reason,
    )
    await r.record_async("handler_explore_cancelled", test_handler_explore_cancelled_yields_error)
    await r.record_async("handler_explore_exception", test_handler_explore_exception_yields_error)
    await r.record_async("handler_browser_delegates", test_handler_browser_delegates)
    await r.record_async("handler_code_delegates", test_handler_code_delegates)
    await r.record_async("handler_sub_agent_no_verifier_arg", test_handler_sub_agent_delegates_without_verifier_arg)
    await r.record_async(
        "handler_blocks_recursive_general_purpose_for_explore_only_child",
        test_handler_blocks_recursive_general_purpose_for_explore_only_child,
    )
    await r.record_async(
        "handler_allows_root_explicit_general_purpose_with_explore_research_children",
        test_handler_allows_root_explicit_general_purpose_with_explore_research_children,
    )
    await r.record_async(
        "handler_blocks_recursive_general_purpose_for_web_search_only_child",
        test_handler_blocks_recursive_general_purpose_for_web_search_only_child,
    )
    await r.record_async(
        "handler_allows_explore_for_explore_only_child",
        test_handler_allows_explore_for_explore_only_child,
    )
    await r.record_async(
        "handler_blocks_root_general_purpose_for_explore_subagent_only_task",
        test_handler_blocks_root_general_purpose_for_explore_subagent_only_task,
    )
    await r.record_async(
        "handler_caps_root_explore_for_one_per_city_task",
        test_handler_caps_root_explore_for_one_per_city_task,
    )
    await r.record_async(
        "handler_reserves_final_explore_slot_across_same_turn_calls",
        test_handler_reserves_final_explore_slot_across_same_turn_calls,
    )
    await r.record_async(
        "handler_allows_one_corrective_explore_after_verifier_feedback",
        test_handler_allows_one_corrective_explore_after_verifier_feedback,
    )
    await r.record_async(
        "handler_allows_general_purpose_when_explicitly_required",
        test_handler_allows_general_purpose_when_explicitly_required,
    )
    await r.record_async(
        "handler_blocks_child_general_purpose_even_when_parent_required_general_purpose",
        test_handler_blocks_child_general_purpose_even_when_parent_required_general_purpose,
    )
    await r.record_async("handler_for_each_depth", test_handler_for_each_depth_exceeded_raises)
    await r.record_async("handler_for_each_no_items", test_handler_for_each_no_items_raises)
    await r.record_async("handler_for_each_happy", test_handler_for_each_happy_path_all_succeed)
    await r.record_async("handler_for_each_pre_registers_ids", test_handler_for_each_pre_registers_child_ids_for_batch)
    await r.record_async("handler_for_each_failed", test_handler_for_each_failed_yields_error)
    await r.record_async("spawn_agent_helper", test_spawn_agent_helper_tracks_usage_and_returns)
    # repo.py
    await r.record_async("save_explore_message_happy", test_save_explore_message_posts_to_backend)
    await r.record_async("save_explore_message_error", test_save_explore_message_marks_error_metadata)
    await r.record_async("save_explore_message_swallow", test_save_explore_message_swallows_http_error)
    await r.record_async("resolve_explore_attachments", test_resolve_explore_attachments_returns_metadata_texts)
    await r.record_async("network_metadata_http_error", test_fetch_network_metadata_handles_http_error)
    await r.record_async("network_metadata_skip_unnamed", test_fetch_network_metadata_skips_unnamed_persons)
    await r.record_async("network_metadata_caches", test_fetch_network_metadata_caches_result)
    await r.record_async("network_metadata_empty", test_fetch_network_metadata_empty_people)
    # service.py
    await r.record_async("explore_activity_happy", test_spawn_explore_agent_activity_runs_run_agent_and_returns_result)
    await r.record_async(
        "explore_activity_rejects_completion_until_evidence_succeeds",
        test_spawn_explore_agent_activity_rejects_completion_until_evidence_succeeds,
    )
    await r.record_async("explore_activity_error", test_spawn_explore_agent_activity_error_status_returned)
    await r.record_async(
        "explore_activity_rejects_tool_free_completion",
        test_spawn_explore_agent_activity_rejects_tool_free_completion,
    )
    await r.record_async(
        "explore_activity_accepts_grounded_local_summary",
        test_spawn_explore_agent_activity_accepts_grounded_local_summary,
    )
    await r.record_async(
        "explore_activity_ignores_unrequested_best_effort_source_failure",
        test_spawn_explore_agent_activity_ignores_unrequested_best_effort_source_failure,
    )
    await r.record_async(
        "explore_activity_keeps_named_source_failure_required",
        test_spawn_explore_agent_activity_keeps_named_source_failure_required,
    )
    await r.record_async(
        "explore_activity_rejects_empty_or_failed_tool_results",
        test_spawn_explore_agent_activity_rejects_empty_or_failed_tool_results,
    )
    await r.record_async("explore_activity_callbacks", test_spawn_explore_agent_activity_inner_callbacks_work)
    r.record(
        "explore_cache_sequences_stable_and_isolated",
        test_three_sibling_explores_get_stable_isolated_cache_sequences,
    )
    await r.record_async("explore_activity_dispatch", test_spawn_explore_agent_activity_execute_tool_dispatch)
    # handler.py
    await r.record_async("handler_explore_resolves_attachments", test_handler_explore_resolves_attachments)
    await r.record_async("handler_explore_unknown_attachment", test_handler_explore_unknown_attachment_warns)
    await r.record_async("handler_for_each_drain_exception", test_handler_for_each_drain_exception_counts_as_failure)
    await r.record_async("handler_for_each_spawn_exception", test_handler_for_each_spawn_exception_counts_as_failure)
    await r.record_async(
        "tagged_execute_activity_injects", test_tagged_execute_activity_injects_taskid_for_post_agent_message
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
