"""Project-owned custody around the pinned browser-use session lifecycle.

The SDK deliberately catches stop failures and clears roots. Keep the actual
clients, sockets and tasks independently, including across reconnect/reset.
"""
import asyncio
from contextlib import contextmanager
from functools import lru_cache
from typing import Any

from pydantic import PrivateAttr
from websockets.protocol import State


class BrowserSessionCustody:
    def __init__(self) -> None:
        self.sealed = False
        self.clients: dict[int, Any] = {}
        self.sockets: dict[int, Any] = {}
        self.tasks: set[asyncio.Task] = set()
        self.acquisitions: dict[asyncio.Task, int] = {}
        self.errors: list[BaseException] = []
        self.stop_task: asyncio.Task | None = None
        self.close_task: asyncio.Task | None = None

    def remember(self, client: Any) -> None:
        if client is None:
            return
        self.clients[id(client)] = client
        socket = getattr(client, "ws", None)
        if socket is not None:
            self.sockets[id(socket)] = socket
            keepalive = getattr(socket, "keepalive_task", None)
            if keepalive is not None:
                self.tasks.add(keepalive)
        task = getattr(client, "_message_handler_task", None)
        if task is not None:
            self.tasks.add(task)

    @contextmanager
    def acquiring(self, *, allow_teardown: bool = False):
        if self.sealed and not allow_teardown:
            raise RuntimeError("Browser session acquisition is closed")
        task = asyncio.current_task()
        self.acquisitions[task] = self.acquisitions.get(task, 0) + 1
        try:
            yield
        except BaseException as error:
            self.errors.append(error)
            raise
        finally:
            count = self.acquisitions[task] - 1
            if count:
                self.acquisitions[task] = count
            else:
                del self.acquisitions[task]

    async def quiesce(self, session: Any) -> None:
        # No await between closing admission and taking the ownership snapshot.
        self.sealed = True
        self.remember(getattr(session, "_cdp_client_root", None))
        session._intentional_stop = True
        reconnect = getattr(session, "_reconnect_task", None)
        manager = getattr(session, "session_manager", None)
        recovery = getattr(manager, "_recovery_task", None)
        pending = set(self.acquisitions)
        if recovery is not None:
            pending.add(recovery)
        if reconnect is not None:
            pending.add(reconnect)
        pending.discard(asyncio.current_task())
        pending.discard(self.stop_task)
        self.tasks.update(pending)
        for task in pending:
            if not task.done():
                task.cancel()
        if pending:
            outcomes = await asyncio.gather(*pending, return_exceptions=True)
            self.errors.extend(result for result in outcomes if isinstance(result, BaseException))
        self.remember(getattr(session, "_cdp_client_root", None))

    def _retain_failure(self, task: asyncio.Task) -> None:
        if task.cancelled():
            self.errors.append(asyncio.CancelledError())
        elif task.exception() is not None:
            self.errors.append(task.exception())

    async def stop_session(self, session: Any) -> None:
        if self.stop_task is None or (self.stop_task.done() and (self.stop_task.cancelled() or self.stop_task.exception() is not None)):
            self.stop_task = asyncio.create_task(session.stop(), name="browser-session-stop")
            self.stop_task.add_done_callback(self._retain_failure)
        try:
            await asyncio.shield(self.stop_task)
        except BaseException as error:
            self.errors.append(error)
            raise

    async def close_clients(self) -> None:
        if self.close_task is None or self.close_task.done():
            self.close_task = asyncio.create_task(self._close_clients(), name="browser-native-clients-stop")
            self.close_task.add_done_callback(self._retain_failure)
        await asyncio.shield(self.close_task)

    async def _close_clients(self) -> None:
        # The acquisition gate is closed and all its admitted work has settled.
        # SDK stop is insufficient: it may have dropped a still-live client.
        for client in tuple(self.clients.values()):
            self.remember(client)
            try:
                await client.stop()
            except BaseException as error:
                self.errors.append(error)
                raise
            finally:
                self.remember(client)
        # WebSocket connection_lost cancels keepalive; join that cancellation.
        pending = [task for task in self.tasks if not task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if not self.closed:
            raise RuntimeError("Browser session native transport remains live")

    @property
    def closed(self) -> bool:
        return (
            self.sealed
            and not self.acquisitions
            and (self.stop_task is None or self.stop_task.done())
            and (self.close_task is None or self.close_task.done() or self.close_task is asyncio.current_task())
            and all(task.done() for task in self.tasks)
            and all(getattr(client, "ws", None) is None for client in self.clients.values())
            and all(getattr(socket, "state", None) is State.CLOSED for socket in self.sockets.values())
        )


class BrowserSessionOwnershipMixin:
    """Wrap SDK lifecycle entrypoints without copying its connection logic."""

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_cdp_client_root":
            custody = self._native_custody
            custody.remember(getattr(self, name, None))
            custody.remember(value)
        elif name == "_reconnect_task" and value is not None:
            self._native_custody.tasks.add(value)
        super().__setattr__(name, value)

    async def start(self) -> None:
        with self._native_custody.acquiring():
            try:
                await super().start()
            finally:
                self._native_custody.remember(self._cdp_client_root)

    async def on_BrowserStartEvent(self, event):
        with self._native_custody.acquiring():
            try:
                return await super().on_BrowserStartEvent(event)
            finally:
                self._native_custody.remember(self._cdp_client_root)

    async def connect(self, cdp_url: str | None = None):
        with self._native_custody.acquiring():
            try:
                return await super().connect(cdp_url)
            finally:
                self._native_custody.remember(self._cdp_client_root)

    async def reconnect(self) -> None:
        with self._native_custody.acquiring():
            try:
                await super().reconnect()
            finally:
                self._native_custody.remember(self._cdp_client_root)

    async def _auto_reconnect(self, max_attempts: int = 3) -> None:
        with self._native_custody.acquiring():
            try:
                await super()._auto_reconnect(max_attempts)
            finally:
                self._native_custody.remember(self._cdp_client_root)

    async def get_or_create_cdp_session(self, target_id=None, focus: bool = True):
        with self._native_custody.acquiring():
            return await super().get_or_create_cdp_session(target_id, focus)

    async def reset(self) -> None:
        custody = self._native_custody
        with custody.acquiring(allow_teardown=asyncio.current_task() is custody.stop_task):
            custody.remember(self._cdp_client_root)
            try:
                await super().reset()
            finally:
                custody.remember(self._cdp_client_root)
                if custody.sealed:
                    self._intentional_stop = True


@lru_cache(maxsize=None)
def _owned_session_type(native_type: type) -> type:
    class OwnedBrowserSession(BrowserSessionOwnershipMixin, native_type):
        _native_custody: BrowserSessionCustody = PrivateAttr(default_factory=BrowserSessionCustody)

    return OwnedBrowserSession


def create_owned_browser_session(factory: Any, **kwargs: Any) -> Any:
    # Resolve only the factory supplied by this caller. Importing the SDK class
    # while a test factory is installed would permanently capture that mock.
    if isinstance(factory, type) and factory.__module__ == "browser_use.browser.session":
        return _owned_session_type(factory)(**kwargs)
    return factory(**kwargs)
