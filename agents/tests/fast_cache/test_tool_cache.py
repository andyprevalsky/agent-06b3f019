"""Fast Mode — web_search / web_fetch tool cache tests.

  - #1  off → provider called, nothing cached
  - #7  on/miss → provider called once, result stored
  - #11 on/hit → provider NOT called, cached result returned
  - #15 web_fetch key collapses cache-buster URL drift
  - #15 file download key collapses cache-buster URL drift
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict

import pytest

from providers.fast_cache import normalize
import tools.web_search.handler as ws
import domains.web_fetch.handler as wf


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
    monkeypatch.setattr(ws.fast_cache_client, "cache_get", store.get)
    monkeypatch.setattr(ws.fast_cache_client, "cache_set", store.set)
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


def test_web_search_record_then_replay(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": f"result-{calls['n']}", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        r1 = await ws.web_search_activity("weather", 100, fast_mode_cache_enabled=True, fast_mode_goal="g")
        r2 = await ws.web_search_activity("weather", 100, fast_mode_cache_enabled=True, fast_mode_goal="g")
        assert calls["n"] == 1  # provider hit once; #11 replay served from cache
        assert r1 == r2

    asyncio.run(body())


def test_web_search_replays_across_goals(mem, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_search(query, max_tokens):
            calls["n"] += 1
            return {"answer": f"result-{calls['n']}", "query": query}

        monkeypatch.setattr(ws, "execute_search", fake_search)
        r1 = await ws.web_search_activity("Best cities to live in your 20s", 100, True, "goal-a")
        r2 = await ws.web_search_activity(" best   cities to LIVE in your 20s ", 100, True, "goal-b")
        assert calls["n"] == 1
        assert r1 == r2

    asyncio.run(body())


@pytest.fixture
def memwf(monkeypatch):
    store = MemStore()
    monkeypatch.setattr(wf, "logger", wf.logger)
    # web_fetch_activity imports the cache client lazily inside the function, so patch
    # the module functions it resolves.
    import providers.fast_cache.client as cclient
    monkeypatch.setattr(cclient, "cache_get", store.get)
    monkeypatch.setattr(cclient, "cache_set", store.set)
    return store


def test_web_fetch_record_then_replay(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": f"page-{calls['n']}", "links": [], "metadata": {}}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)

        # cache-buster drift between the two calls must still hit (#15)
        r1 = await wf.web_fetch_activity("https://x.com/a?t=1", True, "g")
        r2 = await wf.web_fetch_activity("https://x.com/a?t=99999", True, "g")
        assert calls["n"] == 1
        assert r1 == r2

    asyncio.run(body())


def test_web_fetch_replays_across_goals(memwf, monkeypatch):
    async def body():
        calls = {"n": 0}

        async def fake_scrape(url):
            calls["n"] += 1
            return {"markdown": f"page-{calls['n']}", "links": [], "metadata": {}}

        monkeypatch.setattr(wf, "scrape_url", fake_scrape)

        r1 = await wf.web_fetch_activity("https://x.com/a?t=1", True, "goal-a")
        r2 = await wf.web_fetch_activity("https://x.com/a?t=99999", True, "goal-b")
        assert calls["n"] == 1
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
        import providers.fast_cache.blob_store as blob_store
        import providers.fast_cache.client as cclient

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

        first = await service._download_files_with_fast_cache(
            ["https://x.com/report.pdf?t=1"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )
        second = await service._download_files_with_fast_cache(
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
        import providers.fast_cache.client as cclient

        calls = {"n": 0}

        async def fake_download(urls):
            calls["n"] += 1
            return {url: None for url in urls}

        monkeypatch.setattr(service, "download_files_batch", fake_download)
        monkeypatch.setattr(cclient, "cache_get_record", memwf.get_record)
        monkeypatch.setattr(cclient, "cache_set", memwf.set)

        first = await service._download_files_with_fast_cache(
            ["https://x.com/report.pdf?t=1"],
            fast_mode_cache_enabled=True,
            fast_mode_goal="g",
        )
        second = await service._download_files_with_fast_cache(
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
        import providers.fast_cache.blob_store as blob_store
        import providers.fast_cache.client as cclient

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

        out = await service._download_files_with_fast_cache(
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
