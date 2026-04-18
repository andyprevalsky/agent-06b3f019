"""Blackbox tests for enrich domain."""

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


def _setup():
    setup_mock({
        "api.parallel.ai/v1/tasks/runs": {
            "status": 200,
            "json": {"run_id": "run-enrich-001"},
        },
    })


async def test_create_task_happy_path():
    """enrich_create_task_activity returns run_id from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_create_task_activity

        result = await enrich_create_task_activity(
            input_data={"name": "Elon Musk", "company": "SpaceX"},
            output_schema={"type": "object", "properties": {"bio": {"type": "string"}}},
            processor="lite",
        )

    assert result["run_id"] == "run-enrich-001"


async def test_create_task_boundary():
    """Verify exact HTTP request sent to Parallel AI Task API."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_create_task_activity

        await enrich_create_task_activity(
            input_data={"name": "Ada Lovelace"},
            output_schema={"type": "object"},
            processor="core",
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs",
        method="POST",
        body_contains={"processor": "core"},
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    assert body["input"]["name"] == "Ada Lovelace"
    assert "task_spec" in body
    assert "output_schema" in body["task_spec"]


async def test_poll_status_boundary():
    """Verify poll status GET request to Parallel AI."""
    setup_mock({
        "api.parallel.ai/v1/tasks/runs/run-poll-test": {
            "status": 200,
            "json": {
                "status": "completed",
                "is_active": False,
                "warnings": None,
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_poll_status_once_activity

        result = await enrich_poll_status_once_activity("run-poll-test")

    assert result["is_completed"] is True
    assert result["is_failed"] is False

    assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs/run-poll-test",
        method="GET",
        header_present="x-api-key",
    )


async def test_get_results_boundary():
    """Verify get results GET request to Parallel AI."""
    setup_mock({
        "api.parallel.ai/v1/tasks/runs/run-results-test/result": {
            "status": 200,
            "json": {
                "output": {"bio": "Computer scientist and mathematician."},
                "run": {"run_id": "run-results-test", "status": "completed"},
            },
        },
    })

    with patch("temporalio.activity.heartbeat"):
        from tools.enrich import enrich_get_task_results_activity

        result = await enrich_get_task_results_activity("run-results-test")

    assert result["output"]["bio"] == "Computer scientist and mathematician."
    assert result["run"]["run_id"] == "run-results-test"

    assert_captured_call(
        url_contains="api.parallel.ai/v1/tasks/runs/run-results-test/result",
        method="GET",
        header_present="x-api-key",
    )


# =========================================================================
# Pure-helper tests
# =========================================================================


def test_safe_time_returns_float():
    from domains.enrich.service import _safe_time

    t = _safe_time()
    assert isinstance(t, float)
    assert t >= 0.0


def test_build_title_entity_name_preferred():
    from domains.enrich.service import _build_title_entity

    assert _build_title_entity({"name": "Ada", "email": "a@b.com"}) == "Ada"


def test_build_title_entity_falls_back_through_fields():
    from domains.enrich.service import _build_title_entity

    assert _build_title_entity({"email": "a@b.com"}) == "a@b.com"
    assert _build_title_entity({"company": "Acme"}) == "Acme"
    assert _build_title_entity({"url": "http://x"}) == "http://x"
    assert _build_title_entity({}) == "entity"


def test_build_title_entity_truncates_long_name():
    from domains.enrich.config import MAX_ENTITY_NAME_LENGTH, TRUNCATED_LENGTH, TRUNCATED_SUFFIX
    from domains.enrich.service import _build_title_entity

    long = "A" * (MAX_ENTITY_NAME_LENGTH + 20)
    result = _build_title_entity({"name": long})
    assert len(result) == TRUNCATED_LENGTH + len(TRUNCATED_SUFFIX)
    assert result.endswith(TRUNCATED_SUFFIX)


def test_build_display_input_all_fields():
    from domains.enrich.service import _build_display_input

    result = _build_display_input(
        {"name": "Ada", "email": "a@b.com", "company": "Acme", "url": "http://x"}
    )
    assert "Name: Ada" in result
    assert "Email: a@b.com" in result
    assert "Company: Acme" in result
    assert "URL: http://x" in result


def test_build_display_input_empty_fallback():
    from domains.enrich.service import _build_display_input

    assert _build_display_input({}) == "Entity data provided"


def test_build_display_input_partial():
    from domains.enrich.service import _build_display_input

    result = _build_display_input({"name": "N", "company": "C"})
    assert "Name: N" in result
    assert "Company: C" in result
    assert "Email:" not in result
    assert "URL:" not in result


def test_resolve_processor_enum():
    from domains.enrich.service import _resolve_processor

    class E:
        value = "core"

    assert _resolve_processor(E()) == "core"


def test_resolve_processor_string():
    from domains.enrich.service import _resolve_processor

    assert _resolve_processor("lite") == "lite"
    assert _resolve_processor(123) == "123"


def test_calculate_cost_cents_known_tiers():
    from domains.enrich.service import _calculate_cost_cents

    assert _calculate_cost_cents("lite") == 0.5
    assert _calculate_cost_cents("base") == 1
    assert _calculate_cost_cents("core") == 2.5
    assert _calculate_cost_cents("pro") == 10
    assert _calculate_cost_cents("ultra") == 30


def test_calculate_cost_cents_case_insensitive():
    from domains.enrich.service import _calculate_cost_cents

    assert _calculate_cost_cents("LITE") == 0.5
    assert _calculate_cost_cents("Core") == 2.5


def test_calculate_cost_cents_unknown_defaults():
    from domains.enrich.config import DEFAULT_COST_CENTS
    from domains.enrich.service import _calculate_cost_cents

    assert _calculate_cost_cents("unknown-tier") == DEFAULT_COST_CENTS


# =========================================================================
# execute_enrichment (service) tests — patch workflow module
# =========================================================================


class _FakeWorkflowModule:
    def __init__(self, activity_results: dict, sleep_records: list):
        self._activity_results = activity_results
        self._sleep_records = sleep_records

    async def execute_activity(self, fn, args=None, **kwargs):
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
    import domains.enrich.service as svc

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


async def test_execute_enrichment_happy_path():
    """execute_enrichment yields a FINISHED event with correct cost based on processor tier."""
    from domains.enrich.service import execute_enrichment
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "enrich_create_task_activity": {"run_id": "run-1"},
            "enrich_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "warnings": None,
            },
            "enrich_get_task_results_activity": {
                "output": {"bio": "…"},
                "run": {"run_id": "run-1", "status": "completed"},
                "usage": {"tokens": 100},
            },
        },
        sleep_records=[],
    )

    restore = _patch_workflow_module(fake)
    try:
        events = await _collect_events(
            execute_enrichment(
                {
                    "input": {"name": "Ada Lovelace"},
                    "output_schema": {"type": "object"},
                    "processor": "pro",
                }
            )
        )
    finally:
        restore()

    statuses = [e.status for e in events]
    assert MessageStatus.FINISHED in statuses
    assert MessageStatus.ERROR not in statuses

    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    # pro -> 10 cents
    assert finished.data["usage"]["service"][0]["cost_cents"] == 10


async def test_execute_enrichment_failure_yields_error():
    """A poll returning is_failed triggers an ERROR event."""
    from domains.enrich.service import execute_enrichment
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "enrich_create_task_activity": {"run_id": "run-bad"},
            "enrich_poll_status_once_activity": {
                "is_completed": False,
                "is_failed": True,
                "warnings": "some warnings",
            },
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        events = await _collect_events(
            execute_enrichment(
                {
                    "input": {"email": "a@b.test"},
                    "output_schema": {},
                    "processor": "lite",
                }
            )
        )
    finally:
        restore()

    err = next((e for e in events if e.status == MessageStatus.ERROR), None)
    assert err is not None
    assert "some warnings" in err.message or "failed" in err.message.lower()


async def test_execute_enrichment_exception_during_create_task():
    """An exception raised in enrich_create_task_activity bubbles to ERROR event."""
    from domains.enrich.service import execute_enrichment
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "enrich_create_task_activity": RuntimeError("create boom"),
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        events = await _collect_events(
            execute_enrichment({"input": {"name": "x"}, "processor": "core"})
        )
    finally:
        restore()

    err = next(e for e in events if e.status == MessageStatus.ERROR)
    assert "create boom" in err.message


async def test_execute_enrichment_default_processor_when_missing():
    """Missing processor defaults to 'lite' (0.5 cents)."""
    from domains.enrich.service import execute_enrichment
    from tools.base import MessageStatus

    fake = _FakeWorkflowModule(
        activity_results={
            "enrich_create_task_activity": {"run_id": "r"},
            "enrich_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "warnings": None,
            },
            "enrich_get_task_results_activity": {
                "output": {},
                "run": {"run_id": "r"},
                "usage": None,
            },
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        events = await _collect_events(
            execute_enrichment({"input": {"name": "Bob"}})
        )
    finally:
        restore()

    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    # 'lite' default -> 0.5 cents, int cast -> 0
    assert finished.data["usage"]["service"][0]["cost_cents"] == 0


async def test_execute_enrichment_processor_enum_value_extracted():
    """Enum-like processor's `.value` is extracted via _resolve_processor."""
    from domains.enrich.service import execute_enrichment
    from tools.base import MessageStatus

    class _Proc:
        value = "core"

    fake = _FakeWorkflowModule(
        activity_results={
            "enrich_create_task_activity": {"run_id": "r"},
            "enrich_poll_status_once_activity": {
                "is_completed": True,
                "is_failed": False,
                "warnings": None,
            },
            "enrich_get_task_results_activity": {
                "output": {},
                "run": {},
                "usage": None,
            },
        },
        sleep_records=[],
    )
    restore = _patch_workflow_module(fake)
    try:
        events = await _collect_events(
            execute_enrichment({"input": {"name": "x"}, "processor": _Proc()})
        )
    finally:
        restore()

    finished = next(e for e in events if e.status == MessageStatus.FINISHED)
    # core -> 2.5 cents -> int cast -> 2
    assert finished.data["usage"]["service"][0]["cost_cents"] == 2


# =========================================================================
# Handler thin-wrapper tests
# =========================================================================


async def test_handler_enrich_delegates_to_service():
    """enrich handler invokes the manager and forwards events + usage to workflow."""
    import domains.enrich.handler as handler_mod
    import domains.enrich.service as service_mod
    from tools.base import EventType, MessageStatus, ToolEvent

    # Patch the service entry point (the manager calls it internally)
    async def fake_execute_enrichment(tool_call):
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="t",
            message="m",
            status=MessageStatus.IN_PROGRESS,
        )
        yield ToolEvent(
            type=EventType.POST_MESSAGE,
            title="t",
            message="m",
            status=MessageStatus.FINISHED,
            data={"usage": {"llm": [], "service": [{"cost_cents": 1, "provider": "x"}]}},
        )

    # The manager imports execute_enrichment from .service at module load. We need to
    # patch the binding inside the handler module (which also imports from .service).
    # Simpler: patch service_mod.execute_enrichment so the manager's call resolves to the fake.
    original_service = service_mod.execute_enrichment
    original_handler = getattr(handler_mod, "execute_enrichment", None)
    service_mod.execute_enrichment = fake_execute_enrichment
    if original_handler is not None:
        handler_mod.execute_enrichment = fake_execute_enrichment

    # Re-import EnrichManager to ensure it uses the patched binding - but the
    # manager already references `execute_enrichment` via from-import at class
    # definition time, so we need to also patch the name inside the manager's
    # module namespace. The handler module IS the manager's module.
    forwarded_events: list = []
    tracked_usage: list = []

    class FakeWorkflow:
        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            forwarded_events.append((event, tool_call_id, tool_name))

        async def _track_usage(self, usage, tool_name):
            tracked_usage.append((usage, tool_name))

    try:
        last = await handler_mod.enrich(
            workflow_instance=FakeWorkflow(),
            tool_call={"input": {"name": "x"}, "processor": "core"},
            tool_call_id="tc-1",
        )
    finally:
        service_mod.execute_enrichment = original_service
        if original_handler is not None:
            handler_mod.execute_enrichment = original_handler

    assert last == MessageStatus.FINISHED
    assert len(forwarded_events) == 2
    assert len(tracked_usage) == 1
    assert tracked_usage[0][1] == "enrich"


async def test_handler_get_manager_singleton():
    """get_manager returns the same instance."""
    from domains.enrich.handler import get_manager

    m1 = get_manager()
    m2 = get_manager()
    assert m1 is m2
    assert m1.tool_name == "enrich"


async def run_all_tests():
    print("enrich blackbox tests:")
    r = BlackboxResult()
    await r.record_async("create_task_happy_path", test_create_task_happy_path)
    await r.record_async("create_task_boundary", test_create_task_boundary)
    await r.record_async("poll_status_boundary", test_poll_status_boundary)
    await r.record_async("get_results_boundary", test_get_results_boundary)
    # Pure helpers
    r.record("safe_time_returns_float", test_safe_time_returns_float)
    r.record("build_title_entity_name", test_build_title_entity_name_preferred)
    r.record("build_title_entity_fallback", test_build_title_entity_falls_back_through_fields)
    r.record("build_title_entity_truncate", test_build_title_entity_truncates_long_name)
    r.record("build_display_all_fields", test_build_display_input_all_fields)
    r.record("build_display_empty_fallback", test_build_display_input_empty_fallback)
    r.record("build_display_partial", test_build_display_input_partial)
    r.record("resolve_processor_enum", test_resolve_processor_enum)
    r.record("resolve_processor_string", test_resolve_processor_string)
    r.record("calculate_cost_known_tiers", test_calculate_cost_cents_known_tiers)
    r.record("calculate_cost_case_insensitive", test_calculate_cost_cents_case_insensitive)
    r.record("calculate_cost_unknown_defaults", test_calculate_cost_cents_unknown_defaults)
    # Service execute_enrichment
    await r.record_async("enrichment_happy_path", test_execute_enrichment_happy_path)
    await r.record_async("enrichment_failure_error", test_execute_enrichment_failure_yields_error)
    await r.record_async("enrichment_create_exception", test_execute_enrichment_exception_during_create_task)
    await r.record_async("enrichment_default_processor", test_execute_enrichment_default_processor_when_missing)
    await r.record_async("enrichment_processor_enum", test_execute_enrichment_processor_enum_value_extracted)
    # Handler wrapper
    await r.record_async("handler_enrich_delegates", test_handler_enrich_delegates_to_service)
    await r.record_async("handler_get_manager_singleton", test_handler_get_manager_singleton)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
