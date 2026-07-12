"""Unit tests for the served-WMH `/rose_usage` route.

`build_app` needs a built WMH model artifact + the vendored `wmh` package, which is
too heavy for a unit test. The behavior we own — exposing the Rose usage accumulator
over `GET /rose_usage` — is isolated in `_add_rose_usage_route`, so we exercise that
against a bare FastAPI app + a real `RoseUsageAccumulator` via TestClient.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from benchmarks.serve_world_model import _add_rose_usage_route
from benchmarks.wmh_rose_provider import RoseUsageAccumulator


def _app_with_usage(acc: RoseUsageAccumulator) -> TestClient:
    app = FastAPI()
    _add_rose_usage_route(app, acc)
    return TestClient(app)


def test_rose_usage_route_empty():
    client = _app_with_usage(RoseUsageAccumulator())
    resp = client.get("/rose_usage")
    assert resp.status_code == 200
    assert resp.json() == {
        "total_cost_usd": 0.0,
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
    }


def test_rose_usage_route_reflects_recorded_usage():
    acc = RoseUsageAccumulator()
    acc.record(cost_usd=0.5, input_tokens=100, output_tokens=40)
    acc.record(cost_usd=0.25, input_tokens=10, output_tokens=4)
    client = _app_with_usage(acc)

    body = client.get("/rose_usage").json()
    assert body["calls"] == 2
    assert body["input_tokens"] == 110
    assert body["output_tokens"] == 44
    assert body["total_cost_usd"] == 0.75


def test_rose_usage_route_live_updates():
    """The route reads the accumulator live — usage recorded after wiring shows up."""
    acc = RoseUsageAccumulator()
    client = _app_with_usage(acc)

    assert client.get("/rose_usage").json()["calls"] == 0
    acc.record(cost_usd=0.01, input_tokens=3, output_tokens=1)
    assert client.get("/rose_usage").json()["calls"] == 1
    assert client.get("/rose_usage").json()["total_cost_usd"] == 0.01
