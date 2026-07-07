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
