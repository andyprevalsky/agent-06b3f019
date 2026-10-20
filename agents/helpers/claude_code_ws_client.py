"""WebSocket client for Claude Code E2B sandbox communication.

Provides bidirectional communication with the Claude Code sandbox:
- Receives stdout/stderr/buffer/exit messages
- Sends stdin messages for follow-up prompts
- Handles reconnection with exponential backoff
"""

import asyncio
import json
from typing import Any, Awaitable, Callable, Optional

import aiohttp
import structlog

logger = structlog.get_logger()


class ClaudeCodeWsClient:
    """
    Async WebSocket client for Claude Code sandbox communication.

    Features:
    - Connects to E2B sandbox WebSocket
    - Receives stdout/stderr/exit messages
    - Sends stdin messages for follow-up prompts
    - Reconnection with exponential backoff
    - On reconnect, server sends full buffer (authoritative state)
    """

    def __init__(
        self,
        ws_url: str,
        on_output: Callable[[str, bool], Awaitable[None]],  # (data, is_buffer) -> None
        on_exit: Callable[[int], Awaitable[None]],  # (exit_code) -> None
        on_connection_change: Optional[Callable[[bool], Awaitable[None]]] = None,  # (is_connected) -> None
        on_stdin_error: Optional[Callable[[str], Awaitable[None]]] = None,  # (error_msg) -> None
        on_event: Optional[Callable[[dict[str, Any]], Awaitable[None]]] = None,
        heartbeat_fn: Optional[Callable[[str], None]] = None,
        max_reconnects: int = 5,
        reconnect_delay: float = 1.0,
        on_events_replay: Optional[Callable[[list[dict[str, Any]]], Awaitable[None]]] = None,
    ):
        """
        Initialize the WebSocket client.

        Args:
            ws_url: WebSocket URL to connect to (e.g., wss://sandbox-id.e2b.dev:3000)
            on_output: Callback for output data. Called with (data, is_buffer).
                       is_buffer=True means this is the full buffer from reconnect.
            on_exit: Callback when process exits. Called with exit code.
            on_connection_change: Callback when connection state changes. Called with True on connect, False on disconnect.
            on_stdin_error: Callback when server reports stdin delivery failure. Called with error message.
            on_event: Callback for normalized code-agent JSON events.
            heartbeat_fn: Optional Temporal activity heartbeat function.
            max_reconnects: Maximum reconnection attempts.
            reconnect_delay: Base delay for exponential backoff (seconds).
            on_events_replay: Callback for the server's full event history, sent on
                every (re)connect. Replaces everything seen so far; without it each
                replayed event goes to ``on_event``.
        """
        self.ws_url = ws_url
        self.on_output = on_output
        self.on_exit = on_exit
        self.on_connection_change = on_connection_change
        self.on_stdin_error = on_stdin_error
        self.on_event = on_event
        self.on_events_replay = on_events_replay
        self.heartbeat_fn = heartbeat_fn
        self.max_reconnects = max_reconnects
        self.reconnect_delay = reconnect_delay

        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._running = False
        self._reconnect_count = 0
        self._exited = False  # Process has exited, don't reconnect
        self._reconnects_exhausted = False  # All reconnect attempts failed
        self._stdin_ack_event: Optional[asyncio.Event] = None
        self._stdin_ack_result: Optional[bool] = None

    async def connect(self) -> bool:
        """
        Connect to the WebSocket server.

        Returns:
            True if connected successfully, False otherwise.
        """
        try:
            if self._session is None:
                self._session = aiohttp.ClientSession()

            self._ws = await asyncio.wait_for(
                self._session.ws_connect(
                    self.ws_url,
                    heartbeat=30.0,
                    receive_timeout=60.0,
                ),
                timeout=30.0,  # Don't hang if sandbox is dead
            )
            self._running = True
            self._reconnect_count = 0  # Reset on successful connect
            logger.info("[ClaudeCodeWs] Connected", url=self.ws_url[:60])

            # Notify connection state change
            if self.on_connection_change:
                await self.on_connection_change(True)

            return True

        except Exception as e:
            logger.error("[ClaudeCodeWs] Connection failed", error=str(e))
            return False

    async def disconnect(self) -> None:
        """Disconnect from the WebSocket server."""
        self._running = False
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None
        self._ws = None
        logger.info("[ClaudeCodeWs] Disconnected")

    async def send_stdin(self, data: str) -> bool:
        """
        Send data to Claude Code's stdin and wait for server acknowledgment.

        Blocks until the ws-server confirms the stdin write to the PTY succeeded
        (stdin_ack) or failed (stdin_error), with a 5s timeout.

        Args:
            data: Text to send to stdin.

        Returns:
            True if stdin was delivered to the process, False otherwise.
        """
        if not self._ws or self._ws.closed:
            logger.warning("[ClaudeCodeWs] Cannot send stdin - not connected")
            return False

        try:
            self._stdin_ack_event = asyncio.Event()
            self._stdin_ack_result = None

            msg = json.dumps({"type": "stdin", "data": data})
            await self._ws.send_str(msg)
            logger.info("[ClaudeCodeWs] Sent stdin, waiting for ack", bytes=len(data))

            # Wait for stdin_ack or stdin_error from server
            try:
                await asyncio.wait_for(self._stdin_ack_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.error("[ClaudeCodeWs] stdin ack timeout (5s)")
                return False
            finally:
                self._stdin_ack_event = None

            return self._stdin_ack_result or False
        except Exception as e:
            logger.error("[ClaudeCodeWs] stdin send failed", error=str(e))
            return False

    async def listen(self) -> None:
        """
        Main listen loop. Processes messages until exit or disconnect.

        Handles reconnection automatically on disconnect (unless process exited).
        Call this in a task after connect().
        """
        while self._running and not self._exited:
            try:
                await self._listen_loop()
            except asyncio.CancelledError:
                logger.info("[ClaudeCodeWs] Listen cancelled")
                break
            except asyncio.TimeoutError as e:
                logger.error("[ClaudeCodeWs] Receive timeout (no messages for 60s)", error=str(e))
            except Exception as e:
                logger.error("[ClaudeCodeWs] Listen error", error=str(e), error_type=type(e).__name__)

            # Don't reconnect if process exited or we're shutting down
            if self._exited or not self._running:
                break

            # Notify disconnection before attempting reconnect
            if self.on_connection_change:
                await self.on_connection_change(False)

            # Attempt reconnection
            if not await self._reconnect():
                logger.error("[ClaudeCodeWs] Max reconnects exceeded")
                self._reconnects_exhausted = True
                break

    async def _listen_loop(self) -> None:
        """Inner listen loop for a single connection."""
        if not self._ws:
            return

        msg_count = 0
        async for msg in self._ws:
            if not self._running:
                logger.info("[ClaudeCodeWs] Loop stopped (not running)", msg_count=msg_count)
                break

            msg_count += 1
            if msg.type == aiohttp.WSMsgType.TEXT:
                await self._handle_message(msg.data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                logger.error("[ClaudeCodeWs] WS error", error=str(self._ws.exception()), msg_count=msg_count)
                break
            elif msg.type == aiohttp.WSMsgType.CLOSED:
                logger.info("[ClaudeCodeWs] WS closed by server", msg_count=msg_count)
                break

            # Heartbeat on each message
            if self.heartbeat_fn:
                self.heartbeat_fn("Processing Claude Code output")

        # Log if loop exited without explicit break (e.g., receive_timeout)
        logger.info("[ClaudeCodeWs] Listen loop ended", msg_count=msg_count, exited=self._exited)

    async def _handle_message(self, data: str) -> None:
        """Handle a WebSocket message."""
        try:
            msg = json.loads(data)
            msg_type = msg.get("type")

            if msg_type == "buffer":
                # Full buffer (initial connect or reconnect) - authoritative state
                msg_data = msg.get("data", "")
                logger.info("[ClaudeCodeWs] Received buffer", bytes=len(msg_data))
                await self.on_output(msg_data, True)

            elif msg_type in ("stdout", "stderr"):
                # Live output chunk
                msg_data = msg.get("data", "")
                logger.debug("[ClaudeCodeWs] Received output", type=msg_type, bytes=len(msg_data))
                await self.on_output(msg_data, False)

            elif msg_type == "code_agent_event":
                event = msg.get("data")
                if isinstance(event, dict) and self.on_event:
                    await self.on_event(event)

            elif msg_type == "code_agent_events":
                events = msg.get("data")
                if isinstance(events, list):
                    replayed = [event for event in events if isinstance(event, dict)]
                    if self.on_events_replay:
                        await self.on_events_replay(replayed)
                    elif self.on_event:
                        for event in replayed:
                            await self.on_event(event)

            elif msg_type == "exit":
                # Process exited - don't reconnect after this
                exit_code = msg.get("code", 0)
                logger.info("[ClaudeCodeWs] Process exited", exit_code=exit_code)
                self._exited = True
                await self.on_exit(exit_code)

            elif msg_type == "error":
                logger.error("[ClaudeCodeWs] Server error", error=msg.get("data"))

            elif msg_type == "stdin_ack":
                logger.debug("[ClaudeCodeWs] stdin ack", bytes=msg.get("bytes"))
                if self._stdin_ack_event:
                    self._stdin_ack_result = True
                    self._stdin_ack_event.set()

            elif msg_type == "stdin_error":
                error_msg = msg.get("error", "unknown")
                logger.error("[ClaudeCodeWs] stdin error — message did NOT reach Claude Code", error=error_msg)
                if self._stdin_ack_event:
                    self._stdin_ack_result = False
                    self._stdin_ack_event.set()
                if self.on_stdin_error:
                    await self.on_stdin_error(error_msg)

            elif msg_type == "code_agent_delta":
                # Live token stream for UI viewers; the complete assistant
                # message follows as a code_agent_event, so the monitor
                # (which never reads partial output) ignores it.
                pass

            else:
                logger.warning("[ClaudeCodeWs] Unknown message type", msg_type=msg_type)

        except json.JSONDecodeError:
            # Raw data, treat as stdout
            logger.debug("[ClaudeCodeWs] Received raw data", bytes=len(data))
            await self.on_output(data, False)

    async def _reconnect(self) -> bool:
        """
        Attempt reconnection with exponential backoff.

        Total deadline of 60s prevents hanging when the sandbox is dead
        (each connect() has a 30s timeout, so we get ~2 real attempts).

        Returns:
            True if reconnected successfully, False if max retries exceeded or deadline hit.
        """
        deadline = asyncio.get_event_loop().time() + 60.0  # 60s total deadline

        while self._reconnect_count < self.max_reconnects:
            if asyncio.get_event_loop().time() >= deadline:
                logger.error("[ClaudeCodeWs] Reconnect deadline exceeded (60s)")
                return False

            self._reconnect_count += 1
            delay = self.reconnect_delay * (2 ** (self._reconnect_count - 1))

            logger.info(
                "[ClaudeCodeWs] Reconnecting",
                attempt=self._reconnect_count,
                max_attempts=self.max_reconnects,
                delay_s=delay,
            )

            await asyncio.sleep(delay)

            # Close existing connection if any
            if self._ws and not self._ws.closed:
                await self._ws.close()

            if await self.connect():
                logger.info("[ClaudeCodeWs] Reconnected successfully")
                return True

        return False

    @property
    def is_connected(self) -> bool:
        """Check if currently connected."""
        return self._ws is not None and not self._ws.closed

    @property
    def has_exited(self) -> bool:
        """Check if the Claude Code process has exited."""
        return self._exited

    @property
    def reconnects_exhausted(self) -> bool:
        """Check if all reconnection attempts have been exhausted."""
        return self._reconnects_exhausted


async def ws_endpoint_reachable(
    ws_url: str,
    timeout: float = 10.0,
    attempts: int = 1,
    backoff_s: float = 2.0,
) -> bool:
    """True when a WebSocket handshake with ``ws_url`` succeeds within ``timeout``.

    Tries up to ``attempts`` times, doubling ``backoff_s`` between tries.
    """
    for attempt in range(1, attempts + 1):
        try:
            async with aiohttp.ClientSession() as session:
                ws = await asyncio.wait_for(session.ws_connect(ws_url), timeout=timeout)
                await ws.close()
            return True
        except Exception as e:
            logger.info(
                "[ClaudeCodeWs] Endpoint unreachable",
                url=ws_url[:60],
                attempt=attempt,
                attempts=attempts,
                error=str(e),
            )
        if attempt < attempts:
            await asyncio.sleep(backoff_s * 2 ** (attempt - 1))
    return False
