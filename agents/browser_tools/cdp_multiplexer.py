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
# Tilion accepts a second CDP socket and closes it at once with 4409 while
# another client still holds the session, and frees the slot asynchronously
# after that client closes (e.g. the backend's recovery probe client right
# before recover-challenge answers). A fresh upstream is therefore confirmed
# quiet for a short window before any client command is forwarded, and an
# early 4409 is redialled with bounded backoff, invisibly to the clients.
_SLOT_CONFIRM_SECONDS = 0.6
_SLOT_RETRY_DELAYS_SECONDS = (0.5, 1.0, 2.0, 3.0, 4.0)
_SLOT_BUSY_CLOSE_CODE = 4409
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
# Overrides Chrome keeps once per target, owned by the session that set it and
# lost when that session detaches ("Another ... override is already in effect"
# for every other session). Re-applied on a surviving session when the holder goes.
_EXCLUSIVE_OVERRIDES = ("Emulation.setTimezoneOverride", "Emulation.setLocaleOverride")
# Tilion drops (never answers, never delivers) a key event sent while another
# Input event is unanswered on the same CDP session (live 2026-10-21/22, T37).
# Key events are therefore isolated per session (see _forward_input_in_order);
# mouse events still pipeline. Any Input the provider leaves unanswered is
# failed back to its client after this bound instead of hanging it (Playwright
# awaits input forever). A late mouse event is usually still delivered: a page
# whose renderer is starved (e.g. FCaptcha's PoW workers) acks input, DOM and
# Runtime calls only once its main thread frees, so clients must treat this
# error as "sent, ack late" for mouse input and must not re-send it.
_INPUT_ANSWER_TIMEOUT_SECONDS = 10.0
# Stable text of that error reply; the humanizer keys its skip-and-continue on it.
UNANSWERED_INPUT_MARKER = "was not answered by the browser provider"
# A CDP session whose oldest forwarded command has had no reply for this long is
# reported once, naming its target and the pending methods, with the age of the
# newest reply on ANY session: a busy renderer (challenge JS) silences only the
# pages it hosts, a dead provider socket silences everything (T83).
_SILENCE_THRESHOLD_SECONDS = 30.0
_SILENCE_CHECK_SECONDS = 5.0
# The watchdog also notices the worker's own event loop stalling (several agents
# share one worker process): a check that wakes this much later than scheduled.
_LOOP_STALL_SECONDS = 5.0
# Empty authenticator the multiplexer installs so an unarmed WebAuthn ceremony
# rejects instead of opening the native chooser (see arm_webauthn).
_EMPTY_AUTHENTICATOR = {
    "protocol": "ctap2",
    "transport": "internal",
    "hasResidentKey": True,
    "hasUserVerification": True,
    "isUserVerified": True,
    "automaticPresenceSimulation": True,
}


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
        input_answer_timeout: float = _INPUT_ANSWER_TIMEOUT_SECONDS,
        slot_confirm_seconds: float = _SLOT_CONFIRM_SECONDS,
        slot_retry_delays: Tuple[float, ...] = _SLOT_RETRY_DELAYS_SECONDS,
        arm_webauthn: bool = True,
        label: str = "",
        silence_threshold: float = _SILENCE_THRESHOLD_SECONDS,
        silence_check_interval: float = _SILENCE_CHECK_SECONDS,
        loop_stall_threshold: float = _LOOP_STALL_SECONDS,
    ) -> None:
        self._upstream_url = upstream_url
        self._refresh_url = refresh_url
        self._upstream_connect = upstream_connect or _default_upstream_connect
        self._label = label
        self._server: Any = None
        self._local_url = ""
        self._upstream: Any = None
        self._dialing_upstream: Any = None
        self._reader: Optional[asyncio.Task] = None
        self._upstream_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
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
        # WebAuthn with the native UI off plus an EMPTY internal virtual
        # authenticator on every page/iframe target before its first script.
        # Without it a page the worker never armed opens Chrome's passkey
        # chooser, which on a single-client provider (Tilion) cannot be
        # dismissed by Escape, is not a CDP target and is not in the live view.
        # enable alone is not enough: with no authenticator credentials.get
        # still waits; with an empty one it rejects NotAllowedError at once.
        # Internal, not usb: an extra usb authenticator makes Chrome reject
        # assertions from DOMService's seeded internal one (local, 2026-10-22).
        # DOMService then hits "one internal authenticator per environment" and
        # its existing recovery (disable + enable + add on its session) takes
        # over; seeded assertions resolve. Once per target.
        self._arm_webauthn = arm_webauthn
        self._webauthn_armed_targets: Set[str] = set()
        # Chrome drops a session's WebAuthn environment when that session
        # detaches, so forget the target then and let the next attach re-arm it.
        self._webauthn_armed_by_session: Dict[str, str] = {}
        self._hold_new_targets = bool(self._emulation) or arm_webauthn
        self._wants_debugger_wait: Dict[Tuple[_Client, str], bool] = {}
        self._background: Set[asyncio.Task] = set()
        self._browser_user_agent: Optional[str] = None
        self.emulation_applied = 0
        self.emulation_failures = 0
        # Per-session Input serialisation: the tail future resolves when the
        # last Input command queued on that session is answered or expired.
        self._input_answer_timeout = input_answer_timeout
        self._input_tail: Dict[str, asyncio.Future] = {}  # last key event per session
        self._input_inflight: Dict[str, Dict[int, asyncio.Future]] = {}
        self._input_done: Dict[int, Tuple[asyncio.Future, Optional[asyncio.TimerHandle]]] = {}
        # Upstream session of each in-flight Input command: an expiry error must
        # carry it, because flat-session clients route replies by sessionId (a
        # root-level reply to a page-session id killed Playwright's driver).
        self._input_session: Dict[int, str] = {}
        # Upstream ids failed back on expiry; their late real reply is dropped
        # (the client already got an answer for that id). Bounded.
        self._expired_inputs: Set[int] = set()
        self.late_input_replies_dropped = 0
        self.input_unanswered = 0
        self.locale_mismatches = 0
        # Chrome keeps one locale override per target, owned by the session that
        # set it; it ends when that session detaches. Track the holder so its
        # detach (browser-use session churn, client release, rotation) is
        # followed by a read-back on a remaining session of the same target.
        self._session_target: Dict[str, str] = {}
        self._override_holder: Dict[Tuple[str, str], str] = {}
        # Send an exclusive override to a target once: skip it while another of
        # our sessions claims it, or after the target refused it 'already in
        # effect' (another holder, e.g. the provider's persona or the opener's
        # renderer). Cleared when our holder detaches (re-apply) or the target dies.
        self._override_claim: Dict[Tuple[str, str], str] = {}
        self._override_refused: Set[Tuple[str, str]] = set()
        self.emulation_refused = 0
        self.overrides_reapplied = 0
        self._closed = False
        self._checkpoint_close: Optional[asyncio.Future] = None
        self._checkpoint_close_task: Optional[asyncio.Task] = None
        self.upstream_connections_opened = 0
        self._slot_confirm_seconds = slot_confirm_seconds
        self._slot_retry_delays = tuple(slot_retry_delays)
        self.slot_busy_retries = 0
        # Bytes Tilion relayed to us: what it bills as the session's CDP egress.
        self.upstream_bytes_received = 0
        self.last_upstream_close: Optional[Tuple[Optional[int], str]] = None
        # Silence watchdog (T83): forwarded client commands awaiting a reply, the
        # target behind each session, and the sessions currently reported silent.
        self._silence_threshold = silence_threshold
        self._silence_check_interval = silence_check_interval
        self._pending_since: Dict[int, Tuple[float, str]] = {}
        self._session_info: Dict[str, Tuple[str, str, str]] = {}
        self._silent_since: Dict[str, float] = {}
        self._last_reply_at: Optional[float] = None
        self._watchdog: Optional[asyncio.Task] = None
        self.silent_sessions = 0
        self.silence_recoveries = 0
        self._loop_stall_threshold = loop_stall_threshold
        self.loop_stalls = 0

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
        if self._watchdog is None and self._silence_threshold > 0:
            self._watchdog = asyncio.create_task(self._watch_silence())
        return self._local_url

    async def close(self) -> None:
        self._closed = True
        async with self._close_lock:
            if self._watchdog is not None:
                self._watchdog.cancel()
                await asyncio.gather(self._watchdog, return_exceptions=True)
                self._watchdog = None
            for task in list(self._background):
                task.cancel()
            for client in list(self._clients):
                await self._close_client(client, code=1001, reason="multiplexer closed")
            if self._server is not None:
                self._server.close()
                await self._server.wait_closed()
                self._server = None
            await self._close_upstream()
            # The reader can admit work while sockets are closing. Drain only
            # after it stops, retaining descendants registered while unwinding.
            while self._background:
                tasks = list(self._background)
                for task in tasks:
                    if not task.cancelling():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                self._background.difference_update(tasks)

    async def _close_client(self, client: _Client, *, code: int, reason: str) -> None:
        await client.websocket.close(code=code, reason=reason)
        await client.websocket.wait_closed()
        if client.sender is not None:
            client.sender.cancel()
            await asyncio.gather(client.sender, return_exceptions=True)
            client.sender = None
        self._clients.discard(client)

    async def disconnect_confirmed(self, disconnect: Callable[[], Awaitable[None]]) -> None:
        """Fence new dials and confirm the transport actually closed by owner detach."""
        async with self._upstream_lock:
            self._closed = True
            if self._checkpoint_close is None:
                self._checkpoint_close = asyncio.get_running_loop().create_future()
                self._checkpoint_close.add_done_callback(
                    lambda done: done.exception() if not done.cancelled() else None
                )
            closed = self._checkpoint_close
        try:
            await disconnect()
            await closed
        except BaseException:
            closer = self._checkpoint_close_task
            if closer is not None and closer is not asyncio.current_task():
                closer.cancel()
            raise

    # ----- upstream -------------------------------------------------------

    async def _dial_upstream(self) -> Any:
        try:
            return await self._upstream_connect(self._upstream_url)
        except websockets.InvalidStatus as error:
            # Tilion connect tokens last 1800 s; an expired one is refused
            # with HTTP 403 at the handshake. Mint a fresh URL once.
            status = getattr(getattr(error, "response", None), "status_code", None)
            fresh = await self._refresh_url() if status == 403 and self._refresh_url else None
            if not fresh or fresh == self._upstream_url:
                raise CdpMultiplexerUpstreamClosed(status, "provider refused the CDP handshake") from error
            logger.info("[CdpMux] Reattaching with a freshly minted CDP URL (label=%s)", self._label)
            self._upstream_url = fresh
            return await self._upstream_connect(self._upstream_url)

    async def _dial_confirmed_upstream(self) -> Any:
        """Dial, then confirm the provider did not refuse the slot (4409) within the
        confirm window; redial with bounded backoff while it reports the slot busy."""
        delays = list(self._slot_retry_delays)
        while True:
            upstream = await self._dial_upstream()
            # Keep native custody through confirmation without exposing a
            # socket that has no reader to commands or departing clients.
            self._dialing_upstream = upstream
            if self._slot_confirm_seconds <= 0:
                return upstream
            try:
                # Nothing was sent yet, so any frame is unexpected; only a close matters.
                await asyncio.wait_for(upstream.recv(), timeout=self._slot_confirm_seconds)
                return upstream
            except asyncio.TimeoutError:
                return upstream
            except websockets.ConnectionClosed:
                code = getattr(upstream, "close_code", None)
                reason = getattr(upstream, "close_reason", "") or ""
                await upstream.wait_closed()
                self._dialing_upstream = None
                if code != _SLOT_BUSY_CLOSE_CODE or not delays:
                    raise CdpMultiplexerUpstreamClosed(code, reason or "provider closed the CDP socket") from None
                delay = delays.pop(0)
                self.slot_busy_retries += 1
                logger.warning(
                    "[CdpMux] Provider reports the session busy (4409: %s); redialling in %.1fs (label=%s)",
                    reason[:80],
                    delay,
                    self._label,
                )
                await asyncio.sleep(delay)

    async def _ensure_upstream(self) -> None:
        async with self._upstream_lock:
            if self._closed:
                raise CdpMultiplexerUpstreamClosed(1001, "multiplexer closed")
            if self._upstream is not None:
                return
            # A previous confirmation may have failed/cancelled. It cannot be
            # reused, and another dial cannot bypass its retained native owner.
            await self._close_dialing_upstream()
            upstream = await self._dial_confirmed_upstream()
            self._reader = asyncio.create_task(self._read_upstream(upstream))
            self._upstream = upstream
            self._dialing_upstream = None
            self.upstream_connections_opened += 1
            logger.info(
                "[CdpMux] Upstream CDP socket attached (label=%s, opened=%d)",
                self._label,
                self.upstream_connections_opened,
            )

    async def _close_dialing_upstream(self) -> None:
        """Called under _upstream_lock; failed closure retains native custody."""
        upstream = self._dialing_upstream
        if upstream is not None:
            await upstream.close()
            await upstream.wait_closed()
            self._dialing_upstream = None

    async def _close_upstream(self) -> None:
        async with self._upstream_lock:
            upstream, reader = self._upstream, self._reader
            self._fail_internal(CdpMultiplexerUpstreamClosed(1000, "released"))
            self._pending.clear()
            self._pending_since.clear()
            self._silent_since.clear()
            self._fail_pending_input()
            self._session_owner.clear()
            self._browser_session_owner.clear()
            self._hidden_sessions.clear()
            self._webauthn_armed_targets.clear()
            self._webauthn_armed_by_session.clear()
            self._session_target.clear()
            self._override_holder.clear()
            self._override_claim.clear()
            self._override_refused.clear()
            self._wants_debugger_wait.clear()
            self._browser_user_agent = None
            self._checkpoint_close_task = asyncio.current_task()
            try:
                await self._close_dialing_upstream()
                if upstream is not None:
                    # The owner must remain reachable during both awaits. A
                    # close request (or cancellation) is not a native receipt.
                    await upstream.close()
                    await upstream.wait_closed()
                if reader is not None and reader is not asyncio.current_task():
                    reader.cancel()
                    await asyncio.gather(reader, return_exceptions=True)
                self._upstream, self._reader = None, None
            except BaseException as error:
                if self._checkpoint_close is not None and not self._checkpoint_close.done():
                    self._checkpoint_close.set_exception(error)
                raise
            finally:
                self._checkpoint_close_task = None
            if upstream is not None:
                logger.info("[CdpMux] Upstream CDP socket released (label=%s)", self._label)
            if self._checkpoint_close is not None and not self._checkpoint_close.done():
                self._checkpoint_close.set_result(None)

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
                self.upstream_bytes_received += len(raw) if isinstance(raw, bytes) else len(raw.encode("utf-8"))
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
        # A reader error can occur while the socket is still live. Confirm its
        # closure before relinquishing the native handle or notifying clients.
        async with self._upstream_lock:
            if self._upstream is not upstream:
                return
            await upstream.close()
            await upstream.wait_closed()
            self._upstream = None
        self._fail_internal(CdpMultiplexerUpstreamClosed(code, reason))
        self._pending.clear()
        self._pending_since.clear()
        self._silent_since.clear()
        self._fail_pending_input()
        self._session_owner.clear()
        self._browser_session_owner.clear()
        self._webauthn_armed_targets.clear()
        self._webauthn_armed_by_session.clear()
        self._session_target.clear()
        self._override_holder.clear()
        self._override_claim.clear()
        self._override_refused.clear()
        for client in list(self._clients):
            await self._close_client(client, code=_downstream_close_code(code), reason=reason[:120])
        if self._reader is asyncio.current_task():
            self._reader = None

    async def _route_upstream(self, raw: Any) -> None:
        message = json.loads(raw)
        message_id = message.get("id")
        if message_id is not None:
            future = self._internal.pop(message_id, None)
            if future is not None:
                if not future.done():
                    future.set_result(message)
                return
            self._finish_input(message_id)
            self._note_reply(message_id)
            pending = self._pending.pop(message_id, None)
            if pending is None:
                if message_id in self._expired_inputs:
                    self._expired_inputs.discard(message_id)
                    self.late_input_replies_dropped += 1
                    logger.info("[CdpMux] Dropped a late provider reply to an expired input (label=%s)", self._label)
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
        self._track_target_url(session_id, method, params)
        if method == "Target.attachedToTarget" and params.get("sessionId"):
            info = params.get("targetInfo") or {}
            self._session_info[str(params["sessionId"])] = (
                str(info.get("targetId") or ""),
                str(info.get("type") or ""),
                str(info.get("url") or ""),
            )
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
            if self._hold_new_targets and target_type in _EMULATED_TARGET_TYPES:
                released: asyncio.Future = asyncio.get_running_loop().create_future()
                client.outbox.put_nowait(released)
                task = asyncio.create_task(self._apply_emulation_then_release(client, session_id, message, released))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
                return
        await self._send_to_client(client, message)
        if method == "Target.targetDestroyed" and params.get("targetId"):
            self._webauthn_armed_targets.discard(str(params["targetId"]))
            self._forget_target_overrides(str(params["targetId"]))
        if method == "Target.detachedFromTarget" and params.get("sessionId"):
            self._reapply_overrides_after_detach([str(params["sessionId"])])
            armed_target = self._webauthn_armed_by_session.pop(str(params["sessionId"]), None)
            if armed_target is not None:
                self._webauthn_armed_targets.discard(armed_target)
            self._session_owner.pop(params["sessionId"], None)
            self._session_info.pop(str(params["sessionId"]), None)
            self._drop_session_silence(str(params["sessionId"]), "it detached")
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

    async def _send_emulation(self, session_id: str, target_id: str = "") -> List[Tuple[str, asyncio.Future]]:
        commands = []
        if self._arm_webauthn and target_id and target_id not in self._webauthn_armed_targets:
            self._webauthn_armed_targets.add(target_id)
            self._webauthn_armed_by_session[session_id] = target_id
            commands.append(("WebAuthn.enable", {"enableUI": False}))
            commands.append(("WebAuthn.addVirtualAuthenticator", {"options": _EMPTY_AUTHENTICATOR}))
        for method in _EXCLUSIVE_OVERRIDES:
            params = self._override_params(method)
            if params is None or not self._claim_override(target_id, method, session_id):
                continue
            commands.append((method, params))
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
        target_id = str((params.get("targetInfo") or {}).get("targetId") or "")
        if target_id:
            self._session_target[child] = target_id
        sent: List[Tuple[str, asyncio.Future]] = []
        try:
            sent = await asyncio.wait_for(
                self._send_emulation(child, target_id), timeout=_EMULATION_COMMAND_TIMEOUT_SECONDS
            )
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
                message_text = str((response.get("error") or {}).get("message") or response["error"])
                if method in _EXCLUSIVE_OVERRIDES and "already in effect" in message_text:
                    # Expected: one holder per target/renderer. Do not resend to it.
                    self.emulation_refused += 1
                    if target_id:
                        self._override_refused.add((target_id, method))
                        if self._override_claim.get((target_id, method)) == child:
                            self._override_claim.pop((target_id, method), None)
                    logger.debug("[CdpMux] %s already held for target %s", method, target_id[:12] or child[:12])
                    continue
                self.emulation_failures += 1
                logger.info("[CdpMux] %s not applied on %s: %s", method, child[:12], message_text[:160])
            elif method in _EXCLUSIVE_OVERRIDES and target_id:
                self._override_holder[(target_id, method)] = child
        if sent:
            self.emulation_applied += 1

    async def _verify_child_locale(self, child: str) -> None:
        """Read back the document's Intl locale after a rejected override; log a mismatch as an error."""
        wanted = str(self._emulation.get("locale") or "")
        try:
            future = await self._send_session_command(
                child,
                "Runtime.evaluate",
                {"expression": "Intl.DateTimeFormat().resolvedOptions().locale", "returnByValue": True},
            )
            response = await asyncio.wait_for(future, timeout=_EMULATION_COMMAND_TIMEOUT_SECONDS)
        except Exception as error:
            logger.warning("[CdpMux] Could not read back locale on %s: %s", child[:12], str(error)[:120])
            return
        actual = str(((response.get("result") or {}).get("result") or {}).get("value") or "")
        if actual and wanted and actual.lower() != wanted.lower():
            self.locale_mismatches += 1
            logger.error(
                "[CdpMux] Locale override not in effect on %s: wanted %s, document reports %s",
                child[:12],
                wanted,
                actual,
            )

    def _claim_override(self, target_id: str, method: str, session_id: str) -> bool:
        """True when this session should send the exclusive override to its target."""
        if not target_id:
            return True
        key = (target_id, method)
        if key in self._override_refused:
            return False
        claimer = self._override_claim.get(key)
        if claimer is not None and claimer != session_id and claimer in self._session_target:
            return False
        self._override_claim[key] = session_id
        return True

    def _forget_target_overrides(self, target_id: str) -> None:
        for method in _EXCLUSIVE_OVERRIDES:
            self._override_claim.pop((target_id, method), None)
            self._override_refused.discard((target_id, method))
            self._override_holder.pop((target_id, method), None)

    def _override_params(self, method: str) -> Optional[Dict[str, Any]]:
        if method == "Emulation.setTimezoneOverride" and self._emulation.get("timezone"):
            return {"timezoneId": self._emulation["timezone"]}
        if method == "Emulation.setLocaleOverride" and self._emulation.get("locale"):
            return {"locale": self._emulation["locale"]}
        return None

    def _reapply_overrides_after_detach(self, sessions: List[str], after: Optional[Awaitable[Any]] = None) -> None:
        """A session holding a target's timezone/locale override detached: the
        override ended with it. Re-apply it on a surviving session of that target
        (after the detach completes, or Chrome still refuses it) and read back."""
        orphaned: List[Tuple[str, str]] = []
        for session in sessions:
            target_id = self._session_target.pop(session, None)
            if target_id is None:
                continue
            for method in _EXCLUSIVE_OVERRIDES:
                if self._override_holder.get((target_id, method)) == session:
                    self._override_holder.pop((target_id, method), None)
                    self._override_refused.discard((target_id, method))
                    self._override_claim.pop((target_id, method), None)
                    orphaned.append((target_id, method))
        if not orphaned:
            return

        async def reapply() -> None:
            """Restore each orphaned override on a still-bound session of its target."""
            if after is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(after, timeout=_EMULATION_COMMAND_TIMEOUT_SECONDS)
            for target_id, method in orphaned:
                params = self._override_params(method)
                if params is None:
                    continue
                survivors = [s for s, t in self._session_target.items() if t == target_id]
                saw_dead_session = False
                for survivor in survivors:
                    if self._session_target.get(survivor) != target_id:
                        continue
                    try:
                        future = await self._send_session_command(survivor, method, params)
                        response = await asyncio.wait_for(future, timeout=_EMULATION_COMMAND_TIMEOUT_SECONDS)
                    except Exception as error:
                        response = {"error": {"message": f"not sent: {type(error).__name__}"}}
                    failure = response.get("error") or {}
                    if failure.get("code") == -32001 and failure.get("message") == "Session with given id not found.":
                        saw_dead_session = True
                        # Native detach can precede its event. Retire that
                        # confirmed-dead locator and use another session of
                        # the SAME target; do not abandon its emulation.
                        if self._session_target.get(survivor) == target_id:
                            self._reapply_overrides_after_detach([survivor])
                        continue
                    if "error" in response:
                        logger.error(
                            "[CdpMux] %s holder for target %s detached and re-apply on %s failed: %s",
                            method,
                            target_id[:12],
                            survivor[:12],
                            str(failure)[:160],
                        )
                    elif self._session_target.get(survivor) != target_id:
                        continue
                    else:
                        self.overrides_reapplied += 1
                        self._override_holder[(target_id, method)] = survivor
                        self._override_claim[(target_id, method)] = survivor
                        logger.info("[CdpMux] Re-applied %s on %s after its holder detached", method, survivor[:12])
                    if method == "Emulation.setLocaleOverride":
                        await self._verify_child_locale(survivor)
                    break
                else:
                    if saw_dead_session and (target_id, method) not in self._override_holder:
                        logger.error(
                            "[CdpMux] %s holder for target %s detached; every surviving locator was lost",
                            method,
                            target_id[:12],
                        )

        task = asyncio.create_task(reapply())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    def _note_reply(self, message_id: int) -> None:
        now = asyncio.get_running_loop().time()
        self._last_reply_at = now
        entry = self._pending_since.pop(message_id, None)
        if entry is None:
            return
        session_id = entry[1]
        since = self._silent_since.pop(session_id, None)
        if since is not None:
            self.silence_recoveries += 1
            logger.warning(
                "[CdpMux] Session %s (%s) answered again after %.0fs of silence (label=%s)",
                session_id[:12],
                self._describe_session(session_id),
                now - since,
                self._label,
            )

    def _track_target_url(self, session_id: str, method: Any, params: Dict[str, Any]) -> None:
        """Keep each session's current URL so a silence report names the page, not about:blank."""
        if method == "Page.frameNavigated":
            frame = params.get("frame") or {}
            if not frame.get("parentId") and session_id in self._session_info:
                target_id, target_type, _ = self._session_info[session_id]
                self._session_info[session_id] = (target_id, target_type, str(frame.get("url") or ""))
        elif method == "Target.targetInfoChanged":
            info = params.get("targetInfo") or {}
            for session, (target_id, target_type, _) in list(self._session_info.items()):
                if target_id and target_id == info.get("targetId"):
                    self._session_info[session] = (target_id, target_type, str(info.get("url") or ""))

    def _end_silence_if_idle(self, session_id: str, why: str) -> None:
        if session_id in self._silent_since and not any(entry[1] == session_id for entry in self._pending_since.values()):
            self._drop_session_silence(session_id, why)

    def _drop_session_silence(self, session_id: str, why: str) -> None:
        for message_id, entry in list(self._pending_since.items()):
            if entry[1] == session_id and why == "it detached":
                self._pending_since.pop(message_id, None)
        since = self._silent_since.pop(session_id, None)
        if since is not None:
            logger.warning(
                "[CdpMux] Session %s no longer silent after %.0fs: %s (label=%s)",
                session_id[:12],
                asyncio.get_running_loop().time() - since,
                why,
                self._label,
            )

    def _describe_session(self, session_id: str) -> str:
        if any(client.browser_session_id == session_id for client in self._clients):
            return "browser-level"
        target_id, target_type, url = self._session_info.get(session_id, ("", "", ""))
        return f"target {target_id[:12] or '?'} {target_type or '?'} {url[:120]}"

    def silence_report(self) -> List[Dict[str, Any]]:
        """Sessions whose oldest pending command exceeds the threshold, oldest first."""
        now = asyncio.get_running_loop().time()
        by_session: Dict[str, List[Tuple[float, str]]] = {}
        for message_id, (sent_at, session_id) in list(self._pending_since.items()):
            pending = self._pending.get(message_id)
            if pending is None:
                self._pending_since.pop(message_id, None)
                continue
            by_session.setdefault(session_id, []).append((sent_at, pending[2]))
        report = []
        for session_id, items in by_session.items():
            items.sort()
            oldest_at, oldest_method = items[0]
            if now - oldest_at < self._silence_threshold:
                continue
            report.append(
                {
                    "session": session_id,
                    "target": self._describe_session(session_id),
                    "oldest_method": oldest_method,
                    "oldest_age_s": round(now - oldest_at, 1),
                    "pending": len(items),
                    "pending_methods": sorted({method for _, method in items})[:8],
                    "last_reply_any_session_s": None if self._last_reply_at is None else round(now - self._last_reply_at, 1),
                }
            )
        report.sort(key=lambda item: -item["oldest_age_s"])
        return report

    async def _watch_silence(self) -> None:
        loop = asyncio.get_running_loop()
        while not self._closed:
            scheduled = loop.time() + self._silence_check_interval
            await asyncio.sleep(self._silence_check_interval)
            lag = loop.time() - scheduled
            if lag >= self._loop_stall_threshold:
                self.loop_stalls += 1
                logger.warning(
                    "[CdpMux] Worker event loop stalled %.1fs (no CDP traffic was read meanwhile) (label=%s)",
                    lag,
                    self._label,
                )
            with contextlib.suppress(Exception):
                for item in self.silence_report():
                    if item["session"] in self._silent_since:
                        continue
                    self._silent_since[item["session"]] = asyncio.get_running_loop().time() - item["oldest_age_s"]
                    self.silent_sessions += 1
                    logger.warning(
                        "[CdpMux] Session %s silent for %.0fs: %s; %d pending, oldest %s; methods %s; "
                        "last reply on any session %ss ago (label=%s)",
                        item["session"][:12],
                        item["oldest_age_s"],
                        item["target"],
                        item["pending"],
                        item["oldest_method"],
                        ",".join(item["pending_methods"]),
                        item["last_reply_any_session_s"],
                        self._label,
                    )

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
            await websocket.wait_closed()
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
            await self._close_client(client, code=1000, reason="client disconnected")
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
        if not method.startswith("Input."):
            # Input ages from _send_input: a key the mux holds behind in-flight input is not provider silence.
            self._pending_since[message_id] = (asyncio.get_running_loop().time(), str(message["sessionId"]))
        if method.startswith("Input."):
            await self._forward_input_in_order(upstream, message_id, message)
            return
        if method == "Target.setAutoAttach" and self._hold_new_targets:
            # Hold every new target until its emulation lands; remember whether
            # this client resumes targets itself or the multiplexer must.
            params = dict(message.get("params") or {})
            self._wants_debugger_wait[(client, message["sessionId"])] = bool(params.get("waitForDebuggerOnStart"))
            if params.get("autoAttach"):
                params["waitForDebuggerOnStart"] = True
            message["params"] = params
        await upstream.send(json.dumps(message))

    async def _forward_input_in_order(self, upstream: Any, message_id: int, message: Dict[str, Any]) -> None:
        """Isolate key events on their CDP session, exactly as Tilion's drop rule needs.

        Tilion drops a key event sent while another Input event is unanswered on
        the same session (A1 live). So a key waits for every Input already in
        flight on its session, and any Input sent while a key is in flight or
        queued waits for that key. Mouse events after mouse events pipeline as
        they always did: serialising them too (T37 first cut) let humanizer idle
        drift outrun a ~100 ms provider round trip, queue clicks behind hundreds
        of moves and expire them (webdecoy checkbox, lane D f2cb5283).
        """
        session_id = str(message["sessionId"])
        is_key = message.get("method") == "Input.dispatchKeyEvent"
        loop = asyncio.get_running_loop()
        done: asyncio.Future = loop.create_future()
        inflight = self._input_inflight.setdefault(session_id, {})
        if is_key:
            waits = [future for future in inflight.values() if not future.done()]
            self._input_tail[session_id] = done
        else:
            key = self._input_tail.get(session_id)
            waits = [key] if key is not None and not key.done() else []
        inflight[message_id] = done

        def settled(_: asyncio.Future) -> None:
            inflight.pop(message_id, None)
            if not inflight:
                self._input_inflight.pop(session_id, None)
            if self._input_tail.get(session_id) is done:
                self._input_tail.pop(session_id, None)

        done.add_done_callback(settled)
        self._input_done[message_id] = (done, None)
        self._input_session[message_id] = session_id
        if not waits:
            await self._send_input(upstream, message_id, message)
            return
        task = asyncio.create_task(self._send_input_after(waits, upstream, message_id, message))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _send_input_after(
        self, waits: List[asyncio.Future], upstream: Any, message_id: int, message: Dict[str, Any]
    ) -> None:
        # Each awaited command settles within its own answer bound (answered or expired).
        with contextlib.suppress(Exception):
            await asyncio.gather(*(asyncio.shield(future) for future in waits), return_exceptions=True)
        if message_id not in self._pending or self._upstream is not upstream:
            self._finish_input(message_id)
            return
        with contextlib.suppress(Exception):
            await self._send_input(upstream, message_id, message)

    async def _send_input(self, upstream: Any, message_id: int, message: Dict[str, Any]) -> None:
        entry = self._input_done.get(message_id)
        if entry is not None:
            timer = asyncio.get_running_loop().call_later(self._input_answer_timeout, self._expire_input, message_id)
            self._input_done[message_id] = (entry[0], timer)
        self._pending_since[message_id] = (asyncio.get_running_loop().time(), str(message["sessionId"]))
        await upstream.send(json.dumps(message))

    def _finish_input(self, message_id: int) -> None:
        self._input_session.pop(message_id, None)
        entry = self._input_done.pop(message_id, None)
        if entry is None:
            return
        done, timer = entry
        if timer is not None:
            timer.cancel()
        if not done.done():
            done.set_result(None)

    def _expire_input(self, message_id: int) -> None:
        """The provider never answered: fail the command back to its client and let the next one go.

        Removing it from _pending also drops the provider's late real reply."""
        pending = self._pending.pop(message_id, None)
        expired = self._pending_since.pop(message_id, None)
        session_id = self._input_session.get(message_id)
        self._finish_input(message_id)
        if expired is not None:
            self._end_silence_if_idle(expired[1], "its last pending command expired")
        if pending is None:
            return
        client, original_id, method = pending
        self.input_unanswered += 1
        if len(self._expired_inputs) >= 1000:
            self._expired_inputs.clear()
        self._expired_inputs.add(message_id)
        logger.warning(
            "[CdpMux] %s not answered by the provider within %gs; failing it to the client (label=%s)",
            method,
            self._input_answer_timeout,
            self._label,
        )
        error_reply: Dict[str, Any] = {
            "id": original_id,
            "error": {
                "code": -32000,
                "message": f"{method} {UNANSWERED_INPUT_MARKER} within "
                f"{self._input_answer_timeout:g}s (dropped input event)",
            },
        }
        # Same shape as a real reply routed by _route_upstream: the child session
        # stays, the client's own browser session (sent at root level) is dropped.
        if session_id and session_id != client.browser_session_id:
            error_reply["sessionId"] = session_id
        client.outbox.put_nowait(error_reply)

    def _fail_pending_input(self) -> None:
        for message_id in list(self._input_done):
            self._finish_input(message_id)
        self._input_tail.clear()
        self._input_inflight.clear()
        self._input_session.clear()
        self._expired_inputs.clear()

    async def _release_client(self, client: _Client) -> None:
        self._browser_session_owner.pop(client.browser_session_id, None)
        for session_id in client.child_sessions:
            self._session_owner.pop(session_id, None)
        for message_id in [key for key, value in self._pending.items() if value[0] is client]:
            self._pending.pop(message_id, None)
        if self._clients:
            if client.browser_session_id and self._upstream is not None:
                detached: Optional[asyncio.Future] = None
                with contextlib.suppress(Exception):
                    message_id = next(self._ids)
                    detached = asyncio.get_running_loop().create_future()
                    self._internal[message_id] = detached
                    await self._upstream.send(
                        json.dumps(
                            {
                                "id": message_id,
                                "method": "Target.detachFromTarget",
                                "params": {"sessionId": client.browser_session_id},
                            }
                        )
                    )
                # Its child sessions go with it and get no detach event downstream.
                self._reapply_overrides_after_detach(list(client.child_sessions), after=detached)
            return
        # Last local client gone: release the provider's single client slot.
        await self._close_upstream()
