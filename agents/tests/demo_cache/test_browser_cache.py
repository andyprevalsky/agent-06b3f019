"""Fast Mode — browser HTTPS + browser-use decision cache tests.

Proves the user's headline worry: the live browser session runs, but its network
RESPONSES and its LLM DECISIONS replay from cache.

  - #5/#7  record path stores responses/decisions
  - #11     replay path serves without re-fetching
  - #15     URL normalization makes browser_http keys bust-proof
  - #17/#18 only cacheable resource types are cached; POST is body-partitioned
  - #8      non-2xx responses are not cached
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any, Dict

import pytest

from providers.demo_cache import browser_http, browser_use_cache
from providers.demo_cache import normalize
from domains.spawn_browser_agent_v3.handler import (
    _attach_browser_replay_target,
    _install_fast_mode_network_cache,
    _remap_cached_browser_action_target,
)
import json
from pathlib import Path


def _soft_complete_bench_goal() -> str:
    tasks = json.loads(
        (Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json").read_text(
            encoding="utf-8"
        )
    )
    return next(t["prompt"] for t in tasks if t["name"] == "test-mass-agent-run-0")


class MemStore:
    def __init__(self):
        self.data: Dict[str, Any] = {}
        self.set_calls = 0
        self.get_calls = 0

    async def get(self, key: str):
        self.get_calls += 1
        return self.data.get(key)

    async def set(
        self, key: str, kind: str, goal_hash: str, value: Any, *, goal: str | None = None, root_goal: str | None = None
    ) -> bool:
        self.set_calls += 1
        self.data[key] = normalize.strip_secrets(value)
        return True


class FakeElement:
    def __init__(self, *, tag_name: str = "button", text: str = "", attrs: Dict[str, Any] | None = None):
        self.tag_name = tag_name
        self.node_name = tag_name
        self.text_content = text
        self.attributes = attrs or {}

    def get_all_children_text(self) -> str:
        return self.text_content


class FakeDom:
    def __init__(self, selector_map: Dict[int, FakeElement]):
        self.selector_map = selector_map


@pytest.fixture
def mem(monkeypatch):
    store = MemStore()
    monkeypatch.setattr(browser_http.cache_client, "cache_get", store.get)
    monkeypatch.setattr(browser_http.cache_client, "cache_set", store.set)
    monkeypatch.setattr(browser_use_cache.cache_client, "cache_get", store.get)
    monkeypatch.setattr(browser_use_cache.cache_client, "cache_set", store.set)
    return store


# ---------------------------------------------------------------------------
# Browser HTTP
# ---------------------------------------------------------------------------


def test_should_cache_only_get_cacheable_types():
    # #17/#18 page-resource types only; POST is allowed for XHR/fetch with body keying.
    assert browser_http.should_cache("GET", "document", "https://example.com/") is True
    assert browser_http.should_cache("get", "xhr", "https://example.com/api") is True
    assert browser_http.should_cache("POST", "xhr", "https://example.com/api") is True
    assert browser_http.should_cache("POST", "document", "https://example.com/") is False
    assert browser_http.should_cache("GET", "websocket", "wss://example.com/ws") is False
    assert browser_http.should_cache("GET", "media", "https://example.com/video.mp4") is False
    # Payment CDNs must never enter Fast Mode HTTP cache (Eventim Stripe Elements).
    assert browser_http.should_cache("GET", "script", "https://js.stripe.com/v3/") is False
    assert browser_http.should_cache("GET", "fetch", "https://api.stripe.com/healthcheck") is False
    assert browser_http.should_cache("POST", "xhr", "https://r.stripe.com/b") is False
    assert browser_http.is_payment_cdn_url("https://merchant-ui-api.stripe.com/link/get-cookie") is True


def test_browser_http_never_records_payment_cdn(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("checkout", read_enabled=False, write_enabled=True)
        wrote = await cache.record(
            "GET",
            "https://js.stripe.com/v3/",
            "script",
            200,
            {"content-type": "application/javascript"},
            b"stripe",
        )
        assert wrote is False
        assert mem.set_calls == 0
        assert await cache.lookup("GET", "https://js.stripe.com/v3/", "script") is None

    asyncio.run(body())


def test_browser_http_record_then_replay(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("load page")
        html = b"<html>cached</html>"
        # record
        wrote = await cache.record(
            "GET", "https://site.com/p?cb=1", "document", 200,
            {"content-type": "text/html", "set-cookie": "s=secret"}, html,
        )
        assert wrote is True
        # replay (cache-buster differs → still hits via normalization, #15)
        hit = await cache.lookup("GET", "https://site.com/p?cb=999", "document")
        assert hit is not None
        assert hit["body"] == html
        assert hit["status"] == 200
        # #26 secret header stripped from stored value
        assert "set-cookie" not in {k.lower() for k in hit["headers"]}

    asyncio.run(body())


def test_browser_http_hit_response_is_not_recorded_again(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("load page")
        assert await cache.record("GET", "https://site.com/p", "document", 200, {}, b"live") is True
        assert mem.set_calls == 1
        hit = await cache.lookup("GET", "https://site.com/p", "document")
        assert hit is not None
        assert await cache.record("GET", "https://site.com/p", "document", 200, {}, b"live") is False
        assert mem.set_calls == 1

    asyncio.run(body())


def test_browser_http_write_only_records_without_read(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("load page", read_enabled=False, write_enabled=True)
        html = b"<html>live</html>"
        assert await cache.lookup("GET", "https://site.com/p", "document") is None
        assert mem.get_calls == 0

        wrote = await cache.record(
            "GET", "https://site.com/p", "document", 200, {"content-type": "text/html"}, html
        )
        assert wrote is True
        assert mem.get_calls == 0
        assert mem.set_calls == 1
        assert len(mem.data) == 1

    asyncio.run(body())


def test_write_through_install_does_not_route_all_requests(mem):
    """Write-through must record without Playwright route interception.

    Routing ``**/*`` (even with continue_) breaks Eventim Stripe Elements while
    js.stripe.com still returns 200 — empty Billing Address / Payment Details.
    """

    class FakeContext:
        def __init__(self):
            self.route_patterns: list[str] = []
            self.response_handlers = 0

        async def route(self, pattern, _handler):
            self.route_patterns.append(pattern)

        def on(self, event, _handler):
            if event == "response":
                self.response_handlers += 1

    async def body():
        write_only = FakeContext()
        await _install_fast_mode_network_cache(
            write_only, "eventim checkout", read_enabled=False, write_enabled=True
        )
        assert write_only.route_patterns == []
        assert write_only.response_handlers == 1

        replay = FakeContext()
        await _install_fast_mode_network_cache(
            replay, "eventim checkout", read_enabled=True, write_enabled=True
        )
        assert replay.route_patterns == ["**/*"]
        assert replay.response_handlers == 1

    asyncio.run(body())


def test_browser_http_non_2xx_not_cached(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("g")
        wrote = await cache.record("GET", "https://s.com/x", "document", 404, {}, b"nope")
        assert wrote is False
        assert await cache.lookup("GET", "https://s.com/x", "document") is None

    asyncio.run(body())


def test_browser_http_post_record_then_replay_goal_scoped(mem):
    async def body():
        cache = browser_http.BrowserHttpCache("g")
        assert await cache.lookup("POST", "https://s.com/api", "xhr", request_body='{"a":1}') is None
        wrote = await cache.record("POST", "https://s.com/api", "xhr", 200, {}, b"x", request_body='{"a":1}')
        assert wrote is True
        hit = await cache.lookup("POST", "https://s.com/api", "xhr", request_body='{"a":1}')
        assert hit is not None
        assert hit["body"] == b"x"
        assert (await cache.lookup("POST", "https://s.com/api", "xhr", request_body='{"a":2}')) is not None
        other_goal = browser_http.BrowserHttpCache("other")
        assert await other_goal.lookup("POST", "https://s.com/api", "xhr", request_body='{"a":1}') is None

    asyncio.run(body())


# ---------------------------------------------------------------------------
# Browser-use decision
# ---------------------------------------------------------------------------


def test_browser_use_passthrough_when_disabled(mem):
    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 3}

        out = await browser_use_cache.cached_browser_decision(
            enabled=False, goal="g", request={"url": "https://x.com"}, call_llm=live
        )
        assert out == {"action": "click", "index": 3}
        assert calls["n"] == 1
        assert mem.data == {}  # nothing cached when off

    asyncio.run(body())


def test_browser_use_write_only_records_without_read(mem):
    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 3}

        out = await browser_use_cache.cached_browser_decision(
            enabled=False,
            write_enabled=True,
            goal="g",
            request={"url": "https://x.com"},
            call_llm=live,
        )
        assert out == {"action": "click", "index": 3}
        assert calls["n"] == 1
        assert mem.get_calls == 0
        assert mem.set_calls == 1
        assert len(mem.data) == 1

    asyncio.run(body())


def test_browser_use_write_skips_child_under_demo_tree_root(mem, monkeypatch):
    """A non-DEMO child goal under a DEMO root never writes the frozen replay namespace."""
    monkeypatch.delenv("FAST_MODE_CACHE_RECORD_DEMO", raising=False)
    roots = {"child-under-demo": _soft_complete_bench_goal(), "child-under-ordinary": "ordinary root goal"}

    async def resolve(agent_id):
        return False, "child browser goal", True, f"root-of-{agent_id}", roots[agent_id], True

    monkeypatch.setattr(browser_use_cache.cache_client, "resolve_agent_fast_mode", resolve)

    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 2}

        for agent_id in ("child-under-demo", "child-under-ordinary"):
            out = await browser_use_cache.cached_browser_decision(
                enabled=False,
                write_enabled=True,
                goal="child browser goal",
                request={"url": f"https://x.com/{agent_id}"},
                call_llm=live,
                agent_id=agent_id,
            )
            assert out == {"action": "click", "index": 2}
        assert calls["n"] == 2
        # Only the ordinary-rooted child records its live decision.
        assert mem.set_calls == 1

    asyncio.run(body())


def test_browser_use_record_then_replay(mem):
    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "goto", "url": "https://x.com", "thinking": "navigate"}

        request = {"task": "go to x", "browser_state": {"url": "https://x.com"}}
        # Seed via write-only (read path soft-completes on miss).
        r1 = await browser_use_cache.cached_browser_decision(
            enabled=False,
            write_enabled=True,
            goal="g",
            request=request,
            call_llm=live,
        )
        assert calls["n"] == 1
        assert r1["action"] == "goto"
        # Replay under Fast Mode read — live must NOT be called again.
        r2 = await browser_use_cache.cached_browser_decision(
            enabled=True, goal="g", request=request, call_llm=live
        )
        assert calls["n"] == 1
        assert r2 == r1

    asyncio.run(body())


def test_browser_use_cache_key_includes_page_url(mem):
    """Page URL must partition the Fast Mode key so a navigation cannot replay
    a decision recorded on a different page with the same action history."""

    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": calls["n"]}

        base = {
            "task": "click next",
            "turn_messages": [],
            "action_entries": [{"action": "scroll", "params": {"direction": "down"}}],
            "config": {"browser_use_mode": None},
        }
        page_a = {**base, "browser_state": {"url": "https://shop.example/a", "title": "A"}}
        page_b = {**base, "browser_state": {"url": "https://shop.example/b", "title": "B"}}
        assert normalize.canonical_browser_use_request(page_a) != normalize.canonical_browser_use_request(
            page_b
        )
        await browser_use_cache.cached_browser_decision(
            enabled=False, write_enabled=True, goal="g", request=page_a, call_llm=live
        )
        assert calls["n"] == 1
        # Same trajectory on a different URL must miss (non-bench goal → live).
        r_b = await browser_use_cache.cached_browser_decision(
            enabled=True, goal="g", request=page_b, call_llm=live
        )
        assert calls["n"] == 2
        assert r_b.get("index") == 2
        # Exact same page URL still replays page_a's decision.
        r_a2 = await browser_use_cache.cached_browser_decision(
            enabled=True, goal="g", request=page_a, call_llm=live
        )
        assert calls["n"] == 2
        assert r_a2.get("action") == "click"
        assert r_a2.get("index") == 1

    asyncio.run(body())


def test_browser_use_soft_completes_on_miss(mem):
    async def body():
        calls = {"n": 0}
        bench = _soft_complete_bench_goal()

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 1}

        out = await browser_use_cache.cached_browser_decision(
            enabled=True,
            goal=bench,
            request={"task": "x", "browser_state": {"url": "https://x.com"}},
            call_llm=live,
        )
        assert calls["n"] == 0
        assert mem.set_calls == 0
        assert out["action"]["action"] == "done"
        assert out.get("from_fast_cache") is True

    asyncio.run(body())


def test_browser_use_miss_non_bench_calls_live(mem):
    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 1}

        out = await browser_use_cache.cached_browser_decision(
            enabled=True,
            goal="Order Blue Bottle",
            request={"task": "x", "browser_state": {"url": "https://x.com"}},
            call_llm=live,
        )
        assert calls["n"] == 1
        assert out["action"] == "click"

    asyncio.run(body())


def test_browser_use_soft_completes_on_lookup_error(monkeypatch, mem):
    """Cache-read errors must not fall through to live browser LLM under FM read."""

    async def boom(*_a, **_k):
        raise RuntimeError("backend down")

    monkeypatch.setattr(browser_use_cache.cache_client, "cache_get", boom)
    bench = _soft_complete_bench_goal()

    async def body():
        calls = {"n": 0}

        async def live():
            calls["n"] += 1
            return {"action": "click", "index": 1}

        out = await browser_use_cache.cached_browser_decision(
            enabled=True,
            goal=bench,
            request={"task": "x", "browser_state": {"url": "https://x.com"}},
            call_llm=live,
        )
        assert calls["n"] == 0
        assert mem.set_calls == 0
        assert out["action"]["action"] == "done"
        assert out.get("from_fast_cache") is True

    asyncio.run(body())


def test_browser_use_cached_action_remaps_shifted_dom_index():
    old_dom = FakeDom({
        105: FakeElement(
            tag_name="div",
            text="Online Python compiler (interpreter) to run Python online.",
            attrs={"role": "textbox"},
        )
    })
    cached = _attach_browser_replay_target(
        {
            "action": {
                "action": "click",
                "index": 105,
                "params": {"index": 105},
                "thinking": "Click the code editor.",
            }
        },
        old_dom,
    )

    new_dom = FakeDom({
        106: FakeElement(
            tag_name="div",
            text="Online Python compiler (interpreter) to run Python online.",
            attrs={"role": "textbox"},
        )
    })
    remapped = _remap_cached_browser_action_target(
        cached["action"],
        cached_target=cached["_fast_cache_browser_target"],
        dom_service=new_dom,
    )

    assert remapped["index"] == 106
    assert remapped["params"]["index"] == 106
