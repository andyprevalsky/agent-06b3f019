"""Coverage for demo-only Fast Mode gates plus pointer/source-connect helpers."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from domains.spawn_agent.config import (
    EXPLORE_DEPTH_LIMITS,
    explore_limits_for_depth,
    resolve_explore_depth,
    resolve_explore_oai_demo,
    should_skip_oai_demo_browser_spawn,
)
from domains.spawn_agent.oai_demo_report_files import (
    _csv_text,
    _safe_csv_cell,
    is_file_pointer_value,
    materialize_oai_demo_report_files_activity,
    passthrough_file_pointer_specs,
    plan_oai_demo_report_files,
    render_calendar_csv,
    render_html_document,
    render_records_csv,
    rewrite_schema_file_pointer_fields,
    value_to_markdown,
)
from domains.spawn_browser_agent_v3.config import (
    ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES,
    ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES_FAST_MODE,
    browser_start_to_close_timeout_minutes,
    get_max_iterations,
    skip_browser_network_recording,
)
from helpers.fetch_queue_pointer import fetch_agent_queue_pointer
from helpers.source_connect_gates import raise_source_connect_gates
from utils.oai_demo import (
    OAI_DEMO_CHILD_GOAL_PREFIX,
    OAI_DEMO_CHILD_WINDOW,
    OAI_DEMO_ROOT_GOAL_PREFIX,
    is_oai_demo_goal,
    is_oai_demo_mass_agent_task,
)


def test_explore_depth_timeouts():
    assert EXPLORE_DEPTH_LIMITS == {
        "quick": (5, timedelta(seconds=600)),
        "medium": (20, timedelta(seconds=600)),
        "deep": (50, timedelta(seconds=1800)),
    }
    assert explore_limits_for_depth(None) == EXPLORE_DEPTH_LIMITS["quick"]


def test_is_oai_demo_goal_matches_all_three_prefixes():
    assert is_oai_demo_goal(OAI_DEMO_ROOT_GOAL_PREFIX + " extra")
    assert is_oai_demo_goal(f"window {OAI_DEMO_CHILD_WINDOW} here")
    assert is_oai_demo_goal(f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman")
    assert not is_oai_demo_goal(f"{OAI_DEMO_CHILD_GOAL_PREFIX} Huberman")
    assert not is_oai_demo_goal("Order a Vanilla Bean Shakerato from Blue Bottle")
    assert not is_oai_demo_goal(None)
    assert not is_oai_demo_goal("")


def test_is_oai_demo_mass_agent_task_reads_goal_or_demo_cache_goal():
    assert is_oai_demo_mass_agent_task(SimpleNamespace(goal=OAI_DEMO_ROOT_GOAL_PREFIX, demo_cache_goal=""))
    assert is_oai_demo_mass_agent_task(
        SimpleNamespace(goal="Buy socks", demo_cache_goal=f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky")
    )
    assert not is_oai_demo_mass_agent_task(SimpleNamespace(goal="Buy socks", demo_cache_goal=None))


def test_is_oai_demo_mass_agent_task_inherits_tree_root_goal():
    leftover = (
        "Produce fresh tool-grounded evidence for the remaining strategic "
        "deliverables for Andy Prevalsky's [REDACTED] brand task."
    )
    assert not is_oai_demo_goal(leftover)
    assert not is_oai_demo_mass_agent_task(SimpleNamespace(goal=leftover, demo_cache_goal=leftover, root_goal=None))
    assert is_oai_demo_mass_agent_task(
        SimpleNamespace(
            goal=leftover,
            demo_cache_goal=leftover,
            root_goal=OAI_DEMO_ROOT_GOAL_PREFIX,
        )
    )


def test_browser_timeout_and_recording_are_demo_only():
    demo_wf = SimpleNamespace(goal=OAI_DEMO_ROOT_GOAL_PREFIX)
    live_wf = SimpleNamespace(goal="Buy socks")
    assert (
        browser_start_to_close_timeout_minutes(fast_mode=True, goal=f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky")
        == ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES_FAST_MODE
    )
    assert (
        browser_start_to_close_timeout_minutes(fast_mode=True, workflow_instance=demo_wf)
        == ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES_FAST_MODE
    )
    assert (
        browser_start_to_close_timeout_minutes(fast_mode=True, goal="Buy socks", workflow_instance=live_wf)
        == ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES
    )
    assert (
        browser_start_to_close_timeout_minutes(fast_mode=False, goal=OAI_DEMO_ROOT_GOAL_PREFIX)
        == ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES
    )
    assert (
        skip_browser_network_recording(fast_mode=True, goal=f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky") is True
    )
    assert skip_browser_network_recording(fast_mode=True, goal="Buy socks") is False
    assert skip_browser_network_recording(fast_mode=False, goal=OAI_DEMO_ROOT_GOAL_PREFIX) is False


def test_plan_oai_demo_report_files_skips_existing_pointers_and_empty():
    pointer = {
        "id": "fp-1",
        "storage_path": "user/fp-1_positioning-statement.md",
        "original_filename": "positioning-statement.md",
    }
    planned = plan_oai_demo_report_files(
        {
            "positioning_statement": pointer,
            "top_creators_analysis": "",
            "creator_name": "Andrew Huberman",
            "ninety_day_content_calendar": "Week 1 / Substack / Founder Health OS",
        }
    )
    assert [item["key"] for item in planned] == ["ninety_day_content_calendar"]
    assert planned[0]["filename"] == "90-day-content-calendar.csv"
    assert planned[0]["mime_type"] == "text/csv"
    assert "section,week,dates,platform,format,title,details" in planned[0]["content"]
    assert "Founder Health OS" in planned[0]["content"]
    assert plan_oai_demo_report_files(None) == []
    assert is_file_pointer_value(pointer) is True
    assert is_file_pointer_value("not a file") is False


def test_human_readable_renderers_and_schema_rewrite_use_file_pointer_types():
    numbered = value_to_markdown(["first hook", "second hook"])
    assert numbered == "1. first hook\n2. second hook"
    creator_md = value_to_markdown(
        [{"creator_name": "Siim Land", "platform_to_engage_on": "YouTube", "why_selected": "overlap"}]
    )
    assert "### 1. Siim Land" in creator_md
    assert "platform to engage on" in creator_md
    html = render_html_document("Hook-tested script openings", numbered)
    assert "<!DOCTYPE html>" in html
    assert "Hook-tested script openings" in html
    assert "<ol>" in html
    assert "<li>first hook</li>" in html
    assert "font-family" in html

    calendar_csv = render_calendar_csv(
        "**Strategy:** Treat healthspan like a product.\n\n"
        "**Recurring series:**\n"
        "- Founder Health OS (Substack, Weekly): Ship one evidence-led essay.\n"
        "- Week 1 (Jul 13-19) / YouTube / long-form video: "
        "**Stop Biohacking** — Build a measurable health system."
    )
    assert "strategy" in calendar_csv
    assert "recurring_series" in calendar_csv
    assert "calendar,1,Jul 13-19,YouTube,long-form video,Stop Biohacking" in calendar_csv

    records_csv = render_records_csv(
        '[{"creator_name":"Siim Land","platform":"YouTube","why_selected":"Strong overlap"}]'
    )
    assert records_csv.splitlines()[0] == "creator_name,platform,why_selected"
    assert "Siim Land,YouTube,Strong overlap" in records_csv

    schema = rewrite_schema_file_pointer_fields(
        {
            "fields": [
                {"name": "positioning_statement", "type": "str", "required": True},
                {
                    "name": "ninety_day_content_calendar",
                    "type": "list[object]",
                    "properties": [{"name": "day", "type": "int"}],
                },
                {"name": "creator_name", "type": "str"},
            ]
        },
        {
            "positioning_statement": ("positioning-statement.html", "text/html", "Positioning statement", "html"),
            "ninety_day_content_calendar": (
                "90-day-content-calendar.csv",
                "text/csv",
                "90-day content calendar",
                "calendar_csv",
            ),
        },
    )
    assert schema["fields"][0]["type"] == "file_pointer"
    assert schema["fields"][0]["file_types"] == ["html"]
    assert schema["fields"][1]["type"] == "file_pointer"
    assert schema["fields"][1]["file_types"] == ["csv"]
    assert "properties" not in schema["fields"][1]
    assert schema["fields"][2]["type"] == "str"


def test_materialize_oai_demo_report_files_activity_uploads_readable_formats_idempotently():
    uploads: list[tuple[str, bytes, str, str, str | None]] = []

    async def _upload(user_id, content, filename, mime_type, *, idempotency_key=None):
        uploads.append((user_id, content, filename, mime_type, idempotency_key))
        return {
            "id": f"fp-{len(uploads)}",
            "storage_path": f"{user_id}/{filename}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(content),
            "created_at": "2026-09-03T00:00:00Z",
        }

    async def _run():
        with patch(
            "domains.spawn_agent.oai_demo_report_files.upload_to_storage",
            side_effect=_upload,
        ):
            return await materialize_oai_demo_report_files_activity(
                "user-1",
                {
                    "positioning_statement": "Longevity OS for founders.",
                    "top_creators_analysis": "1. **Andrew Huberman**\n   - Cadence: weekly",
                    "ninety_day_content_calendar": (
                        "- Week 1 (Jul 13-19) / YouTube / long-form video: "
                        "**Stop Biohacking** — Build a measurable system."
                    ),
                    "hook_tested_video_script_openings": ["Track the metric nobody sees."],
                    "weekly_engagement_target_creators": [{"creator_name": "Siim Land", "platform": "YouTube"}],
                    "creator_name": "ignored",
                },
                {"fields": [{"name": "positioning_statement", "type": "str"}]},
                "agent-1",
            )

    result = asyncio.run(_run())
    assert uploads[0][0] == "user-1"
    assert [item[2] for item in uploads] == [
        "positioning-statement.html",
        "top-creators-analysis.html",
        "90-day-content-calendar.csv",
        "hook-tested-script-openings.html",
        "weekly-engagement-targets.csv",
    ]
    assert [item[3] for item in uploads] == ["text/html", "text/html", "text/csv", "text/html", "text/csv"]
    assert all(item[4] == f"oai-demo-report:agent-1:{item[2]}" for item in uploads)
    assert result["structured_response"]["positioning_statement"]["original_filename"] == ("positioning-statement.html")
    assert result["output_schema"]["fields"][0]["type"] == "file_pointer"
    assert result["output_schema"]["fields"][0]["file_types"] == ["html"]


def test_materialize_oai_demo_report_files_activity_keeps_legacy_three_arg_calls_retry_safe():
    idempotency_keys: list[str | None] = []

    async def _upload(user_id, content, filename, mime_type, *, idempotency_key=None):
        idempotency_keys.append(idempotency_key)
        return {
            "id": "fp-legacy",
            "storage_path": f"{user_id}/{filename}",
            "original_filename": filename,
            "mime_type": mime_type,
            "size_bytes": len(content),
            "created_at": "2026-09-03T00:00:00Z",
        }

    async def _run():
        with patch(
            "domains.spawn_agent.oai_demo_report_files.upload_to_storage",
            side_effect=_upload,
        ):
            args = (
                "user-legacy",
                {"positioning_statement": "Stable report."},
                {"fields": [{"name": "positioning_statement", "type": "str"}]},
            )
            await materialize_oai_demo_report_files_activity(*args)
            await materialize_oai_demo_report_files_activity(*args)

    asyncio.run(_run())
    assert len(idempotency_keys) == 2
    assert idempotency_keys[0] == idempotency_keys[1]
    assert idempotency_keys[0] is not None
    assert idempotency_keys[0].startswith("oai-demo-report:")


def test_should_skip_oai_demo_browser_spawn_is_demo_only():
    demo = SimpleNamespace(goal=OAI_DEMO_ROOT_GOAL_PREFIX, fast_mode_cache_enabled=True)
    child = SimpleNamespace(goal=f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky", fast_mode_cache_enabled=False)
    live_fm = SimpleNamespace(goal="Buy socks", fast_mode_cache_enabled=True)
    demo_button_off = SimpleNamespace(goal=OAI_DEMO_ROOT_GOAL_PREFIX, fast_mode_cache_enabled=False)
    assert should_skip_oai_demo_browser_spawn(demo) is True
    assert should_skip_oai_demo_browser_spawn(child) is True
    assert should_skip_oai_demo_browser_spawn(live_fm) is False
    # DEMO prompt skips browser even when the Fast Mode button is off.
    assert should_skip_oai_demo_browser_spawn(demo_button_off) is True


def test_get_max_iterations_reads_positive_env(monkeypatch):
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "12")
    assert get_max_iterations() == 12
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "0")
    assert get_max_iterations() == 250
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "nope")
    assert get_max_iterations() == 250
    monkeypatch.delenv("BROWSER_MAX_ITERATIONS", raising=False)
    assert get_max_iterations() == 250


def test_browser_activity_timeout_grows_only_for_an_explicit_step_override(monkeypatch):
    """The 250-step default keeps the 30-minute window a browser session can outlive."""
    monkeypatch.delenv("BROWSER_MAX_ITERATIONS", raising=False)
    assert get_max_iterations() == 250
    assert browser_start_to_close_timeout_minutes(fast_mode=False, goal="Buy socks") == 30
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "60")
    assert browser_start_to_close_timeout_minutes(fast_mode=False, goal="Buy socks") == 30
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "250")
    assert browser_start_to_close_timeout_minutes(fast_mode=False, goal="Buy socks") == 102
    monkeypatch.setenv("BROWSER_MAX_ITERATIONS", "500")
    assert browser_start_to_close_timeout_minutes(fast_mode=False, goal="Buy socks") == 190


def test_resolve_explore_depth_promotes_on_demo_prompt_not_button():
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=True, oai_demo=True) == "deep"
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=False, oai_demo=True) == "deep"
    assert resolve_explore_depth("quick", fast_mode_cache_enabled=True, oai_demo=False) == "quick"
    assert resolve_explore_depth(None, fast_mode_cache_enabled=False, oai_demo=False) == "quick"


def test_resolve_explore_oai_demo_explicit_flag_wins_over_goal():
    live_goal = "Order a Vanilla Bean Shakerato from Blue Bottle"
    demo_goal = f"{OAI_DEMO_CHILD_GOAL_PREFIX} for Andy Prevalsky — Huberman"
    assert resolve_explore_oai_demo(live_goal, oai_demo=True) is True
    assert resolve_explore_oai_demo(demo_goal, oai_demo=False) is False
    assert resolve_explore_oai_demo(demo_goal) is True
    assert resolve_explore_oai_demo(live_goal) is False
    assert resolve_explore_oai_demo("Research Andrew Huberman last 90 days") is False


def test_raise_source_connect_gates_dedups_and_swallows_reject():
    from tools.gate import GateRejectedError

    wf = SimpleNamespace()
    raised: list[str] = []

    async def fake_raise(_wf, _gate, gate_key=""):
        raised.append(gate_key)
        if gate_key.endswith("gmail"):
            raise GateRejectedError("declined")

    async def _run():
        with (
            patch("helpers.source_connect_gates.raise_gate_direct", new=fake_raise),
            patch("helpers.source_connect_gates.workflow.logger.info"),
        ):
            await raise_source_connect_gates(
                wf,
                [
                    "skip-me",
                    {"source": ""},
                    {"source": "email", "connector": "gmail", "connectUrl": "https://x"},
                    {"source": "gmail", "connector": "gmail", "connectUrl": "https://x"},
                    {"source": "calendar", "connectUrl": ""},
                ],
            )

    asyncio.run(_run())
    assert raised == ["source_connect:gmail", "source_connect:calendar"]


def test_fetch_agent_queue_pointer_parses_payload():
    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"taskQueue": "navi-agent-tasks@abc", "surfaceHash": "deadbeef"}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            assert url.endswith("/api/agent-queue-pointer")
            assert headers["X-API-Key"] == "k"
            assert headers["X-Workflow-Id"] == "workflow-1"
            assert headers["X-Workflow-Run-Id"] == "run-1"
            return _Resp()

    fake_config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend/", api_key="k"))
    with (
        patch("helpers.fetch_queue_pointer.config", fake_config),
        patch(
            "helpers.fetch_queue_pointer.activity.info",
            return_value=SimpleNamespace(workflow_id="workflow-1", workflow_run_id="run-1"),
        ),
        patch("helpers.fetch_queue_pointer.httpx.AsyncClient", return_value=_Client()),
    ):
        result = asyncio.run(fetch_agent_queue_pointer())
    assert result == {"task_queue": "navi-agent-tasks@abc", "surface_hash": "deadbeef"}


def test_fetch_agent_queue_pointer_requires_key_and_queue():
    fake_config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key=""))
    with patch("helpers.fetch_queue_pointer.config", fake_config):
        with pytest.raises(RuntimeError, match="BACKEND_API_KEY"):
            asyncio.run(fetch_agent_queue_pointer())

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"taskQueue": ""}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            assert headers["X-Workflow-Id"] == "workflow-1"
            assert headers["X-Workflow-Run-Id"] == "run-1"
            return _Resp()

    fake_config.backend.api_key = "k"
    with (
        patch("helpers.fetch_queue_pointer.config", fake_config),
        patch(
            "helpers.fetch_queue_pointer.activity.info",
            return_value=SimpleNamespace(workflow_id="workflow-1", workflow_run_id="run-1"),
        ),
        patch("helpers.fetch_queue_pointer.httpx.AsyncClient", return_value=_Client()),
    ):
        with pytest.raises(RuntimeError, match="missing taskQueue"):
            asyncio.run(fetch_agent_queue_pointer())


def test_create_gate_request_activity_paths(monkeypatch):
    from domains.gate.config import GATE_SUPPRESSED_SENTINEL
    from domains.gate.repo import (
        create_gate_request_activity,
        has_message_corpus_activity,
        mint_gmail_connect_activity,
        mint_subscription_checkout_activity,
        source_status_activity,
    )

    class _Resp:
        def __init__(self, status=200, payload=None, text="ok"):
            self.status_code = status
            self._payload = payload or {}
            self.text = text

        def json(self):
            return self._payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"http {self.status_code}")

    class _Client:
        def __init__(self, response):
            self._response = response

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            return self._response

        async def get(self, *args, **kwargs):
            return self._response

    async def _run():
        monkeypatch.delenv("NON_PURCHASE_GATES_ENABLED", raising=False)
        suppressed = await create_gate_request_activity(
            "u", "a", "w", "q", {"type": "source_connect"}, "source_connect:gmail"
        )
        assert suppressed == GATE_SUPPRESSED_SENTINEL

        fake_config = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key="k"))
        monkeypatch.setenv("NON_PURCHASE_GATES_ENABLED", "1")
        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch(
                "domains.gate.repo.httpx.AsyncClient",
                return_value=_Client(_Resp(payload={"id": "req-1", "deduped": True})),
            ),
        ):
            created = await create_gate_request_activity("u", "a", "w", "q", {"type": "purchase"}, "purchase:1")
        assert created == "req-1"

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch("domains.gate.repo.httpx.AsyncClient", return_value=_Client(_Resp(payload={"url": "https://pay"}))),
        ):
            assert await mint_subscription_checkout_activity("u") == "https://pay"

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch("domains.gate.repo.httpx.AsyncClient", return_value=_Client(_Resp(payload={"url": ""}))),
        ):
            with pytest.raises(ValueError, match="missing url"):
                await mint_subscription_checkout_activity("u")

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch(
                "domains.gate.repo.httpx.AsyncClient",
                return_value=_Client(_Resp(payload={"authUrl": "https://gmail"})),
            ),
        ):
            assert await mint_gmail_connect_activity("u") == "https://gmail"

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch("domains.gate.repo.httpx.AsyncClient", return_value=_Client(_Resp(payload={"authUrl": ""}))),
        ):
            with pytest.raises(ValueError, match="missing authUrl"):
                await mint_gmail_connect_activity("u")

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch(
                "domains.gate.repo.httpx.AsyncClient",
                return_value=_Client(_Resp(payload={"sources": {"messages": {"total_messages": 3}}})),
            ),
        ):
            assert await has_message_corpus_activity("u") is True

        assert await source_status_activity("u", []) == []
        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch(
                "domains.gate.repo.httpx.AsyncClient",
                return_value=_Client(_Resp(payload={"statuses": [{"source": "gmail", "connected": False}]})),
            ),
        ):
            statuses = await source_status_activity("u", ["gmail"])
        assert statuses[0]["source"] == "gmail"

        with (
            patch("domains.gate.repo.load_config", return_value=fake_config),
            patch("domains.gate.repo.httpx.AsyncClient", return_value=_Client(_Resp(payload={"statuses": "nope"}))),
        ):
            with (
                patch("domains.gate.repo.load_config", return_value=fake_config),
                patch(
                    "domains.gate.repo.httpx.AsyncClient",
                    return_value=_Client(_Resp(status=500, payload={}, text="boom")),
                ),
            ):
                with pytest.raises(RuntimeError, match="http 500"):
                    await create_gate_request_activity("u", "a", "w", "q", {"type": "purchase"}, "purchase:err")

            assert await source_status_activity("u", ["gmail"]) == []

    asyncio.run(_run())


def test_realtime_message_helpers_cover_coalesce_and_order_keys():
    from helpers.messages import (
        _QueuedRealtimeMessage,
        _assistant_delta_coalesce_key,
        _broadcast_coalesce_items,
        _broadcast_queue,
        _coalesce_assistant_delta,
        _get_broadcast_batch_lock,
        _get_broadcast_client,
        _message_order_key,
        _queue_realtime_message,
        _schedule_broadcast_flush,
    )

    assert _message_order_key({"topic": "t", "event": "e", "payload": {"record": {"stream_id": "s1"}}}) == "t:e:s1"
    assert _message_order_key({"topic": "t", "event": "e", "payload": {"record": {"taskId": "tid"}}}) == "t:e:tid"
    assert _message_order_key({"topic": "t", "event": "e", "payload": {}}) == "t:e"
    assert _assistant_delta_coalesce_key({"event": "OTHER"}) is None
    assert _assistant_delta_coalesce_key({"event": "ASSISTANT_STREAM", "payload": {}}) is None
    assert (
        _assistant_delta_coalesce_key(
            {
                "event": "ASSISTANT_STREAM",
                "topic": "t",
                "payload": {"record": {"done": False, "stream_id": "s", "subAgentId": "c"}},
            }
        )
        == "t:ASSISTANT_STREAM:s:c"
    )
    existing = _QueuedRealtimeMessage(
        message={"payload": {"record": {"delta": "a", "sequence": 1}}},
        enqueued_at=0.0,
        order_key="t:e",
    )
    assert _coalesce_assistant_delta(existing, {"payload": {}}) is False
    assert (
        _coalesce_assistant_delta(
            existing,
            {"payload": {"record": {"delta": "b", "sequence": 2, "llm_started_at_ms": 9}}},
        )
        is True
    )
    assert existing.message["payload"]["record"]["delta"] == "ab"
    assert existing.coalesced_count == 2
    client = _get_broadcast_client()
    assert client is _get_broadcast_client()

    async def _run():
        lock = _get_broadcast_batch_lock()
        assert lock is _get_broadcast_batch_lock()
        _schedule_broadcast_flush(0.0)
        _schedule_broadcast_flush(0.2)

        message = {
            "topic": "agent:a",
            "event": "ASSISTANT_STREAM",
            "payload": {"record": {"done": False, "stream_id": "s", "delta": "a", "sequence": 1}},
        }
        _broadcast_queue.clear()
        _broadcast_coalesce_items.clear()
        with patch("helpers.messages._schedule_broadcast_flush"):
            await _queue_realtime_message(message)
            await _queue_realtime_message(
                {
                    **message,
                    "payload": {"record": {**message["payload"]["record"], "delta": "b", "sequence": 2}},
                }
            )
        assert _broadcast_queue[0].message["payload"]["record"]["delta"] == "ab"
        _broadcast_queue.clear()
        _broadcast_coalesce_items.clear()

    asyncio.run(_run())


def test_spawn_handler_helpers_cover_demo_counts_and_wrapup():
    from domains.spawn_agent.handler import (
        _activity_handle_done,
        _fm_explore_handles,
        _is_for_each_finalize_timeout,
        _is_oai_demo_for_each_tool,
        _oai_demo_child_result_failed,
        _oai_demo_first_level_gp_count,
        _prior_oai_demo_for_each_count,
        _recover_oai_demo_for_each_timeout,
        prune_fast_mode_explores,
        user_facing_explore_result,
        wait_for_fast_mode_explore_slot,
        wrap_up_payload_from_failure,
    )
    from utils.oai_demo_july import (
        apply_oai_demo_july_for_each,
        extract_oai_demo_creator_name,
        july_explore_goal_hash_for_goal,
        july_gp_goal_hash_for_goal,
        normalize_oai_demo_creator_key,
    )
    from domains.spawn_agent.service import (
        _has_usable_tool_evidence,
        _looks_like_common_csv_header,
        _unavailable_source_is_required,
        build_for_each_goal,
        coerce_for_each_items,
        compile_explore_wrap_up,
        resolve_start_phase,
        validate_spawn_params,
    )

    assert user_facing_explore_result("") == ""
    assert user_facing_explore_result("Research started.") == ""
    assert user_facing_explore_result("fast mode stub") == ""
    assert user_facing_explore_result("Huberman sleep protocol") == "Huberman sleep protocol"

    class _Exc(Exception):
        def __init__(self):
            self.last_heartbeat_details = ({"result": "from-tuple"},)
            self.cause = None

    assert wrap_up_payload_from_failure(_Exc())["result"] == "from-tuple"

    class _StrExc(Exception):
        def __init__(self):
            self.last_heartbeat_details = "plain-text"
            self.cause = None

    assert wrap_up_payload_from_failure(_StrExc()) == {"result": "plain-text"}
    assert wrap_up_payload_from_failure(Exception("no details")) == {}

    wf = SimpleNamespace()
    assert _fm_explore_handles(wf) is _fm_explore_handles(wf)
    done_handle = SimpleNamespace(done=lambda: True)
    open_handle = SimpleNamespace(done=lambda: False)
    wf._fm_explore_handles = [{"handle": done_handle}, {"handle": open_handle}]
    prune_fast_mode_explores(wf)
    assert len(wf._fm_explore_handles) == 1
    assert _activity_handle_done(SimpleNamespace()) is False

    asyncio.run(wait_for_fast_mode_explore_slot(wf, cap=8))

    assert _is_oai_demo_for_each_tool({"toolName": "spawn_general_purpose_agent_for_each"})
    assert _is_oai_demo_for_each_tool({"toolName": "spawn_agent", "agentType": "for_each"})
    assert not _is_oai_demo_for_each_tool({"toolName": "spawn_agent", "agentType": "explore"})
    assert _is_for_each_finalize_timeout(TimeoutError("activity timed out"))
    assert not _is_for_each_finalize_timeout(RuntimeError("boom"))
    assert _oai_demo_child_result_failed({"status": "failed"})
    assert _oai_demo_child_result_failed({"success": False})
    assert not _oai_demo_child_result_failed({"status": "completed", "success": True})

    assert _prior_oai_demo_for_each_count(SimpleNamespace(context="bad")) == 0
    assert (
        _prior_oai_demo_for_each_count(
            SimpleNamespace(
                context=[
                    {"role": "USER", "text": "hi"},
                    {
                        "role": "TOOL",
                        "metadata": {
                            "toolName": "spawn_agent",
                            "agentType": "for_each",
                            "toolCallId": "cur",
                        },
                    },
                    {
                        "role": "TOOL",
                        "metadata": {
                            "toolName": "spawn_agent",
                            "agentType": "for_each",
                            "toolCallId": "prior",
                        },
                    },
                    {
                        "role": "TOOL",
                        "metadata": {
                            "toolName": "spawn_agent",
                            "agentType": "for_each",
                            "toolCallId": "prior",
                        },
                    },
                    {"role": "TOOL", "metadata": {"toolName": "web_search"}},
                ]
            ),
            current_tool_call_id="cur",
        )
        == 1
    )

    assert _oai_demo_first_level_gp_count(SimpleNamespace(context=None)) == 0
    assert (
        _oai_demo_first_level_gp_count(
            SimpleNamespace(
                context=[
                    {"role": "TOOL", "metadata": {"toolName": "spawn_general_purpose_agent_for_each"}},
                    {
                        "role": "TOOL",
                        "metadata": {"toolName": "spawn_general_purpose_agent", "toolCallId": "gp1"},
                    },
                    {
                        "role": "TOOL",
                        "metadata": {"toolName": "spawn_general_purpose_agent", "toolCallId": "gp1"},
                    },
                    {
                        "role": "TOOL",
                        "metadata": {"toolName": "spawn_agent", "agentType": "general_purpose", "toolCallId": "gp2"},
                    },
                    {"role": "TOOL", "metadata": {"toolName": "spawn_agent", "agentType": "explore"}},
                ]
            )
        )
        == 2
    )

    demo_wf = SimpleNamespace(
        goal=OAI_DEMO_ROOT_GOAL_PREFIX,
        demo_cache_goal="",
        fast_mode_cache_enabled=True,
        child_results={"cid": {"status": "completed"}},
    )
    live_wf = SimpleNamespace(goal="Buy socks", demo_cache_goal="", fast_mode_cache_enabled=True)

    async def _recover():
        assert await _recover_oai_demo_for_each_timeout(demo_wf, "", TimeoutError("timed out")) is None
        assert (
            await _recover_oai_demo_for_each_timeout(
                SimpleNamespace(fast_mode_cache_enabled=False, goal=OAI_DEMO_ROOT_GOAL_PREFIX),
                "cid",
                TimeoutError("timed out"),
            )
            is None
        )
        assert await _recover_oai_demo_for_each_timeout(live_wf, "cid", TimeoutError("timed out")) is None
        assert await _recover_oai_demo_for_each_timeout(demo_wf, "cid", RuntimeError("other")) is None
        assert (
            await _recover_oai_demo_for_each_timeout(
                SimpleNamespace(
                    goal=OAI_DEMO_ROOT_GOAL_PREFIX,
                    demo_cache_goal="",
                    fast_mode_cache_enabled=True,
                    child_results="bad",
                ),
                "cid",
                TimeoutError("timed out"),
            )
            is None
        )
        assert await _recover_oai_demo_for_each_timeout(demo_wf, "cid", TimeoutError("timed out")) == {
            "status": "completed"
        }

        demo_empty = SimpleNamespace(
            goal=OAI_DEMO_ROOT_GOAL_PREFIX,
            demo_cache_goal="",
            fast_mode_cache_enabled=True,
            child_results={},
            pending_children={"cid"},
        )

        async def _durable_completed(fn, args=None, **kwargs):
            assert args == ["cid"]
            return {"status": "completed", "summary": "from-db"}

        import domains.spawn_agent.handler as spawn_handler

        with patch.object(spawn_handler.workflow, "execute_activity", _durable_completed):
            recovered = await asyncio.wait_for(
                _recover_oai_demo_for_each_timeout(demo_empty, "cid", TimeoutError("Activity task timed out")),
                timeout=1.0,
            )
        assert recovered == {"status": "completed", "summary": "from-db"}
        assert demo_empty.child_results["cid"]["summary"] == "from-db"
        assert "cid" not in demo_empty.pending_children

    asyncio.run(_recover())

    assert normalize_oai_demo_creator_key("Dr. Andrew Huberman") == "andrew huberman"
    assert extract_oai_demo_creator_name("") is None
    assert extract_oai_demo_creator_name("Research Andrew Huberman sleep")
    assert july_gp_goal_hash_for_goal("no creator here") is None
    assert july_explore_goal_hash_for_goal("no creator here") is None
    assert apply_oai_demo_july_for_each("g", [{"n": 1}], enabled=False) == ("g", [{"n": 1}])
    _, july_items = apply_oai_demo_july_for_each("g", [{"n": 1}], enabled=True)
    assert len(july_items) >= 50

    assert compile_explore_wrap_up("fast mode cache trajectory ended") == ""
    assert compile_explore_wrap_up("real summary") == "real summary"
    assert "excerpt" in compile_explore_wrap_up("", ["prefix **Result:** excerpt"])
    assert compile_explore_wrap_up("", ["  raw-tool  "]) == "raw-tool"
    assert compile_explore_wrap_up("", ["x" * 200], budget=20) == "x" * 20
    assert "[...truncated...]" in compile_explore_wrap_up("", ["x" * 200], budget=40)
    assert _has_usable_tool_evidence(None) is False
    assert _has_usable_tool_evidence("error: nope") is False
    assert _has_usable_tool_evidence("Huberman notes") is True
    assert _has_usable_tool_evidence({"success": False}) is False
    assert _has_usable_tool_evidence({"status": "failed"}) is False
    assert _has_usable_tool_evidence({"error": "x"}) is False
    assert _has_usable_tool_evidence({"text": "ok"}) is True
    assert _has_usable_tool_evidence(["ok"]) is True
    assert _has_usable_tool_evidence(1) is True
    assert _unavailable_source_is_required("gmail", "anything", True) is True
    assert _unavailable_source_is_required("gmail", "use gmail inbox", False) is True
    assert _unavailable_source_is_required("calendar", "buy coffee", False) is False
    validate_spawn_params({"type": "explore", "goal": "research sleep", "_phase": "PLAN"})
    with pytest.raises(ValueError, match="requires 'type'"):
        validate_spawn_params({})
    with pytest.raises(ValueError, match="invalid"):
        validate_spawn_params({"type": "nope"})
    with pytest.raises(ValueError, match="not allowed during PLAN"):
        validate_spawn_params({"type": "browser", "goal": "x", "_phase": "PLAN", "start_url": "https://x"})
    with pytest.raises(ValueError, match="requires 'goal'"):
        validate_spawn_params({"type": "explore"})
    with pytest.raises(ValueError, match="start_url"):
        validate_spawn_params({"type": "browser", "goal": "x"})
    assert resolve_start_phase({"start_phase": "EXECUTE"}) == "execute"
    assert resolve_start_phase({}) == "plan"
    assert _looks_like_common_csv_header(["name", "email"]) is True
    assert _looks_like_common_csv_header(["x"]) is False
    assert coerce_for_each_items({"items": [1, 2]}) == [1, 2]
    assert coerce_for_each_items({}) == []
    assert coerce_for_each_items({"items_csv": "name,email\nAda,ada@x.com"})[0]["name"] == "Ada"
    assert coerce_for_each_items({"items_csv": "42\n99"}) == ["42", "99"]
    assert "Row item" in build_for_each_goal("base", {"b": 1, "a": 2})


def test_misc_low_coverage_helpers():
    from domains.attempt_completion.handler import get_manager
    from helpers.messages import schedule_background_broadcast
    from tools.web_search.repo import fetch_search_results_ddgs

    first = get_manager()
    assert get_manager() is first

    async def _boom():
        raise RuntimeError("broadcast failed")

    async def _ok():
        return None

    async def _run():
        schedule_background_broadcast(_boom(), label="unit")
        schedule_background_broadcast(_ok(), label="unit-ok")
        await asyncio.sleep(0)

    asyncio.run(_run())

    class _DDGS:
        def text(self, query, max_results=5):
            return [
                {"title": "A", "href": "https://a", "body": "one"},
                {"title": "B", "href": "https://b", "body": ""},
            ]

    with patch("ddgs.DDGS", return_value=_DDGS()):
        rows = fetch_search_results_ddgs("sleep", max_results=2)
    assert rows[0]["url"] == "https://a"
    assert rows[1]["excerpts"] == []


def test_csv_cells_neutralize_spreadsheet_formulas():
    """CSV quoting stops delimiter injection but not formula execution.

    Report text and record keys are model- and web-derived, so a value starting
    with =, +, - or @ would execute on open in Excel/Sheets.
    """
    assert _safe_csv_cell("=cmd|'/c calc'!A1") == "'=cmd|'/c calc'!A1"
    for prefix in ("=", "+", "-", "@"):
        assert _safe_csv_cell(f"{prefix}danger").startswith("'")
    # Leading whitespace must not smuggle a formula past the check.
    assert _safe_csv_cell("   =sneaky").startswith("'")
    # Ordinary values and non-strings are untouched.
    assert _safe_csv_cell("safe text") == "safe text"
    assert _safe_csv_cell(7) == 7

    rendered = _csv_text(["=header", "plain"], [{"=header": "=evil", "plain": "ok"}])
    assert "'=header" in rendered
    assert "'=evil" in rendered
    assert rendered.endswith("\n")


def test_passthrough_file_pointers_still_rewrite_their_schema_fields():
    """Values that arrive as FilePointers are skipped for upload but still typed.

    plan_oai_demo_report_files intentionally skips them (nothing to upload); if
    their schema fields kept the old type the declared schema would contradict
    the value it describes.
    """
    pointer = {"storage_path": "p/x.html", "original_filename": "x.html"}
    response = {"positioning_statement": pointer, "top_creators_analysis": "prose"}

    assert plan_oai_demo_report_files(response) != []
    assert sorted(passthrough_file_pointer_specs(response)) == ["positioning_statement"]

    # A response made entirely of pass-through pointers plans no uploads at all.
    all_pointers = {"positioning_statement": pointer}
    assert plan_oai_demo_report_files(all_pointers) == []
    assert sorted(passthrough_file_pointer_specs(all_pointers)) == ["positioning_statement"]

    schema = {"fields": [{"name": "positioning_statement", "type": "string"}]}
    rewritten = rewrite_schema_file_pointer_fields(schema, passthrough_file_pointer_specs(all_pointers))
    assert rewritten["fields"][0]["type"] != "string"


def test_materialize_persists_rewritten_schema_for_passthrough_only_response():
    """mark_finished carries structured_response but not the schema.

    Without an explicit persist the DB keeps pre-rewrite field types while the
    stored response holds FilePointers.
    """
    pointer = {"storage_path": "p/x.html", "original_filename": "x.html"}
    response = {"positioning_statement": pointer}
    schema = {"fields": [{"name": "positioning_statement", "type": "string"}]}

    result = asyncio.run(materialize_oai_demo_report_files_activity("user-1", response, schema, "agent-1"))
    # No uploads were planned, but the schema must still describe a file.
    assert result["output_schema"]["fields"][0]["type"] != "string"


def test_for_each_timeout_recovers_terminal_child_without_completion_signal(monkeypatch):
    from domains.spawn_agent import handler

    child_id = "completed-without-signal"
    workflow_instance = SimpleNamespace(
        goal=OAI_DEMO_ROOT_GOAL_PREFIX,
        demo_cache_goal="",
        fast_mode_cache_enabled=True,
        child_results={},
        pending_children={child_id},
    )

    async def fetch_terminal_result(activity, *, args, **_kwargs):
        assert activity is handler.fetch_child_terminal_result_activity
        assert args == [child_id]
        return {"status": "completed", "summary": "saved result"}

    monkeypatch.setattr(handler.workflow, "execute_activity", fetch_terminal_result)
    recovered = asyncio.run(
        handler._recover_oai_demo_for_each_timeout(workflow_instance, child_id, TimeoutError("activity timed out"))
    )
    assert recovered == {"status": "completed", "summary": "saved result"}
    assert child_id not in workflow_instance.pending_children
