"""One upstream CDP websocket shared by every local CDP client of a browser session.

Tilion admits exactly one CDP client per session: a second socket is accepted
and closed with 4409. The browser worker attaches browser-use (cdp-use) and
Playwright to the same session, so for such providers both connect to this
loopback multiplexer instead of the provider URL.

Each downstream client gets its own browser-target session
(``Target.attachToBrowserTarget``). Root-level commands from a client are sent
on that session, so per-session state such as ``Target.setAutoAttach`` and
``Browser.setDownloadBehavior`` stays isolated per client, exactly as with two
real sockets. Message ids are rewritten to one upstream id space; responses and
events are routed back by id and by CDP session ownership.

The upstream socket exists only while at least one downstream client is
connected. Tilion fails REST drive calls (screenshot, act, files/fetch) while a
client is attached, so the backend close/harvest path must see the socket gone
as soon as the worker disconnects. A later client reattaches with the same URL.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Tuple

import websockets

logger = logging.getLogger(__name__)

UpstreamConnect = Callable[[str], Awaitable[Any]]

_ATTACH_TIMEOUT_SECONDS = 30.0
# Browser.close on a provider CDP endpoint only disconnects that client
# (Tilion documents browser.close() as a disconnect); never forward it to the
# shared browser on behalf of one local client.
_CLIENT_LOCAL_METHODS = frozenset({"Browser.close"})


class CdpMultiplexerUpstreamClosed(ConnectionError):
    """The provider closed the shared CDP socket (code/reason preserved)."""

    def __init__(self, code: Optional[int], reason: str) -> None:
        super().__init__(f"provider CDP socket closed: code={code} reason={reason}")
        self.code = code
        self.reason = reason


@dataclass(eq=False)
class _Client:
    websocket: Any
    number: int
    browser_session_id: str = ""
    child_sessions: Set[str] = field(default_factory=set)


async def _default_upstream_connect(url: str) -> Any:
    return await websockets.connect(
        url, max_size=None, ping_interval=20, ping_timeout=60, proxy=None
    )


def _downstream_close_code(code: Optional[int]) -> int:
    # 1005/1006/1015 are reserved and cannot be sent; report them as 1011.
    if code is None or code in (1005, 1006, 1015):
        return 1011
    return code


class SingleCdpConnectionMultiplexer:
    def __init__(
        self,
        upstream_url: str,
        *,
        upstream_connect: Optional[UpstreamConnect] = None,
        refresh_url: Optional[Callable[[], Awaitable[Optional[str]]]] = None,
        label: str = "",
    ) -> None:
        self._upstream_url = upstream_url
        self._refresh_url = refresh_url
        self._upstream_connect = upstream_connect or _default_upstream_connect
        self._label = label
        self._server: Any = None
        self._local_url = ""
        self._upstream: Any = None
        self._reader: Optional[asyncio.Task] = None
        self._upstream_lock = asyncio.Lock()
        self._ids = itertools.count(1)
        self._clients: Set[_Client] = set()
        self._client_numbers = itertools.count(1)
        self._pending: Dict[int, Tuple[_Client, Any, str]] = {}
        self._internal: Dict[int, asyncio.Future] = {}
        self._session_owner: Dict[str, _Client] = {}
        self._browser_session_owner: Dict[str, _Client] = {}
        self._closed = False
        self.upstream_connections_opened = 0
        self.last_upstream_close: Optional[Tuple[Optional[int], str]] = None

    @property
    def local_url(self) -> str:
        return self._local_url

    @property
    def upstream_attached(self) -> bool:
        return self._upstream is not None

    async def start(self) -> str:
        if self._server is None:
            quiet = logging.getLogger(f"{__name__}.server")
            # browser-use probes the TCP port before its websocket handshake.
            quiet.setLevel(logging.CRITICAL)
            self._server = await websockets.serve(
                self._serve_client, "127.0.0.1", 0, max_size=None, logger=quiet
            )
            port = self._server.sockets[0].getsockname()[1]
            self._local_url = f"ws://127.0.0.1:{port}/devtools/browser/rose-single-cdp"
        return self._local_url

    async def close(self) -> None:
        self._closed = True
        for client in list(self._clients):
            with contextlib.suppress(Exception):
                await client.websocket.close(code=1001, reason="multiplexer closed")
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None
        await self._close_upstream()

    # ----- upstream -------------------------------------------------------

    async def _ensure_upstream(self) -> None:
        async with self._upstream_lock:
            if self._upstream is not None:
                return
            try:
                self._upstream = await self._upstream_connect(self._upstream_url)
            except websockets.InvalidStatus as error:
                # Tilion connect tokens last 1800 s; an expired one is refused
                # with HTTP 403 at the handshake. Mint a fresh URL once.
                status = getattr(getattr(error, "response", None), "status_code", None)
                fresh = await self._refresh_url() if status == 403 and self._refresh_url else None
                if not fresh or fresh == self._upstream_url:
                    raise CdpMultiplexerUpstreamClosed(status, "provider refused the CDP handshake") from error
                logger.info("[CdpMux] Reattaching with a freshly minted CDP URL (label=%s)", self._label)
                self._upstream_url = fresh
                self._upstream = await self._upstream_connect(self._upstream_url)
            self.upstream_connections_opened += 1
            self._reader = asyncio.create_task(self._read_upstream(self._upstream))
            logger.info(
                "[CdpMux] Upstream CDP socket attached (label=%s, opened=%d)",
                self._label,
                self.upstream_connections_opened,
            )

    async def _close_upstream(self) -> None:
        async with self._upstream_lock:
            upstream, reader = self._upstream, self._reader
            self._upstream, self._reader = None, None
            self._fail_internal(CdpMultiplexerUpstreamClosed(1000, "released"))
            self._pending.clear()
            self._session_owner.clear()
            self._browser_session_owner.clear()
            if upstream is not None:
                with contextlib.suppress(Exception):
                    await upstream.close()
            if reader is not None and reader is not asyncio.current_task():
                reader.cancel()
                with contextlib.suppress(BaseException):
                    await reader
            if upstream is not None:
                logger.info("[CdpMux] Upstream CDP socket released (label=%s)", self._label)

    def _fail_internal(self, error: BaseException) -> None:
        for future in self._internal.values():
            if not future.done():
                future.set_exception(error)
        self._internal.clear()

    async def _internal_command(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        upstream = self._upstream
        if upstream is None:
            raise CdpMultiplexerUpstreamClosed(*(self.last_upstream_close or (None, "not attached")))
        message_id = next(self._ids)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._internal[message_id] = future
        await upstream.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        response = await asyncio.wait_for(future, timeout=_ATTACH_TIMEOUT_SECONDS)
        if "error" in response:
            raise RuntimeError(f"{method} failed: {response['error']}")
        return response.get("result") or {}

    async def _read_upstream(self, upstream: Any) -> None:
        code: Optional[int] = None
        reason = ""
        try:
            async for raw in upstream:
                await self._route_upstream(raw)
        except websockets.ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("[CdpMux] Upstream reader failed: %s", error)
        code = getattr(upstream, "close_code", None)
        reason = getattr(upstream, "close_reason", "") or ""
        if self._upstream is not upstream:
            return
        self.last_upstream_close = (code, reason)
        logger.warning(
            "[CdpMux] Provider closed the CDP socket (label=%s, code=%s, reason=%s)",
            self._label,
            code,
            reason[:120],
        )
        self._upstream, self._reader = None, None
        self._fail_internal(CdpMultiplexerUpstreamClosed(code, reason))
        self._pending.clear()
        self._session_owner.clear()
        self._browser_session_owner.clear()
        for client in list(self._clients):
            with contextlib.suppress(Exception):
                await client.websocket.close(code=_downstream_close_code(code), reason=reason[:120])

    async def _route_upstream(self, raw: Any) -> None:
        message = json.loads(raw)
        message_id = message.get("id")
        if message_id is not None:
            future = self._internal.pop(message_id, None)
            if future is not None:
                if not future.done():
                    future.set_result(message)
                return
            pending = self._pending.pop(message_id, None)
            if pending is None:
                return
            client, original_id, method = pending
            message["id"] = original_id
            if message.get("sessionId") == client.browser_session_id:
                message.pop("sessionId")
            if method == "Target.attachToTarget":
                child = (message.get("result") or {}).get("sessionId")
                if child:
                    self._own_session(client, child)
            await self._send_to_client(client, message)
            return

        session_id = message.get("sessionId")
        if not session_id:
            # Root-session events belong to the multiplexer's own session,
            # which enables no domains; nothing downstream subscribed to them.
            return
        client = self._browser_session_owner.get(session_id)
        if client is not None:
            message.pop("sessionId")
        else:
            client = self._session_owner.get(session_id)
        if client is None:
            return
        method = message.get("method")
        params = message.get("params") or {}
        if method == "Target.attachedToTarget" and params.get("sessionId"):
            self._own_session(client, params["sessionId"])
        await self._send_to_client(client, message)
        if method == "Target.detachedFromTarget" and params.get("sessionId"):
            self._session_owner.pop(params["sessionId"], None)
            client.child_sessions.discard(params["sessionId"])

    def _own_session(self, client: _Client, session_id: str) -> None:
        self._session_owner[session_id] = client
        client.child_sessions.add(session_id)

    async def _send_to_client(self, client: _Client, message: Dict[str, Any]) -> None:
        with contextlib.suppress(websockets.ConnectionClosed):
            await client.websocket.send(json.dumps(message))

    # ----- downstream -----------------------------------------------------

    async def _serve_client(self, websocket: Any) -> None:
        if self._closed:
            await websocket.close(code=1001, reason="multiplexer closed")
            return
        client = _Client(websocket=websocket, number=next(self._client_numbers))
        self._clients.add(client)
        try:
            try:
                await self._ensure_upstream()
                attached = await self._internal_command("Target.attachToBrowserTarget")
            except CdpMultiplexerUpstreamClosed as error:
                await websocket.close(code=_downstream_close_code(error.code), reason=error.reason[:120])
                return
            client.browser_session_id = str(attached["sessionId"])
            self._browser_session_owner[client.browser_session_id] = client
            async for raw in websocket:
                await self._forward_client_message(client, raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(client)
            await self._release_client(client)

    async def _forward_client_message(self, client: _Client, raw: Any) -> None:
        message = json.loads(raw)
        method = str(message.get("method") or "")
        original_id = message.get("id")
        if method in _CLIENT_LOCAL_METHODS and not message.get("sessionId"):
            await self._send_to_client(client, {"id": original_id, "result": {}})
            await client.websocket.close(code=1000, reason="client disconnected")
            return
        upstream = self._upstream
        if upstream is None:
            await client.websocket.close(code=1011, reason="provider CDP socket closed")
            return
        message_id = next(self._ids)
        self._pending[message_id] = (client, original_id, method)
        message["id"] = message_id
        if not message.get("sessionId"):
            message["sessionId"] = client.browser_session_id
        await upstream.send(json.dumps(message))

    async def _release_client(self, client: _Client) -> None:
        self._browser_session_owner.pop(client.browser_session_id, None)
        for session_id in client.child_sessions:
            self._session_owner.pop(session_id, None)
        for message_id in [key for key, value in self._pending.items() if value[0] is client]:
            self._pending.pop(message_id, None)
        if self._clients:
            if client.browser_session_id and self._upstream is not None:
                with contextlib.suppress(Exception):
                    await self._upstream.send(
                        json.dumps(
                            {
                                "id": next(self._ids),
                                "method": "Target.detachFromTarget",
                                "params": {"sessionId": client.browser_session_id},
                            }
                        )
                    )
            return
        # Last local client gone: release the provider's single client slot.
        await self._close_upstream()
