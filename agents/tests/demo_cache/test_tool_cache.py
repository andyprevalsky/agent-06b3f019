"""Fast Mode — web_search / web_fetch tool cache tests.

  - #1  off → provider called, nothing cached
  - write-only → provider called once, result stored (no read)
  - on/miss → soft-complete stub, provider NOT called, nothing stored
  - #11 on/hit → provider NOT called, cached result returned
  - #15 web_fetch key collapses cache-buster URL drift
  - #15 file download key collapses cache-buster URL drift
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict

import pytest

from providers.demo_cache import normalize
import tools.web_search.handler as ws
import domains.web_fetch.handler as wf
import json
from pathlib import Path


def _soft_complete_bench_goal() -> str:
    tasks = json.loads(
        (Path(__file__).resolve().parents[2] / "benchmarks" / "tasks.json").read_text(
            encoding="utf-8"
        )
    )
    return next(t["prompt"] for t in tasks if t["name"] == "test-mass-agent-run-0")


def _without_demo_cache_hit(value: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in value.items() if k != "_fast_cache_hit"}


class MemStore:
    def __init__(self):
        self.data: Dict[str, Any] = {}
        self.blobs: Dict[str, bytes] = {}
        self.get_calls = 0
        self.get_record_calls = 0

    async def get(self, key: str):
        self.get_calls += 1
        row = self.data.get(key)
        return row.get("value") if row is not None else None

    async def get_record(self, key: str):
        self.get_record_calls += 1
        row = self.data.get(key)
        if row is None:
            return {"hit": False, "value": None, "blobPath": None}
        return {
            "hit": True,
            "value": row.get("value"),
            "blobPath": row.get("blobPath"),
        }

    async def set(
        self,
        key: str,
        kind: str,
        goal_hash: str,
        value: Any,
        blob_path: str | None = None,
        *,
        goal: str | None = None,
        root_goal: str | None = None,
    ) -> bool:
        self.data[key] = {
            "kind": kind,
            "goalHash": goal_hash,
            "value": value,
            "blobPath": blob_path,
        }
        return True


@pytest.fixture
def mem(monkeypatch):
    store = MemStore()
    monkeypatch.setattr(ws.demo_cache_client, "cache_get", store.get)
    monkeypatch.setattr(ws.demo_cache_client, "cache_set", store.set)
    return store


def test_web_search_off_is_passthrough(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": "live", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        out = await ws.web_search_activity("q", 100, fast_mode_cache_enabled=False, fast_mode_goal="g")
        assert out["answer"] == "live"
        assert calls["n"] == 1
        assert mem.data == {}

    asyncio.run(body())


def test_web_search_write_only_stores_without_read(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": "live", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        out = await ws.web_search_activity(
            "q",
            100,
            fast_mode_cache_enabled=False,
            fast_mode_goal="g",
            fast_mode_cache_write_enabled=True,
        )
        assert out["answer"] == "live"
        assert calls["n"] == 1
        assert mem.get_calls == 0
        assert len(mem.data) == 1

    asyncio.run(body())


def test_web_search_miss_soft_completes_without_provider(mem, monkeypatch):
    async def body():
        calls = {"n": 0}
        bench = _soft_complete_bench_goal()

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": "live", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        out = await ws.web_search_activity(
            "weather", 100, fast_mode_cache_enabled=True, fast_mode_goal=bench
        )
        assert calls["n"] == 0
        assert out.pop(ws.DEMO_CACHE_HIT_FIELD) is True
        assert out["provider"] == "fast-mode-soft-complete"
        assert mem.data == {}

    asyncio.run(body())


def test_web_search_miss_non_bench_calls_provider(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": "live", "query": query, "sources": [], "provider": "parallel"}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        out = await ws.web_search_activity(
            "weather", 100, fast_mode_cache_enabled=True, fast_mode_goal="Order coffee"
        )
        assert calls["n"] == 1
        assert out["answer"] == "live"

    asyncio.run(body())


def test_web_search_record_then_replay(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": f"result-{calls['n']}", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        # Seed via write-only (Fast Mode read soft-completes misses).
        r1 = await ws.web_search_activity(
            "weather",
            100,
            fast_mode_cache_enabled=False,
            fast_mode_goal="g",
            fast_mode_cache_write_enabled=True,
        )
        r2 = await ws.web_search_activity("weather", 100, fast_mode_cache_enabled=True, fast_mode_goal="g")
        assert calls["n"] == 1  # provider hit once on write-only; #11 replay from cache
        assert r2.pop(ws.DEMO_CACHE_HIT_FIELD) is True
        assert r1 == r2

    asyncio.run(body())


def test_web_search_replays_across_goals(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": f"result-{calls['n']}", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        r1 = await ws.web_search_activity(
            "Best cities to live in your 20s",
            100,
            fast_mode_cache_enabled=False,
            fast_mode_goal="goal-a",
            fast_mode_cache_write_enabled=True,
        )
        r2 = await ws.web_search_activity(
            " best   cities to LIVE in your 20s ",
            100,
            fast_mode_cache_enabled=True,
            fast_mode_goal="goal-b",
        )
        assert calls["n"] == 1
        assert r2.pop(ws.DEMO_CACHE_HIT_FIELD) is True
        assert r1 == r2

    asyncio.run(body())


@pytest.fixture
def memwf(monkeypatch):
    store = MemStore()
    monkeypatch.setattr(wf, "logger", wf.logger)
    # web_fetch_activity imports the cache client lazily inside the function, so patch
    # the module functions it resolves.
    import providers.demo_cache.client as cclient
    monkeypatch.setattr(cclient, "cache_get", store.get)
    monkeypatch.setattr(cclient, "cache_set", store.set)
    return store


def test_web_fetch_miss_soft_completes_without_provider(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}
        bench = _soft_complete_bench_goal()

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": "live", "links": [], "metadata": {}}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)
        out = await wf.web_fetch_activity("https://x.com/a", True, bench)
        assert calls["n"] == 0
        assert out.pop(wf.DEMO_CACHE_HIT_FIELD) is True
        assert out["metadata"]["provider"] == "fast-mode-soft-complete"
        assert memwf.data == {}

    asyncio.run(body())


def test_web_fetch_record_then_replay(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": f"page-{calls['n']}", "links": [], "metadata": {}}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)

        # Seed via write-only; cache-buster drift on read must still hit (#15)
        r1 = await wf.web_fetch_activity(
            "https://x.com/a?t=1",
            False,
            "g",
            fast_mode_cache_write_enabled=True,
        )
        r2 = await wf.web_fetch_activity("https://x.com/a?t=99999", True, "g")
        assert calls["n"] == 1
        assert r2.pop(wf.DEMO_CACHE_HIT_FIELD) is True
        assert r1 == r2

    asyncio.run(body())


def test_web_fetch_replays_across_goals(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": f"page-{calls['n']}", "links": [], "metadata": {}}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)

        r1 = await wf.web_fetch_activity(
            "https://x.com/a?t=1",
            False,
            "goal-a",
            fast_mode_cache_write_enabled=True,
        )
        r2 = await wf.web_fetch_activity("https://x.com/a?t=99999", True, "goal-b")
        assert calls["n"] == 1
        assert r2.pop(wf.DEMO_CACHE_HIT_FIELD) is True
        assert r1 == r2

    asyncio.run(body())


def test_web_fetch_off_is_passthrough(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": "live"}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)
        out = await wf.web_fetch_activity("https://x.com/a", False, None)
        assert out["markdown"] == "live"
        assert calls["n"] == 1
        assert memwf.data == {}

    asyncio.run(body())


def test_web_fetch_write_only_stores_without_read(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": "live"}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)
        out = await wf.web_fetch_activity(
            "https://x.com/a",
            False,
            "g",
            fast_mode_cache_write_enabled=True,
        )
        assert out["markdown"] == "live"
        assert calls["n"] == 1
        assert memwf.get_calls == 0
        assert len(memwf.data) == 1

    asyncio.run(body())


def test_web_fetch_file_download_record_then_replay(memwf, monkeypatch):
    async def body():
        import domains.web_fetch.service as service
        import providers.demo_cache.blob_store as blob_store
        import providers.demo_cache.client as cclient

        calls = {"n": 0}

        async def fake_download(urls):
            calls["n"] += 1
            return {url: b"LIVE-FILE-BYTES" for url in urls}

        async def fake_upload_blob(path, body, content_type="application/octet-stream"):
            memwf.blobs[path] = body
            return True

        async def fake_download_blob(path):
            return memwf.blobs.get(path)

        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)
        monkeypatch.setattr(blob_store, "upload_blob", fake_upload_blob)
        monkeypatch.setattr(blob_store, "download_blob", fake_download_blob)

        first = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf?t=1"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )
        second = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf?t=99999"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )

        assert calls["n"] == 1
        assert first["https://x.com/report.pdf?t=1"] == b"LIVE-FILE-BYTES"
        assert second["https://x.com/report.pdf?t=99999"] == b"LIVE-FILE-BYTES"
        stored = next(iter(memwf.data.values()))
        assert stored["kind"] == "file"
        assert stored["blobPath"].startswith("fast-mode-cache/")

    asyncio.run(body())


def test_web_fetch_file_download_failed_download_record_then_replay(memwf, monkeypatch):
    async def body():
        import domains.web_fetch.service as service
        import providers.demo_cache.client as cclient

        calls = {"n": 0}

        async def fake_download(urls):
            calls["n"] += 1
            return {url: None for url in urls}

        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)

        first = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf?t=1"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )
        second = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf?t=99999"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )

        assert calls["n"] == 1
        assert first["https://x.com/report.pdf?t=1"] is None
        assert second["https://x.com/report.pdf?t=99999"] is None
        stored = next(iter(memwf.data.values()))
        assert stored["kind"] == "file"
        assert stored["blobPath"] is None
        assert stored["value"]["download_failed"] is True

    asyncio.run(body())


def test_web_fetch_file_download_write_only_stores_without_read(memwf, monkeypatch):
    async def body():
        import domains.web_fetch.service as service
        import providers.demo_cache.blob_store as blob_store
        import providers.demo_cache.client as cclient

        calls = {"n": 0}

        async def fake_download(urls):
            calls["n"] += 1
            return {url: b"LIVE-FILE-BYTES" for url in urls}

        async def fake_upload_blob(path, body, content_type="application/octet-stream"):
            memwf.blobs[path] = body
            return True

        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)
        monkeypatch.setattr(blob_store, "upload_blob", fake_upload_blob)

        out = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf"],
            fast_mode_cache_enabled=False,
            fast_mode_goal="g",
            fast_mode_cache_write_enabled=True,
        )

        assert calls["n"] == 1
        assert out["https://x.com/report.pdf"] == b"LIVE-FILE-BYTES"
        assert memwf.get_record_calls == 0
        assert len(memwf.data) == 1
        assert len(memwf.blobs) == 1

    asyncio.run(body())


def test_web_fetch_file_download_skips_frozen_demo_namespace(memwf, monkeypatch):
    """A live DEMO-goal download returns its bytes without uploading a blob or row."""

    async def body():
        import domains.web_fetch.service as service
        import providers.demo_cache.blob_store as blob_store
        import providers.demo_cache.client as cclient

        async def fake_download(urls):
            return {url: b"LIVE-FILE-BYTES" for url in urls}

        async def fake_upload_blob(path, body, content_type="application/octet-stream"):
            memwf.blobs[path] = body
            return True

        monkeypatch.delenv("FAST_MODE_CACHE_RECORD_DEMO", raising=False)
        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)
        monkeypatch.setattr(blob_store, "upload_blob", fake_upload_blob)

        out = await service._download_files_with_demo_cache(
            ["https://x.com/report.pdf"],
            fast_mode_cache_enabled=False,
            fast_mode_goal=_soft_complete_bench_goal(),
            fast_mode_cache_write_enabled=True,
        )

        assert out["https://x.com/report.pdf"] == b"LIVE-FILE-BYTES"
        assert memwf.data == {}
        assert memwf.blobs == {}

    asyncio.run(body())


def _demo_tree(monkeypatch):
    """Resolve agent tree roots: one DEMO-root child, one ordinary agent, one failed lookup."""
    import providers.demo_cache.client as cclient

    demo_root = _soft_complete_bench_goal()
    child = "an ordinary child goal"

    async def fake_resolve(agent_id):
        if agent_id == "demo-child":
            return True, child, True, "demo-root", demo_root, True
        if agent_id == "ordinary-agent":
            return True, child, True, "ordinary-agent", child, True
        return False, None, False, agent_id, None, True

    monkeypatch.delenv("FAST_MODE_CACHE_RECORD_DEMO", raising=False)
    monkeypatch.setattr(cclient, "resolve_agent_fast_mode", fake_resolve)
    return child


def test_web_search_write_only_child_under_demo_root_does_not_write(mem, monkeypatch):
    """Real-mode shape: world-model args stay empty and the cache-write agent id gates writes.

    A child goal under an allowlisted DEMO root gains no entry from a live miss,
    and an unresolved tree root fails closed.
    """

    async def body():
        async def fake_search(query, max_tokens):
            return {"answer": "live", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        child = _demo_tree(monkeypatch)
        for agent_id in ("demo-child", "unresolved-agent"):
            await ws.web_search_activity("q", 100, False, child, True, None, None, agent_id)
            assert mem.data == {}, agent_id
        await ws.web_search_activity("q", 100, False, child, True, None, None, "ordinary-agent")
        assert len(mem.data) == 1

    asyncio.run(body())


def test_web_fetch_write_only_child_under_demo_root_does_not_write(memwf, monkeypatch):
    async def body():
        async def fake_scrape(url):
            return {"markdown": "live"}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)
        child = _demo_tree(monkeypatch)
        for agent_id in ("demo-child", "unresolved-agent"):
            out = await wf.web_fetch_activity("https://x.com/a", False, child, True, None, None, agent_id)
            assert out["markdown"] == "live"
            assert memwf.data == {}, agent_id
        await wf.web_fetch_activity("https://x.com/a", False, child, True, None, None, "ordinary-agent")
        assert len(memwf.data) == 1

    asyncio.run(body())


def test_web_fetch_download_child_under_demo_root_does_not_write(memwf, monkeypatch):
    """The download activity forwards its cache-write agent id; DEMO-tree children upload nothing."""

    async def body():
        import domains.web_fetch.service as service
        import providers.demo_cache.blob_store as blob_store
        import providers.demo_cache.client as cclient

        async def fake_download(urls):
            return {url: b"LIVE-FILE-BYTES" for url in urls}

        async def fake_upload_blob(path, body, content_type="application/octet-stream"):
            memwf.blobs[path] = body
            return True

        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)
        monkeypatch.setattr(blob_store, "upload_blob", fake_upload_blob)
        child = _demo_tree(monkeypatch)
        for agent_id in ("demo-child", "unresolved-agent"):
            out = await service._download_files_with_demo_cache(
                ["https://x.com/report.pdf"],
                fast_mode_cache_enabled=False,
                fast_mode_goal=child,
                fast_mode_cache_write_enabled=True,
                agent_id=agent_id,
            )
            assert out["https://x.com/report.pdf"] == b"LIVE-FILE-BYTES"
            assert memwf.data == {} and memwf.blobs == {}, agent_id

        forwarded = {}

        async def fake_download_and_attach(**kwargs):
            forwarded.update(kwargs)
            return []

        monkeypatch.delenv("BENCHMARK_WORLD_MODEL_MODE", raising=False)
        monkeypatch.setattr(wf, "download_and_attach", fake_download_and_attach)
        await wf.web_fetch_download_activity(
            ["https://x.com/report.pdf"], "user-1", False, child, True, None, None, "demo-child"
        )
        assert forwarded["agent_id"] == "demo-child"

    asyncio.run(body())
