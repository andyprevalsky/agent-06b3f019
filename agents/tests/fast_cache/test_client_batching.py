from __future__ import annotations

import asyncio

from providers.fast_cache import client


def test_concurrent_cache_gets_are_batched(monkeypatch):
    calls: list[list[str]] = []

    async def fake_fetch(keys: list[str]):
        calls.append(keys)
        return {
            key: {
                "hit": True,
                "value": {"key": key},
                "blobPath": None,
            }
            for key in keys
        }

    def noop_archive(*args, **kwargs):
        return None

    async def run():
        client._pending_gets.clear()
        client._pending_gets_lock = None
        client._pending_gets_flush_task = None
        client._archive_read_tasks.clear()
        client._archive_read_semaphore = None
        client._archive_read_semaphore_loop = None
        monkeypatch.setattr(client, "_GET_BATCH_DELAY_S", 0.001)
        monkeypatch.setattr(client, "_fetch_cache_records_many", fake_fetch)
        monkeypatch.setattr(client, "_queue_archive_cache_read", noop_archive)

        results = await asyncio.gather(
            client.cache_get_record("k1"),
            client.cache_get_record("k2"),
            client.cache_get_record("k1"),
        )

        assert [result["value"]["key"] for result in results] == ["k1", "k2", "k1"]
        assert calls == [["k1", "k2"]]

    asyncio.run(run())


def test_cache_get_record_does_not_wait_for_read_archive(monkeypatch):
    archive_started = asyncio.Event()

    async def fake_fetch(keys: list[str]):
        return {
            key: {
                "hit": True,
                "value": {"key": key},
                "blobPath": None,
            }
            for key in keys
        }

    async def slow_archive(*args, **kwargs):
        archive_started.set()
        await asyncio.sleep(0.05)

    async def run():
        client._pending_gets.clear()
        client._pending_gets_lock = None
        client._pending_gets_flush_task = None
        client._archive_read_tasks.clear()
        client._archive_read_semaphore = None
        client._archive_read_semaphore_loop = None
        monkeypatch.setattr(client, "_GET_BATCH_DELAY_S", 0.001)
        monkeypatch.setattr(client, "_fetch_cache_records_many", fake_fetch)
        monkeypatch.setattr(client, "_archive_cache_read", slow_archive)

        started = asyncio.get_running_loop().time()
        result = await client.cache_get_record("k1")
        elapsed = asyncio.get_running_loop().time() - started

        assert result["hit"] is True
        assert elapsed < 0.03
        await asyncio.wait_for(archive_started.wait(), timeout=0.1)
        await asyncio.gather(*list(client._archive_read_tasks))

    asyncio.run(run())


def test_archive_read_side_work_is_bounded(monkeypatch):
    active = 0
    max_active = 0

    async def slow_archive(*args, **kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1

    async def run():
        client._archive_read_tasks.clear()
        client._archive_read_semaphore = None
        client._archive_read_semaphore_loop = None
        monkeypatch.setattr(client, "_ARCHIVE_READ_MAX_CONCURRENCY", 2)
        monkeypatch.setattr(client, "_archive_cache_read", slow_archive)

        for i in range(8):
            client._queue_archive_cache_read(f"k{i}", hit=True, value={"i": i}, blob_path=None, status=200)

        await asyncio.gather(*list(client._archive_read_tasks))
        assert max_active == 2

    asyncio.run(run())
