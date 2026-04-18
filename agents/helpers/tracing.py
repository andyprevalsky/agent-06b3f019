"""Span tracing helpers — hierarchical causal tracing for agent runs.

Emits `span.start` / `span.end` structlog events with `span_id` and
`parent_span_id` bound via contextvars. Downstream code (LLM calls, HTTP
requests, nested spans) that reads `structlog.contextvars.get_contextvars()`
sees the enclosing span_id automatically.

Typical usage:
    async with span("execute_iteration", iteration=n):
        ...

HTTP propagation: use `tracing_headers()` when making backend requests so
the backend can nest its own spans under the caller.
"""

from __future__ import annotations

import functools
import inspect
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Iterator, Optional, Tuple, TypeVar

import structlog
import structlog.contextvars

T = TypeVar("T")

logger = structlog.get_logger()

# Param names we accept as a stand-in for "agent_id" when auto-binding from @traced.
# Ordered by preference: an explicit agent_id wins over parent_agent_id.
_AGENT_ID_PARAM_NAMES: Tuple[str, ...] = (
    "agent_id",
    "messages_or_agent_id",  # call_llm_activity: first positional may be agent_id string
    "parent_agent_id",
)


def _new_span_id() -> str:
    return uuid.uuid4().hex[:12]


def _current() -> Dict[str, Any]:
    return structlog.contextvars.get_contextvars()


def current_span_id() -> Optional[str]:
    return _current().get("span_id")


def current_request_id() -> Optional[str]:
    return _current().get("request_id")


def current_agent_id() -> Optional[str]:
    return _current().get("agent_id")


@asynccontextmanager
async def span(name: str, **metadata: Any) -> AsyncIterator[str]:
    """Async span — emits span.start/span.end, binds span_id for children."""
    span_id = _new_span_id()
    parent_span_id = current_span_id()
    tokens = structlog.contextvars.bind_contextvars(span_id=span_id)
    started = time.monotonic()
    logger.info(
        "span.start",
        span_name=name,
        span_id=span_id,
        parent_span_id=parent_span_id,
        **metadata,
    )
    status = "ok"
    try:
        yield span_id
    except BaseException:
        status = "error"
        raise
    finally:
        duration_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "span.end",
            span_name=name,
            span_id=span_id,
            parent_span_id=parent_span_id,
            duration_ms=duration_ms,
            status=status,
            **metadata,
        )
        structlog.contextvars.reset_contextvars(**tokens)


@contextmanager
def sync_span(name: str, **metadata: Any) -> Iterator[str]:
    """Sync variant — same semantics as `span()` but for non-async code."""
    span_id = _new_span_id()
    parent_span_id = current_span_id()
    tokens = structlog.contextvars.bind_contextvars(span_id=span_id)
    started = time.monotonic()
    logger.info(
        "span.start",
        span_name=name,
        span_id=span_id,
        parent_span_id=parent_span_id,
        **metadata,
    )
    status = "ok"
    try:
        yield span_id
    except BaseException:
        status = "error"
        raise
    finally:
        duration_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "span.end",
            span_name=name,
            span_id=span_id,
            parent_span_id=parent_span_id,
            duration_ms=duration_ms,
            status=status,
            **metadata,
        )
        structlog.contextvars.reset_contextvars(**tokens)


def tracing_headers() -> Dict[str, str]:
    """Build HTTP headers that propagate the current trace context to backend."""
    ctx = _current()
    headers: Dict[str, str] = {}
    if sid := ctx.get("span_id"):
        headers["X-Parent-Span-Id"] = str(sid)
    if rid := ctx.get("request_id"):
        headers["X-Request-Id"] = str(rid)
    if aid := ctx.get("agent_id"):
        headers["X-Agent-Id"] = str(aid)
    return headers


def backend_api_headers(api_key: str) -> Dict[str, str]:
    """Standard headers for backend HTTP calls, incl. tracing propagation."""
    return {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        **tracing_headers(),
    }


def bind_request_id(request_id: str) -> None:
    """Bind a request_id so subsequent HTTP calls and logs inherit it."""
    structlog.contextvars.bind_contextvars(request_id=request_id)


def _extract_agent_id(sig: inspect.Signature, args: tuple, kwargs: dict) -> Optional[str]:
    """Pull an agent_id (or equivalent) out of a call's bound arguments.

    Temporal activities run in a fresh execution context where workflow
    contextvars don't propagate, so `@traced` activities lose `agent_id`
    unless we re-bind it from the call itself.
    """
    try:
        bound = sig.bind_partial(*args, **kwargs)
    except TypeError:
        return None
    for param in _AGENT_ID_PARAM_NAMES:
        if param in bound.arguments:
            v = bound.arguments[param]
            if isinstance(v, str) and v:
                return v
    return None


def traced(name: str) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
    """Decorator: wrap an async function body with a span.

    Apply BEFORE other decorators that care only about registration (e.g.
    Temporal's @activity.defn). The span emits start/end with span_id +
    parent_span_id, and binds span_id into structlog contextvars for the
    duration of the call so nested code inherits it.

    If the wrapped function accepts an `agent_id` (or `parent_agent_id`, or a
    `messages_or_agent_id` string), it is auto-bound into structlog
    contextvars before the span opens. That way activity-level spans (which
    don't inherit workflow contextvars) still carry agent_id on their
    span.start/end events and all nested db/http/broadcast spans.
    """

    def deco(fn: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        sig = inspect.signature(fn)

        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            tokens: Dict[str, Any] = {}
            if not current_agent_id():
                aid = _extract_agent_id(sig, args, kwargs)
                if aid:
                    tokens = structlog.contextvars.bind_contextvars(agent_id=aid)
            try:
                async with span(name):
                    return await fn(*args, **kwargs)
            finally:
                if tokens:
                    structlog.contextvars.reset_contextvars(**tokens)

        return wrapper

    return deco
