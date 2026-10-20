"""Deliver a turn straight to a running code session's CLI.

This is the one inbound primitive for talking to a code agent (Claude Code in
an E2B or local sandbox) while it runs. The user's direct chat (backend route
``POST /api/claude-code-session/:taskId/turns``, TypeScript twin in
``back-end/src/providers/codeSessionTurns.ts``) and agent-to-code-agent
messaging both speak the same ws-server protocol::

    caller ──ws──► ws-server.mjs  {type:"user_turn", id, token, text, sender}
           ◄──────                {type:"user_turn_ack", id, status, reason?}

``status`` is ``delivered`` (written to the CLI's stream-json stdin),
``duplicate`` (this ``id`` was already delivered: retries never repeat a
turn) or ``rejected`` with a ``reason`` (``unauthorized``, ``session_ended``,
``provider_unsupported``, ``invalid_text`` / ``invalid_id``). The ws-server
dedupes by ``id`` for the life of the session, so a Temporal activity that
retries after delivering is safe (CLAUDE.md rule 20).

``token`` is derived per task from ``BACKEND_API_KEY`` and injected into the
sandbox at creation, so only the backend and our workers can write turns,
even though the read-only output stream URL is shared with the browser.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from typing import Literal, Optional

import aiohttp
import structlog

logger = structlog.get_logger()

TURN_TOKEN_CONTEXT = "rose-code-session-turn:v1:"
DEFAULT_TIMEOUT_S = 10.0
DEFAULT_ATTEMPTS = 3

TurnStatus = Literal["delivered", "duplicate", "rejected", "unreachable"]


@dataclass(frozen=True)
class TurnDelivery:
    """Outcome of one delivery call."""

    status: TurnStatus
    turn_id: str
    reason: Optional[str] = None
    attempts: int = 1

    @property
    def reached_cli(self) -> bool:
        """The CLI has this turn (now or from an earlier attempt)."""
        return self.status in ("delivered", "duplicate")


def code_session_turn_token(task_id: str, secret: Optional[str] = None) -> str:
    """Per-session write token; must match ``codeSessionTurnToken`` in the backend."""
    key = secret if secret is not None else os.environ.get("BACKEND_API_KEY", "")
    if not key:
        raise ValueError("BACKEND_API_KEY is required to address a code session")
    return hmac.new(
        key.encode("utf-8"),
        f"{TURN_TOKEN_CONTEXT}{task_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


async def _send_once(
    session: aiohttp.ClientSession,
    ws_url: str,
    payload: dict[str, str],
    ack_type: str,
    timeout_s: float,
) -> dict:
    async with session.ws_connect(ws_url, heartbeat=15.0) as ws:
        await ws.send_str(json.dumps(payload))
        deadline = asyncio.get_running_loop().time() + timeout_s
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError(f"no {ack_type} within {timeout_s}s")
            msg = await ws.receive(timeout=remaining)
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    # The server closes immediately after serving a finished run.
                    return {"status": "rejected", "reason": "session_ended"}
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            if data.get("type") == "exit":
                return {"status": "rejected", "reason": "session_ended"}
            if data.get("type") != ack_type:
                continue
            if ack_type == "user_turn_ack" and data.get("id") != payload["id"]:
                continue
            return data


async def deliver_user_turn_to_code_session(
    ws_url: str,
    *,
    task_id: str,
    text: str,
    turn_id: str,
    sender: Literal["user", "agent"] = "user",
    token: Optional[str] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    attempts: int = DEFAULT_ATTEMPTS,
) -> TurnDelivery:
    """Deliver ``text`` to the code session's CLI as a new user turn, once.

    Safe to call again with the same ``turn_id``: the ws-server answers
    ``duplicate`` instead of writing a second turn. Transport failures retry
    with the same id; a definite ``rejected`` ack is returned immediately.
    """
    payload = {
        "type": "user_turn",
        "id": turn_id,
        "token": token if token is not None else code_session_turn_token(task_id),
        "text": text,
        "sender": sender,
    }
    last_error = ""
    async with aiohttp.ClientSession() as session:
        for attempt in range(1, max(1, attempts) + 1):
            try:
                ack = await _send_once(session, ws_url, payload, "user_turn_ack", timeout_s)
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "[CodeSessionTurns] Delivery attempt failed",
                    task_id=task_id,
                    turn_id=turn_id,
                    attempt=attempt,
                    error=last_error[:200],
                )
                if attempt < attempts:
                    await asyncio.sleep(min(0.25 * attempt, 1.0))
                continue
            status = ack.get("status")
            if status not in ("delivered", "duplicate", "rejected"):
                status = "rejected"
            logger.info(
                "[CodeSessionTurns] Turn acknowledged",
                task_id=task_id,
                turn_id=turn_id,
                sender=sender,
                status=status,
                reason=ack.get("reason"),
                attempt=attempt,
            )
            return TurnDelivery(status=status, turn_id=turn_id, reason=ack.get("reason"), attempts=attempt)
    return TurnDelivery(status="unreachable", turn_id=turn_id, reason=last_error or None, attempts=attempts)


async def hand_back_code_session(
    ws_url: str,
    *,
    task_id: str,
    token: Optional[str] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> str:
    """Release a direct-chat hold so the session can finish on its own.

    Returns the ack status: ``released``, ``not_held``, ``rejected`` or
    ``unreachable``. Idempotent.
    """
    payload = {
        "type": "hand_back",
        "id": "",
        "token": token if token is not None else code_session_turn_token(task_id),
    }
    try:
        async with aiohttp.ClientSession() as session:
            ack = await _send_once(session, ws_url, payload, "hand_back_ack", timeout_s)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        logger.warning("[CodeSessionTurns] Hand back failed", task_id=task_id, error=str(exc)[:200])
        return "unreachable"
    status = str(ack.get("status") or "rejected")
    if status == "rejected" and ack.get("reason") == "session_ended":
        return "not_held"
    return status
