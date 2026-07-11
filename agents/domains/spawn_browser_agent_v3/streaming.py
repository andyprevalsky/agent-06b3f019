"""Realtime progress bridge for browser-use LLM decisions."""

from __future__ import annotations

import json
import time
import uuid
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional

from helpers.messages import stream_assistant_chunk, stream_tool_event
from providers.rose import RoseClient

if TYPE_CHECKING:
    from providers.rose import StreamChunk


class BrowserStreamingRoseClient(RoseClient):
    """Rose client adapter that exposes browser chunks to the realtime bridge."""

    def __init__(self) -> None:
        super().__init__()
        self._thinking_stream: Optional[BrowserThinkingStream] = None
        self._selected_tool_call_id: Optional[str] = None

    def set_thinking_stream(self, stream: Optional["BrowserThinkingStream"]) -> None:
        self._thinking_stream = stream

    async def complete(self, **kwargs: Any) -> AsyncIterator["StreamChunk"]:
        """Observe the selected browser call while base Rose owns collection."""
        forwarded_tool = False
        async for chunk in super().complete(**kwargs):
            should_forward = True
            if chunk.kind == "tool_call":
                should_forward = not forwarded_tool
                if should_forward:
                    forwarded_tool = True
                    self._selected_tool_call_id = str(chunk.data.get("id") or "") or None
            if should_forward and self._thinking_stream is not None:
                await self._thinking_stream.on_chunk(chunk)
            yield chunk

    async def complete_browser_use(self, **kwargs: Any) -> dict[str, Any]:
        self._selected_tool_call_id = None
        result = await super().complete_browser_use(**kwargs)
        return {**result, "tool_call_id": self._selected_tool_call_id}


class BrowserThinkingStream:
    """Publish one browser decision as the shared thinking/tool stream protocol."""

    def __init__(
        self,
        *,
        agent_id: str,
        task_id: str,
        iteration: int,
        started_at_ms: Optional[int] = None,
    ) -> None:
        self.agent_id = agent_id
        self.task_id = task_id
        self.stream_id = f"browser-use-{task_id}-{iteration}-{uuid.uuid4().hex[:8]}"
        self.started_at_ms = started_at_ms or int(time.time() * 1000)
        self._sequence = 0
        self._is_claude = False
        self._is_gpt = False
        self._started = False
        self._finished = False
        self._tool_calls: dict[str, str] = {}

    async def _publish_assistant(self, *, delta: str, done: bool) -> None:
        await stream_assistant_chunk(
            agent_id=self.agent_id,
            stream_id=self.stream_id,
            delta=delta,
            done=done,
            sequence=self._sequence,
            sub_agent_id=self.task_id,
            is_claude=self._is_claude,
            is_gpt=self._is_gpt,
            llm_started_at_ms=self.started_at_ms,
            clear_on_done=True,
        )
        self._sequence += 1

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        await self._publish_assistant(delta="", done=False)

    async def on_chunk(self, chunk: "StreamChunk") -> None:
        if self._finished:
            return
        if not self._started:
            await self.start()

        if chunk.kind == "metadata":
            actual_model = str(chunk.data.get("actual_model") or "")
            self._is_claude = actual_model.endswith("-claude")
            self._is_gpt = actual_model.endswith("-gpt")
            await self._publish_assistant(delta="", done=False)
            return

        if chunk.kind in {"content", "reasoning"}:
            text = str(chunk.data.get("text") or "")
            if text:
                await self._publish_assistant(delta=text, done=False)
            return

        if chunk.kind == "tool_call":
            serialized = json.dumps(chunk.data, ensure_ascii=False, separators=(",", ":"), default=str)
            await self._publish_assistant(delta=serialized, done=False)
            tool_call_id = str(chunk.data.get("id") or "")
            tool_name = str(chunk.data.get("name") or "")
            if tool_call_id and tool_name:
                self._tool_calls[tool_call_id] = tool_name
                await stream_tool_event(
                    agent_id=self.agent_id,
                    stream_id=self.stream_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    title=f"Starting {tool_name}...",
                    char_count=len(serialized),
                    is_gpt=self._is_gpt,
                    is_claude=self._is_claude,
                    llm_started_at_ms=self.started_at_ms,
                    sub_agent_id=self.task_id,
                )
            return

    async def finish(self) -> None:
        if self._finished:
            return
        if not self._started:
            await self.start()
        self._finished = True
        await self._publish_assistant(delta="", done=True)
        for tool_call_id, tool_name in self._tool_calls.items():
            await stream_tool_event(
                agent_id=self.agent_id,
                stream_id=self.stream_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                title=f"Finished {tool_name}",
                status="FINISHED",
                sub_agent_id=self.task_id,
            )
