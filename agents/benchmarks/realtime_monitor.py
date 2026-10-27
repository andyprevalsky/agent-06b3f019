"""Supabase Realtime monitor for benchmark smoke invariants."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any, Optional

from benchmarks.logs import load_env_var
from tests.e2e.test_helpers import authenticate

_AGENTS_ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
_BACKEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "back-end", ".env")
_FRONTEND_ENV = os.path.join(os.path.dirname(__file__), "..", "..", "front-end", ".env")


def _record_from_broadcast(payload: Any) -> dict[str, Any]:
    """Extract the broadcast record from realtime-py or raw Supabase wrappers."""
    if not isinstance(payload, dict):
        return {}
    body = payload.get("payload", payload)
    if not isinstance(body, dict):
        return {}
    record = body.get("record", body)
    return record if isinstance(record, dict) else {}


@dataclass
class OpenToolCall:
    tool_name: str
    message_id: str
    sequence: int
    timestamp: str


_ASYNC_ORCHESTRATION_TOOLS = {"spawn_agent", "spawn_general_purpose_agent"}


def _record_timestamp(record: dict[str, Any]) -> str:
    timestamp = record.get("createdAt") or record.get("created_at") or record.get("timestamp") or ""
    return str(timestamp)


def _assistant_started_timestamp(record: dict[str, Any]) -> str:
    """DAG reasoning flushes can INSERT after a later tool started.

    Smoke11: assemble stream firstTimestamp 23:51:25.158, then
    attempt_completion IN_PROGRESS 23:51:25.531, then the ASSISTANT row
    INSERTed at 23:51:25.738. Compare the stream start, not the late write.
    """
    metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
    for key in ("firstTimestamp", "startedAt"):
        value = metadata.get(key)
        if value:
            return str(value)
    return _record_timestamp(record)


def _is_dag_stream_assistant(metadata: dict[str, Any]) -> bool:
    return bool(metadata.get("streamId") or metadata.get("dagTaskIndex") is not None)


def _assistant_tool_call_ids(metadata: dict[str, Any]) -> set[str]:
    tool_calls = metadata.get("tool_calls")
    if not isinstance(tool_calls, list):
        return set()

    ids: set[str] = set()
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        tool_call_id = tool_call.get("tool_call_id") or tool_call.get("toolCallId") or tool_call.get("id")
        if tool_call_id:
            ids.add(str(tool_call_id))
    return ids


class NoHangingToolCallsInvariant:
    """Fails when an assistant message follows an unresolved IN_PROGRESS tool."""

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self._open_tools: dict[str, OpenToolCall] = {}
        self._closed_tool_ids: set[str] = set()
        self._sequence = 0
        self.failure_reason: Optional[str] = None

    def handle_insert(self, record: dict[str, Any]) -> None:
        if self.failure_reason:
            return
        if record.get("agentId") != self.agent_id:
            return

        self._sequence += 1
        role = record.get("role")
        metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
        if metadata.get("subAgentId"):
            return

        if role == "TOOL":
            tool_call_id = metadata.get("toolCallId")
            status = metadata.get("toolStatus")
            if not tool_call_id:
                return
            tool_call_id = str(tool_call_id)
            tool_name = str(metadata.get("toolName") or "unknown")
            if tool_name in _ASYNC_ORCHESTRATION_TOOLS:
                if status in {"FINISHED", "ERROR"}:
                    self._closed_tool_ids.add(tool_call_id)
                    self._open_tools.pop(tool_call_id, None)
                return
            if status == "IN_PROGRESS":
                if tool_call_id in self._closed_tool_ids:
                    return
                self._open_tools[tool_call_id] = OpenToolCall(
                    tool_name=tool_name,
                    message_id=str(record.get("id") or record.get("message_id") or ""),
                    sequence=self._sequence,
                    timestamp=_record_timestamp(record),
                )
            elif status in {"FINISHED", "ERROR"}:
                self._closed_tool_ids.add(tool_call_id)
                self._open_tools.pop(tool_call_id, None)
            return

        if role != "ASSISTANT" or not self._open_tools:
            return
        # Child output files are attached to the parent transcript as empty
        # ASSISTANT rows. They are artifacts, not a resumed model turn. Require
        # the file pointer and empty text as well as the explicit marker so an
        # authored assistant message cannot hide an unresolved tool call.
        if metadata.get("artifactOnly") is True and record.get("filePointer") and not record.get("text"):
            return
        # A Display row (including a running code agent's mirror into this
        # conversation) shows a file to the user; the caller's model gets the
        # tool result instead, so it can land while that tool is still open.
        if (
            metadata.get("source") == "display"
            and metadata.get("excludeFromModel") is True
            and record.get("filePointer")
        ):
            return
        if _is_dag_stream_assistant(metadata):
            return

        assistant_tool_ids = _assistant_tool_call_ids(metadata)
        assistant_timestamp = _assistant_started_timestamp(record)
        unresolved = [
            (tool_call_id, tool)
            for tool_call_id, tool in self._open_tools.items()
            if tool_call_id not in assistant_tool_ids and self._assistant_follows_tool(assistant_timestamp, tool)
        ]
        if not unresolved:
            return

        first_id, first = unresolved[0]
        assistant_id = record.get("id") or record.get("message_id") or "unknown"
        self.failure_reason = (
            "Realtime invariant failed: assistant message "
            f"{assistant_id} followed unresolved tool {first.tool_name} "
            f"({first_id}, IN_PROGRESS message {first.message_id}) with no FINISHED/ERROR state"
        )

    def _assistant_follows_tool(self, assistant_timestamp: str, tool: OpenToolCall) -> bool:
        if assistant_timestamp and tool.timestamp:
            return assistant_timestamp > tool.timestamp
        return self._sequence > tool.sequence

    def handle_broadcast(self, event: str, payload: Any) -> None:
        if event == "INSERT":
            self.handle_insert(_record_from_broadcast(payload))

    def reconcile_snapshot(self, messages: list[dict[str, Any]]) -> Optional[str]:
        """Re-check the invariant against the canonical DB message snapshot."""
        snapshot = NoHangingToolCallsInvariant(self.agent_id)
        for message in sorted(messages, key=_record_timestamp):
            record = dict(message)
            if "agentId" not in record:
                record["agentId"] = self.agent_id
            if "timestamp" not in record and "created_at" in record:
                record["timestamp"] = record["created_at"]
            # The agent detail API names these `message` / `file_pointer`;
            # realtime INSERT records use `text` / `filePointer`.
            if "text" not in record and "message" in record:
                record["text"] = record["message"]
            if "filePointer" not in record and "file_pointer" in record:
                record["filePointer"] = record["file_pointer"]
            snapshot.handle_insert(record)

        self._open_tools = snapshot._open_tools
        self._closed_tool_ids = snapshot._closed_tool_ids
        self._sequence = snapshot._sequence
        self.failure_reason = snapshot.failure_reason
        return self.failure_reason


class SupabaseRealtimeSmokeMonitor:
    """Listens to the same agent channel as the frontend during smoke tests."""

    def __init__(self, agent_id: str, *, private: bool):
        self.agent_id = agent_id
        self.private = private
        self.invariant = NoHangingToolCallsInvariant(agent_id)
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._subscribed = asyncio.Event()
        self._startup_error: Optional[BaseException] = None

    @property
    def failure_reason(self) -> Optional[str]:
        if self._startup_error:
            return f"Realtime monitor failed to subscribe: {self._startup_error}"
        return self.invariant.failure_reason

    def reconcile_snapshot(self, messages: list[dict[str, Any]]) -> Optional[str]:
        return self.invariant.reconcile_snapshot(messages)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"realtime-smoke-{self.agent_id[:8]}")
        await asyncio.wait_for(self._subscribed.wait(), timeout=15)
        if self._startup_error:
            raise self._startup_error

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self) -> None:
        try:
            from realtime import AsyncRealtimeClient, RealtimeSubscribeStates

            supabase_url = load_env_var("SUPABASE_URL", _AGENTS_ENV, _BACKEND_ENV, _FRONTEND_ENV)
            anon_key = load_env_var("SUPABASE_ANON_KEY", _AGENTS_ENV, _BACKEND_ENV, _FRONTEND_ENV) or load_env_var(
                "VITE_SUPABASE_ANON_KEY", _FRONTEND_ENV
            )
            if not supabase_url or not anon_key:
                raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY are required")

            try:
                auth = await authenticate()
                access_token = auth.get("access_token") or anon_key
            except Exception:
                access_token = anon_key

            realtime_url = f"{supabase_url.rstrip('/')}/realtime/v1"
            client = AsyncRealtimeClient(realtime_url, token=anon_key, timeout=10)
            await client.set_auth(access_token)
            channel = client.channel(
                f"agent:{self.agent_id}",
                {"config": {"private": self.private}},
            )

            for event_name in ("INSERT", "UPDATE", "DELETE", "ASSISTANT_STREAM", "TOOL_STREAM"):
                channel.on_broadcast(
                    event_name,
                    lambda payload, name=event_name: self.invariant.handle_broadcast(name, payload),
                )

            def on_subscribe(status: RealtimeSubscribeStates, error: Optional[Exception]) -> None:
                if status == RealtimeSubscribeStates.SUBSCRIBED:
                    self._subscribed.set()
                else:
                    self._startup_error = error or RuntimeError(f"subscription status {status.value}")
                    self._subscribed.set()

            await channel.subscribe(on_subscribe)
            await self._stop.wait()
            await channel.unsubscribe()
        except BaseException as exc:
            self._startup_error = exc
            self._subscribed.set()
