"""Security and lifecycle tests for the one-off planner-memory backfill cache."""

from __future__ import annotations

import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_planner_memory.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("backfill_planner_memory_test_module", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cache_is_owner_only(tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"

    module.write_cache([{"id": "one", "goal": "private history"}])

    assert module.CACHE_PATH.stat().st_mode & 0o777 == 0o600


def test_complete_full_upsert_removes_cache(monkeypatch, tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"
    module.write_cache([{"id": "one", "goal": "goal", "world_model_mode": "real"}])

    async def successful_upsert(rows, **kwargs):
        assert [row["id"] for row in rows] == ["one"]
        return Counter(ok=1)

    monkeypatch.setattr(module, "upsert", successful_upsert)
    monkeypatch.setenv("BACKEND_API_KEY", "test-key")
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--backend", "https://backend.test"])

    assert module.main() == 0
    assert not module.CACHE_PATH.exists()


def test_limited_upsert_preserves_cache(monkeypatch, tmp_path: Path) -> None:
    module = _load_script()
    module.CACHE_PATH = tmp_path / "planner-memory-backfill.jsonl"
    module.write_cache([{"id": "one", "goal": "goal", "world_model_mode": "real"}])

    async def successful_upsert(rows, **kwargs):
        return Counter(ok=len(rows))

    monkeypatch.setattr(module, "upsert", successful_upsert)
    monkeypatch.setenv("BACKEND_API_KEY", "test-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [str(SCRIPT), "--backend", "https://backend.test", "--limit", "1"],
    )

    assert module.main() == 0
    assert module.CACHE_PATH.exists()


def test_embed_pending_drains_until_nothing_remains(monkeypatch) -> None:
    import asyncio

    import httpx

    module = _load_script()
    batches = iter(
        [
            {"embedded": 50, "failed": 0, "remaining": 1},
            {"embedded": 8, "failed": 0, "remaining": 0},
        ]
    )
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/planner-memory/embed-pending"
        assert request.headers["X-API-Key"] == "k"
        seen.append(json.loads(request.content))
        return httpx.Response(200, json=next(batches))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )
    totals = asyncio.run(module.embed_pending(backend="http://backend.test", api_key="k"))
    assert totals == {"embedded": 58, "failed": 0, "remaining": 0}
    assert seen == [{"limit": 50}, {"limit": 50}]


def test_embed_pending_stops_when_a_batch_makes_no_progress(monkeypatch) -> None:
    import asyncio

    import httpx

    module = _load_script()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embedded": 0, "failed": 3, "remaining": 3})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        module.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)
    )
    totals = asyncio.run(module.embed_pending(backend="http://backend.test", api_key="k"))
    assert totals["remaining"] == 3 and totals["failed"] == 3, "a stuck provider must not loop forever"
