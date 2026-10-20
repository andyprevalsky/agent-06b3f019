"""Blackbox tests for web-search domain."""

import asyncio
import contextlib
import json
import threading
import time
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from _test_utils import (
    BlackboxResult,
    assert_captured_call,
    setup_mock,
    setup_mock_fn,
    teardown_mock,
)


def _setup():
    setup_mock(
        {
            "api.parallel.ai/v1/search": {
                "status": 200,
                "json": {
                    "results": [
                        {
                            "title": "AI Trends 2026",
                            "url": "https://example.com/ai-trends",
                            "excerpts": ["The latest trends in AI..."],
                        },
                        {
                            "title": "Machine Learning Guide",
                            "url": "https://example.com/ml-guide",
                            "excerpts": ["A comprehensive guide to ML..."],
                        },
                    ],
                },
            },
        }
    )


def test_types_contracts_are_importable():
    """Public web-search result contracts stay importable for tool callers."""
    from tools.web_search.types import ExecuteActivityCallable, SearchResult

    assert ExecuteActivityCallable is not None
    assert SearchResult.__annotations__ == {
        "answer": str,
        "sources": list[str],
        "query": str,
        "provider": str,
    }


async def test_web_search_happy_path():
    """web_search_activity returns search results from Parallel AI."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_search import web_search_activity

        result = await web_search_activity(
            query="AI trends 2026",
            max_tokens=1500,
        )

    assert "results" in result or "answer" in result


async def test_web_search_boundary():
    """Verify exact HTTP request sent to Parallel AI search endpoint."""
    _setup()
    with patch("temporalio.activity.heartbeat"):
        from tools.web_search import web_search_activity

        await web_search_activity(
            query="quantum computing breakthroughs",
            max_tokens=2000,
        )

    call = assert_captured_call(
        url_contains="api.parallel.ai/v1/search",
        method="POST",
        header_present="x-api-key",
    )
    body = json.loads(call["requestBody"])
    # Activity sends Parallel V1 Turbo contract (same as chat web_search)
    assert body["mode"] == "turbo"
    assert body["objective"] == "quantum computing breakthroughs"
    assert "quantum computing breakthroughs" in body["search_queries"]
    assert body.get("max_results") is None, "V1 max_results must be nested"
    assert body.get("excerpts") is None, "V1 excerpt settings must be nested"
    assert body["advanced_settings"] == {
        "max_results": 5,
        "excerpt_settings": {"max_chars_per_result": 8000},
    }

    # V1 turbo must not send the beta header
    headers_lower = {k.lower(): v for k, v in call["requestHeaders"].items()}
    assert "parallel-beta" not in headers_lower


async def test_web_search_ddgs_fallback():
    """When Parallel AI raises, execute_search falls back to DuckDuckGo."""
    from unittest.mock import patch

    fallback = [{"title": "DDG Result", "url": "https://ddg.example.com", "excerpts": ["Some body text"]}]
    with (
        patch("temporalio.activity.heartbeat"),
        patch("tools.web_search.service.load_config", return_value=_provider_config(exa_key="")),
        patch("tools.web_search.service.fetch_search_results", side_effect=Exception("parallel offline")),
        patch("tools.web_search.service.fetch_search_results_ddgs", return_value=fallback),
    ):
        from tools.web_search.service import execute_search

        result = await execute_search("test query")

    assert result["provider"] == "ddgs"
    assert "DDG Result" in result["answer"]
    assert "https://ddg.example.com" in result["sources"]


async def test_web_search_ddgs_no_api_key():
    """When no API key is configured, goes directly to DuckDuckGo."""
    from unittest.mock import patch

    with patch("temporalio.activity.heartbeat"), patch("tools.web_search.service.load_config") as mock_cfg:
        mock_cfg.return_value.parallel.api_key = ""
        mock_cfg.return_value.exa.api_key = ""
        with patch(
            "tools.web_search.service.fetch_search_results_ddgs",
            return_value=[
                {"title": "DDG No Key", "url": "https://ddg.example.com", "excerpts": ["content"]},
            ],
        ) as mock_ddgs:
            from tools.web_search.service import execute_search

            result = await execute_search("no key query")
            mock_ddgs.assert_called_once_with("no key query")

    assert result["provider"] == "ddgs"


# -------------------- handler.py tests --------------------


def _mock_execute(calls: list, *, result: dict | None = None, raises: bool = False):
    async def mock(activity_fn, *args, **kwargs):
        name = getattr(activity_fn, "__name__", "")
        calls.append({"activity": name, "args": args, "kwargs": kwargs})
        if name == "web_search_activity":
            if raises:
                raise RuntimeError("parallel offline")
            return result or {"results": [], "answer": "", "query": "x"}
        return None

    return mock


async def test_manager_passes_cache_write_agent_without_changing_world_model_args():
    """Real agents keep world-model args empty but always pass the cache-write agent id."""
    from tools.web_search.handler import WebSearchManager

    for mode, expected in (("real", [None, None, "agent-1"]), ("simulate", ["agent-1", "simulate", "agent-1"])):
        calls = []
        await WebSearchManager().execute_tool(
            execute_activity=_mock_execute(calls),
            tool_call={"query": "AI trends", "max_tokens": 1000},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
            world_model_mode=mode,
        )
        search = next(c for c in calls if c["activity"] == "web_search_activity")
        assert search["kwargs"]["args"][-3:] == expected, mode


async def test_manager_execute_tool_happy():
    """WebSearchManager.execute_tool returns result + usage with per-query cost."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(calls, result={"results": [{"title": "r"}], "answer": "a", "query": "q"}),
        tool_call={"query": "AI trends", "max_tokens": 1000},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert out["result"]["answer"] == "a"
    assert out["usage"]["service"][0]["provider"] == "Parallel AI Search"
    posted = [c for c in calls if c["activity"] == "post_agent_message"]
    assert posted
    first_metadata = posted[0]["kwargs"]["args"][3]
    assert first_metadata["title"] == "Searching the web for AI trends"


async def test_manager_execute_tool_fast_cache_hit_has_no_service_cost():
    """Fast Mode cache hits should not be billed as live Parallel searches."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, WebSearchManager

    calls = []
    manager = WebSearchManager()
    out = await manager.execute_tool(
        execute_activity=_mock_execute(
            calls,
            result={
                "results": [{"title": "cached"}],
                "answer": "cached answer",
                "query": "q",
                FAST_CACHE_HIT_FIELD: True,
            },
        ),
        tool_call={"query": "AI trends", "max_tokens": 1000},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )

    assert out["result"]["answer"] == "cached answer"
    assert FAST_CACHE_HIT_FIELD not in out["result"]
    assert out["usage"]["service"] == []

    finished = [c for c in calls if c["activity"] == "post_agent_message"][-1]
    assert "**Cost:** $0.0000" in finished["kwargs"]["args"][1]
    assert FAST_CACHE_HIT_FIELD not in finished["kwargs"]["args"][1]


async def test_web_search_activity_fast_cache_hit_marks_cached_result():
    """Activity returns a cache-hit marker so the manager can skip service billing."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, web_search_activity

    cached = {"results": [{"title": "cached"}], "answer": "cached answer", "query": "q"}
    with (
        patch("tools.web_search.handler.fast_cache_client.cache_get", new=AsyncMock(return_value=cached)),
        patch("tools.web_search.handler.execute_search", new=AsyncMock(side_effect=AssertionError("live call"))),
    ):
        result = await web_search_activity(
            query="AI trends",
            max_tokens=1000,
            fast_mode_cache_enabled=True,
            fast_mode_goal="goal",
        )

    assert result["answer"] == "cached answer"
    assert result[FAST_CACHE_HIT_FIELD] is True


async def test_web_search_activity_ignores_unavailable_fast_cache_when_fallback_enabled():
    """Benchmark fallback mode treats unavailable WMH observations as cache misses."""
    from tools.web_search.handler import FAST_CACHE_HIT_FIELD, web_search_activity

    cached = {
        "answer": '{"result_unavailable": true}',
        "metadata": {"result_unavailable": True},
    }
    live = {"results": [{"title": "live"}], "answer": "live answer", "query": "q"}

    with (
        patch.dict(
            "os.environ",
            {
                "BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE": "1",
                "BENCHMARK_WORLD_MODEL_MODE": "",
            },
            clear=False,
        ),
        patch("tools.web_search.handler.fast_cache_client.cache_get", new=AsyncMock(return_value=cached)),
        patch("tools.web_search.handler.fast_cache_client.cache_set", new=AsyncMock(return_value=True)) as set_cache,
        patch("tools.web_search.handler.execute_search", new=AsyncMock(return_value=live)) as execute_search,
    ):
        result = await web_search_activity(
            query="AI trends",
            max_tokens=1000,
            fast_mode_cache_enabled=True,
            fast_mode_goal="goal",
        )

    execute_search.assert_awaited_once_with(query="AI trends", max_tokens=1000)
    assert result == live
    assert FAST_CACHE_HIT_FIELD not in result
    assert set_cache.await_count == 1


async def test_manager_execute_tool_raises_on_error():
    """WebSearchManager re-raises on activity exception."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    try:
        await manager.execute_tool(
            execute_activity=_mock_execute(calls, raises=True),
            tool_call={"query": "q"},
            tool_call_id="tc-1",
            agent_id="agent-1",
            user_id="user-1",
        )
        raise AssertionError("Expected RuntimeError")
    except RuntimeError as e:
        assert "parallel offline" in str(e)


async def test_manager_execute_tool_long_query_truncates():
    """Long query is truncated for display only; activity gets full value."""
    from tools.web_search.handler import WebSearchManager

    calls = []
    manager = WebSearchManager()
    long_query = "q" * 500
    await manager.execute_tool(
        execute_activity=_mock_execute(calls),
        tool_call={"query": long_query},
        tool_call_id="tc-1",
        agent_id="agent-1",
    )
    read = [c for c in calls if c["activity"] == "web_search_activity"]
    assert len(read) == 1


async def test_web_search_entry_point():
    """web_search() entry point dispatches to manager."""
    from tools.web_search.handler import web_search

    calls = []
    out = await web_search(
        execute_activity=_mock_execute(calls),
        tool_call={"query": "q"},
        tool_call_id="tc-1",
        agent_id="agent-1",
        user_id="user-1",
    )
    assert "result" in out


# -------------------- provider rate limits / outages --------------------
#
# run600c (2026-10-18, 600 concurrent REAL copies): the shared Parallel key
# returned HTTP 429, the keyless DDGS fallback's engines (Brave, Google, ...)
# answered 429/403 from the shared egress, and DDGS raised its generic
# "No results found." The model received "Error: No results found." and
# concluded the web had nothing, then finished without browsing.

PARALLEL_URL = "api.parallel.ai/v1/search"
EXA_URL = "api.exa.ai/search"
QUERY = "Spotify Premium New Zealand student price"


def _provider_config(*, parallel_key: str = "test-parallel-key", exa_key: str = "") -> MagicMock:
    cfg = MagicMock()
    cfg.parallel.api_key = parallel_key
    cfg.exa.api_key = exa_key
    return cfg


def _provider_responses(routes: dict[str, list[httpx.Response]], calls: dict[str, list[dict]]):
    """Serve a per-provider response sequence (the last response repeats)."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for pattern, responses in routes.items():
            if pattern in url:
                seen = calls.setdefault(pattern, [])
                seen.append({"at": time.monotonic(), "body": json.loads(request.content or b"{}")})
                return responses[min(len(seen), len(responses)) - 1]
        return httpx.Response(404, json={"error": f"unexpected url {url}"})

    return handler


def _rate_limited(retry_after: str | None = "1") -> httpx.Response:
    headers = {"retry-after": retry_after} if retry_after is not None else {}
    return httpx.Response(429, headers=headers, json={"error": {"message": "Too Many Requests"}})


class _EngineResponse:
    """What ddgs' primp client returns when a scraped engine refuses the request."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.text = "<html><body><h1>Too Many Requests</h1></body></html>"
        self.content = self.text.encode()


@contextmanager
def _ddgs_engines_answer(status_code: int, record: dict):
    """Run the real ddgs metasearch while every scraped engine answers ``status_code``."""
    import ddgs

    original_text = ddgs.DDGS.text

    def counted_text(self, *args, **kwargs):
        record["text_calls"] = record.get("text_calls", 0) + 1
        record.setdefault("threads", []).append(threading.get_ident())
        return original_text(self, *args, **kwargs)

    def engine_request(self, method, url, *args, **kwargs):
        record.setdefault("engine_urls", []).append(url)
        return _EngineResponse(status_code)

    with patch("ddgs.http_client.HttpClient.request", engine_request), patch.object(ddgs.DDGS, "text", counted_text):
        yield


async def _run_tool_through_explore_shim(cfg: MagicMock) -> tuple[Exception | None, dict | None, list[dict]]:
    """Execute the tool exactly as explore agents do: manager -> in-activity retry shim."""
    from loop.activity_helper import call_temporal_activity_from_activity
    from tools.web_search.handler import WebSearchManager

    posted: list[dict] = []

    async def execute_activity(fn, *, args, start_to_close_timeout, retry_policy):
        if getattr(fn, "__name__", "") == "web_search_activity":
            return await call_temporal_activity_from_activity(
                fn, args=args, start_to_close_timeout=start_to_close_timeout, retry_policy=retry_policy
            )
        posted.append({"activity": getattr(fn, "__name__", ""), "args": args})
        return None

    error = None
    out = None
    with patch("temporalio.activity.heartbeat"), patch("tools.web_search.service.load_config", return_value=cfg):
        try:
            out = await WebSearchManager().execute_tool(
                execute_activity=execute_activity,
                tool_call={"query": QUERY},
                tool_call_id="tc-rate-limit",
                agent_id="agent-rate-limit",
                user_id="user-1",
            )
        except Exception as exc:  # the manager re-raises the tool failure
            error = exc
    return error, out, posted


def _application_error(error: BaseException | None):
    from temporalio.exceptions import ApplicationError

    current = error
    while current is not None:
        if isinstance(current, ApplicationError):
            return current
        current = current.__cause__
    return None


async def test_rate_limited_providers_are_not_reported_as_no_results():
    """A 429 primary plus blocked keyless engines is a typed outage, never "No results found."."""
    from utils.error_utils import extract_error_message

    calls: dict[str, list[dict]] = {}
    ddgs_record: dict = {}
    setup_mock_fn(_provider_responses({PARALLEL_URL: [_rate_limited("1")]}, calls))
    try:
        with _ddgs_engines_answer(429, ddgs_record):
            error, _out, posted = await _run_tool_through_explore_shim(_provider_config())
    finally:
        teardown_mock()

    assert error is not None, "a search no provider answered must fail the tool call"
    model_text = f"Error: {error}"  # exactly what run_agent appends to the model context
    assert "No results found" not in model_text, model_text
    assert "rate-limited" in model_text and "HTTP 429" in model_text, model_text
    assert "No results found" not in extract_error_message(error)

    app_error = _application_error(error)
    assert app_error is not None, f"expected a typed ApplicationError, got {type(error).__name__}"
    assert app_error.type == "WebSearchProviderUnavailable"
    assert app_error.non_retryable, "bounded in-call retries already ran; outer retries would multiply load"
    detail = app_error.details[0]
    assert detail["status"] == "search_provider_rate_limited", detail
    parallel = next(p for p in detail["providers"] if p["provider"] == "parallel-ai")
    assert parallel["kind"] == "rate_limited" and parallel["http_status"] == 429, parallel
    assert parallel["attempts"] == 3 and parallel["retry_after_seconds"] == 1.0, parallel
    ddgs_outcome = next(p for p in detail["providers"] if p["provider"] == "ddgs")
    assert ddgs_outcome["kind"] == "no_results", ddgs_outcome

    # Bounded and spaced: three Parallel requests total (no shim x service
    # amplification), each retry at least Retry-After after the previous one.
    stamps = [c["at"] for c in calls[PARALLEL_URL]]
    assert len(stamps) == 3, len(stamps)
    gaps = [b - a for a, b in zip(stamps, stamps[1:], strict=False)]
    assert all(gap >= 1.0 for gap in gaps), gaps
    # The keyless scraper fan-out runs once per tool call, off the event loop.
    assert ddgs_record.get("text_calls") == 1, ddgs_record.get("text_calls")
    assert ddgs_record.get("engine_urls"), "real ddgs engines must have been exercised"
    assert threading.get_ident() not in ddgs_record["threads"], "ddgs blocked the worker event loop"

    error_chip = [p for p in posted if p["activity"] == "post_agent_message"][-1]
    assert "rate-limited" in error_chip["args"][1], error_chip["args"][1]


async def test_parallel_rate_limit_recovers_after_retry_after():
    """A transient 429 is retried after Retry-After and the provider's real result is returned."""
    calls: dict[str, list[dict]] = {}
    ok = httpx.Response(
        200, json={"results": [{"title": "Spotify NZ", "url": "https://spotify.com/nz", "excerpts": ["$13.99"]}]}
    )
    setup_mock_fn(_provider_responses({PARALLEL_URL: [_rate_limited("1"), ok]}, calls))
    ddgs_record: dict = {}
    try:
        with _ddgs_engines_answer(429, ddgs_record):
            error, out, _posted = await _run_tool_through_explore_shim(_provider_config())
    finally:
        teardown_mock()

    assert error is None, error
    assert out["result"]["provider"] == "parallel-ai"
    assert "Spotify NZ" in out["result"]["answer"]
    stamps = [c["at"] for c in calls[PARALLEL_URL]]
    assert len(stamps) == 2 and stamps[1] - stamps[0] >= 1.0, stamps
    assert not ddgs_record.get("text_calls"), "a recovered primary must not scrape keyless engines"
    assert out["usage"]["service"] == [{"cost_cents": 0.1, "provider": "Parallel AI Search"}]


async def test_rate_limited_parallel_fails_over_to_configured_exa():
    """With Parallel rate-limited, the configured Exa key answers before any keyless scrape."""
    calls: dict[str, list[dict]] = {}
    exa_ok = httpx.Response(
        200,
        json={
            "results": [
                {"title": "Premium NZ", "url": "https://spotify.com/nz-en/premium", "highlights": ["Student $7.99"]}
            ]
        },
    )
    setup_mock_fn(_provider_responses({PARALLEL_URL: [_rate_limited("5")], EXA_URL: [exa_ok]}, calls))
    ddgs_record: dict = {}
    try:
        with _ddgs_engines_answer(429, ddgs_record):
            error, out, _posted = await _run_tool_through_explore_shim(_provider_config(exa_key="test-exa-key"))
    finally:
        teardown_mock()

    assert error is None, error
    assert out["result"]["provider"] == "exa"
    assert "Student $7.99" in out["result"]["answer"]
    assert out["result"]["sources"] == ["https://spotify.com/nz-en/premium"]
    assert len(calls[PARALLEL_URL]) == 1 and len(calls[EXA_URL]) == 1
    exa_body = calls[EXA_URL][0]["body"]
    assert exa_body["query"] == QUERY
    assert exa_body["numResults"] == 5 and exa_body["contents"] == {"highlights": True}
    assert "category" not in exa_body, "general web search must not use the people category"
    assert not ddgs_record.get("text_calls")
    assert out["usage"]["service"] == [{"cost_cents": 0.7, "provider": "Exa Search"}]


async def test_auth_rejection_is_not_retried_and_keyless_fallback_is_unbilled():
    """A 401 is permanent for this call: one request, then the keyless fallback, billed at $0."""
    calls: dict[str, list[dict]] = {}
    rejected = httpx.Response(401, json={"error": "invalid api key"})
    setup_mock_fn(_provider_responses({PARALLEL_URL: [rejected]}, calls))
    fallback = [{"title": "DDG", "url": "https://ddg.example.com", "excerpts": ["body"]}]
    try:
        with patch("tools.web_search.service.fetch_search_results_ddgs", return_value=fallback):
            error, out, _posted = await _run_tool_through_explore_shim(_provider_config())
    finally:
        teardown_mock()

    assert error is None, error
    assert out["result"]["provider"] == "ddgs"
    assert len(calls[PARALLEL_URL]) == 1
    assert out["usage"]["service"] == []


async def test_retry_after_beyond_call_budget_fails_over_without_waiting():
    """A Retry-After longer than the bounded budget is honored by not retrying, not by sleeping."""
    calls: dict[str, list[dict]] = {}
    setup_mock_fn(_provider_responses({PARALLEL_URL: [_rate_limited("120")]}, calls))
    ddgs_record: dict = {}
    started = time.monotonic()
    try:
        with _ddgs_engines_answer(429, ddgs_record):
            error, _out, _posted = await _run_tool_through_explore_shim(_provider_config())
    finally:
        teardown_mock()
    elapsed = time.monotonic() - started

    app_error = _application_error(error)
    assert app_error is not None and app_error.type == "WebSearchProviderUnavailable", error
    parallel = next(p for p in app_error.details[0]["providers"] if p["provider"] == "parallel-ai")
    assert parallel["attempts"] == 1 and parallel["retry_after_seconds"] == 120.0, parallel
    assert len(calls[PARALLEL_URL]) == 1
    assert elapsed < 30, elapsed


async def test_server_error_is_retried_as_transient():
    """HTTP 5xx is transient: retried with jittered backoff, then the real result is used."""
    calls: dict[str, list[dict]] = {}
    ok = httpx.Response(200, json={"results": [{"title": "Back", "url": "https://x.example", "excerpts": ["up"]}]})
    setup_mock_fn(_provider_responses({PARALLEL_URL: [httpx.Response(503, json={}), ok]}, calls))
    try:
        error, out, _posted = await _run_tool_through_explore_shim(_provider_config())
    finally:
        teardown_mock()

    assert error is None, error
    assert out["result"]["provider"] == "parallel-ai"
    assert len(calls[PARALLEL_URL]) == 2


# -------------------- one end-to-end deadline inside the activity timeout --------------------
#
# CodeRabbit 4310481662: HTTP_TIMEOUT and ACTIVITY_TIMEOUT_SECONDS were both 60
# seconds, so one slow authenticated request could consume the whole activity
# attempt before the retry or DDGS fallback ran. The service now carries one
# deadline below the activity timeout and gives each call only what remains.
# These cases scale every budget by 1/100 (a controlled clock) instead of
# sleeping through real 60-second windows.

_SCALE = 0.01


@contextmanager
def _scaled_search_budgets():
    """Scale the activity, search, fallback-reserve, retry and HTTP budgets by 1/100."""
    from tools.web_search import config

    scaled = {
        "SEARCH_DEADLINE_SECONDS": 55.0 * _SCALE,
        "DDGS_FALLBACK_RESERVE_SECONDS": 15.0 * _SCALE,
        "PROVIDER_RETRY_BUDGET_SECONDS": config.PROVIDER_RETRY_BUDGET_SECONDS * _SCALE,
        "HTTP_TIMEOUT": config.HTTP_TIMEOUT * _SCALE,
    }
    with contextlib.ExitStack() as stack:
        for name, value in scaled.items():
            # create=True keeps the fail-before revision (no deadline constants) runnable.
            stack.enter_context(patch(f"tools.web_search.service.{name}", value, create=True))
        yield config.ACTIVITY_TIMEOUT_SECONDS * _SCALE


def _hanging_provider(seen: list[dict]):
    """An authenticated provider that never answers within any search budget."""

    async def fetch(**kwargs):
        seen.append({"at": time.monotonic(), "timeout": kwargs.get("timeout")})
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    return fetch


def test_search_deadline_fits_inside_the_activity_timeout():
    """The end-to-end deadline, fallback reserve and retry budget fit strictly inside the activity."""
    from tools.web_search.config import (
        ACTIVITY_TIMEOUT_SECONDS,
        DDGS_FALLBACK_RESERVE_SECONDS,
        PROVIDER_RETRY_BUDGET_SECONDS,
        SEARCH_DEADLINE_SECONDS,
    )

    assert 0 < SEARCH_DEADLINE_SECONDS < ACTIVITY_TIMEOUT_SECONDS
    assert 0 < DDGS_FALLBACK_RESERVE_SECONDS < SEARCH_DEADLINE_SECONDS
    assert PROVIDER_RETRY_BUDGET_SECONDS < SEARCH_DEADLINE_SECONDS - DDGS_FALLBACK_RESERVE_SECONDS


async def test_hanging_provider_leaves_the_fallback_its_time_inside_the_activity_deadline():
    """A provider that never answers is cut off at its deadline; DDGS still answers in the attempt."""
    from tools.web_search.service import execute_search

    seen: list[dict] = []
    fallback = [{"title": "DDG", "url": "https://ddg.example.com", "excerpts": ["body"]}]
    with (
        _scaled_search_budgets() as activity_timeout,
        patch("temporalio.activity.heartbeat"),
        patch("tools.web_search.service.load_config", return_value=_provider_config()),
        patch("tools.web_search.service.fetch_search_results", _hanging_provider(seen)),
        patch("tools.web_search.service.fetch_search_results_ddgs", return_value=fallback) as ddgs_fetch,
    ):
        started = time.monotonic()
        try:
            async with asyncio.timeout(activity_timeout):  # Temporal's start-to-close timeout
                result = await execute_search(QUERY)
        except TimeoutError:
            raise AssertionError("the hung provider consumed the activity deadline before the fallback") from None
        elapsed = time.monotonic() - started

    assert result["provider"] == "ddgs" and result["sources"] == ["https://ddg.example.com"], result
    ddgs_fetch.assert_called_once_with(QUERY)
    assert elapsed < 55.0 * _SCALE, elapsed
    assert len(seen) == 1, "no retry is scheduled past the authenticated deadline"
    # The provider receives only the time left before its deadline, never the full HTTP_TIMEOUT.
    assert 0 < seen[0]["timeout"] <= (55.0 - 15.0) * _SCALE, seen


async def test_hanging_provider_and_fallback_raise_the_typed_outage_before_the_activity_deadline():
    """When every provider runs out of time the typed, truthful outage is still returned in the attempt."""
    from tools.web_search.service import execute_search

    seen: list[dict] = []
    fallback_released = threading.Event()

    def slow_ddgs(query):
        fallback_released.wait(5.0)
        return []

    try:
        with (
            _scaled_search_budgets() as activity_timeout,
            patch("temporalio.activity.heartbeat"),
            patch("tools.web_search.service.load_config", return_value=_provider_config()),
            patch("tools.web_search.service.fetch_search_results", _hanging_provider(seen)),
            patch("tools.web_search.service.fetch_search_results_ddgs", side_effect=slow_ddgs),
        ):
            error = None
            try:
                async with asyncio.timeout(activity_timeout):
                    await execute_search(QUERY)
            except TimeoutError:
                raise AssertionError("the search outlived the activity deadline") from None
            except Exception as exc:
                error = exc
    finally:
        fallback_released.set()  # release the abandoned fallback thread

    app_error = _application_error(error)
    assert app_error is not None and app_error.type == "WebSearchProviderUnavailable", error
    assert app_error.non_retryable
    detail = app_error.details[0]
    assert detail["status"] == "search_provider_unavailable", detail
    kinds = {p["provider"]: p["kind"] for p in detail["providers"]}
    assert kinds == {"parallel-ai": "timeout", "ddgs": "timeout"}, kinds
    assert len(seen) == 1, seen


async def run_all_tests():
    print("web-search blackbox tests:")
    r = BlackboxResult()
    r.record("types_contracts", test_types_contracts_are_importable)
    await r.record_async("happy_path", test_web_search_happy_path)
    await r.record_async("boundary", test_web_search_boundary)
    await r.record_async("ddgs_fallback", test_web_search_ddgs_fallback)
    await r.record_async("ddgs_no_api_key", test_web_search_ddgs_no_api_key)
    await r.record_async(
        "manager_passes_cache_write_agent",
        test_manager_passes_cache_write_agent_without_changing_world_model_args,
    )
    await r.record_async("manager_execute_tool_happy", test_manager_execute_tool_happy)
    await r.record_async("manager_fast_cache_no_cost", test_manager_execute_tool_fast_cache_hit_has_no_service_cost)
    await r.record_async(
        "activity_fast_cache_marks_result", test_web_search_activity_fast_cache_hit_marks_cached_result
    )
    await r.record_async(
        "activity_fast_cache_ignores_unavailable",
        test_web_search_activity_ignores_unavailable_fast_cache_when_fallback_enabled,
    )
    await r.record_async("manager_execute_tool_raises", test_manager_execute_tool_raises_on_error)
    await r.record_async("manager_long_query_truncates", test_manager_execute_tool_long_query_truncates)
    await r.record_async("web_search_entry_point", test_web_search_entry_point)
    await r.record_async(
        "rate_limited_providers_not_no_results", test_rate_limited_providers_are_not_reported_as_no_results
    )
    await r.record_async("parallel_429_recovers_after_retry_after", test_parallel_rate_limit_recovers_after_retry_after)
    await r.record_async(
        "rate_limited_parallel_fails_over_to_exa", test_rate_limited_parallel_fails_over_to_configured_exa
    )
    await r.record_async(
        "auth_rejection_not_retried_fallback_unbilled",
        test_auth_rejection_is_not_retried_and_keyless_fallback_is_unbilled,
    )
    await r.record_async(
        "retry_after_beyond_budget_fails_over", test_retry_after_beyond_call_budget_fails_over_without_waiting
    )
    await r.record_async("server_error_retried_as_transient", test_server_error_is_retried_as_transient)
    r.record("search_deadline_fits_activity_timeout", test_search_deadline_fits_inside_the_activity_timeout)
    await r.record_async(
        "hanging_provider_leaves_fallback_time",
        test_hanging_provider_leaves_the_fallback_its_time_inside_the_activity_deadline,
    )
    await r.record_async(
        "hanging_provider_and_fallback_typed_outage",
        test_hanging_provider_and_fallback_raise_the_typed_outage_before_the_activity_deadline,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
