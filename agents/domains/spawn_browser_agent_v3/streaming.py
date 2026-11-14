"""Realtime progress bridge for browser-use LLM decisions."""

from __future__ import annotations

import json
import re
import time
import uuid
from html import escape
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional
from urllib.parse import quote, quote_plus

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
            if chunk.kind == "restart":
                forwarded_tool = False
                self._selected_tool_call_id = None
            if chunk.kind == "tool_call" and not forwarded_tool:
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
        self._pending_text = ""
        self._selected_ids: Optional[set[str]] = None

    def _redact_delta(self, delta: str, *, ending: bool) -> str:
        # The registry is an activity ContextVar, never a worker-wide snapshot.
        # Keep only a suffix that might complete a registered value. Reuse the
        # canonical redactor for substitutions and numeric/public-ref boundaries.
        from browser_tools.secret_refs import _LOG_SECRET_REFS, redact_current_secret_values

        self._pending_text += delta
        pending = self._pending_text
        if ending:
            self._pending_text = ""
            return redact_current_secret_values(pending)
        forms: set[str] = set()
        formatted_prefixes: list[str] = []
        for ref, value in (_LOG_SECRET_REFS.get() or {}).items():
            if not isinstance(value, str) or not value:
                continue
            forms.update((ref, "{{secret:" + ref + "}}"))
            for form in (value, escape(value, quote=True),
                         escape(value, quote=True).replace("&#x27;", "&#39;"),
                         quote(value, safe=""), quote(value), quote_plus(value)):
                for encoded in (form, json.dumps(form, ensure_ascii=False)[1:-1],
                                json.dumps(form, ensure_ascii=True)[1:-1]):
                    forms.update((encoded, encoded.replace("/", "\\/")))
            canonical = re.sub(r"(?::previous|#redacted-[0-9]+)+$", "", ref)
            if canonical == "card_number" and re.fullmatch(r"[0-9]{12,19}", value):
                separator = r"[ \u00a0\u202f\-]?"
                formatted_prefixes.extend(
                    separator.join(value[:length]) + (separator if length < len(value) else "")
                    for length in range(1, len(value) + 1)
                )
            if canonical == "card_expiry" and re.fullmatch(r"[0-9]{2}/[0-9]{2}", value):
                spaced = value[:2] + r"[ \t\u00a0\u202f]{0,3}"
                formatted_prefixes.extend((spaced, spaced + "/" + r"[ \t\u00a0\u202f]{0,3}" + value[3:4],
                                           spaced + "/" + r"[ \t\u00a0\u202f]{0,3}" + value[3:]))
                formatted_prefixes.append(spaced + "/" + r"[ \t\u00a0\u202f]{0,3}")
        keep = 0
        for form in forms:
            for length in range(min(len(form), len(pending)), keep, -1):
                if pending.endswith(form[:length]):
                    keep = length
                    break
        for pattern in formatted_prefixes:
            match = re.search("(?:" + pattern + ")$", pending)
            if match:
                keep = max(keep, len(match.group()))
        # A numeric credential needs its preceding digit boundary even when
        # that digit arrived before the possible credential prefix did.
        if pending and pending[-1].isdigit():
            keep = max(keep, 1)
        if keep and len(pending) > keep and pending[-keep - 1].isdigit():
            keep += 1
        cut = len(pending) - keep
        visible = redact_current_secret_values(pending)
        # Do not cut through a match, a public alias, or a numeric boundary.
        while cut and (redact_current_secret_values(pending[:cut])
                       + redact_current_secret_values(pending[cut:]) != visible):
            cut -= 1
        self._pending_text = pending[cut:]
        return redact_current_secret_values(pending[:cut])

    async def _publish_assistant(self, *, delta: str, done: bool) -> None:
        delta = self._redact_delta(delta, ending=done)
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
        if chunk.kind == "restart":
            # The attempt that just cut off is abandoned: close what it
            # published and give the retry its own stream, so the displayed
            # decision never mixes the two.
            self._pending_text = ""
            self._selected_ids = None
            if self._started:
                await self._publish_assistant(delta="", done=True)
            # Tool calls the abandoned attempt announced never get a result from
            # the retry, so close them under the stream that opened them.
            await self.finish_tools(status="FAILED", all_tools=True)
            self.stream_id = f"{self.stream_id.rsplit('-', 1)[0]}-{uuid.uuid4().hex[:8]}"
            self._started = False
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
        """Close the assistant decision stream without resolving its action."""
        if self._finished:
            return
        if not self._started:
            await self.start()
        self._finished = True
        await self._publish_assistant(delta="", done=True)

    def select_tools(self, call_ids: list[str]) -> None:
        self._selected_ids = set(call_ids)

    async def finish_tools(self, *, status: str, all_tools: bool = False) -> None:
        """Resolve detected tools when the corresponding browser action resolves."""
        tool_calls = [(key, name) for key, name in self._tool_calls.items()
                      if all_tools or self._selected_ids is None or key in self._selected_ids]
        for key, _ in tool_calls:
            self._tool_calls.pop(key, None)
        for tool_call_id, tool_name in tool_calls:
            title_prefix = "Finished" if status == "FINISHED" else "Failed"
            await stream_tool_event(
                agent_id=self.agent_id,
                stream_id=self.stream_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                title=f"{title_prefix} {tool_name}",
                status=status,
                sub_agent_id=self.task_id,
            )
