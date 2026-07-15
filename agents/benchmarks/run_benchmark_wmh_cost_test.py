"""Tests for `run_benchmark._fetch_wmh_grounding_usd` — the report-card wiring
that pulls cumulative WMH grounding cost from the served WMH's `/rose_usage`.

This is the seam between the served WMH (which meters Rose inference cost) and the
report card's `cost.wmh_grounding_usd`. We stub `httpx.get` so no server is needed.
"""

from __future__ import annotations

import benchmarks.run_benchmark as rb


class _FakeResp:
    def __init__(self, payload, *, status_ok: bool = True):
        self._payload = payload
        self._status_ok = status_ok

    def raise_for_status(self):
        if not self._status_ok:
            raise RuntimeError("http error")

    def json(self):
        return self._payload


def test_returns_none_when_wmh_not_served(monkeypatch):
    monkeypatch.delenv("WMH_BASE_URL", raising=False)
    assert rb._fetch_wmh_grounding_usd() is None


def test_returns_cost_from_rose_usage(monkeypatch):
    monkeypatch.setenv("WMH_BASE_URL", "http://localhost:9999")
    calls = {}

    def fake_get(url, *a, **k):
        calls["url"] = url
        return _FakeResp({"total_cost_usd": 1.87, "calls": 42, "input_tokens": 10, "output_tokens": 5})

    monkeypatch.setattr(rb.httpx, "get", fake_get)
    cost = rb._fetch_wmh_grounding_usd()
    assert cost == 1.87
    assert calls["url"] == "http://localhost:9999/rose_usage"


def test_strips_trailing_slash_on_base(monkeypatch):
    monkeypatch.setenv("WMH_BASE_URL", "http://localhost:9999/")
    seen = {}

    def fake_get(url, *a, **k):
        seen["url"] = url
        return _FakeResp({"total_cost_usd": 0.0})

    monkeypatch.setattr(rb.httpx, "get", fake_get)
    rb._fetch_wmh_grounding_usd()
    assert seen["url"] == "http://localhost:9999/rose_usage"


def test_returns_none_on_unreachable(monkeypatch):
    monkeypatch.setenv("WMH_BASE_URL", "http://localhost:9999")

    def boom(*a, **k):
        raise ConnectionError("refused")

    monkeypatch.setattr(rb.httpx, "get", boom)
    assert rb._fetch_wmh_grounding_usd() is None


def test_returns_none_on_http_error_status(monkeypatch):
    monkeypatch.setenv("WMH_BASE_URL", "http://localhost:9999")
    monkeypatch.setattr(rb.httpx, "get", lambda *a, **k: _FakeResp({}, status_ok=False))
    assert rb._fetch_wmh_grounding_usd() is None


def test_returns_none_when_cost_missing_or_unparseable(monkeypatch):
    monkeypatch.setenv("WMH_BASE_URL", "http://localhost:9999")

    monkeypatch.setattr(rb.httpx, "get", lambda *a, **k: _FakeResp({"calls": 1}))
    assert rb._fetch_wmh_grounding_usd() is None

    monkeypatch.setattr(rb.httpx, "get", lambda *a, **k: _FakeResp({"total_cost_usd": "oops"}))
    assert rb._fetch_wmh_grounding_usd() is None


def _fixture_ctx():
    return rb.LiveFixtureContext(
        base_url="http://localhost:3001",
        user_id="u1",
        auth_realm="amazon.com",
    )


def test_base_live_fixture_skips_browser_creds_in_simulate(monkeypatch):
    """Simulate mode: the WMH mocks env tools, so the heavy 21k-cookie browser
    credential sync is skipped (it otherwise blows the 180s budget on a throttled
    uplink and stalls agent creation). Compute tokens are still refreshed."""
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    calls = []
    monkeypatch.setattr(rb, "_sync_compute_tokens", lambda: calls.append("compute") or True)
    monkeypatch.setattr(rb, "_sync_browser_credentials", lambda: calls.append("browser"))

    manifest = rb._apply_base_live_fixture(_fixture_ctx())

    assert calls == ["compute"]  # browser cred sync NOT called
    assert manifest == {"fixture": "base", "browser_credentials": False}


def test_base_live_fixture_syncs_browser_creds_when_live(monkeypatch):
    """Real (non-simulate) mode still refreshes cookies/passwords — live tasks
    exercise real browser auth."""
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "real")
    calls = []
    monkeypatch.setattr(rb, "_sync_compute_tokens", lambda: calls.append("compute") or True)
    monkeypatch.setattr(rb, "_sync_browser_credentials", lambda: calls.append("browser") or True)

    manifest = rb._apply_base_live_fixture(_fixture_ctx())

    assert calls == ["compute", "browser"]
    assert manifest == {"fixture": "base", "browser_credentials": True}


def test_is_simulate_mode_reads_env(monkeypatch):
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "simulate")
    assert rb._is_simulate_mode() is True
    monkeypatch.setenv("BENCHMARK_WORLD_MODEL_MODE", "shadow")
    assert rb._is_simulate_mode() is False
    monkeypatch.delenv("BENCHMARK_WORLD_MODEL_MODE", raising=False)
    assert rb._is_simulate_mode() is False


def test_tree_token_totals_prefers_root_agent_without_summing_children():
    agents = [
        {"agent_id": "root", "tokens_in": 1000, "tokens_out": 120},
        {"agent_id": "child-1", "tokens_in": 400, "tokens_out": 30},
        {"agent_id": "child-2", "tokens_in": 700, "tokens_out": 50},
    ]

    assert rb._tree_token_totals_from_agents(agents, "root") == (1000, 120)


def test_tree_token_totals_falls_back_to_largest_agent_counter_when_root_missing():
    agents = [
        {"agent_id": "child-1", "tokens_in": 400, "tokens_out": 30},
        {"agent_id": "child-2", "tokens_in": 700, "tokens_out": 50},
    ]

    assert rb._tree_token_totals_from_agents(agents, "root") == (700, 50)


def test_merge_tool_and_tree_tokens_keeps_tool_total_when_it_covers_chat_loop():
    assert rb._merge_tool_and_tree_tokens(
        tool_tokens_in=1500,
        tool_tokens_out=200,
        tree_tokens_in=1000,
        tree_tokens_out=120,
        tool_tokens_cover_tree=True,
    ) == (1500, 200)


def test_merge_tool_and_tree_tokens_uses_tree_total_when_modern_tool_usage_is_lower():
    assert rb._merge_tool_and_tree_tokens(
        tool_tokens_in=300,
        tool_tokens_out=40,
        tree_tokens_in=1000,
        tree_tokens_out=120,
        tool_tokens_cover_tree=True,
    ) == (1000, 120)


def test_merge_tool_and_tree_tokens_adds_tree_total_when_cache_fallback_misses_chat_loop():
    assert rb._merge_tool_and_tree_tokens(
        tool_tokens_in=300,
        tool_tokens_out=40,
        tree_tokens_in=1000,
        tree_tokens_out=120,
        tool_tokens_cover_tree=False,
    ) == (1300, 160)


def test_report_card_folds_wmh_cost_into_total():
    """End-to-end: a fetched WMH cost lands in cost.wmh_grounding_usd + total_usd."""
    from benchmarks.report_card import RunState, TaskCard, build_report_card

    state = RunState(
        run_id="r1",
        elapsed_s=10.0,
        world_model_mode="simulate",
        total_tasks=1,
        per_task=[TaskCard(name="t", status="passed", duration_s=5.0, cost_usd=2.0)],
        agents_llm_usd=2.0,
        wmh_grounding_usd=1.87,
    )
    card = build_report_card(state)
    assert card["cost"]["wmh_grounding_usd"] == 1.87
    assert card["cost"]["agents_llm_usd"] == 2.0
    assert card["cost"]["total_usd"] == 3.87
