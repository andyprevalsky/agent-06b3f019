"""WebSocket client for Claude Code E2B sandbox communication.

Provides bidirectional communication with the Claude Code sandbox:
- Receives stdout/stderr/buffer/exit messages
- Sends stdin messages for follow-up prompts
- Handles reconnection with exponential backoff
"""

import asyncio
import json
from typing import Callable, Optional, Awaitable
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
        heartbeat_fn: Optional[Callable[[str], None]] = None,
        max_reconnects: int = 5,
        reconnect_delay: float = 1.0,
    ):
        """
        Initialize the WebSocket client.

        Args:
            ws_url: WebSocket URL to connect to (e.g., wss://sandbox-id.e2b.dev:3000)
            on_output: Callback for output data. Called with (data, is_buffer).
                       is_buffer=True means this is the full buffer from reconnect.
            on_exit: Callback when process exits. Called with exit code.
            on_connection_change: Callback when connection state changes. Called with True on connect, False on disconnect.
            heartbeat_fn: Optional Temporal activity heartbeat function.
            max_reconnects: Maximum reconnection attempts.
            reconnect_delay: Base delay for exponential backoff (seconds).
        """
        self.ws_url = ws_url
        self.on_output = on_output
        self.on_exit = on_exit
        self.on_connection_change = on_connection_change
        self.heartbeat_fn = heartbeat_fn
        self.max_reconnects = max_reconnects
        self.reconnect_delay = reconnect_delay

        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._session: Optional[aiohttp.ClientSession] = None
        self._running = False
        self._reconnect_count = 0
        self._exited = False  # Process has exited, don't reconnect
        self._reconnects_exhausted = False  # All reconnect attempts failed

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
        Send data to Claude Code's stdin.

        Args:
            data: Text to send to stdin. Newline will be added if not present.

        Returns:
            True if sent successfully, False otherwise.
        """
        if not self._ws or self._ws.closed:
            logger.warning("[ClaudeCodeWs] Cannot send stdin - not connected")
            return False

        try:
            msg = json.dumps({"type": "stdin", "data": data})
            await self._ws.send_str(msg)
            logger.info("[ClaudeCodeWs] Sent stdin", bytes=len(data))
            return True
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

            elif msg_type == "stdin_error":
                logger.error("[ClaudeCodeWs] stdin error", error=msg.get("error"))

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
                delay_s=delay
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
