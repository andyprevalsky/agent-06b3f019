from __future__ import annotations

import asyncio

from providers.demo_cache import client

EVENT_TIMEOUT_S = 1.0


def reset_client_state() -> None:
    client._pending_gets.clear()
    client._pending_gets_lock = None
    client._pending_gets_flush_task = None
    client._pending_gets_batch_tasks.clear()
    client._archive_read_tasks.clear()
    client._archive_read_semaphore = None
    client._archive_read_semaphore_loop = None


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
        reset_client_state()
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


def test_cache_get_batches_can_overlap_when_one_batch_is_in_flight(monkeypatch):
    calls: list[list[str]] = []
    first_fetch_started = asyncio.Event()
    second_fetch_started = asyncio.Event()
    release_first_fetch = asyncio.Event()

    async def fake_fetch(keys: list[str]):
        calls.append(keys)
        if keys == ["k1"]:
            first_fetch_started.set()
            await release_first_fetch.wait()
        else:
            second_fetch_started.set()
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
        reset_client_state()
        monkeypatch.setattr(client, "_GET_BATCH_DELAY_S", 0.001)
        monkeypatch.setattr(client, "_GET_BATCH_MAX_IN_FLIGHT", 2)
        monkeypatch.setattr(client, "_fetch_cache_records_many", fake_fetch)
        monkeypatch.setattr(client, "_queue_archive_cache_read", noop_archive)

        first = asyncio.create_task(client.cache_get_record("k1"))
        await asyncio.wait_for(first_fetch_started.wait(), timeout=EVENT_TIMEOUT_S)

        second = asyncio.create_task(client.cache_get_record("k2"))
        await asyncio.wait_for(second_fetch_started.wait(), timeout=EVENT_TIMEOUT_S)

        release_first_fetch.set()
        results = await asyncio.gather(first, second)

        assert [result["value"]["key"] for result in results] == ["k1", "k2"]
        assert calls == [["k1"], ["k2"]]

    asyncio.run(run())


def test_completed_batch_tasks_are_removed_without_mutating_during_iteration():
    async def run():
        reset_client_state()
        completed = asyncio.create_task(asyncio.sleep(0))
        await completed
        client._pending_gets_batch_tasks.add(completed)

        await client._flush_pending_gets()

        assert client._pending_gets_batch_tasks == set()

    asyncio.run(run())


def test_cache_get_record_does_not_wait_for_read_archive(monkeypatch):
    archive_started = asyncio.Event()
    archive_release = asyncio.Event()

    async def fake_fetch(keys: list[str]):
        return {
            key: {
                "hit": True,
                "value": {"key": key},
                "blobPath": None,
            }
            for key in keys
        }

    async def blocked_archive(*args, **kwargs):
        archive_started.set()
        await archive_release.wait()

    async def run():
        reset_client_state()
        monkeypatch.setattr(client, "_GET_BATCH_DELAY_S", 0.001)
        monkeypatch.setattr(client, "_fetch_cache_records_many", fake_fetch)
        monkeypatch.setattr(client, "_archive_cache_read", blocked_archive)

        result = await asyncio.wait_for(
            client.cache_get_record("k1"), timeout=EVENT_TIMEOUT_S
        )
        assert result["hit"] is True
        await asyncio.wait_for(archive_started.wait(), timeout=EVENT_TIMEOUT_S)
        assert client._archive_read_tasks
        assert all(not task.done() for task in client._archive_read_tasks)
        archive_release.set()
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
        reset_client_state()
        monkeypatch.setattr(client, "_ARCHIVE_READ_MAX_CONCURRENCY", 2)
        monkeypatch.setattr(client, "_archive_cache_read", slow_archive)

        for i in range(8):
            client._queue_archive_cache_read(f"k{i}", hit=True, value={"i": i}, blob_path=None, status=200)

        await asyncio.gather(*list(client._archive_read_tasks))
        assert max_active == 2

    asyncio.run(run())
