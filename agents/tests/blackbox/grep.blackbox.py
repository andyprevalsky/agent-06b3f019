"""Blackbox tests for grep domain."""

import asyncio
import json
from types import SimpleNamespace
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
        "/api/data/grep": {
            "status": 200,
            "json": {
                "matches": [
                    {
                        "thread_id": "t-1",
                        "person_name": "Alice",
                        "messages": [
                            {"text": "Let's discuss the project", "timestamp": "2026-01-01T10:00:00Z"}
                        ],
                    }
                ],
                "total_matches": 1,
                "truncated": False,
            },
        },
        "/api/data/summary": {
            "status": 200,
            "json": {
                "sources": {
                    "messages": {
                        "total_threads": 5,
                        "total_messages": 120,
                        "channels": {"sms": 80, "email": 40},
                        "date_range": {"from": "2025-06-01T00:00:00Z", "to": "2026-04-01T00:00:00Z"},
                        "latest_message": {
                            "timestamp": "2026-04-01T12:34:56Z",
                            "channel": "sms",
                            "from": "me",
                            "to": "+15551234567",
                            "text": "Latest exact text",
                        },
                        "threads": [
                            {"name": "Alice", "message_count": 50, "last_message": "2026-04-01"},
                            {"name": "Bob", "message_count": 30, "last_message": "2026-03-15"},
                        ],
                    }
                }
            },
        },
    })


async def test_grep_happy_path():
    """grep_activity returns matches from backend."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            {"pattern": "project", "source": "messages"},
            user_id="user-42",
            agent_id="agent-1",
        )

    assert result["total_matches"] == 1
    assert result["truncated"] is False
    assert len(result["matches"]) == 1
    assert result["matches"][0]["person_name"] == "Alice"


async def test_grep_boundary():
    """Verify exact HTTP request sent to backend grep endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        await grep_activity(
            {
                "pattern": "quarterly report",
                "source": "messages",
                "-i": True,
                "head_limit": 5,
                "offset": 2,
                "context": 1,
                "multiline": True,
            },
            user_id="user-99",
            agent_id="agent-2",
        )

    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body["pattern"] == "quarterly report"
    assert body["source"] == "messages"
    assert body["-i"] is True
    assert body["head_limit"] == 5
    assert body["offset"] == 2
    assert body["context"] == 1
    assert body["multiline"] is True
    assert body["user_id"] == "user-99"
    assert body["agent_id"] == "agent-2"
    assert "tool" not in body
    assert "person_id" not in body
    assert "since" not in body
    assert "limit" not in body

    # Verify X-User-Id header is set
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "x-user-id" in headers_lower


async def test_grep_boundary_normalizes_model_dump_keys():
    """Actual model dumps use Python field names; HTTP payload must use public Grep keys."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        await grep_activity(
            {
                "tool": "grep",
                "pattern": "Lighthouse|Aurora",
                "source": "messages",
                "before": 1,
                "after": 2,
                "context_c": 3,
                "line_numbers": False,
                "case_insensitive": True,
                "head_limit": 5,
                "offset": 2,
                "multiline": True,
            },
            user_id="user-99",
            agent_id="agent-2",
        )

    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
        header_present="X-API-Key",
    )
    body = json.loads(call["requestBody"])
    assert body == {
        "pattern": "Lighthouse|Aurora",
        "source": "messages",
        "-B": 1,
        "-A": 2,
        "-C": 3,
        "-n": False,
        "-i": True,
        "head_limit": 5,
        "offset": 2,
        "multiline": True,
        "user_id": "user-99",
        "agent_id": "agent-2",
    }


async def test_grep_agent_metadata_only():
    """Typed trajectory selectors reach the backend without a text pattern."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        await grep_activity(
            {"role": "USER", "record_kind": "message", "surface": "SMS"},
            user_id="user-42",
            agent_id="agent-1",
        )

    call = assert_captured_call(url_contains="/api/data/grep", method="POST")
    body = json.loads(call["requestBody"])
    assert body == {
        "role": "USER",
        "record_kind": "message",
        "surface": "SMS",
        "user_id": "user-42",
        "agent_id": "agent-1",
    }


async def test_fetch_local_data_summary():
    """The explore agent's inventory is the backend's grep `summary` rendering, cached per user."""
    rendered = "LOCAL DATA SOURCES:\n\nmessages/ 5 threads, 120 messages\n    Alice  50 msgs"
    setup_mock({"/api/data/grep": {"status": 200, "json": {"sources": ["summary"], "message": rendered}}})
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import _data_summary_cache, fetch_local_data_summary

        _data_summary_cache.clear()
        result = await fetch_local_data_summary("user-42")
        cached = await fetch_local_data_summary("user-42")
        _data_summary_cache.clear()

    assert result == rendered and cached == rendered
    call = assert_captured_call(url_contains="/api/data/grep", method="POST", header_present="X-API-Key")
    assert json.loads(call["requestBody"]) == {"sources": ["summary"], "user_id": "user-42"}
    assert len([c for c in get_captured_requests() if "/api/data/grep" in c["url"]]) == 1


async def test_grep_empty_pattern():
    """grep_activity with empty pattern still sends POST request."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            {"pattern": "", "source": "messages"},
            user_id="user-42",
        )

    assert "matches" in result
    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["pattern"] == ""


async def test_grep_summary_source_is_answered_by_the_backend_executor():
    """summary goes to the shared backend grep tool executor like any other source."""
    setup_mock({
        "/api/data/grep": {
            "status": 200,
            "json": {"matches": [], "total_matches": 1, "sources": ["summary"], "message": "LOCAL DATA SOURCES:"},
        }
    })
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity({"pattern": "message totals", "sources": ["summary"]}, user_id="user-42")

    call = assert_captured_call(url_contains="/api/data/grep", method="POST")
    assert json.loads(call["requestBody"])["sources"] == ["summary"]
    assert result["message"] == "LOCAL DATA SOURCES:"


async def test_grep_backend_error_is_not_retried_by_the_agent():
    """The literal retry of an invalid regex lives in the backend executor; the agent
    forwards the backend's answer, including its literal_fallback fields, from one request."""
    from unittest.mock import AsyncMock, MagicMock

    from tools.grep import grep_activity

    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "matches": [{"content": "+15551234567"}],
        "total_matches": 1,
        "truncated": False,
        "literal_fallback": True,
        "original_pattern": "+15551234567",
        "effective_pattern": r"\+15551234567",
    }
    rejected = MagicMock()
    rejected.status_code = 400
    rejected.json.return_value = {"error": "INVALID_GREP_PARAM", "message": "Unsupported grep parameter: 'x'."}
    client = SimpleNamespace(post=AsyncMock(side_effect=[response, rejected]))

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.grep.repo.get_http_client", return_value=client),
    ):
        result = await grep_activity({"pattern": "+15551234567", "source": "network"}, user_id="user-42")
        try:
            await grep_activity({"pattern": "x", "x": 1}, user_id="user-42")
            raise AssertionError("a backend 400 must raise")
        except ValueError as error:
            assert "Unsupported grep parameter" in str(error)

    assert client.post.await_count == 2
    assert client.post.await_args_list[0].kwargs["json"]["pattern"] == "+15551234567"
    assert result["literal_fallback"] is True


async def test_grep_network_source_forwarded():
    """grep_activity forwards source=network to backend."""
    setup_mock({
        "/api/data/grep": {
            "status": 200,
            "json": {
                "matches": [
                    {
                        "person_id": "p-1",
                        "first_name": "Alice",
                        "last_name": "Smith",
                        "phone_number": "+15551234567",
                        "email": "alice@example.com",
                        "company": "Acme",
                        "title": "CTO",
                        "relation": "colleague",
                        "communication_frequency": "weekly",
                        "messages_exchanged": 42,
                    }
                ],
                "total_matches": 1,
                "truncated": False,
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import grep_activity

        result = await grep_activity(
            {"pattern": "acme", "source": "network"},
            user_id="user-42",
        )

    assert result["total_matches"] == 1
    assert result["matches"][0]["first_name"] == "Alice"

    call = assert_captured_call(
        url_contains="/api/data/grep",
        method="POST",
    )
    body = json.loads(call["requestBody"])
    assert body["source"] == "network"
    assert body["pattern"] == "acme"
    # Removed params must NOT be injected.
    assert "person_id" not in body
    assert "since" not in body
    assert "limit" not in body


# -------------------- service.py tests --------------------


def test_truncate_pattern_short():
    from domains.grep.service import _truncate_pattern
    assert _truncate_pattern("abc") == "abc"


def test_truncate_pattern_long():
    from domains.grep.service import _truncate_pattern
    from domains.grep.config import DISPLAY_PATTERN_MAX_LENGTH
    long = "x" * (DISPLAY_PATTERN_MAX_LENGTH + 50)
    out = _truncate_pattern(long)
    assert len(out) == DISPLAY_PATTERN_MAX_LENGTH
    assert out.endswith("...")


async def test_execute_grep_happy():
    from domains.grep.service import execute_grep

    calls = []
    activity_result = {"matches": [], "total_matches": 0, "truncated": False}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": getattr(activity_fn, "__name__", "fn"), "args": args})
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return activity_result
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "foo", "source": "messages"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"] == activity_result
    assert out["usage"] == {"llm": [], "service": []}
    # IN_PROGRESS + activity + FINISHED = 3
    assert any(c["activity"] == "grep_activity" for c in calls)
    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[0] == 'Searching messages for "foo"'
    assert tool_titles[-1] == 'Searched messages for "foo"'


async def test_execute_grep_empty_pattern_path():
    """Empty pattern exercises the 'all messages' title branch."""
    from domains.grep.service import execute_grep

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return {"matches": []}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": ""},
        tool_call_id="tc-1",
        agent_id="a-1",
    )
    assert out["result"] == {"matches": []}


async def test_execute_grep_error_reraises():
    from domains.grep.service import execute_grep

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        calls.append({"activity": getattr(activity_fn, "__name__", "fn"), "args": args})
        name = getattr(activity_fn, "__name__", "")
        if name == "grep_activity":
            raise RuntimeError("backend down")
        return None

    try:
        await execute_grep(
            execute_activity=mock_execute_activity,
            tool_call={"pattern": "x"},
            tool_call_id="tc-1",
            agent_id="a-1",
        )
        raise AssertionError("should have raised")
    except RuntimeError as e:
        assert "backend down" in str(e)
    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[-1] == 'Grep failed searching all local data for "x"'


async def test_manager_execute_tool():
    from domains.grep.handler import GrepManager

    activity_result = {"matches": [], "total_matches": 0}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(activity_fn, "__name__", "") == "grep_activity":
            return activity_result
        return None

    manager = GrepManager()
    out = await manager.execute_tool(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "foo", "source": "messages"},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["result"] == activity_result


async def test_execute_grep_source_unavailable():
    """An unconnected external source returns a source_unavailable marker and
    skips grep_activity when nothing else is searchable."""
    from domains.grep.service import execute_grep

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append(name)
        if name == "source_status_activity":
            return [
                {"source": "email", "connector": "gmail", "connected": False, "connectUrl": "https://x"}
            ]
        if name == "grep_activity":
            return {"matches": [], "total_matches": 0}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "flight", "sources": ["email"]},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["unavailable_sources"] and out["unavailable_sources"][0]["source"] == "email"
    assert "not connected" in out["result"].lower()
    # grep_activity is NOT called — email was the only (unavailable) source.
    assert "grep_activity" not in calls
    assert "source_status_activity" in calls


async def test_execute_grep_partial_connectivity():
    """One unavailable + one available source: grep runs on the available one,
    the unavailable one is still surfaced."""
    from domains.grep.service import execute_grep

    grep_called_with = {}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "source_status_activity":
            return [
                {"source": "email", "connector": "gmail", "connected": False, "connectUrl": "https://x"},
                {"source": "transactions", "connector": "plaid", "connected": True, "connectUrl": None},
            ]
        if name == "grep_activity":
            grep_called_with.update(args[0])
            return {"matches": [], "total_matches": 0}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "x", "sources": ["email", "transactions"]},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["unavailable_sources"][0]["source"] == "email"
    # grep ran only on the connected source
    assert grep_called_with.get("sources") == ["transactions"]


def test_grep_tool_accepts_calendar_and_drive_listings():
    """calendar and drive are selectable sources, and a listing needs no pattern."""
    from utils.tool_schemas import GrepTool

    day = GrepTool.model_validate(
        {"tool": "grep", "sources": ["calendar"], "filters": {"since": "2026-10-02", "until": "2026-10-02"}}
    )
    assert day.pattern is None
    assert day.sources == ["calendar"]
    folder = GrepTool.model_validate(
        {"tool": "grep", "sources": ["drive"], "filters": {"path": "drive/a@example.com/My Drive/Legal"}}
    )
    assert folder.sources == ["drive"]
    assert GrepTool.model_validate({"tool": "grep", "source": "drive", "pattern": "lease"}).source == "drive"


async def test_execute_grep_calendar_listing_reaches_backend():
    """A pattern-less calendar listing is forwarded as asked and titled by its source."""
    from domains.grep.service import execute_grep

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": args})
        if name == "source_status_activity":
            return [{"source": "calendar", "connector": "gmail", "connected": True, "connectUrl": None}]
        if name == "grep_activity":
            return {"matches": [], "total_matches": 0}
        return None

    tool_call = {"sources": ["calendar"], "filters": {"since": "2026-10-02", "until": "2026-10-02"}}
    await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call=tool_call,
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    status_calls = [c for c in calls if c["activity"] == "source_status_activity"]
    assert status_calls and status_calls[0]["args"][1] == ["calendar"]
    grep_calls = [c for c in calls if c["activity"] == "grep_activity"]
    assert grep_calls and grep_calls[0]["args"][0] == tool_call
    tool_titles = [
        call["args"][3]["title"]
        for call in calls
        if call["activity"] == "post_agent_message" and call["args"][2] == "TOOL"
    ]
    assert tool_titles[0] == "Searching calendar"
    assert tool_titles[-1] == "Searched calendar"


async def test_execute_grep_drive_unconnected_gates_on_google():
    """drive without a Google connection is skipped and reported against the gmail connector."""
    from domains.grep.service import execute_grep

    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append(name)
        if name == "source_status_activity":
            return [
                {
                    "source": "drive",
                    "connector": "gmail",
                    "connected": False,
                    "connectUrl": "https://roselabs.ai/connect/gmail",
                }
            ]
        return {"matches": [], "total_matches": 0}

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "lease", "sources": ["drive"]},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert out["unavailable_sources"][0]["connector"] == "gmail"
    assert "grep_activity" not in calls


def test_printed_google_path_names_its_source():
    """A calendar or drive path with no source still gates and titles as that source."""
    from domains.grep.service import _extract_sources, _title_source

    drive = {"filters": {"path": "drive/a@example.com/My Drive/Legal/Lease.gdoc"}}
    assert _extract_sources(drive) == ["drive"]
    assert _title_source(drive) == "drive"
    assert _extract_sources({"filters": {"path": "calendar/a@example.com/2026-10-06"}}) == ["calendar"]
    # An explicit choice wins, and other paths keep the default local sources.
    assert _extract_sources({"sources": ["messages"], "filters": {"path": "drive/a@example.com"}}) == ["messages"]


def test_grep_titles_name_the_requested_sources():
    """A card title names what was searched instead of 'all local data'."""
    from domains.grep.service import _format_grep_title, _title_source

    assert _title_source({"sources": ["email", "drive"]}) == "email, drive"
    assert _title_source({"source": "messages", "sources": ["drive"]}) == "messages"
    assert _title_source({}) == ""
    assert _format_grep_title("Searching", "lease", "drive") == 'Searching drive for "lease"'
    assert _format_grep_title("Searching", "", "drive") == "Searching drive"
    assert _format_grep_title("Searching", "", "email") == "Searching email for all messages"
    assert _format_grep_title("Searching", "", "") == "Searching all local data for all messages"


async def test_execute_grep_documents_provider_gate():
    """Documents is an umbrella grep corpus; provider filters drive source gates."""
    from domains.grep.service import execute_grep

    source_status_args = []
    calls = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append(name)
        if name == "source_status_activity":
            source_status_args.extend(args[1])
            return [
                {
                    "source": "apple_notes",
                    "connector": "apple_notes",
                    "connected": False,
                    "connectUrl": "https://roselabs.ai/connect/apple_notes",
                }
            ]
        if name == "grep_activity":
            return {"matches": [], "total_matches": 0}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={
            "pattern": "renewal clause",
            "source": "documents",
            "filters": {"document_source": "apple_notes"},
            "require_source_access": True,
        },
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )

    assert source_status_args == ["apple_notes"]
    assert out["unavailable_sources"][0]["source"] == "apple_notes"
    assert "documents" not in [item["source"] for item in out["unavailable_sources"]]
    assert "grep_activity" not in calls


async def test_execute_grep_documents_provider_opportunistic_does_not_gate():
    """Opportunistic document-provider checks should not block on missing access."""
    from domains.grep.service import execute_grep

    calls = []
    grep_called_with = {}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append(name)
        if name == "grep_activity":
            grep_called_with.update(args[0])
            return {"matches": [], "total_matches": 0}
        return None

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={
            "pattern": "Cali gift preferences",
            "source": "documents",
            "filters": {"document_source": "apple_notes"},
        },
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )

    assert "source_status_activity" not in calls
    assert "grep_activity" in calls
    assert grep_called_with["source"] == "documents"
    assert "require_source_access" not in grep_called_with
    assert out["unavailable_sources"] == []


def test_filters_name_their_sources_like_the_backend():
    """A nested filter block or a printed path selects its source, as the backend resolves it."""
    from domains.grep.service import _extract_sources

    assert _extract_sources({"filters": {"drive": {"path": "drive/a@example.com/My Drive"}}}) == ["drive"]
    assert _extract_sources({"filters": {"documents": {"document_source": "apple_notes"}}}) == ["documents"]
    assert _extract_sources({"filters": {"path": "transactions/Chase/Checking"}}) == ["transactions"]
    assert _extract_sources({"filters": {"path": "messages/Alice.thread"}}) == ["messages"]
    # Flat filter keys are not sources, and an explicit choice still wins.
    assert _extract_sources({"filters": {"since": "7d"}}) == []
    assert _extract_sources({"sources": ["email"], "filters": {"drive": {"since": "7d"}}}) == ["email"]


async def test_execute_grep_nested_filter_block_gates_its_source():
    """filters={"drive": {...}} with no sources still checks the Google connection first."""
    from domains.grep.service import execute_grep

    calls = []
    status_args = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        calls.append(name)
        if name == "source_status_activity":
            status_args.extend(args[1])
            return [{"source": "drive", "connector": "gmail", "connected": False, "connectUrl": "https://x"}]
        return {"matches": [], "total_matches": 0}

    out = await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={"pattern": "lease", "filters": {"drive": {"path": "drive/a@example.com/My Drive"}}},
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert status_args == ["drive"]
    assert out["unavailable_sources"][0]["source"] == "drive"
    assert "grep_activity" not in calls


async def test_execute_grep_nested_documents_provider_gate():
    """filters={"documents": {"document_source": ...}} gates on that provider like the flat form."""
    from domains.grep.service import execute_grep

    status_args = []

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "source_status_activity":
            status_args.extend(args[1])
            return [{"source": "apple_notes", "connector": "apple_notes", "connected": True, "connectUrl": None}]
        return {"matches": [], "total_matches": 0}

    await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={
            "pattern": "renewal clause",
            "source": "documents",
            "filters": {"documents": {"document_source": "Apple Notes"}, "tag": "lease"},
            "require_source_access": True,
        },
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert status_args == ["apple_notes"]


async def test_execute_grep_partial_gate_drops_nested_block_of_skipped_source():
    """Skipping an unconnected source also drops its nested filter block, which the
    backend rejects for a source that is no longer selected."""
    from domains.grep.service import execute_grep

    grep_called_with = {}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "source_status_activity":
            return [
                {"source": "email", "connector": "gmail", "connected": False, "connectUrl": "https://x"},
                {"source": "transactions", "connector": "plaid", "connected": True, "connectUrl": None},
            ]
        if name == "grep_activity":
            grep_called_with.update(args[0])
            return {"matches": [], "total_matches": 0}
        return None

    await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={
            "pattern": "x",
            "sources": ["email", "transactions"],
            "filters": {"messages": {"since": "7d"}, "transactions": {"min_amount": 5}},
        },
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert grep_called_with.get("sources") == ["transactions"]
    assert grep_called_with.get("filters") == {"transactions": {"min_amount": 5}}


def test_grep_schema_filter_keys_match_backend_validator():
    """The GrepTool filters description lists exactly the keys the backend validator
    accepts per source (back-end DATA_SOURCE_CONFIGS), so the advertised contract
    and the executor cannot drift apart."""
    import re
    from pathlib import Path

    from utils.tool_schemas import GrepTool

    types_ts = (Path(__file__).resolve().parents[3] / "back-end/src/domains/data/types.ts").read_text()
    configs = types_ts.split("export const DATA_SOURCE_CONFIGS", 1)[1].split("} as const;", 1)[0]
    backend = {
        source: [key.strip().strip("'") for key in keys.replace("\n", " ").split(",") if key.strip()]
        for source, keys in re.findall(r"^  (\w+): \{.*?filters: \[(.*?)\]", configs, re.S | re.M)
    }
    advertised = {}
    for line in GrepTool.model_fields["filters"].description.splitlines():
        match = re.match(r"^  ([\w ,()]+?): (.+)$", line)
        if not match:
            continue
        names = re.findall(r"\w+", match.group(1).replace("and ", ""))
        keys = [key.strip() for key in re.sub(r" \([^)]*\)", "", match.group(2)).split(",")]
        for name in names:
            advertised[name] = keys
    assert set(advertised) == set(backend), (sorted(advertised), sorted(backend))
    for source, keys in backend.items():
        assert sorted(advertised[source]) == sorted(keys), (source, advertised[source], keys)



async def test_execute_grep_partial_gate_drops_keys_only_skipped_sources_accept():
    """After skipping unconnected transactions, a flat key and a top-level shorthand only
    transactions/calendar accepted are dropped; keys the kept source accepts stay."""
    from domains.grep.service import execute_grep

    grep_called_with = {}

    async def mock_execute_activity(activity_fn, *, args, start_to_close_timeout, retry_policy):
        name = getattr(activity_fn, "__name__", "")
        if name == "source_status_activity":
            return [{"source": "transactions", "connector": "plaid", "connected": False, "connectUrl": "https://x"}]
        if name == "grep_activity":
            grep_called_with.update(args[0])
            return {"matches": [], "total_matches": 0}
        return None

    await execute_grep(
        execute_activity=mock_execute_activity,
        tool_call={
            "pattern": "x",
            "sources": ["messages", "transactions"],
            "filters": {"min_amount": 5, "since": "7d"},
            "until": "2026-11-01",
            "person": "Ann",
        },
        tool_call_id="tc-1",
        agent_id="a-1",
        user_id="u-1",
    )
    assert grep_called_with.get("sources") == ["messages"]
    assert grep_called_with.get("filters") == {"since": "7d"}
    assert "until" not in grep_called_with
    assert grep_called_with.get("person") == "Ann"


def test_grep_source_filter_keys_match_backend_validator():
    """agents SOURCE_FILTER_KEYS (used to narrow partially gated calls) equals back-end DATA_SOURCE_CONFIGS."""
    import re
    from pathlib import Path

    from domains.grep.config import SOURCE_FILTER_KEYS

    types_ts = (Path(__file__).resolve().parents[3] / "back-end/src/domains/data/types.ts").read_text()
    configs = types_ts.split("export const DATA_SOURCE_CONFIGS", 1)[1].split("} as const;", 1)[0]
    backend = {
        source: sorted(key.strip().strip("'") for key in keys.split(",") if key.strip())
        for source, keys in re.findall(r"^  (\w+): \{.*?filters: \[(.*?)\]", configs, re.S | re.M)
    }
    assert {source: sorted(keys) for source, keys in SOURCE_FILTER_KEYS.items()} == backend


def test_grep_tool_definition_json_is_generated_from_the_explore_tool():
    """The JSON the SMS supervisor and web chat load is byte-identical to a fresh build
    of the explore agent's native grep tool. Regenerate with
    `python scripts/grep_tool_definition.py --write` after changing the contract."""
    import importlib.util
    from pathlib import Path

    script = Path(__file__).resolve().parents[2] / "scripts" / "grep_tool_definition.py"
    spec = importlib.util.spec_from_file_location("grep_tool_definition", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checked_in = module.DEFINITION_PATH.read_text(encoding="utf-8")
    assert checked_in == module.render_grep_tool_definition(), (
        "back-end/src/providers/grepTool/grepToolDefinition.json drifted from the explore agent's grep tool; "
        "run `python scripts/grep_tool_definition.py --write` from agents/."
    )


def test_grep_native_tool_and_planner_share_the_contract_description():
    """The explore agent's native tool, the planner's tool reference and the generated
    definition all carry the one contract description."""
    import inspect

    from providers.rose.schema import build_anthropic_tools_from_response_model
    from tools.prompts import tool_prompts_for
    from utils.grep_tool_contract import GREP_TOOL_PROMPT
    from utils.tool_schemas import GrepTool, create_agent_action_model

    (native,) = build_anthropic_tools_from_response_model(
        create_agent_action_model(["grep"], tool_registry={"grep": GrepTool})
    )
    assert native["description"] == GREP_TOOL_PROMPT
    assert inspect.cleandoc(GrepTool.__doc__) == GREP_TOOL_PROMPT
    assert tool_prompts_for()["grep"] == GREP_TOOL_PROMPT
    assert tool_prompts_for(rose_desktop=True)["grep"] == GREP_TOOL_PROMPT


def test_grep_filters_are_a_closed_object_with_every_source_block():
    """filters is typed, not an open map, so strict surfaces can send it unchanged:
    each source's block takes exactly that source's keys, flat keys are their union,
    unknown keys are rejected, and unset keys never reach the backend."""
    import pytest
    from pydantic import ValidationError

    from utils.grep_tool_contract import GREP_SOURCE_FILTER_KEYS
    from utils.tool_schemas import GrepFilters, GrepTool

    flat = {key for keys in GREP_SOURCE_FILTER_KEYS.values() for key in keys}
    assert set(GrepFilters.model_fields) == flat | set(GREP_SOURCE_FILTER_KEYS)
    for source, keys in GREP_SOURCE_FILTER_KEYS.items():
        block = GrepFilters.model_fields[source].annotation.__args__[0]
        assert set(block.model_fields) == set(keys), source
    schema = GrepTool.model_json_schema()
    filters_ref = next(b for b in schema["properties"]["filters"]["anyOf"] if "$ref" in b)["$ref"]
    assert schema["$defs"][filters_ref.rsplit("/", 1)[-1]]["additionalProperties"] is False
    call = GrepTool.model_validate(
        {"tool": "grep", "filters": {"since": "7d", "calendar": {"until": "2026-11-02"}, "drive": None}}
    )
    assert call.model_dump()["filters"] == {"since": "7d", "calendar": {"until": "2026-11-02"}}
    with pytest.raises(ValidationError):
        GrepTool.model_validate({"tool": "grep", "filters": {"bogus": 1}})
    with pytest.raises(ValidationError):
        GrepTool.model_validate({"tool": "grep", "filters": {"network": {"since": "7d"}}})


async def test_meeting_notes_gate_and_tool_contract():
    """Generic notes probe one OR gate and preserve provider filters for grep."""
    from domains.grep.service import execute_grep
    from utils.tool_schemas import GrepTool

    description = GrepTool.model_fields["filters"].description
    for key in ("meeting_notes", "granola", "fireflies", "fireflies_transcript"):
        assert key in description, key
    for provider in ("meeting_notes", "Meeting Notes", "meeting-notes", "granola", "fireflies", "fireflies_transcript"):
        for nested in (False, True):
            calls = []
            filters = {"document_source": provider}
            if nested:
                filters = {"documents": filters}

            async def execute(activity_fn, *, args, **kwargs):
                name = getattr(activity_fn, "__name__", "")
                calls.append((name, args))
                if name == "source_status_activity":
                    normalized = provider.lower().replace(" ", "_").replace("-", "_")
                    assert args[1] == [normalized]
                    return [{"source": normalized, "connector": "fireflies", "connected": True, "connectUrl": None}]
                return {"matches": [], "total_matches": 0}

            result = await execute_grep(
                execute, {"source": "documents", "pattern": "budget", "filters": filters,
                          "require_source_access": True}, "tc-meetings", "a-1", "u-1",
            )
            assert result["unavailable_sources"] == []
            searches = [args[0] for name, args in calls if name == "grep_activity"]
            assert len(searches) == 1
            assert searches[0]["filters"] == filters


async def run_all_tests():
    print("grep blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_grep_happy_path)
    await r.record_async("meeting_notes_gate_and_tool_contract", test_meeting_notes_gate_and_tool_contract)
    await r.record_async("boundary", test_grep_boundary)
    await r.record_async("boundary_normalizes_model_dump_keys", test_grep_boundary_normalizes_model_dump_keys)
    await r.record_async("agent_metadata_only", test_grep_agent_metadata_only)
    await r.record_async("fetch_local_data_summary", test_fetch_local_data_summary)
    await r.record_async("empty_pattern", test_grep_empty_pattern)
    await r.record_async("summary_source", test_grep_summary_source_is_answered_by_the_backend_executor)
    await r.record_async("backend_error_not_retried", test_grep_backend_error_is_not_retried_by_the_agent)
    await r.record_async("network_source_forwarded", test_grep_network_source_forwarded)
    r.record("truncate_pattern_short", test_truncate_pattern_short)
    r.record("truncate_pattern_long", test_truncate_pattern_long)
    await r.record_async("execute_grep_happy", test_execute_grep_happy)
    await r.record_async("execute_grep_empty_pattern_path", test_execute_grep_empty_pattern_path)
    await r.record_async("execute_grep_error_reraises", test_execute_grep_error_reraises)
    await r.record_async("manager_execute_tool", test_manager_execute_tool)
    await r.record_async("execute_grep_source_unavailable", test_execute_grep_source_unavailable)
    await r.record_async("execute_grep_partial_connectivity", test_execute_grep_partial_connectivity)
    await r.record_async("execute_grep_documents_provider_gate", test_execute_grep_documents_provider_gate)
    r.record("grep_tool_accepts_calendar_and_drive_listings", test_grep_tool_accepts_calendar_and_drive_listings)
    r.record("printed_google_path_names_its_source", test_printed_google_path_names_its_source)
    await r.record_async(
        "execute_grep_calendar_listing_reaches_backend", test_execute_grep_calendar_listing_reaches_backend
    )
    await r.record_async(
        "execute_grep_drive_unconnected_gates_on_google", test_execute_grep_drive_unconnected_gates_on_google
    )
    r.record("grep_titles_name_the_requested_sources", test_grep_titles_name_the_requested_sources)
    await r.record_async(
        "execute_grep_documents_provider_opportunistic_does_not_gate",
        test_execute_grep_documents_provider_opportunistic_does_not_gate,
    )
    r.record("filters_name_their_sources_like_the_backend", test_filters_name_their_sources_like_the_backend)
    await r.record_async(
        "execute_grep_nested_filter_block_gates_its_source", test_execute_grep_nested_filter_block_gates_its_source
    )
    await r.record_async(
        "execute_grep_nested_documents_provider_gate", test_execute_grep_nested_documents_provider_gate
    )
    await r.record_async(
        "execute_grep_partial_gate_drops_nested_block_of_skipped_source",
        test_execute_grep_partial_gate_drops_nested_block_of_skipped_source,
    )
    r.record("grep_schema_filter_keys_match_backend_validator", test_grep_schema_filter_keys_match_backend_validator)
    r.record("grep_source_filter_keys_match_backend_validator", test_grep_source_filter_keys_match_backend_validator)
    await r.record_async(
        "execute_grep_partial_gate_drops_keys_only_skipped_sources_accept",
        test_execute_grep_partial_gate_drops_keys_only_skipped_sources_accept,
    )
    r.record("tool_definition_json_is_generated", test_grep_tool_definition_json_is_generated_from_the_explore_tool)
    r.record("native_tool_and_planner_share_description", test_grep_native_tool_and_planner_share_the_contract_description)
    r.record("filters_closed_object_every_source_block", test_grep_filters_are_a_closed_object_with_every_source_block)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
