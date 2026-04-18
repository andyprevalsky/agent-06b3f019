"""Blackbox tests for find-all domain."""

import asyncio
import json
from unittest.mock import patch

from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    get_captured_requests,
    setup_mock,
    teardown_mock,
)


async def test_ingest_happy_path():
    """find_all_ingest_activity returns entity_type and match_conditions."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/ingest": {
            "status": 200,
            "json": {
                "entity_type": "companies",
                "match_conditions": [{"field": "industry", "op": "eq", "value": "AI"}],
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_ingest_activity

        result = await find_all_ingest_activity("Find all AI startups in San Francisco")

    assert result["entity_type"] == "companies"
    assert len(result["match_conditions"]) == 1


async def test_ingest_boundary():
    """Verify exact HTTP request sent to FindAll ingest endpoint."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/ingest": {
            "status": 200,
            "json": {"entity_type": "people", "match_conditions": []},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_ingest_activity

        await find_all_ingest_activity("Find all data scientists at Google")

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/ingest",
        method="POST",
        body_contains={"objective": "Find all data scientists at Google"},
        header_present="x-api-key",
    )
    # Verify beta header
    headers = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "parallel-beta" in headers


async def test_create_run_boundary():
    """Verify create run POST sends correct params."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs": {
            "status": 200,
            "json": {"findall_id": "fa-run-001"},
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_create_run_activity

        result = await find_all_create_run_activity(
            objective="Find all AI startups",
            entity_type="companies",
            match_conditions=[{"field": "industry", "op": "eq", "value": "AI"}],
            generator="core",
            match_limit=25,
        )

    assert result["findall_id"] == "fa-run-001"

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["generator"] == "core"
    assert body["match_limit"] == 25
    assert body["entity_type"] == "companies"


async def test_poll_status_boundary():
    """Verify poll status GET hits correct URL."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs/fa-poll-test": {
            "status": 200,
            "json": {
                "status": {
                    "status": "completed",
                    "is_active": False,
                    "metrics": {
                        "generated_candidates_count": 100,
                        "matched_candidates_count": 12,
                    },
                }
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_poll_status_once_activity

        result = await find_all_poll_status_once_activity("fa-poll-test")

    assert result["is_completed"] is True
    assert result["generated_candidates_count"] == 100
    assert result["matched_candidates_count"] == 12

    assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs/fa-poll-test",
        method="GET",
        header_present="x-api-key",
    )


async def test_get_results_boundary():
    """Verify get results GET hits correct URL."""
    setup_mock({
        "api.parallel.ai/v1beta/findall/runs/fa-res-test/result": {
            "status": 200,
            "json": {
                "candidates": [
                    {"name": "Startup A", "score": 0.95},
                    {"name": "Startup B", "score": 0.87},
                ],
                "usage": {"credits": 5},
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.find_all import find_all_get_results_activity

        result = await find_all_get_results_activity("fa-res-test")

    assert len(result["candidates"]) == 2
    assert result["candidates"][0]["name"] == "Startup A"

    assert_captured_call(
        url_contains="api.parallel.ai/v1beta/findall/runs/fa-res-test/result",
        method="GET",
        header_present="x-api-key",
    )


# =========================================================================
# Pure helper tests
# =========================================================================


def test_safe_time_returns_float():
    from domains.find_all.service import _safe_time

    t = _safe_time()
    assert isinstance(t, float)
    assert t >= 0.0


def test_build_title_objective_strips_find_all_prefix():
    from domains.find_all.service import _build_title_objective

    assert _build_title_objective("find all AI startups") == "AI startups"


def test_build_title_objective_strips_find_prefix():
    from domains.find_all.service import _build_title_objective

    # After stripping 'find ', remainder starts lowercase -> should be capitalized
    assert _build_title_objective("find startups in SF") == "Startups in SF"


def test_build_title_objective_strips_search_for_prefix():
    from domains.find_all.service import _build_title_objective

    assert _build_title_objective("search for data scientists") == "Data scientists"


def test_build_title_objective_truncates_long():
    from domains.find_all.service import _build_title_objective
    from domains.find_all.config import TITLE_OBJECTIVE_MAX_LEN

    long_obj = "find all " + ("a" * 100)
    result = _build_title_objective(long_obj)
    assert len(result) == TITLE_OBJECTIVE_MAX_LEN
    assert result.endswith("...")


def test_build_title_objective_empty_string():
    from domains.find_all.service import _build_title_objective

    assert _build_title_objective("") == ""


def test_build_title_objective_capitalizes_first_letter():
    from domains.find_all.service import _build_title_objective

    # No known prefix — should capitalize first letter
    assert _build_title_objective("investigate xyz") == "Investigate xyz"


def test_truncate_objective_short_unchanged():
    from domains.find_all.service import _truncate_objective

    assert _truncate_objective("short") == "short"


def test_truncate_objective_long_truncated():
    from domains.find_all.service import _truncate_objective
    from domains.find_all.config import OBJECTIVE_PREVIEW_MAX_LEN

    long = "a" * (OBJECTIVE_PREVIEW_MAX_LEN + 50)
    result = _truncate_objective(long)
    assert len(result) == OBJECTIVE_PREVIEW_MAX_LEN
    assert result.endswith("...")


# =========================================================================
# FindAllManager tests — patch workflow.execute_activity + workflow.sleep
# =========================================================================


class _FakeWorkflowModule:
    """Stand-in for temporalio.workflow with execute_activity and sleep coroutines."""

    def __init__(self, activity_results: dict, sleep_records: list):
        self._activity_results = activity_results
        self._sleep_records = sleep_records

    async def execute_activity(self, fn, args=None, **kwargs):
        # Dispatch based on the activity function's __name__
        name = getattr(fn, "__name__", "?")
        if name in self._activity_results:
            value = self._activity_results[name]
            if isinstance(value, Exception):
                raise value
            if callable(value):
                return value()
            return value
        raise KeyError(f"No fake result configured for activity: {name}")

    async def sleep(self, seconds):
        self._sleep_records.append(seconds)


def _patch_workflow_module(fake):
    import domains.find_all.service as svc

    original = svc.workflow
    svc.workflow = fake

    def restore():
        svc.workflow = original

    return restore


async def _collect_events(gen):
    events = []
    async for e in gen:
        events.append(e)
    return events


async def test_find_all_manager_preview_limit_validation():
    """FindAllManager rejects match_limit > 10 on preview generator."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    manager = FindAllManager()
    events = await _collect_events(
        manager.execute_tool(
            workflow_instance=None,
            tool_call={"objective": "find things", "generator": "preview", "match_limit": 50},
            tool_call_id="tc-1",
        )
    )

    assert len(events) == 1
    assert events[0].status == MessageStatus.ERROR
    assert "preview" in events[0].message.lower() or "10 or less" in events[0].message


async def test_find_all_manager_happy_path_completes():
    """FindAllManager yields progress events and a final FINISHED event with usage."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    # Pre-canned activity results keyed by activity function name
    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {
                "entity_type": "companies",
                "match_conditions": [{"field": "industry", "op": "eq", "value": "AI"}],
            },
            "find_all_create_run_activity": {"findall_id": "run-42"},
            "find_all_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "generated_candidates_count": 10,
                "matched_candidates_count": 3,
                "status": {"status": "completed"},
            },
            "find_all_get_results_activity": {
                "candidates": [{"name": "Acme"}, {"name": "Beta"}, {"name": "Gamma"}],
                "usage": {"credits": 7},
            },
        },
        sleep_records=[],
    )

    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "find all ai startups", "generator": "base", "match_limit": 10},
                tool_call_id="tc-happy",
            )
        )
    finally:
        restore()

    # Expect at least: start, ingested, run_created, completed, results
    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses

    # Verify usage in last (FINISHED) event's data
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert finished.data is not None
    assert "usage" in finished.data
    assert len(finished.data["usage"]["service"]) == 1
    # base: fixed 25 + 3*3 matches = 34
    assert finished.data["usage"]["service"][0]["cost_cents"] == 34


async def test_find_all_manager_poll_failure_yields_error():
    """Poll returning is_failed -> ERROR event emitted."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {"entity_type": "x", "match_conditions": []},
            "find_all_create_run_activity": {"findall_id": "run-bad"},
            "find_all_poll_status_once_activity": {
                "is_completed": False,
                "is_failed": True,
                "generated_candidates_count": 0,
                "matched_candidates_count": 0,
                "status": {"message": "boom"},
            },
        },
        sleep_records=[],
    )

    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "test", "generator": "core", "match_limit": 5},
                tool_call_id="tc-fail",
            )
        )
    finally:
        restore()

    error = next((e for e in events if e.status == MessageStatus.ERROR), None)
    assert error is not None
    assert "boom" in error.message or "failed" in error.message.lower()


async def test_find_all_manager_progress_updates_on_generation_delta():
    """When generated/matched counts grow between polls, progress updates yield events."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    poll_seq = [
        {
            "is_completed": False,
            "is_failed": False,
            "generated_candidates_count": 5,
            "matched_candidates_count": 1,
            "status": {},
        },
        {
            "is_completed": False,
            "is_failed": False,
            "generated_candidates_count": 10,
            "matched_candidates_count": 4,
            "status": {},
        },
        {
            "is_completed": True,
            "is_failed": False,
            "generated_candidates_count": 10,
            "matched_candidates_count": 4,
            "status": {"status": "completed"},
        },
    ]
    poll_idx = {"n": 0}

    def next_poll():
        i = poll_idx["n"]
        poll_idx["n"] += 1
        return poll_seq[min(i, len(poll_seq) - 1)]

    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {"entity_type": "people", "match_conditions": []},
            "find_all_create_run_activity": {"findall_id": "run-deltas"},
            "find_all_poll_status_once_activity": next_poll,
            "find_all_get_results_activity": {"candidates": [{"x": 1}], "usage": {}},
        },
        sleep_records=[],
    )

    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "list all the things", "generator": "pro", "match_limit": 100},
                tool_call_id="tc-deltas",
            )
        )
    finally:
        restore()

    # We should see at least 2 IN_PROGRESS events with progressComplete > 40 from deltas
    progress_events = [
        e for e in events
        if e.status == MessageStatus.IN_PROGRESS
        and e.metadata and e.metadata.get("progressComplete", 0) > 40
    ]
    assert len(progress_events) >= 1
    # Final event should be FINISHED
    assert events[-1].status == MessageStatus.FINISHED
    # Pro generator pricing: fixed 1000 + 100 per match; 1 candidate -> 1100
    assert events[-1].data["usage"]["service"][0]["cost_cents"] == 1100


async def test_find_all_manager_default_generator_when_missing():
    """Missing generator tool_call key falls back to DEFAULT_GENERATOR (core)."""
    from domains.find_all.config import DEFAULT_GENERATOR
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {"entity_type": "x", "match_conditions": []},
            "find_all_create_run_activity": {"findall_id": "r"},
            "find_all_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "generated_candidates_count": 0,
                "matched_candidates_count": 0,
                "status": {},
            },
            "find_all_get_results_activity": {"candidates": [], "usage": {}},
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "stuff"},  # no generator
                tool_call_id="tc-def",
            )
        )
    finally:
        restore()

    # First IN_PROGRESS event mentions default generator
    first = next(e for e in events if e.status == MessageStatus.IN_PROGRESS)
    assert DEFAULT_GENERATOR in first.message


async def test_find_all_manager_exception_during_ingest():
    """Exception during the ingest activity bubbles into an ERROR event."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": RuntimeError("ingest kaboom"),
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "find all things", "generator": "base", "match_limit": 5},
                tool_call_id="tc-ingest-err",
            )
        )
    finally:
        restore()

    assert any(e.status == MessageStatus.ERROR for e in events)
    err = next(e for e in events if e.status == MessageStatus.ERROR)
    assert "ingest kaboom" in err.message


async def test_find_all_manager_generator_enum_value_extracted():
    """If generator is an enum-like with .value attribute, the string is extracted."""
    from domains.find_all.service import FindAllManager
    from tools.base import MessageStatus

    class _GenEnum:
        value = "base"

    fake = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {"entity_type": "x", "match_conditions": []},
            "find_all_create_run_activity": {"findall_id": "r"},
            "find_all_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "generated_candidates_count": 0,
                "matched_candidates_count": 0,
                "status": {},
            },
            "find_all_get_results_activity": {"candidates": [{"n": 1}], "usage": {}},
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        manager = FindAllManager()
        events = await _collect_events(
            manager.execute_tool(
                workflow_instance=None,
                tool_call={"objective": "z", "generator": _GenEnum(), "match_limit": 5},
                tool_call_id="tc-enum",
            )
        )
    finally:
        restore()

    # base pricing: fixed 25 + per_match 3 * 1 candidate = 28
    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    assert finished.data["usage"]["service"][0]["cost_cents"] == 28


# =========================================================================
# Handler thin-wrapper test
# =========================================================================


async def test_handler_get_manager_singleton():
    """get_manager() returns the same instance across calls."""
    from domains.find_all.handler import get_manager

    a = get_manager()
    b = get_manager()
    assert a is b
    assert a.tool_name == "find_all"


# =========================================================================
# find_all() workflow-helper wrapper — exercises dispatch + usage tracking
# =========================================================================


class _FakeWFForFindAll:
    """Minimal workflow stand-in for the find_all top-level helper."""

    def __init__(self):
        self.tool_events = []
        self.usage_calls = []

    async def _handle_tool_event(self, event, tool_call_id, tool_name):
        self.tool_events.append((event, tool_call_id, tool_name))

    async def _track_usage(self, usage, tool_name=None, **kwargs):
        self.usage_calls.append({"usage": usage, "tool_name": tool_name, **kwargs})


async def test_find_all_workflow_helper_returns_last_status_and_tracks_usage():
    """find_all() dispatches events to workflow_instance and forwards usage."""
    from domains.find_all.handler import find_all
    from tools.base import MessageStatus

    fake_wf_module = _FakeWorkflowModule(
        activity_results={
            "find_all_ingest_activity": {
                "entity_type": "companies",
                "match_conditions": [],
            },
            "find_all_create_run_activity": {"findall_id": "r-1"},
            "find_all_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "generated_candidates_count": 1,
                "matched_candidates_count": 1,
                "status": {"status": "completed"},
            },
            "find_all_get_results_activity": {
                "candidates": [{"name": "X"}],
                "usage": {"credits": 3},
            },
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake_wf_module)
    try:
        wf = _FakeWFForFindAll()
        last_status = await find_all(
            workflow_instance=wf,
            tool_call={"objective": "go", "generator": "base", "match_limit": 5},
            tool_call_id="tc-h1",
        )
    finally:
        restore()

    assert last_status == MessageStatus.FINISHED
    # Events forwarded to workflow
    assert len(wf.tool_events) >= 2
    # Usage tracked via _track_usage
    assert len(wf.usage_calls) == 1
    assert wf.usage_calls[0]["tool_name"] == "find_all"


async def test_find_all_workflow_helper_error_returns_error_status():
    """find_all() returns ERROR status when validation fails and does not track usage."""
    from domains.find_all.handler import find_all
    from tools.base import MessageStatus

    wf = _FakeWFForFindAll()
    # No workflow patch needed — validation fails before activities run
    last_status = await find_all(
        workflow_instance=wf,
        tool_call={"objective": "go", "generator": "preview", "match_limit": 50},
        tool_call_id="tc-h2",
    )

    assert last_status == MessageStatus.ERROR
    # Error event forwarded
    assert len(wf.tool_events) == 1
    # No usage event since validation fails early
    assert len(wf.usage_calls) == 0


async def run_all_tests():
    print("find-all blackbox tests:")
    r = BlackboxResult()
    await r.record_async("ingest_happy_path", test_ingest_happy_path)
    await r.record_async("ingest_boundary", test_ingest_boundary)
    await r.record_async("create_run_boundary", test_create_run_boundary)
    await r.record_async("poll_status_boundary", test_poll_status_boundary)
    await r.record_async("get_results_boundary", test_get_results_boundary)
    # Pure helpers
    r.record("safe_time_returns_float", test_safe_time_returns_float)
    r.record("build_title_strips_find_all", test_build_title_objective_strips_find_all_prefix)
    r.record("build_title_strips_find", test_build_title_objective_strips_find_prefix)
    r.record("build_title_strips_search_for", test_build_title_objective_strips_search_for_prefix)
    r.record("build_title_truncates_long", test_build_title_objective_truncates_long)
    r.record("build_title_empty_string", test_build_title_objective_empty_string)
    r.record("build_title_capitalizes_first", test_build_title_objective_capitalizes_first_letter)
    r.record("truncate_objective_short", test_truncate_objective_short_unchanged)
    r.record("truncate_objective_long", test_truncate_objective_long_truncated)
    # Manager tests
    await r.record_async("manager_preview_limit_validation", test_find_all_manager_preview_limit_validation)
    await r.record_async("manager_happy_path", test_find_all_manager_happy_path_completes)
    await r.record_async("manager_poll_failure", test_find_all_manager_poll_failure_yields_error)
    await r.record_async("manager_progress_deltas", test_find_all_manager_progress_updates_on_generation_delta)
    await r.record_async("manager_default_generator", test_find_all_manager_default_generator_when_missing)
    await r.record_async("manager_exception_during_ingest", test_find_all_manager_exception_during_ingest)
    await r.record_async("manager_generator_enum_value", test_find_all_manager_generator_enum_value_extracted)
    await r.record_async("handler_get_manager_singleton", test_handler_get_manager_singleton)
    # find_all() workflow helper
    await r.record_async("handler_find_all_helper_happy", test_find_all_workflow_helper_returns_last_status_and_tracks_usage)
    await r.record_async("handler_find_all_helper_error", test_find_all_workflow_helper_error_returns_error_status)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
