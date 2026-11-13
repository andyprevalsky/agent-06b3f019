"""Own the pinned Playwright 1.63 async driver before its startup handshake.

This intentionally uses the SDK's private context-manager/Connection boundary:
the public start() drops Connection.run's Task, and __aexit__ marks itself done
before its stop await. Neither is a native-exit acknowledgement. Keep this
adapter aligned with that boundary when upgrading the pinned SDK.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from playwright._impl._connection import Connection
from playwright._impl._object_factory import create_remote_object
from playwright._impl._transport import PipeTransport
from playwright.async_api import async_playwright
from playwright.async_api._context_manager import PlaywrightContextManager
from playwright.async_api._generated import Playwright


def _observe(future: asyncio.Future) -> None:
    if not future.cancelled():
        future.exception()


class _OwnedConnection(Connection):
    def _send_message_to_server(self, *args: Any, **kwargs: Any) -> Any:
        callback = super()._send_message_to_server(*args, **kwargs)
        # During cancelled initialization, the SDK may select its transport
        # error and leave the simultaneous protocol error unobserved. Reading
        # it here preserves the original await/result while settling that tail.
        callback.future.add_done_callback(_observe)
        return callback


class _OwnedPipeTransport(PipeTransport):
    creator_task: asyncio.Task | None = None

    async def _connect(self) -> None:
        await super().connect()

    async def connect(self) -> None:
        # Do not cancel subprocess creation before the SDK saves its Process.
        # The transport remains owned even if Connection.run is cancelled here.
        self.creator_task = asyncio.create_task(self._connect(), name="playwright-native-create")
        await asyncio.shield(self.creator_task)


class _OwnedContextManager(PlaywrightContextManager):
    def __init__(self, owner: PlaywrightOwner) -> None:
        super().__init__()
        self.owner = owner

    async def __aenter__(self) -> Playwright:
        # Same handshake as pinned PlaywrightContextManager.__aenter__, with
        # connection/transport/task custody published before any task executes.
        loop = asyncio.get_running_loop()
        transport = self.owner._transport_factory(loop)
        self._connection = _OwnedConnection(None, create_remote_object, transport, loop)
        self.owner.connection = self._connection
        self.owner.transport = transport
        self.owner.connection_task = asyncio.create_task(self._connection.run(), name="playwright-connection")
        future = self._connection.playwright_future
        done, _ = await asyncio.wait({transport.on_error_future, future}, return_when=asyncio.FIRST_COMPLETED)
        if not future.done():
            future.cancel()
        instance = Playwright(next(iter(done)).result())
        instance.stop = self.owner.close
        return instance

    async def __aexit__(self, *args: Any) -> None:
        await self.owner.close()


class PlaywrightOwner:
    """Register synchronously, await start(), then retain until confirmed close.

    Pass the caller's async_playwright factory explicitly to preserve injected
    test factories. Real SDK managers always use the owned native path; simple
    test doubles use their own start/stop contract without claiming a process.
    No caller timeout is introduced here: the activity owns the existing bound.
    """

    def __init__(
        self,
        factory: Callable[[], Any] = async_playwright,
        *,
        _transport_factory: Callable[[asyncio.AbstractEventLoop], _OwnedPipeTransport] = _OwnedPipeTransport,
    ) -> None:
        self._factory = factory
        self._transport_factory = _transport_factory
        self.manager: Any = None
        self.instance: Any = None
        self.connection: Connection | None = None
        self.transport: _OwnedPipeTransport | None = None
        self.startup_task: asyncio.Task | None = None
        self.connection_task: asyncio.Task | None = None
        self.stop_task: asyncio.Task | None = None
        self.process_wait_task: asyncio.Task | None = None
        self.close_task: asyncio.Task | None = None
        self.init_task: asyncio.Task | None = None
        self.close_confirmed = False
        self._sealed = False

    @property
    def process(self) -> Any:
        return getattr(self.transport, "_proc", None)

    @property
    def creator_task(self) -> asyncio.Task | None:
        return getattr(self.transport, "creator_task", None)

    @property
    def confirmed(self) -> bool:
        return self.close_confirmed

    async def _start(self) -> Any:
        manager = self._factory()
        self.manager = _OwnedContextManager(self) if issubclass(type(manager), PlaywrightContextManager) else manager
        self.instance = await self.manager.start()
        return self.instance

    async def start(self) -> Any:
        if self._sealed:
            raise RuntimeError("Playwright owner is closing")
        if self.startup_task is None:
            self.startup_task = asyncio.create_task(self._start(), name="playwright-startup")
            self.startup_task.add_done_callback(_observe)
        return await asyncio.shield(self.startup_task)

    async def close(self) -> None:
        self._sealed = True
        if self.close_task is None or (
            self.close_task.done() and (self.close_task.cancelled() or self.close_task.exception() is not None)
        ):
            self.close_task = asyncio.create_task(self._close(), name="playwright-owned-close")
            self.close_task.add_done_callback(_observe)
        # A caller's cancellation cannot discard the only native-close owner.
        await asyncio.shield(self.close_task)

    async def _close(self) -> None:
        if self.startup_task is not None:
            if not self.startup_task.done():
                self.startup_task.cancel()
            await asyncio.gather(self.startup_task, return_exceptions=True)
        if self.connection is None:
            if self.instance is not None:
                await self.instance.stop()
            elif self.manager is not None and hasattr(self.manager, "__aexit__"):
                await self.manager.__aexit__(None, None, None)
            self.close_confirmed = True
            return

        creator = self.creator_task
        if creator is None:
            # Connection.run has not entered transport.connect yet. Cancelling
            # it now cannot race an unrecorded subprocess creator.
            if self.connection_task is not None:
                self.connection_task.cancel()
        else:
            # Even if the waiter was cancelled, creation must finish publishing
            # its Process before cleanup can prove whether a native owner exists.
            await asyncio.gather(creator, return_exceptions=True)

        process = self.process
        if process is not None:
            self.stop_task = asyncio.create_task(self._stop_native(process), name="playwright-native-stop")
            await self.stop_task
        else:
            self.connection.cleanup()
        self.init_task = self.connection._init_task
        if self.init_task is not None:
            if not self.init_task.done():
                self.init_task.cancel()
            await asyncio.gather(self.init_task, return_exceptions=True)
        if self.connection_task is not None:
            await asyncio.gather(self.connection_task, return_exceptions=True)
        # Consume protocol futures after cleanup without replacing startup's
        # original error or treating a stopped transport Future as process exit.
        for future in (self.connection.playwright_future, self.transport.on_error_future):
            if future.done() and not future.cancelled():
                future.exception()
        if process is not None and process.returncode is None:
            raise RuntimeError("Playwright native process exit is unconfirmed")
        tasks = (
            self.startup_task,
            self.creator_task,
            self.connection_task,
            self.init_task,
            self.stop_task,
            self.process_wait_task,
        )
        if any(task is not None and not task.done() for task in tasks):
            raise RuntimeError("Playwright native work remains unsettled")
        self.close_confirmed = True

    async def _stop_native(self, process: Any) -> None:
        # A cancelled Connection.run may never resolve _stopped_future, or may
        # resolve it before the child exits. Own the actual process receipt.
        self.transport.request_stop()
        self.process_wait_task = asyncio.create_task(process.wait(), name="playwright-native-exit")
        await self.process_wait_task
        if self.connection_task is not None:
            await asyncio.gather(self.connection_task, return_exceptions=True)
        self.connection.cleanup()
