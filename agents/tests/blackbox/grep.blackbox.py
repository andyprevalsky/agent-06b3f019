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
    """fetch_local_data_summary returns formatted summary string."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import fetch_local_data_summary, _data_summary_cache

        # Clear cache to force fresh fetch
        _data_summary_cache.clear()

        result = await fetch_local_data_summary("user-42")

    assert "5 threads" in result
    assert "120" in result
    assert "Alice" in result
    assert "Latest exact text" in result
    assert "2026-04-01T12:34:56Z" in result


async def test_local_data_summary_lists_calendar_and_drive_as_their_own_sources():
    """A connected Google account shows up as calendar/ and drive/, even with nothing else stored."""
    setup_mock({
        "/api/data/summary": {
            "status": 200,
            "json": {
                "sources": {
                    "messages": {"total_threads": 0, "total_messages": 0, "channels": {}, "threads": []},
                    "calendar": {"accounts": ["a@example.com"], "total_events": 1605},
                    "drive": {"accounts": ["a@example.com", "b@example.com"], "total_files": 0},
                }
            },
        },
    })
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import _data_summary_cache, fetch_local_data_summary

        _data_summary_cache.clear()
        result = await fetch_local_data_summary("user-google-only")
        _data_summary_cache.clear()

    assert result != "No local data available."
    lines = result.splitlines()
    calendar = next(index for index, line in enumerate(lines) if line.startswith("calendar/"))
    assert "1,605 events" in lines[calendar]
    assert lines[calendar + 1] == "  Accounts: a@example.com"
    assert lines[calendar + 2] == '  Search with grep source="calendar".'
    drive = next(index for index, line in enumerate(lines) if line.startswith("drive/"))
    # Nothing stored yet is not the same as an empty Drive: the first search fills it.
    assert "0 files" not in lines[drive]
    assert lines[drive + 1] == "  Accounts: a@example.com, b@example.com"
    assert lines[drive + 2] == '  Search with grep source="drive".'


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


async def test_grep_summary_source_returns_compact_inventory():
    """summary is a local grep source for aggregate counts and top threads."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.grep import _data_summary_cache, grep_activity

        _data_summary_cache.clear()
        result = await grep_activity(
            {"pattern": "message totals", "sources": ["summary"], "source": "summary"},
            user_id="user-42",
        )

    assert result["total_matches"] == 1
    assert result["sources"] == ["summary"]
    assert "120" in result["message"]
    assert "Alice" in result["message"]


async def test_grep_invalid_regex_retries_as_literal():
    """A phone-like literal beginning with '+' must not fail the grep tool."""
    from unittest.mock import AsyncMock, MagicMock

    from tools.grep import grep_activity

    invalid_response = MagicMock()
    invalid_response.status_code = 400
    invalid_response.json.return_value = {
        "error": "Invalid regular expression '+15551234567': Nothing to repeat"
    }
    success_response = MagicMock()
    success_response.status_code = 200
    success_response.json.return_value = {
        "matches": [{"content": "+15551234567"}],
        "total_matches": 1,
        "truncated": False,
    }
    client = SimpleNamespace(post=AsyncMock(side_effect=[invalid_response, success_response]))

    with (
        patch("temporalio.activity.heartbeat"),
        patch("domains.grep.repo.get_http_client", return_value=client),
    ):
        result = await grep_activity(
            {"pattern": "+15551234567", "source": "network"},
            user_id="user-42",
        )

    assert client.post.await_count == 2
    first_payload = client.post.await_args_list[0].kwargs["json"]
    second_payload = client.post.await_args_list[1].kwargs["json"]
    assert first_payload["pattern"] == "+15551234567"
    assert second_payload["pattern"] == r"\+15551234567"
    assert result["literal_fallback"] is True
    assert result["original_pattern"] == "+15551234567"
    assert result["effective_pattern"] == r"\+15551234567"
    assert result["total_matches"] == 1


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
            "filters": {"documents": {"document_source": "Apple Notes"}},
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


async def run_all_tests():
    print("grep blackbox tests:")
    r = BlackboxResult()
    await r.record_async("happy_path", test_grep_happy_path)
    await r.record_async("boundary", test_grep_boundary)
    await r.record_async("boundary_normalizes_model_dump_keys", test_grep_boundary_normalizes_model_dump_keys)
    await r.record_async("agent_metadata_only", test_grep_agent_metadata_only)
    await r.record_async("fetch_local_data_summary", test_fetch_local_data_summary)
    await r.record_async(
        "local_data_summary_lists_calendar_and_drive_as_their_own_sources",
        test_local_data_summary_lists_calendar_and_drive_as_their_own_sources,
    )
    await r.record_async("empty_pattern", test_grep_empty_pattern)
    await r.record_async("summary_source", test_grep_summary_source_returns_compact_inventory)
    await r.record_async("invalid_regex_literal_fallback", test_grep_invalid_regex_retries_as_literal)
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
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
