"""Agent-to-agent inbox for agents that run inside one Temporal activity.

Explore and browser agents have no ``poll_messages`` (no workflow signal, no
own conversation rows), so a ``send_message_to_agent`` addressed to their tool-call
address lands as a parent-owned USER row ``{agentMessage, recipientTaskId}``.
No step pays an extra request to read it:

    browser ── its per-step instruction read (GET /api/agents/<owner>?since=&browserToolCallId=)
               already returns every USER row on the owner ──▶ accept_rows(rows):
               only rows whose recipientTaskId == this inbox address are kept
    explore ── its per-step progress post (POST /api/agents/<owner>/messages
               {inbox: {task_id, since}}) returns ``pending_inbox`` ──▶ stash(...)
               (fire-and-forget; delivered at the next step = one step late)
               no post answered for INBOX_FALLBACK_POLL_SECONDS ──▶ one
               GET /api/agents/<owner>/agent-inbox?task_id=&since= (poll)
               attempt_completion_with_result ──▶ one GET (unread_before_finish);
               unread messages defer the completion to the next step

    every source ──▶ dedupe by id, advance ``since`` ──▶ inter-agent message in
    model context (Codex body, helpers/background_agents.py)

Scale (10k explore agents, one step ≈ 5s): before, every step paid one POST and
one inbox GET (2k + 2k req/s); now the POST carries the inbox read (2k req/s,
one bounded indexed ``(agentId, timestamp > since)`` read each) and a GET runs
only when an agent has not posted for 30s (≤ 10k / 30 ≈ 333 req/s worst case,
≈ 0 while agents are posting).
Failures are logged loudly and ignored — the inbox never kills an agent.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

import structlog

from config import load_config
from helpers.background_agents import render_agent_message_text
from helpers.http_client import get_http_client

logger = structlog.get_logger()

AGENT_INBOX_TIMEOUT_SECONDS = 5.0
# Explore: GET the inbox only when no piggybacked read answered for this long.
INBOX_FALLBACK_POLL_SECONDS = 30.0
# Bounded dedupe ledger; ``since`` already excludes older rows.
_MAX_SEEN_IDS = 200


async def fetch_agent_inbox(owner_agent_id: str, inbox_address: str, since: Optional[str]) -> List[Dict[str, Any]]:
    """One backend read of the inbox rows addressed to ``inbox_address``."""
    config = load_config()
    backend_api_key = config.backend.api_key
    if not backend_api_key:
        raise RuntimeError("BACKEND_API_KEY not configured")
    params = {"task_id": inbox_address}
    if since:
        params["since"] = since
    response = await get_http_client().get(
        f"{config.backend.api_url.rstrip('/')}/api/agents/{owner_agent_id}/agent-inbox",
        params=params,
        headers={"X-API-Key": backend_api_key},
        timeout=AGENT_INBOX_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    messages = (response.json() or {}).get("messages") or []
    return [message for message in messages if isinstance(message, dict)]


def inbox_message_from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """A stored agent-message row (conversation read) in the inbox message shape."""
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    message: Dict[str, Any] = {
        "id": row.get("id") or row.get("message_id"),
        "text": row.get("text"),
        "from_agent_id": metadata.get("fromAgentId"),
        "from_agent_path": metadata.get("fromAgentPath"),
        "from_goal": metadata.get("fromGoal"),
        "created_at": row.get("timestamp") or row.get("createdAt"),
    }
    if isinstance(metadata.get("toAgentPath"), str):
        message["to_agent_path"] = metadata["toAgentPath"]
    if isinstance(metadata.get("messageType"), str):
        message["message_type"] = metadata["messageType"]
    return message


def _instant(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def agent_message_metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    """Row metadata of one inbox message (the shape the backend stores)."""
    metadata: Dict[str, Any] = {
        "agentMessage": True,
        "agentMessageId": message.get("id"),
        "fromAgentId": message.get("from_agent_id"),
        "fromAgentPath": message.get("from_agent_path"),
        "toAgentPath": message.get("to_agent_path"),
    }
    if isinstance(message.get("message_type"), str):
        metadata["messageType"] = message["message_type"]
    return metadata


def format_agent_message(message: Dict[str, Any]) -> str:
    """Model-visible Codex body of one inbox message. No extra nudging text."""
    return render_agent_message_text(str(message.get("text") or ""), agent_message_metadata(message))


class AgentInbox:
    """Per-activity inbox cursor. ``poll`` never raises (except cancellation)."""

    def __init__(
        self,
        owner_agent_id: str,
        inbox_address: str,
        *,
        since: Optional[str] = None,
        seen_ids: Optional[Iterable[str]] = None,
    ) -> None:
        self.owner_agent_id = owner_agent_id
        self.inbox_address = inbox_address
        self.since = since
        self.seen_ids: List[str] = [str(i) for i in (seen_ids or [])][-_MAX_SEEN_IDS:]
        self.failures = 0
        # Explore piggyback: accepted but not yet delivered messages, and when a
        # read last answered (monotonic seconds).
        self._stashed: List[Dict[str, Any]] = []
        self._last_read_at = time.monotonic()

    @classmethod
    def create(
        cls, owner_agent_id: str, inbox_address: Optional[str], state: Optional[Dict[str, Any]] = None
    ) -> Optional["AgentInbox"]:
        """An inbox for an addressed agent, restored from ``state`` on resume."""
        if not owner_agent_id or not inbox_address:
            return None
        state = state if isinstance(state, dict) else {}
        if state.get("inbox_address") not in (None, inbox_address):
            state = {}
        return cls(owner_agent_id, inbox_address, since=state.get("since"), seen_ids=state.get("seen_ids"))

    def state(self) -> Dict[str, Any]:
        return {"inbox_address": self.inbox_address, "since": self.since, "seen_ids": list(self.seen_ids)}

    async def poll(self) -> List[Dict[str, Any]]:
        """New messages since the last poll, oldest first; [] on any failure."""
        try:
            messages = await fetch_agent_inbox(self.owner_agent_id, self.inbox_address, self.since)
        except Exception as error:
            self.failures += 1
            logger.error(
                "[AgentInbox] poll failed; continuing without new agent messages",
                owner_agent_id=self.owner_agent_id,
                inbox_address=self.inbox_address,
                since=self.since,
                failures=self.failures,
                error=f"{type(error).__name__}: {str(error)[:200]}",
            )
            return []
        self._last_read_at = time.monotonic()
        return self.accept(messages)

    def accept_rows(self, rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Agent-message rows from a conversation read: keep only this inbox's, deduped."""
        return self.accept(
            inbox_message_from_row(row)
            for row in rows
            if isinstance(row, dict)
            and isinstance(row.get("metadata"), dict)
            and row["metadata"].get("agentMessage") is True
            and row["metadata"].get("recipientTaskId") == self.inbox_address
        )

    def read_request(self) -> Dict[str, Any]:
        """The piggybacked read a progress post carries (backend returns ``pending_inbox``)."""
        return {"task_id": self.inbox_address, **({"since": self.since} if self.since else {})}

    def stash(self, messages: Any) -> None:
        """Keep a piggybacked read's new messages for the next step."""
        if not isinstance(messages, list):
            return
        self._last_read_at = time.monotonic()
        self._stashed.extend(self.accept(message for message in messages if isinstance(message, dict)))

    async def unread_before_finish(self) -> bool:
        """One read at completion: is a message waiting that the agent has not seen?

        A progress post's read is delivered one step late, so a message stored
        during the final LLM call would otherwise never be read. New messages
        stay stashed for the next step's ``next_step_messages``.
        """
        self._stashed.extend(await self.poll())
        return bool(self._stashed)

    async def next_step_messages(self) -> List[Dict[str, Any]]:
        """Stashed messages, plus one GET when no read answered for the fallback window."""
        if time.monotonic() - self._last_read_at >= INBOX_FALLBACK_POLL_SECONDS:
            self._stashed.extend(await self.poll())
        delivered, self._stashed = self._stashed, []
        return delivered

    def accept(self, messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Dedupe by id and advance ``since``; new messages oldest first."""
        fresh: List[Dict[str, Any]] = []
        seen = set(self.seen_ids)
        since_at = _instant(self.since)
        for message in sorted(messages, key=lambda m: str(m.get("created_at") or "")):
            message_id = str(message.get("id") or "")
            created_at = message.get("created_at")
            created_at_instant = _instant(created_at)
            if created_at_instant is not None and (since_at is None or created_at_instant > since_at):
                self.since = created_at
                since_at = created_at_instant
            if not message_id or message_id in seen:
                continue
            seen.add(message_id)
            self.seen_ids.append(message_id)
            fresh.append(message)
        self.seen_ids = self.seen_ids[-_MAX_SEEN_IDS:]
        if fresh:
            logger.info(
                "[AgentInbox] delivered agent messages",
                owner_agent_id=self.owner_agent_id,
                inbox_address=self.inbox_address,
                message_ids=[m.get("id") for m in fresh],
            )
        return fresh
