"""Offline instance-custody controls for sealed browser recorder disposal."""
import asyncio
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from otp_retry_behavior import _offline_activity_edges


def _recorder():
    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder
    return BrowserAgentRecorder(page=SimpleNamespace(), agent_id="same-agent", task_id="same-task",
                                session_id="fixture", browser_url="fixture", session_metadata={"provider": "steel"})


async def assert_sealed_cleanup_settles_only_its_recorder_archive():
    from domains.spawn_browser_agent_v3 import handler, recording
    owner, foreign = _recorder(), _recorder()
    assert owner.output_dir == foreign.output_dir
    started_owner, started_foreign, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    writes = []

    async def archive(started, name):
        started.set()
        await release.wait()
        writes.append(name)
        return True

    loop, errors = asyncio.get_running_loop(), []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: errors.append(context))
    owned = set()
    try:
        with _offline_activity_edges(), patch.object(owner, "_archive_recording_artifacts", lambda: archive(started_owner, "owner")), patch.object(foreign, "_archive_recording_artifacts", lambda: archive(started_foreign, "foreign")):
            initial = set(recording._BACKGROUND_RECORDING_ARCHIVE_TASKS)
            assert recording._schedule_background_recording_archive(owner, cleanup_after=False)
            own_task = next(iter(set(recording._BACKGROUND_RECORDING_ARCHIVE_TASKS) - initial))
            assert recording._schedule_background_recording_archive(foreign, cleanup_after=False)
            foreign_task = next(iter(set(recording._BACKGROUND_RECORDING_ARCHIVE_TASKS) - initial - {own_task}))
            owned = {own_task, foreign_task}
            await started_owner.wait()
            await started_foreign.wait()
            driver = SimpleNamespace(stop=AsyncMock())
            browser = SimpleNamespace(close=AsyncMock())
            try:
                await handler._schedule_browser_cleanup(
                    agent_id="same-agent", task_id="same-task", user_id="fixture", browser_url=None,
                    browser_session_metadata={}, input_page=None, start_url="https://fixture.invalid",
                    cursor_streamer=None, interaction_layer_task=None, humanizer=None,
                    browser_network_recorder=None, network_recorder_task=None, browser_recorder=owner,
                    dom_service=None, playwright_browser=browser, playwright_instance=driver,
                    playwright_driver_pid=None, local_only=True, emit_task_terminal=False,
                )
                assert own_task.done() and own_task.cancelled(), "owned archive survived sealed cleanup"
                assert not foreign_task.done(), "same-path foreign recorder archive was cancelled"
                assert recording._schedule_background_recording_archive(owner, cleanup_after=False) is False
                browser.close.assert_not_awaited()
                driver.stop.assert_awaited_once()
            finally:
                release.set()
                await asyncio.gather(*owned, return_exceptions=True)
            assert writes == ["foreign"], "sealed recorder initiated a later archive write"
            await asyncio.sleep(0)
            assert not (owned & recording._BACKGROUND_RECORDING_ARCHIVE_TASKS)
    finally:
        loop.set_exception_handler(previous)
        for task in owned:
            if not task.done():
                task.cancel()
    assert not errors, errors


async def assert_archive_abort_preserves_same_path_foreign_batches():
    from domains.spawn_browser_agent_v3 import recording
    owner, foreign = _recorder(), _recorder()
    key = (str(owner.output_dir.resolve()), "fixture-root", owner.task_id)
    initial_waiting = recording._CLOSED_RECORDING_WAITING.get(key)
    initial_files = recording._CLOSED_RECORDING_FILES.get(key)
    future = Future()
    submitted = []

    def enqueue(**kwargs):
        submitted.append(kwargs["artifacts"])
        return future

    def queue(recorder, name):
        recording._queue_closed_recording_file(recorder.output_dir, "fixture-root", recorder.task_id,
                                               recorder.output_dir / name, owner=recorder)

    try:
        with _offline_activity_edges(), patch.object(recording, "archive_enabled", return_value=True), patch.object(recording.trace_archive, "closed_file_archive_reservation", return_value=1), patch.object(recording.trace_archive, "archive_closed_files_in_background", side_effect=enqueue):
            queue(owner, "owner.txt")
            queue(foreign, "foreign.txt")
            await owner.abort_local(settle_timeout=10)
            queue(owner, "forbidden.txt")
            # Fill the existing batch using only legitimate foreign work.
            for i in range(recording.trace_archive._BATCH_MAX_RECORDS):
                if submitted:
                    break
                queue(foreign, f"foreign-{i}.txt")
            assert submitted
            names = [artifact[1].name for artifact in submitted[0]]
            assert "foreign.txt" in names and "owner.txt" not in names and "forbidden.txt" not in names
            assert not future.cancelled(), "foreign batch Future was cancelled"
    finally:
        if initial_waiting is None:
            recording._CLOSED_RECORDING_WAITING.pop(key, None)
        else:
            recording._CLOSED_RECORDING_WAITING[key] = initial_waiting
        if initial_files is None:
            recording._CLOSED_RECORDING_FILES.pop(key, None)
        else:
            recording._CLOSED_RECORDING_FILES[key] = initial_files


async def assert_archive_abort_cancels_only_exclusive_queued_futures(mixed=False):
    from domains.spawn_browser_agent_v3 import recording
    owner, foreign = _recorder(), _recorder()
    key = (str(owner.output_dir.resolve()), "fixture-root-future", owner.task_id)
    future = Future()
    before_waiting, before_files = recording._CLOSED_RECORDING_WAITING.get(key), recording._CLOSED_RECORDING_FILES.get(key)
    try:
        with _offline_activity_edges(), patch.object(recording, "archive_enabled", return_value=True), patch.object(recording.trace_archive, "closed_file_archive_reservation", return_value=1), patch.object(recording.trace_archive, "archive_closed_files_in_background", return_value=future):
            for i in range(recording.trace_archive._BATCH_MAX_RECORDS):
                source = foreign if mixed and i == 0 else owner
                recording._queue_closed_recording_file(source.output_dir, key[1], source.task_id,
                                                       source.output_dir / f"item-{i}.txt", owner=source)
            await owner.abort_local(settle_timeout=10)
            assert future.cancelled() is (not mixed)
    finally:
        if before_waiting is None:
            recording._CLOSED_RECORDING_WAITING.pop(key, None)
        else:
            recording._CLOSED_RECORDING_WAITING[key] = before_waiting
        if before_files is None:
            recording._CLOSED_RECORDING_FILES.pop(key, None)
        else:
            recording._CLOSED_RECORDING_FILES[key] = before_files


async def assert_abort_before_archive_start_releases_admission_slot():
    from domains.spawn_browser_agent_v3 import recording
    with _offline_activity_edges():
        # Serial admission must keep succeeding when abort precedes coroutine entry.
        for _ in range(8):
            owner = _recorder()
            with patch.object(owner, "_archive_recording_artifacts", AsyncMock(return_value=True)) as archive:
                assert recording._schedule_background_recording_archive(owner, cleanup_after=False)
                assert await owner.abort_local(settle_timeout=10)
                archive.assert_not_awaited()
                await asyncio.sleep(0)


async def assert_factory_registers_unreturned_recorder_for_abort(network=False):
    from domains.spawn_browser_agent_v3 import handler, recording
    cls = recording.BrowserNetworkRecorder if network else recording.BrowserAgentRecorder
    registered, children = [], []
    started = asyncio.Event()

    async def paused_start(self):
        child = asyncio.create_task(asyncio.Event().wait())
        children.append(child)
        if network:
            self._tasks.add(child)
        else:
            self._loop_task = child
        started.set()
        await asyncio.Event().wait()

    with _offline_activity_edges(), patch.object(cls, "start", paused_start), patch.object(recording, "browser_recordings_enabled", return_value=True), patch.object(recording, "browser_network_recording_enabled", return_value=True):
        if network:
            task = asyncio.create_task(cls.create(
                browser_session=SimpleNamespace(get_or_create_cdp_session=AsyncMock()),
                agent_id="same-agent", task_id="same-task", session_id="fixture",
                output_dir=Path(".context/owner-factory-network"), register_local_owner=registered.append,
            ))
        else:
            task = asyncio.create_task(cls.create(
                page=SimpleNamespace(screenshot=AsyncMock()), agent_id="same-agent", task_id="same-task",
                session_id="fixture", browser_url="fixture", session_metadata={"provider": "steel"},
                register_local_owner=registered.append,
            ))
        await started.wait()
        assert len(registered) == 1 and not task.done(), "owner was not registered before startup awaited"
        try:
            await handler._schedule_browser_cleanup(
                agent_id="same-agent", task_id="same-task", user_id="fixture", browser_url=None,
                browser_session_metadata={}, input_page=None, start_url="https://fixture.invalid",
                cursor_streamer=None, interaction_layer_task=None, humanizer=None,
                browser_network_recorder=None, network_recorder_task=None, browser_recorder=None,
                dom_service=None, playwright_browser=None, playwright_instance=None,
                playwright_driver_pid=None, local_only=True, emit_task_terminal=False,
                local_only_recorders=registered, local_only_setup_tasks=(task,),
            )
            assert task.cancelled() and all(child.cancelled() for child in children)
        finally:
            for child in [task, *children]:
                if not child.done():
                    child.cancel()
            await asyncio.gather(task, *children, return_exceptions=True)


async def assert_abort_reads_only_its_producer_registered_waiting_keys():
    from domains.spawn_browser_agent_v3 import recording
    owner, foreign = _recorder(), _recorder()
    accesses = []
    owned_key = (str(owner.output_dir.resolve()), "bounded-owner", owner.task_id)

    class WatchedRegistry(dict):
        def values(self):
            raise AssertionError("abort enumerated every agent waiting queue")
        def items(self):
            raise AssertionError("abort enumerated every agent waiting queue")
        def __iter__(self):
            raise AssertionError("abort enumerated every agent waiting queue")
        def get(self, key, *default):
            accesses.append(key)
            return super().get(key, *default)
        def pop(self, key, *default):
            accesses.append(key)
            return super().pop(key, *default)

    registry = WatchedRegistry()
    with _offline_activity_edges(), patch.object(recording, "_CLOSED_RECORDING_WAITING", registry), patch.object(recording, "archive_enabled", return_value=True), patch.object(recording.trace_archive, "closed_file_archive_reservation", return_value=1):
        recording._queue_closed_recording_file(owner.output_dir, owned_key[1], owner.task_id,
                                               owner.output_dir / "owned.txt", owner=owner)
        for i in range(100):
            recording._queue_closed_recording_file(foreign.output_dir, f"foreign-{i}", foreign.task_id,
                                                   foreign.output_dir / f"foreign-{i}.txt", owner=foreign)
        accesses.clear()
        await owner.abort_local(settle_timeout=10)
        assert accesses and all(key == owned_key for key in accesses), "abort accessed a foreign waiting key"
        assert len(registry) == 100, "abort removed foreign queue state"
