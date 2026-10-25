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
               every model turn ──▶ one background GET alongside the model call
               /api/agents/<owner>/agent-inbox?task_id=&since= (start_read): the
               post read predates the turn's tools, so this read sees messages
               stored during a tool batch
               attempt_completion_with_result ──▶ a fetched, undelivered message
               defers the completion one step; otherwise a background GET starts
               and the completion proceeds without waiting
               activity hand-off ──▶ finish(): messages fetched after the last
               model turn go to the parent with the explore result

    every source ──▶ ``_fetched`` (dedupe by id; reads never block the agent)
    a model turn uses them ──▶ advance ``since``/``seen_ids`` (ack-after-use) ──▶
    inter-agent message in model context (Codex body, helpers/background_agents.py)
    Rows are never consumed server-side: a read whose rows were not used
    acknowledges nothing, and the next read from ``since`` returns them again.

Scale (10k explore agents, one step ≈ 5s): before, every step paid one POST and
one inbox GET (2k + 2k req/s); now the POST carries the inbox read (2k req/s,
one bounded indexed ``(agentId, timestamp > since)`` read each) plus one
background GET per model turn (≤ 2k req/s, the same indexed read, never
awaited; a turn is at least one LLM call, so real rates are lower).
Failures are logged loudly and ignored — the inbox never kills an agent.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

import structlog

from config import load_config
from helpers.background_agents import render_agent_message_text
from helpers.http_client import get_http_client

logger = structlog.get_logger()

AGENT_INBOX_TIMEOUT_SECONDS = 5.0
# A background GET still in flight for less than this is not started again.
INBOX_READ_INFLIGHT_SECONDS = 30.0
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
    # httpx's timeout is per phase; waiting inside the shared pool is not
    # covered (a completion-time read hung 558s there), so bound the whole GET.
    response = await asyncio.wait_for(
        get_http_client().get(
            f"{config.backend.api_url.rstrip('/')}/api/agents/{owner_agent_id}/agent-inbox",
            params=params,
            headers={"X-API-Key": backend_api_key},
            timeout=AGENT_INBOX_TIMEOUT_SECONDS,
        ),
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
    """Per-activity inbox: background reads, ack-after-use delivery.

    ``since``/``seen_ids`` are the DELIVERED cursor (persisted ``state()``): they
    advance only when a message is handed to the agent's next model turn
    (``next_step_messages``/``accept_rows``) or to its parent (``finish``).
    Reads (a GET or a piggybacked progress-post read) only add to ``_fetched``;
    a read whose result is never used acknowledges nothing, and the next read
    from the delivered cursor returns those rows again. Ids dedupe overlapping
    readers, so each message is delivered exactly once.

    The agent never awaits a read: GETs run as background tasks and their
    results are used once settled (claude-code-src query.ts zero-wait prefetch).
    """

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
        # Fetched but not yet delivered, by message id.
        self._fetched: Dict[str, Dict[str, Any]] = {}
        # Background GETs: task -> monotonic start time.
        self._reads: Dict["asyncio.Task[None]", float] = {}

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
        """One GET from the delivered cursor into ``_fetched``; [] and a log on failure."""
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
        return self._absorb(messages)

    def start_read(self) -> None:
        """Start a background GET unless a recent one is still in flight. Never awaited by the agent."""
        now = time.monotonic()
        if any(now - started < INBOX_READ_INFLIGHT_SECONDS for task, started in self._reads.items() if not task.done()):
            return
        task = asyncio.get_running_loop().create_task(self._background_read())
        self._reads[task] = now

    async def _background_read(self) -> None:
        await self.poll()

    def _settle_reads(self) -> None:
        for task in [task for task in self._reads if task.done()]:
            del self._reads[task]
            if not task.cancelled() and task.exception() is not None:
                logger.error("[AgentInbox] background read raised", error=str(task.exception())[:200])

    def accept_rows(self, rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Agent-message rows from a conversation read, delivered now: keep only this inbox's, deduped."""
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
        """Keep a piggybacked read's messages until they are delivered."""
        if not isinstance(messages, list):
            return
        self._absorb(message for message in messages if isinstance(message, dict))

    async def unread_before_finish(self) -> bool:
        """At completion, without waiting: is a fetched message still undelivered?

        True defers the completion one step so the message reaches the model.
        Otherwise a background read starts for anything stored during the final
        LLM call; if it lands after the agent ends, ``finish`` hands it to the
        parent rather than dropping it.
        """
        self._settle_reads()
        if self._fetched:
            return True
        self.start_read()
        return False

    async def next_step_messages(self) -> List[Dict[str, Any]]:
        """Deliver every fetched message to this model turn; never waits on a read.

        Each turn also starts a background GET alongside its model call. The
        progress-post read answers when the previous model turn ended, before
        its tools ran, so a message stored during a tool batch is only seen by
        this read: it is delivered at the next step, or, when this turn answers,
        defers the completion (``unread_before_finish``) instead of reaching
        the parent at ``finish``.
        """
        self._settle_reads()
        self.start_read()
        return self._deliver(list(self._fetched.values()))

    async def finish(self, timeout: Optional[float] = None) -> List[Dict[str, Any]]:
        """The agent has ended: undelivered messages for its parent, oldest first.

        Called off the agent's own path (at activity hand-off). Reads still in
        flight get ``timeout`` to land; any still hung are cancelled, and their
        rows were never acknowledged.
        """
        pending = [task for task in self._reads if not task.done()]
        if pending:
            _, hung = await asyncio.wait(pending, timeout=AGENT_INBOX_TIMEOUT_SECONDS if timeout is None else timeout)
            for task in hung:
                task.cancel()
        self._settle_reads()
        return self._deliver(list(self._fetched.values()))

    def accept(self, messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Absorb and deliver now (same-step readers such as the browser's row read)."""
        self._absorb(messages)
        return self._deliver(list(self._fetched.values()))

    def _absorb(self, messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Hold not-yet-delivered messages by id; the cursor does not move."""
        seen = set(self.seen_ids)
        fresh: List[Dict[str, Any]] = []
        for message in messages:
            message_id = str(message.get("id") or "")
            if not message_id or message_id in seen or message_id in self._fetched:
                continue
            self._fetched[message_id] = message
            fresh.append(message)
        return fresh

    def _deliver(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Acknowledge ``messages`` as handed to their reader: advance the cursor past them."""
        delivered: List[Dict[str, Any]] = []
        since_at = _instant(self.since)
        for message in sorted(messages, key=lambda m: str(m.get("created_at") or "")):
            message_id = str(message.get("id") or "")
            self._fetched.pop(message_id, None)
            if message_id in self.seen_ids:
                continue
            created_at = message.get("created_at")
            created_at_instant = _instant(created_at)
            if created_at_instant is not None and (since_at is None or created_at_instant > since_at):
                self.since = created_at
                since_at = created_at_instant
            self.seen_ids.append(message_id)
            delivered.append(message)
        self.seen_ids = self.seen_ids[-_MAX_SEEN_IDS:]
        if delivered:
            logger.info(
                "[AgentInbox] delivered agent messages",
                owner_agent_id=self.owner_agent_id,
                inbox_address=self.inbox_address,
                message_ids=[m.get("id") for m in delivered],
            )
        return delivered
