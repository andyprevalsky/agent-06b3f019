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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

import websockets

logger = logging.getLogger(__name__)

UpstreamConnect = Callable[[str], Awaitable[Any]]

_ATTACH_TIMEOUT_SECONDS = 30.0
# Browser.close on a provider CDP endpoint only disconnects that client
# (Tilion documents browser.close() as a disconnect); never forward it to the
# shared browser on behalf of one local client.
_CLIENT_LOCAL_METHODS = frozenset({"Browser.close"})
# Tilion's Chrome exposes its own UI surfaces (chrome://omnibox-popup.top-chrome)
# as type "browser_ui" targets, already attached, in getTargets and auto-attach.
# They are not the user's pages; no local client may see, select or drive them.
# Only this type is hidden: iframes, workers and service workers stay visible.
_HIDDEN_TARGET_TYPES = frozenset({"browser_ui"})
# Targets whose documents get the session's timezone/locale/user-agent
# emulation. Workers have no Emulation domain.
_EMULATED_TARGET_TYPES = frozenset({"page", "iframe"})
_EMULATION_COMMAND_TIMEOUT_SECONDS = 5.0


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
    # Ordered delivery: a held Target.attachedToTarget (a Future) blocks every
    # later message to this client until its emulation lands, so CDP ordering
    # (attach before Target.createTarget's response, before child events) holds.
    outbox: "asyncio.Queue[Any]" = field(default_factory=asyncio.Queue)
    sender: Optional[asyncio.Task] = None


async def _default_upstream_connect(url: str) -> Any:
    return await websockets.connect(url, max_size=None, ping_interval=20, ping_timeout=60, proxy=None)


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
        emulation: Optional[Dict[str, Any]] = None,
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
        self._hidden_target_ids: Set[str] = set()
        self._hidden_sessions: Set[str] = set()
        # emulation = {"timezone"?, "locale"?, "accept_language"?, "user_agent_override"?}.
        # Applied on every page/iframe session any client attaches, before the
        # target runs its first script (see _apply_emulation_then_forward).
        self._emulation = {key: value for key, value in (emulation or {}).items() if value}
        self._wants_debugger_wait: Dict[Tuple[_Client, str], bool] = {}
        self._background: Set[asyncio.Task] = set()
        self._browser_user_agent: Optional[str] = None
        self.emulation_applied = 0
        self.emulation_failures = 0
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
            self._server = await websockets.serve(self._serve_client, "127.0.0.1", 0, max_size=None, logger=quiet)
            port = self._server.sockets[0].getsockname()[1]
            self._local_url = f"ws://127.0.0.1:{port}/devtools/browser/rose-single-cdp"
        return self._local_url

    async def close(self) -> None:
        self._closed = True
        for task in list(self._background):
            task.cancel()
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
            self._hidden_sessions.clear()
            self._wants_debugger_wait.clear()
            self._browser_user_agent = None
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
            if method == "Target.getTargets":
                result = message.get("result") or {}
                infos = result.get("targetInfos")
                if isinstance(infos, list):
                    result["targetInfos"] = [info for info in infos if not self._hide_target(info)]
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
        if await self._drop_hidden_target_event(session_id, method, params):
            return
        if method == "Target.attachedToTarget" and params.get("sessionId"):
            self._own_session(client, params["sessionId"])
            target_type = (params.get("targetInfo") or {}).get("type")
            client_waits = self._wants_debugger_wait.get((client, session_id), True)
            if params.get("waitingForDebugger") and not client_waits and target_type not in _EMULATED_TARGET_TYPES:
                # Held only because the multiplexer forced waitForDebuggerOnStart
                # (workers, service workers): this client never resumes targets,
                # so release it now or it stays paused for good.
                params["waitingForDebugger"] = False
                with contextlib.suppress(Exception):
                    resumed = await self._send_session_command(
                        str(params["sessionId"]), "Runtime.runIfWaitingForDebugger", {}
                    )
                    resumed.add_done_callback(lambda done: done.cancelled() or done.exception())
            if self._emulation and target_type in _EMULATED_TARGET_TYPES:
                released: asyncio.Future = asyncio.get_running_loop().create_future()
                client.outbox.put_nowait(released)
                task = asyncio.create_task(self._apply_emulation_then_release(client, session_id, message, released))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
                return
        await self._send_to_client(client, message)
        if method == "Target.detachedFromTarget" and params.get("sessionId"):
            self._session_owner.pop(params["sessionId"], None)
            client.child_sessions.discard(params["sessionId"])

    def _hide_target(self, info: Any) -> bool:
        if isinstance(info, dict) and info.get("type") in _HIDDEN_TARGET_TYPES:
            if info.get("targetId"):
                self._hidden_target_ids.add(str(info["targetId"]))
            return True
        return False

    async def _drop_hidden_target_event(self, parent_session: str, method: Any, params: Dict[str, Any]) -> bool:
        """Swallow events about browser_ui targets; release any auto-attached one."""
        if method in ("Target.targetCreated", "Target.targetInfoChanged"):
            return self._hide_target(params.get("targetInfo"))
        if method in ("Target.targetDestroyed", "Target.targetCrashed"):
            return str(params.get("targetId") or "") in self._hidden_target_ids
        if method == "Target.detachedFromTarget":
            hidden = str(params.get("sessionId") or "") in self._hidden_sessions
            self._hidden_sessions.discard(str(params.get("sessionId") or ""))
            return hidden
        if method != "Target.attachedToTarget" or not self._hide_target(params.get("targetInfo")):
            return False
        child = str(params.get("sessionId") or "")
        upstream = self._upstream
        if child and upstream is not None:
            self._hidden_sessions.add(child)
            # Never leave it paused by waitForDebuggerOnStart, then let it go.
            if params.get("waitingForDebugger"):
                with contextlib.suppress(Exception):
                    await upstream.send(
                        json.dumps(
                            {"id": next(self._ids), "method": "Runtime.runIfWaitingForDebugger", "sessionId": child}
                        )
                    )
            with contextlib.suppress(Exception):
                await upstream.send(
                    json.dumps(
                        {
                            "id": next(self._ids),
                            "method": "Target.detachFromTarget",
                            "params": {"sessionId": child},
                            "sessionId": parent_session,
                        }
                    )
                )
        return True

    async def _send_session_command(self, session_id: str, method: str, params: Dict[str, Any]) -> asyncio.Future:
        """Send without waiting. Commands on one session are processed in order,
        so overrides sent before Runtime.runIfWaitingForDebugger land before the
        target's first script, although a paused target answers only after it runs."""
        upstream = self._upstream
        if upstream is None:
            raise CdpMultiplexerUpstreamClosed(*(self.last_upstream_close or (None, "not attached")))
        message_id = next(self._ids)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._internal[message_id] = future
        await upstream.send(json.dumps({"id": message_id, "method": method, "params": params, "sessionId": session_id}))
        return future

    async def _user_agent_override(self) -> Optional[Dict[str, Any]]:
        override = dict(self._emulation.get("user_agent_override") or {})
        accept_language = self._emulation.get("accept_language")
        if not override and not accept_language:
            return None
        if accept_language:
            override["acceptLanguage"] = accept_language
        if not override.get("userAgent"):
            if self._browser_user_agent is None:
                version = await self._internal_command("Browser.getVersion")
                self._browser_user_agent = str(version.get("userAgent") or "")
            override["userAgent"] = self._browser_user_agent
        return override

    async def _send_emulation(self, session_id: str) -> List[Tuple[str, asyncio.Future]]:
        commands = []
        if self._emulation.get("timezone"):
            commands.append(("Emulation.setTimezoneOverride", {"timezoneId": self._emulation["timezone"]}))
        if self._emulation.get("locale"):
            commands.append(("Emulation.setLocaleOverride", {"locale": self._emulation["locale"]}))
        user_agent_override = await self._user_agent_override()
        if user_agent_override:
            # Emulation (not Network) variant: no Network.enable, so no event
            # stream is turned on for a client that did not ask for it.
            commands.append(("Emulation.setUserAgentOverride", user_agent_override))
        return [(method, await self._send_session_command(session_id, method, params)) for method, params in commands]

    async def _apply_emulation_then_release(
        self, client: _Client, parent_session: str, message: Dict[str, Any], released: asyncio.Future
    ) -> None:
        params = message.get("params") or {}
        child = str(params["sessionId"])
        sent: List[Tuple[str, asyncio.Future]] = []
        try:
            sent = await asyncio.wait_for(self._send_emulation(child), timeout=_EMULATION_COMMAND_TIMEOUT_SECONDS)
        except Exception as error:
            self.emulation_failures += 1
            logger.warning("[CdpMux] Emulation for new target not sent; releasing it anyway: %s", str(error)[:200])
        try:
            client_waits = self._wants_debugger_wait.get((client, parent_session), True)
            if params.get("waitingForDebugger") and not client_waits:
                # The multiplexer forced the hold; this client expects a running target.
                params["waitingForDebugger"] = False
                with contextlib.suppress(Exception):
                    resumed = await self._send_session_command(child, "Runtime.runIfWaitingForDebugger", {})
                    resumed.add_done_callback(lambda done: done.cancelled() or done.exception())
        finally:
            if not released.done():
                released.set_result(message)
        for method, future in sent:
            try:
                response = await asyncio.wait_for(future, timeout=4 * _EMULATION_COMMAND_TIMEOUT_SECONDS)
            except Exception as error:
                response = {"error": {"message": f"no reply: {type(error).__name__}"}}
            if "error" in response:
                # Chrome keeps one timezone/locale override per target; another
                # client's session may already hold it.
                self.emulation_failures += 1
                logger.info("[CdpMux] %s not applied on %s: %s", method, child[:12], str(response["error"])[:160])
        if sent:
            self.emulation_applied += 1

    def _own_session(self, client: _Client, session_id: str) -> None:
        self._session_owner[session_id] = client
        client.child_sessions.add(session_id)

    async def _send_to_client(self, client: _Client, message: Dict[str, Any]) -> None:
        client.outbox.put_nowait(message)

    async def _drain_outbox(self, client: _Client) -> None:
        while True:
            item = await client.outbox.get()
            if isinstance(item, asyncio.Future):
                item = await item
            with contextlib.suppress(websockets.ConnectionClosed):
                await client.websocket.send(json.dumps(item))

    # ----- downstream -----------------------------------------------------

    async def _serve_client(self, websocket: Any) -> None:
        if self._closed:
            await websocket.close(code=1001, reason="multiplexer closed")
            return
        client = _Client(websocket=websocket, number=next(self._client_numbers))
        client.sender = asyncio.create_task(self._drain_outbox(client))
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
            if client.sender is not None:
                client.sender.cancel()
            await self._release_client(client)

    async def _forward_client_message(self, client: _Client, raw: Any) -> None:
        message = json.loads(raw)
        method = str(message.get("method") or "")
        original_id = message.get("id")
        if method in _CLIENT_LOCAL_METHODS and not message.get("sessionId"):
            with contextlib.suppress(websockets.ConnectionClosed):
                await client.websocket.send(json.dumps({"id": original_id, "result": {}}))
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
        if method == "Target.setAutoAttach" and self._emulation:
            # Hold every new target until its emulation lands; remember whether
            # this client resumes targets itself or the multiplexer must.
            params = dict(message.get("params") or {})
            self._wants_debugger_wait[(client, message["sessionId"])] = bool(params.get("waitForDebuggerOnStart"))
            if params.get("autoAttach"):
                params["waitForDebuggerOnStart"] = True
            message["params"] = params
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
