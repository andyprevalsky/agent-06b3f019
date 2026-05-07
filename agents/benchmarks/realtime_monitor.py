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


class NoHangingToolCallsInvariant:
    """Fails when an assistant message follows an unresolved IN_PROGRESS tool."""

    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self._open_tools: dict[str, OpenToolCall] = {}
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

        if role == "TOOL":
            tool_call_id = metadata.get("toolCallId")
            status = metadata.get("toolStatus")
            if not tool_call_id:
                return
            if status == "IN_PROGRESS":
                self._open_tools[str(tool_call_id)] = OpenToolCall(
                    tool_name=str(metadata.get("toolName") or "unknown"),
                    message_id=str(record.get("id") or record.get("message_id") or ""),
                    sequence=self._sequence,
                )
            elif status in {"FINISHED", "ERROR"}:
                self._open_tools.pop(str(tool_call_id), None)
            return

        if role != "ASSISTANT" or not self._open_tools:
            return

        first_id, first = next(iter(self._open_tools.items()))
        assistant_id = record.get("id") or record.get("message_id") or "unknown"
        self.failure_reason = (
            "Realtime invariant failed: assistant message "
            f"{assistant_id} followed unresolved tool {first.tool_name} "
            f"({first_id}, IN_PROGRESS message {first.message_id}) with no FINISHED/ERROR state"
        )

    def handle_broadcast(self, event: str, payload: Any) -> None:
        if event == "INSERT":
            self.handle_insert(_record_from_broadcast(payload))


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
