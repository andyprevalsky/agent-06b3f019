"""Offline streaming fixtures with production parsers and an isolated clock.

The event loop keeps its real clock. Only RoseClient's wait proxy advances to
scheduled HTTP byte deliveries, so 590/90/120-second bounds run in milliseconds.
No provider credentials or network connections are used.
"""

import asyncio
import heapq
import json
from collections import Counter
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from helpers import httpx_capture

from providers.rose.client import RoseClient
from providers.rose.cerebras import _reset_cerebras_cooldown_cache
from providers.rose.errors import RoseAllFailed, RoseDeadlineError, RoseStallError
from providers.rose.streaming import parse_anthropic_sse, parse_responses_sse


def single_step_waterfall(source):
    """A mocked one-leg waterfall honors the client's production guard contract."""

    async def generated(**kwargs):
        guard = kwargs.pop("stream_guard", None)
        stream = source(**kwargs)
        if guard is not None:
            stream = guard(stream)
        async for chunk in stream:
            yield chunk

    return generated


class _VirtualClock:
    def __init__(self):
        self.now = 0.0
        self.sleepers = []
        self.serial = 0

    def monotonic(self):
        return self.now

    async def sleep(self, seconds):
        future = asyncio.get_running_loop().create_future()
        self.serial += 1
        heapq.heappush(self.sleepers, (self.now + seconds, self.serial, future))
        await future

    async def wait(self, tasks, timeout):
        deadline = self.now + timeout
        while True:
            for _ in range(20):
                await asyncio.sleep(0)
            done = {task for task in tasks if task.done()}
            if done or self.now >= deadline:
                return done, set(tasks) - done
            while self.sleepers and self.sleepers[0][2].done():
                heapq.heappop(self.sleepers)
            delivery = self.sleepers[0][0] if self.sleepers else deadline
            self.now = min(delivery, deadline)
            while self.sleepers and self.sleepers[0][0] <= self.now:
                _, _, future = heapq.heappop(self.sleepers)
                if not future.done():
                    future.set_result(None)


class _SSE(httpx.AsyncByteStream):
    def __init__(
        self, clock, *, mode="tool", seconds=150, protocol="openai", prelude=255, tail_silence=0, fail_after=False
    ):
        self.clock = clock
        self.mode = mode
        self.seconds = seconds
        self.protocol = protocol
        self.prelude = prelude
        self.tail_silence = tail_silence
        self.fail_after = fail_after
        self.closed = False
        self.receipts = []

    def frame(self, event, kind):
        self.receipts.append((self.clock.now, kind))
        return ("data: " + json.dumps(event) + "\n\n").encode()

    async def __aiter__(self):
        for _ in range(self.prelude):
            await self.clock.sleep(0.01)
            if self.protocol == "anthropic":
                event = {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "r"}}
            elif self.protocol == "responses":
                event = {"type": "response.reasoning_text.delta", "delta": "r"}
            else:
                event = {"choices": [{"index": 0, "delta": {"reasoning": "r"}}]}
            yield self.frame(event, "reasoning")
        if self.protocol == "anthropic" and self.mode == "tool":
            yield self.frame(
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "fixture-tool", "name": "fixture_tool"},
                },
                "tool_start",
            )
        elif self.protocol == "anthropic" and self.mode == "mismatched_anthropic":
            yield self.frame(
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "fixture-tool", "name": "fixture_tool"},
                },
                "tool_start",
            )
        elif self.protocol == "responses" and self.mode == "tool":
            yield self.frame(
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {"id": "fixture-tool", "type": "function_call"},
                },
                "tool_start",
            )
        elif self.protocol == "responses" and self.mode == "completed_responses":
            yield self.frame(
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {"id": "fixture-tool", "type": "function_call"},
                },
                "tool_start",
            )
            yield self.frame(
                {
                    "type": "response.output_item.done",
                    "item": {"type": "function_call", "id": "fixture-tool", "name": "fixture_tool", "arguments": "{}"},
                },
                "tool_finish",
            )
        if self.mode == "silence":
            await self.clock.sleep(self.seconds)
        else:
            for index in range(self.seconds):
                await self.clock.sleep(1.0)
                argument = ('{"payload":"' if index == 0 else "") + "x"
                if index == self.seconds - 1:
                    argument += '"}'
                if self.mode == "tool" and self.protocol == "anthropic":
                    event = {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "input_json_delta", "partial_json": argument},
                    }
                elif self.mode == "tool" and self.protocol == "responses":
                    event = {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "fixture-tool",
                        "delta": argument,
                    }
                elif self.mode in {"tool", "empty_tool"}:
                    event = {
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "fixture-tool",
                                            "type": "function",
                                            "function": {
                                                "name": "fixture_tool",
                                                "arguments": argument if self.mode == "tool" else "",
                                            },
                                        }
                                    ]
                                },
                            }
                        ]
                    }
                elif self.mode == "reasoning":
                    event = {"choices": [{"index": 0, "delta": {"reasoning": "r"}}]}
                elif self.mode in {"opaque_reasoning", "summarized_reasoning"}:
                    # One complete encrypted Responses reasoning item per second.
                    item = {"type": "reasoning", "id": f"rs_fixture_{index}", "summary": []}
                    added = {"type": "response.output_item.added", "output_index": index, "item": item}
                    yield self.frame({**added, "item": {**item, "encrypted_content": ""}}, "reasoning_item_start")
                    if self.mode == "summarized_reasoning":
                        yield self.frame(
                            {"type": "response.reasoning_summary_text.delta", "item_id": item["id"], "delta": "r"},
                            "reasoning",
                        )
                    event = {
                        "type": "response.output_item.done",
                        "output_index": index,
                        "item": {**item, "encrypted_content": "opaque"},
                    }
                elif self.mode in {"orphan_anthropic", "mismatched_anthropic"}:
                    event = {
                        "type": "content_block_delta",
                        "index": 999 if self.mode == "mismatched_anthropic" else 0,
                        "delta": {"type": "input_json_delta", "partial_json": argument},
                    }
                elif self.mode in {"orphan_responses", "completed_responses"}:
                    event = {
                        "type": "response.function_call_arguments.delta",
                        "item_id": "fixture-tool" if self.mode == "completed_responses" else "unknown-item",
                        "delta": argument,
                    }
                else:
                    event = {"choices": [], "usage": {"completion_tokens": index}}
                if self.mode == "comments":
                    self.receipts.append((self.clock.now, "comment"))
                    yield b": keepalive\n\n"
                else:
                    yield self.frame(event, self.mode)
        if self.tail_silence:
            await self.clock.sleep(self.tail_silence)
        if self.fail_after:
            raise httpx.ReadError("offline route failed after buffered arguments")
        arguments = json.dumps({"payload": "x" * self.seconds}, separators=(",", ":"))
        if self.protocol == "anthropic":
            yield self.frame({"type": "content_block_stop", "index": 0}, "finish")
            yield self.frame({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}, "usage")
        elif self.protocol == "responses":
            yield self.frame(
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "id": "fixture-tool",
                        "name": "fixture_tool",
                        "arguments": arguments,
                    },
                },
                "finish",
            )
            yield self.frame({"type": "response.completed", "response": {"usage": {}}}, "usage")
        else:
            yield self.frame(
                {
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "tool_calls" if self.mode == "tool" else "stop"}
                    ]
                },
                "finish",
            )
            yield self.frame(
                {"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}, "usage"
            )
        yield b"data: [DONE]\n\n"

    async def aclose(self):
        self.closed = True


async def assert_progress_case(
    *,
    mode="tool",
    seconds=150,
    protocol="openai",
    prelude=255,
    tail_silence=0,
    expected_error=None,
    expected_time=None,
    exhausted=False,
    fallback=False,
    consumer_pause=0,
    pause_at=1,
    idle_timeout_s=120.0,
):
    _reset_cerebras_cooldown_cache()
    clock = _VirtualClock()
    feed = _SSE(
        clock,
        mode=mode,
        seconds=seconds,
        protocol=protocol,
        prelude=prelude,
        tail_silence=tail_silence,
        fail_after=fallback,
    )
    feeds = [feed]
    requests = []
    real_client = httpx.AsyncClient

    async def handler(request):
        requests.append((request.url.host, json.loads(request.content)["model"]))
        if request.url.host == "api.cerebras.ai":
            return httpx.Response(429, json={"error": "offline primary rate limit"})
        assert request.url.host == "openrouter.ai"
        if fallback and len(requests) == 3:
            # A new HTTP attempt must use its own TTFT90, including headers.
            await clock.sleep(95)
            next_feed = _SSE(clock, mode="reasoning", seconds=1, prelude=0)
            feeds.append(next_feed)
            return httpx.Response(200, stream=next_feed)
        selected_feed = feed
        if len(requests) > 2:
            selected_feed = _SSE(clock, mode=mode, seconds=seconds, protocol=protocol, prelude=prelude)
            feeds.append(selected_feed)
        return httpx.Response(200, stream=selected_feed, headers={"content-type": "text/event-stream"})

    def offline_client(*args, **kwargs):
        return real_client(transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout"), trust_env=False)

    async def parsed_waterfall(**kwargs):
        response = httpx.Response(200, stream=feed)
        parser = parse_anthropic_sse if protocol == "anthropic" else parse_responses_sse
        async for chunk in parser(
            response, actual_model="offline-model", pool_name="rose-1-flash", request_id="offline-progress"
        ):
            yield chunk

    clock_asyncio = SimpleNamespace(
        wait=clock.wait,
        ensure_future=asyncio.ensure_future,
        CancelledError=asyncio.CancelledError,
        create_task=asyncio.create_task,
    )
    chunks = []
    error = None
    with (
        # The generic capture harness buffers the entire body before returning
        # headers. These streaming tests use only the explicit MockTransport.
        patch.object(real_client, "__init__", httpx_capture._original_init or real_client.__init__),
        patch("providers.rose.client.load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key=""))),
        patch("providers.rose.cerebras.load_config", lambda: SimpleNamespace()),
        patch("providers.rose.client._cerebras_api_key", return_value="offline-fake" if protocol == "openai" else ""),
        patch("providers.rose.client.anthropic_family_excluded", lambda requested=False: requested),
        patch("providers.rose.client.time", SimpleNamespace(monotonic=clock.monotonic)),
        patch("providers.rose.client.asyncio", clock_asyncio),
        patch("providers.rose.client._safe_heartbeat", lambda message: None),
        patch("providers.rose.transport.httpx.AsyncClient", offline_client),
    ):
        async with offline_client() as stream_client:
            with patch("providers.rose.transport.get_streaming_http_client", return_value=stream_client):
                from contextlib import nullcontext

                with (
                    patch("providers.rose.client.waterfall_complete", single_step_waterfall(parsed_waterfall))
                    if protocol != "openai"
                    else nullcontext()
                ):
                    try:
                        async for chunk in RoseClient(openrouter_key="offline-fake").complete(
                            pool="rose-1-flash",
                            messages=[{"role": "user", "content": "Offline fixture"}],
                            tools=[{"name": "fixture_tool", "parameters": {"type": "object"}}],
                            request_id="offline-progress",
                            call_site="explore_agent",
                            max_tokens=8192,
                            deadline_s=590.0,
                            ttft_timeout_s=90.0,
                            idle_timeout_s=idle_timeout_s,
                            dump_context=False,
                        ):
                            chunks.append(chunk)
                            if len(chunks) == pause_at and consumer_pause:
                                clock.now += consumer_pause
                    except RoseAllFailed as exc:
                        assert exhausted and len(exc.step_errors) == 2, exc
                        assert isinstance(exc.step_errors[-1].error, RoseStallError), exc.step_errors
                        error = str(exc.step_errors[-1].error)
                        if not fallback:
                            assert all(isinstance(step.error, RoseStallError) for step in exc.step_errors)
                    except (RoseDeadlineError, RoseStallError) as exc:
                        assert not exhausted, exc
                        error = str(exc)
    assert error == expected_error, (mode, protocol, error, clock.now)
    if expected_time is not None:
        assert abs(clock.now - expected_time) < 0.000001, (clock.now, expected_time)
    assert all(item.closed for item in feeds), "every timed-out/completed response must close"
    if protocol == "openai":
        assert requests[:2] == [("api.cerebras.ai", "qwen-3.8-27b"), ("openrouter.ai", "qwen/qwen3.8-27b")], requests
    if expected_error is None:
        counts = Counter(chunk.kind for chunk in chunks)
        expected_counts = {
            "metadata": 1,
            "reasoning": prelude + (seconds if mode in {"reasoning", "summarized_reasoning"} else 0),
            "codex_reasoning_item": seconds if mode in {"opaque_reasoning", "summarized_reasoning"} else 0,
            # The Responses fixture always finishes with a function_call item.
            "tool_call": 1 if mode == "tool" or protocol == "responses" else 0,
            "usage": 1,
            "done": 1,
        }
        assert counts == {kind: count for kind, count in expected_counts.items() if count}, counts
        assert chunks[-1].kind == "done"
        if mode == "tool":
            tool = next(chunk for chunk in chunks if chunk.kind == "tool_call")
            assert tool.data == {
                "id": "fixture-tool",
                "name": "fixture_tool",
                "arguments": json.dumps({"payload": "x" * seconds}, separators=(",", ":")),
            }
    return clock, chunks


async def assert_concurrent_progress_and_cancellation():
    """A streaming sibling cannot buy idle time for a stalled/cancelled request."""
    from providers.rose.streaming import _stream_progress

    class Feed(httpx.AsyncByteStream):
        def __init__(self, label):
            self.label = label
            self.entered = asyncio.Event()
            self.closed = False

        async def __aiter__(self):
            self.entered.set()
            if self.label == "productive":
                for index in range(70):
                    await asyncio.sleep(0.002)
                    argument = ('{"payload":"' if index == 0 else "") + "x"
                    if index == 69:
                        argument += '"}'
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {
                                            "tool_calls": [
                                                {
                                                    "index": 0,
                                                    "id": "fixture-tool",
                                                    "function": {"name": "fixture_tool", "arguments": argument},
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        )
                        + "\n\n"
                    ).encode()
                yield b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
                yield b"data: [DONE]\n\n"
            else:
                yield b'data: {"choices":[{"delta":{"content":"started"}}]}\n\n'
                await asyncio.sleep(1)

        async def aclose(self):
            self.closed = True

    feeds = {label: Feed(label) for label in ("productive", "silent", "cancelled")}
    real_client = httpx.AsyncClient

    def handler(request):
        assert request.url.host == "openrouter.ai"
        label = json.loads(request.content)["messages"][-1]["content"]
        return httpx.Response(200, stream=feeds[label])

    def offline_client(*args, **kwargs):
        return real_client(transport=httpx.MockTransport(handler), trust_env=False)

    async def collect(label):
        chunks = []
        async for chunk in RoseClient(openrouter_key="offline-fake").complete(
            pool="rose-1-flash",
            messages=[{"role": "user", "content": label}],
            tools=[{"name": "fixture_tool", "parameters": {"type": "object"}}],
            deadline_s=0.8,
            ttft_timeout_s=0.06,
            idle_timeout_s=0.04,
            dump_context=False,
        ):
            assert _stream_progress.get() is None, "callback leaked into consumer context"
            chunks.append(chunk)
        return chunks

    with (
        patch.object(real_client, "__init__", httpx_capture._original_init or real_client.__init__),
        patch("providers.rose.client.load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key=""))),
        patch("providers.rose.client._cerebras_api_key", return_value=""),
        patch("providers.rose.client.anthropic_family_excluded", lambda requested=False: requested),
        patch("providers.rose.client._safe_heartbeat", lambda message: None),
        patch("providers.rose.transport.httpx.AsyncClient", offline_client),
    ):
        async with offline_client() as stream_client:
            with patch("providers.rose.transport.get_streaming_http_client", return_value=stream_client):
                productive, silent = await asyncio.gather(
                    collect("productive"), collect("silent"), return_exceptions=True
                )
                assert isinstance(silent, RoseDeadlineError) and "idle" in str(silent), silent
                assert isinstance(productive, list) and productive[-1].kind == "done", productive
                tool = next(chunk for chunk in productive if chunk.kind == "tool_call")
                assert json.loads(tool.data["arguments"]) == {"payload": "x" * 70}
                task = asyncio.create_task(collect("cancelled"))
                await feeds["cancelled"].entered.wait()
                # Let the productive normalized chunk reach the consumer, then cancel
                # the next pending read. Closure must finish before cancellation returns.
                await asyncio.sleep(0.005)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                else:
                    raise AssertionError("cancellation was swallowed")
    assert all(feed.closed for feed in feeds.values())
    assert _stream_progress.get() is None


async def assert_waterfall_stalled_leg_uses_existing_fallback(scenario="recover"):
    """A metadata-only leg may fail without cancelling the configured next leg."""
    clock = _VirtualClock()
    requests = []
    feeds = []
    real_client = httpx.AsyncClient

    class Stalled(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            await clock.sleep(600)
            yield b"data: [DONE]\n\n"

        async def aclose(self):
            self.closed = True

    async def handler(request):
        assert request.url.host == "openrouter.ai", "fixture must remain offline"
        requests.append(json.loads(request.content)["model"])
        if len(requests) == 1:
            if scenario == "global_deadline":
                feed = _SSE(clock, seconds=520, prelude=0, fail_after=True)
            elif scenario == "midstream_idle":
                feed = _SSE(clock, mode="reasoning", seconds=1, prelude=0, tail_silence=121)
            elif scenario == "empty":
                feed = _SSE(clock, mode="metadata", seconds=0, prelude=0)
            elif scenario == "buffered_arguments":
                feed = _SSE(clock, seconds=10, prelude=0, fail_after=True)
            else:
                await clock.sleep(10.5)
                feed = Stalled()
        else:
            if scenario == "global_deadline":
                await clock.sleep(95)
            feed = _SSE(clock, mode="reasoning", seconds=1, prelude=0)
        feeds.append(feed)
        return httpx.Response(200, stream=feed, headers={"content-type": "text/event-stream"})

    def offline_client(*args, **kwargs):
        return real_client(transport=httpx.MockTransport(handler), timeout=kwargs.get("timeout"), trust_env=False)

    clock_asyncio = SimpleNamespace(
        wait=clock.wait,
        ensure_future=asyncio.ensure_future,
        CancelledError=asyncio.CancelledError,
        create_task=asyncio.create_task,
    )
    chunks = []
    error = None
    with (
        patch.object(real_client, "__init__", httpx_capture._original_init or real_client.__init__),
        patch("providers.rose.client.load_config", lambda: SimpleNamespace(anthropic=SimpleNamespace(api_key=""))),
        patch("providers.rose.client._cerebras_api_key", return_value=""),
        patch("providers.rose.client.anthropic_family_excluded", lambda requested=False: requested),
        patch("providers.rose.client.time", SimpleNamespace(monotonic=clock.monotonic)),
        patch("providers.rose.client.asyncio", clock_asyncio),
        patch("providers.rose.client._safe_heartbeat", lambda message: None),
        patch("providers.rose.transport.httpx.AsyncClient", offline_client),
    ):
        async with offline_client() as stream_client:
            with patch("providers.rose.transport.get_streaming_http_client", return_value=stream_client):
                try:
                    async for chunk in RoseClient(openrouter_key="offline-fake").complete(
                        pool="rose-1-browser-use",
                        messages=[{"role": "user", "content": "Offline fixture"}],
                        request_id="offline-waterfall-stall",
                        call_site="explore_agent",
                        max_tokens=8192,
                        deadline_s=590.0,
                        ttft_timeout_s=90.0,
                        idle_timeout_s=120.0,
                        dump_context=False,
                    ):
                        chunks.append(chunk)
                except (RoseDeadlineError, RoseStallError) as exc:
                    error = type(exc).__name__
    assert all(feed.closed for feed in feeds), "every owned response must close"
    if scenario in {"recover", "empty", "buffered_arguments"}:
        assert error is None, (error, len(requests), clock.now)
        from providers.rose.pools import get_pool

        assert requests == list(get_pool("rose-1-browser-use").waterfall)
        assert [chunk.kind for chunk in chunks] == ["metadata", "reasoning", "usage", "done"]
        assert chunks[0].data["actual_model"] == requests[-1]
        assert clock.now < 590.0
    else:
        assert error == "RoseDeadlineError", (error, len(requests), clock.now)
        assert len(requests) == (2 if scenario == "global_deadline" else 1)
        assert clock.now <= 590.0
        assert not any(chunk.kind == "done" for chunk in chunks)
