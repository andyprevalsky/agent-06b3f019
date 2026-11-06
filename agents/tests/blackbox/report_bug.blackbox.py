"""Blackbox tests for the report_bug domain: the root agent files a Rose bug like Report Bug.

Exposure is driven through the real AgentWorkflow tool-list method on a bare
instance; the handler runs the real activity and repo against the mock HTTP
transport, so the asserted request is exactly what reaches the backend route.
"""

import asyncio
import contextlib
import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from temporalio.testing import ActivityEnvironment

from _test_utils import BlackboxResult, get_captured_requests, setup_mock, teardown_mock

ANDY = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
ROOT_ID = "11111111-2222-4333-8444-555555555555"
ROUTE = f"/api/agents/{ROOT_ID}/report-bug/by-agent"
ADMIN_ACCESS_TS = Path(__file__).resolve().parents[3] / "back-end" / "src" / "utils" / "adminAccess.ts"
PROD_NAMESPACE = "rose-labs-us-east-1.tch2n"


@contextlib.contextmanager
def _temporal(namespace=PROD_NAMESPACE, task_queue="navi-agent-tasks@a1b2c3"):
    """Run as a workflow on ``namespace``/``task_queue`` (production by default)."""
    from domains.report_bug import handler

    info = SimpleNamespace(namespace=namespace, task_queue=task_queue)
    with (
        patch.object(handler.workflow, "in_workflow", return_value=True),
        patch.object(handler.workflow, "info", return_value=info),
    ):
        yield


def _workflow(**overrides):
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow.__new__(AgentWorkflow)
    fields = {
        "agent_id": ROOT_ID,
        "user_id": ANDY,
        "goal": "Book a table for two in Kyoto",
        "depth": 0,
        "parent_workflow_id": None,
        "world_model_mode": "real",
    }
    fields.update(overrides)
    for name, value in fields.items():
        setattr(wf, name, value)
    wf.posted = []

    async def handle_tool_event(event, tool_call_id, tool_name):
        wf.posted.append((tool_name, tool_call_id, event))

    wf._handle_tool_event = handle_tool_event
    return wf


def test_root_admin_agent_gets_report_bug_in_both_phases():
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

    for queue in ("navi-agent-tasks", "navi-agent-tasks@a1b2c3", "navi-agent-tasks-pool-0123456789ab"):
        with _temporal(task_queue=queue):
            plan, execute = _workflow()._phase_tool_lists()
        assert "report_bug" in plan and "report_bug" in execute, queue
    with _temporal():
        plan, execute = _workflow()._phase_tool_lists()
    assert plan == [*PLAN_PHASE_TOOLS[:-1], "report_bug", "attempt_completion"], plan
    assert execute == [*EXECUTE_PHASE_TOOLS[:-1], "report_bug", "attempt_completion"], execute
    assert "report_bug" not in PLAN_PHASE_TOOLS and "report_bug" not in EXECUTE_PHASE_TOOLS


def test_report_bug_is_withheld_from_ineligible_agents():
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

    for label, overrides in (
        ("sub-agent", {"depth": 1, "parent_workflow_id": "agent-parent"}),
        ("child workflow at depth 0", {"parent_workflow_id": "agent-parent"}),
        ("non-admin owner", {"user_id": "00000000-0000-4000-8000-0000000000aa"}),
        ("simulated world", {"world_model_mode": "simulate"}),
        ("shadow world", {"world_model_mode": "shadow"}),
    ):
        with _temporal():
            plan, execute = _workflow(**overrides)._phase_tool_lists()
        assert plan == list(PLAN_PHASE_TOOLS) and execute == list(EXECUTE_PHASE_TOOLS), label


def test_report_bug_is_production_only():
    """Dev, devbox and benchmark stacks (their own namespace or queue) never get the tool."""
    from utils.tool_schemas import EXECUTE_PHASE_TOOLS, PLAN_PHASE_TOOLS

    for label, context in (
        ("benchmark namespace", _temporal(namespace="rose-bench.tch2n", task_queue="navi-agent-tasks-rbe2e")),
        ("benchmark namespace, prod-shaped queue", _temporal(namespace="rose-bench.tch2n")),
        ("prod namespace, stack queue", _temporal(task_queue="navi-agent-tasks-managua-v1")),
        ("not in a workflow", contextlib.nullcontext()),
    ):
        with context:
            plan, execute = _workflow()._phase_tool_lists()
        assert plan == list(PLAN_PHASE_TOOLS) and execute == list(EXECUTE_PHASE_TOOLS), label


def test_demo_goal_tool_lists_are_unchanged():
    from utils.tool_schemas import PLAN_PHASE_TOOLS
    from workflows import agent_workflow

    with _temporal(), patch.object(agent_workflow, "matches_demo_goal", return_value=True):
        plan, execute = _workflow()._phase_tool_lists()
    assert plan == list(PLAN_PHASE_TOOLS) and execute == ["google_workspace_run", "attempt_completion"]


def test_registration_schema_and_prompt():
    import worker
    from domains.report_bug.handler import report_bug
    from tools.prompts import TOOL_PROMPTS
    from utils.tool_schemas import TOOL_MODELS, create_agent_action_model, get_tool_models
    from workflows.agent_workflow import TOOL_EXECUTORS

    assert TOOL_EXECUTORS["report_bug"] is report_bug and "report_bug" in TOOL_PROMPTS
    source = Path(worker.__file__).read_text()
    assert source.count("report_bug_activity") >= 2, "report_bug_activity must be registered on the worker"
    with _temporal():
        _plan, execute = _workflow()._phase_tool_lists()
    action = create_agent_action_model(execute, tool_registry=get_tool_models())
    call = {"tool": "report_bug", "description": "grep returned HTTP 500 twice"}
    parsed = action.model_validate({"response": "", "tool_calls": [call]})
    assert parsed.model_dump()["tool_calls"] == [call], parsed
    doc = TOOL_MODELS["report_bug"].__doc__ or ""
    assert "Report Bug" in doc and "at most one report" in doc, doc


def test_agent_admin_ids_match_backend_admin_access():
    from domains.report_bug.config import REPORT_BUG_USER_IDS

    source = ADMIN_ACCESS_TS.read_text()
    block = source.split("export const ADMIN_USER_IDS = new Set([", 1)[1].split("]);", 1)[0]
    backend_ids = set(re.findall(r"'([0-9a-f-]{36})'", block))
    assert backend_ids and backend_ids == set(REPORT_BUG_USER_IDS), (backend_ids, REPORT_BUG_USER_IDS)


async def _run_handler(wf, tool_call, **temporal):
    from domains.report_bug import handler

    async def execute_activity(fn, args=None, **_kwargs):
        return await ActivityEnvironment().run(fn, *(args or []))

    with patch.object(handler.workflow, "execute_activity", side_effect=execute_activity), _temporal(**temporal):
        return await handler.report_bug(wf, tool_call, "toolu_report")


async def test_handler_files_report_through_backend_route():
    from tools.base import MessageStatus

    teardown_mock()
    body = {
        "success": True,
        "name": "--ai-- grep returned HTTP 500 twice",
        "url": "https://boxes.dev/open/desktop?box=rose&automation=ta_x",
        "run_id": "tar_123",
        "already_reported": False,
    }
    setup_mock({ROUTE: {"status": 201, "json": body}})
    wf = _workflow()
    status, text = await _run_handler(wf, {"description": "  grep returned HTTP 500 twice  "})
    assert status == MessageStatus.FINISHED, text
    assert text == (
        'Bug report filed: "--ai-- grep returned HTTP 500 twice" (boxes.dev run tar_123). '
        "An engineering agent will investigate it."
    )
    calls = get_captured_requests()
    assert len(calls) == 1 and calls[0]["method"] == "POST" and calls[0]["url"].endswith(ROUTE), calls
    headers = {k.lower(): v for k, v in calls[0]["requestHeaders"].items()}
    assert headers["x-user-id"] == ANDY and headers.get("x-api-key"), headers
    assert json.loads(calls[0]["requestBody"]) == {"description": "grep returned HTTP 500 twice"}, calls[0]
    tool_name, tool_call_id, event = wf.posted[-1]
    assert (tool_name, tool_call_id) == ("report_bug", "toolu_report")
    assert event.metadata == {
        "bugReportTitle": body["name"],
        "bugReportRunId": "tar_123",
        "bugReportUrl": body["url"],
        "alreadyReported": False,
    }, event.metadata
    teardown_mock()


async def test_handler_reports_an_already_filed_run():
    from tools.base import MessageStatus

    teardown_mock()
    setup_mock({ROUTE: {"status": 201, "json": {"name": "--ai-- first", "run_id": "tar_1", "already_reported": True}}})
    status, text = await _run_handler(_workflow(), {"description": "a second problem"})
    assert status == MessageStatus.FINISHED
    assert text == (
        'This run already filed its one bug report, "--ai-- first" (boxes.dev run tar_1); '
        "this description was not sent."
    ), text
    teardown_mock()


async def test_handler_surfaces_backend_refusals():
    from tools.base import MessageStatus

    for status_code, error in (
        (403, "Report Bug is restricted to admin accounts"),
        (429, "Agents already filed 20 bug reports in the last 24 hours"),
        (503, "boxes.dev bug report automation is not configured"),
    ):
        teardown_mock()
        setup_mock({ROUTE: {"status": status_code, "json": {"error": error}}})
        wf = _workflow()
        status, text = await _run_handler(wf, {"description": "web_fetch hung"})
        assert status == MessageStatus.ERROR and text == f"Could not file the bug report: {error}", text
        assert len(get_captured_requests()) == 1, "a refusal is not retried"
        assert wf.posted[-1][2].status == MessageStatus.ERROR
    teardown_mock()


async def test_handler_refuses_without_calling_backend():
    from tools.base import MessageStatus

    teardown_mock()
    setup_mock({ROUTE: {"status": 201, "json": {}}})
    cases = (
        (_workflow(depth=1, parent_workflow_id="agent-parent"), {}, "only available to the production root"),
        (_workflow(), {"namespace": "rose-bench.tch2n"}, "only available to the production root"),
        (_workflow(), {}, "`description` is required"),
    )
    for wf, temporal, expected in cases:
        call = {"description": "x" if "production" in expected else "   "}
        status, text = await _run_handler(wf, call, **temporal)
        assert status == MessageStatus.ERROR and expected in text, text
    assert get_captured_requests() == []
    teardown_mock()


async def test_repo_raises_on_server_error_so_the_activity_retries():
    from domains.report_bug.repo import post_agent_bug_report

    teardown_mock()
    setup_mock({ROUTE: {"status": 500, "json": {"error": "Failed to file agent bug report"}}})
    try:
        await post_agent_bug_report(ROOT_ID, ANDY, "boom")
    except Exception as exc:
        assert "500" in str(exc), exc
    else:
        raise AssertionError("a 5xx must raise so Temporal retries the idempotent request")
    finally:
        teardown_mock()


def test_display_label():
    from utils.format_tool_display import format_tool_display

    label = format_tool_display("report_bug", {"description": "grep returned HTTP 500"})
    assert label == "Reporting bug: grep returned HTTP 500", label


async def run_all_tests():
    print("report-bug blackbox tests:")
    r = BlackboxResult()
    r.record("root_admin_agent_gets_report_bug", test_root_admin_agent_gets_report_bug_in_both_phases)
    r.record("report_bug_withheld_from_ineligible_agents", test_report_bug_is_withheld_from_ineligible_agents)
    r.record("report_bug_production_only", test_report_bug_is_production_only)
    r.record("demo_goal_tool_lists_unchanged", test_demo_goal_tool_lists_are_unchanged)
    r.record("registration_schema_and_prompt", test_registration_schema_and_prompt)
    r.record("agent_admin_ids_match_backend", test_agent_admin_ids_match_backend_admin_access)
    await r.record_async("handler_files_report", test_handler_files_report_through_backend_route)
    await r.record_async("handler_already_filed", test_handler_reports_an_already_filed_run)
    await r.record_async("handler_backend_refusals", test_handler_surfaces_backend_refusals)
    await r.record_async("handler_refuses_locally", test_handler_refuses_without_calling_backend)
    await r.record_async("repo_raises_on_5xx", test_repo_raises_on_server_error_so_the_activity_retries)
    r.record("display_label", test_display_label)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
