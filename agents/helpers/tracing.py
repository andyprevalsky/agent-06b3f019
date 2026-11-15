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
import os
import time
import uuid
from contextlib import asynccontextmanager, contextmanager, suppress
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, Dict, Iterator, Optional, Tuple, TypeVar

import structlog
import structlog.contextvars

if TYPE_CHECKING:
    import asyncio

T = TypeVar("T")

logger = structlog.get_logger()

# Param names we accept as a stand-in for "agent_id" when auto-binding from @traced.
# Ordered by preference: an explicit agent_id wins over parent_agent_id.
_AGENT_ID_PARAM_NAMES: Tuple[str, ...] = (
    "agent_id",
    "messages_or_agent_id",  # call_llm_activity: first positional may be agent_id string
    "parent_agent_id",
)

# Runtime dimensions that are useful for latency diagnosis and cheap enough to
# attach to every span in the active scope. Large prompt/message/tool payloads
# are intentionally excluded.
_RUNTIME_CONTEXT_PARAM_NAMES: Tuple[str, ...] = (
    "agent_id",
    "parent_agent_id",
    "messages_or_agent_id",
    "request_id",
    "call_site",
    "phase",
    "agent_type",
    "tool_name",
    "tool_call_id",
    "task_id",
    "model",
    "provider",
    "code_provider",
    "user_id",
)

_SPAN_RUNTIME_CONTEXT: ContextVar[Dict[str, Any]] = ContextVar("span_runtime_context", default={})
_MAX_RUNTIME_STRING = 500
_MAX_RUNTIME_ITEMS = 40
_AGENTS_TOP_LEVEL_MODULES: Tuple[str, ...] = (
    "benchmarks",
    "domains",
    "helpers",
    "loop",
    "tools",
    "utils",
    "workflows",
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


def current_root_agent_id() -> Optional[str]:
    return _current().get("root_agent_id") or current_agent_id()


def current_bound_root_agent_id() -> Optional[str]:
    """The tree root bound by a workflow or activity header, never a guess."""
    return _current().get("root_agent_id")


def current_workflow_agent_id() -> Optional[str]:
    """Agent whose workflow scheduled the current activity (activity header)."""
    return _current().get("workflow_agent_id")


@contextmanager
def archive_scope(root_agent_id: Optional[str], agent_id: Optional[str] = None) -> Iterator[None]:
    """Bind archive identity for model calls made outside a workflow activity.

    Benchmark harness judges, warmups and transcriptions run in the CLI
    process; their records belong to the benchmark run's root bundle. An empty
    root masks any outer identity for the scope (root, acting agent and
    workflow agent), so the archive writer refuses the record loudly instead
    of filing it under an enclosing root.
    """
    if root_agent_id:
        bindings: Dict[str, Any] = {"root_agent_id": root_agent_id, "agent_id": agent_id or root_agent_id}
    else:
        bindings = {"root_agent_id": None, "agent_id": agent_id or None, "workflow_agent_id": None}
    tokens = structlog.contextvars.bind_contextvars(**bindings)
    try:
        yield
    finally:
        structlog.contextvars.reset_contextvars(**tokens)


def _sanitize_runtime_value(value: Any, depth: int = 0) -> Any:
    """Return a log-safe runtime value without dumping bulky objects."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= _MAX_RUNTIME_STRING:
            return value
        return value[:_MAX_RUNTIME_STRING] + f"...[truncated {len(value) - _MAX_RUNTIME_STRING} chars]"
    if depth >= 2:
        return f"<{type(value).__name__}>"
    if isinstance(value, (list, tuple)):
        items = [_sanitize_runtime_value(v, depth + 1) for v in list(value)[:_MAX_RUNTIME_ITEMS]]
        if len(value) > _MAX_RUNTIME_ITEMS:
            items.append(f"...[truncated {len(value) - _MAX_RUNTIME_ITEMS} items]")
        return items
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for idx, (k, v) in enumerate(value.items()):
            if idx >= _MAX_RUNTIME_ITEMS:
                out["..."] = f"truncated {len(value) - _MAX_RUNTIME_ITEMS} keys"
                break
            out[str(k)] = _sanitize_runtime_value(v, depth + 1)
        return out
    return repr(value)[:_MAX_RUNTIME_STRING]


def _sanitize_metadata(metadata: Dict[str, Any]) -> Dict[str, Any]:
    return {k: _sanitize_runtime_value(v) for k, v in metadata.items() if v is not None}


def current_span_context() -> Dict[str, Any]:
    """Return the runtime dimensions inherited by spans in this context."""
    return dict(_SPAN_RUNTIME_CONTEXT.get())


def bind_span_context(**metadata: Any) -> Token[Dict[str, Any]]:
    """Bind runtime dimensions that every nested span should dump.

    Use this for dimensions that are orthogonal to a single span but critical
    during diagnosis: phase, agent_type, tool_name, call_site, provider, etc.
    """
    ctx = current_span_context()
    ctx.update(_sanitize_metadata(metadata))
    return _SPAN_RUNTIME_CONTEXT.set(ctx)


def reset_span_context(token: Token[Dict[str, Any]]) -> None:
    _SPAN_RUNTIME_CONTEXT.reset(token)


@contextmanager
def span_context(**metadata: Any) -> Iterator[None]:
    """Scoped runtime dimensions for all spans opened inside the block."""
    token = bind_span_context(**metadata)
    try:
        yield
    finally:
        reset_span_context(token)


def _function_source(fn: Callable[..., Any]) -> str:
    module = getattr(fn, "__module__", "") or "<unknown>"
    if module.split(".", 1)[0] in _AGENTS_TOP_LEVEL_MODULES:
        module = f"agents.{module}"
    qualname = getattr(fn, "__qualname__", getattr(fn, "__name__", "<unknown>"))
    return f"{module}.{qualname}"


def _caller_source() -> str:
    """Best-effort source key for manual span()/sync_span() call sites."""
    frame = inspect.currentframe()
    this_file = os.path.abspath(__file__)
    while frame is not None:
        filename = os.path.abspath(frame.f_code.co_filename)
        if filename != this_file and not filename.endswith(os.path.join("contextlib.py")):
            rel = os.path.relpath(filename, os.getcwd())
            source_path = rel[:-3].replace(os.sep, ".") if rel.endswith(".py") else rel.replace(os.sep, ".")
            if source_path.split(".", 1)[0] in _AGENTS_TOP_LEVEL_MODULES:
                source_path = f"agents.{source_path}"
            return f"{source_path}.{frame.f_code.co_name}:{frame.f_lineno}"
        frame = frame.f_back
    return "<unknown>"


def _span_metadata(name: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
    out = _sanitize_metadata(metadata)
    out.setdefault("span_source", _caller_source())
    out.setdefault("span_key", out["span_source"])
    runtime_context = current_span_context()
    if runtime_context:
        out["runtime_context"] = runtime_context
    return out


def _temporal_activity_metadata() -> Dict[str, Any]:
    """Best-effort Temporal activity queue metadata for activity spans."""
    try:
        from temporalio import activity

        info = activity.info()
    except Exception:
        return {}

    scheduled_time = info.current_attempt_scheduled_time or info.scheduled_time
    started_time = info.started_time
    schedule_to_start_ms = int((started_time - scheduled_time).total_seconds() * 1000)
    metadata = {
        "temporal_activity_id": info.activity_id,
        "temporal_activity_type": info.activity_type,
        "temporal_activity_attempt": info.attempt,
        "temporal_task_queue": info.task_queue,
        "temporal_workflow_id": info.workflow_id,
        "temporal_workflow_run_id": info.workflow_run_id,
        "temporal_scheduled_time": scheduled_time.isoformat(),
        "temporal_started_time": started_time.isoformat(),
        "temporal_schedule_to_start_ms": max(schedule_to_start_ms, 0),
    }

    try:
        from health_server import get_queue_metrics_snapshot

        for key, value in get_queue_metrics_snapshot().items():
            metadata[f"worker_{key}_at_activity_start"] = value
    except Exception:
        pass

    return _sanitize_metadata(metadata)


# Process-wide TTL cache for the RSS snapshot. `proc.children(recursive=True)`
# walks the ENTIRE system process table (builds a full ppid map) — ~1k syscalls
# per call on a busy machine. It is called on every activity-span start/end AND
# by a 0.5s-interval background sampler PER open activity span, so under a
# 50-agent fan-out (~50+ concurrent activity spans) it ran ~100+ full
# process-table walks/second and pinned a CPU core, starving the event loop and
# stalling LLM stream reads (~1s/chunk). The snapshot is a coarse memory gauge,
# so all concurrent callers share one computation per TTL window instead of each
# walking the table. Single event loop per process → no await between the check
# and the store, so a plain time guard is race-free.
_RSS_CACHE_TTL_S = 1.0
_rss_cache: Dict[str, int] = {}
_rss_cache_at: float = -1e9


def _rss_snapshot() -> Dict[str, int]:
    """Return current worker process and child RSS, in bytes (TTL-cached)."""
    global _rss_cache, _rss_cache_at
    now = time.monotonic()
    if _rss_cache and (now - _rss_cache_at) < _RSS_CACHE_TTL_S:
        return _rss_cache
    try:
        import psutil

        proc = psutil.Process(os.getpid())
        process_rss = proc.memory_info().rss
        child_rss = 0
        for child in proc.children(recursive=True):
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                child_rss += child.memory_info().rss
        _rss_cache = {
            "process_rss_bytes": process_rss,
            "child_rss_bytes": child_rss,
            "tree_rss_bytes": process_rss + child_rss,
        }
        _rss_cache_at = now
        return _rss_cache
    except Exception:
        return {}


def _memory_metadata(prefix: str, snapshot: Dict[str, int]) -> Dict[str, int]:
    return {f"memory_{key.removesuffix('_bytes')}_{prefix}_bytes": value for key, value in snapshot.items()}


async def _sample_memory_peak(stop: "asyncio.Event", peak: Dict[str, int], interval_s: float = 0.5) -> None:
    import asyncio

    while not stop.is_set():
        snapshot = _rss_snapshot()
        for key, value in snapshot.items():
            peak[key] = max(peak.get(key, 0), value)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass


@asynccontextmanager
async def span(name: str, **metadata: Any) -> AsyncIterator[str]:
    """Async span — emits span.start/span.end, binds span_id for children."""
    import asyncio

    span_id = _new_span_id()
    parent_span_id = current_span_id()
    tokens = structlog.contextvars.bind_contextvars(span_id=span_id)
    started = time.monotonic()
    span_metadata = _span_metadata(name, metadata)
    is_activity_span = "temporal_activity_type" in span_metadata
    memory_start = _rss_snapshot() if is_activity_span else {}
    memory_peak = dict(memory_start)
    memory_stop: Optional[asyncio.Event] = None
    memory_sampler: Optional[asyncio.Task[None]] = None
    if memory_start:
        span_metadata.update(_memory_metadata("start", memory_start))
        memory_stop = asyncio.Event()
        memory_sampler = asyncio.create_task(_sample_memory_peak(memory_stop, memory_peak))
    logger.info(
        "span.start",
        span_name=name,
        span_id=span_id,
        parent_span_id=parent_span_id,
        **span_metadata,
    )
    status = "ok"
    try:
        yield span_id
    except BaseException:
        status = "error"
        raise
    finally:
        duration_ms = int((time.monotonic() - started) * 1000)
        end_metadata = dict(span_metadata)
        if memory_sampler and memory_stop:
            memory_stop.set()
            await memory_sampler
        if memory_start:
            memory_end = _rss_snapshot()
            for key, value in memory_end.items():
                memory_peak[key] = max(memory_peak.get(key, 0), value)
            end_metadata.update(_memory_metadata("end", memory_end))
            end_metadata.update(_memory_metadata("peak", memory_peak))
            for key, start_value in memory_start.items():
                if key in memory_end:
                    end_metadata[f"memory_{key.removesuffix('_bytes')}_delta_bytes"] = memory_end[key] - start_value
                if key in memory_peak:
                    end_metadata[f"memory_{key.removesuffix('_bytes')}_peak_delta_bytes"] = (
                        memory_peak[key] - start_value
                    )
        logger.info(
            "span.end",
            span_name=name,
            span_id=span_id,
            parent_span_id=parent_span_id,
            duration_ms=duration_ms,
            status=status,
            **end_metadata,
        )
        structlog.contextvars.reset_contextvars(**tokens)


@asynccontextmanager
async def stream_span(name: str, **metadata: Any) -> AsyncIterator[str]:
    """Span safe to hold open across `async for ... yield` inside an async generator.

    Unlike span(), it does NOT bind the span_id contextvar. Binding would fail
    with "Token was created in a different Context": when a generator yields out
    of the with-block and is resumed (or finalized) later, __aexit__ runs in a
    different context than __aenter__, so reset_contextvars() raises. This variant
    still emits span.start/span.end with parent linkage + duration; children nest
    under it via the tracer's time-window containment rather than the contextvar.
    Use it to wrap streaming regions (SSE reads, per-attempt token streams); use
    span() everywhere an await does not cross a yield.
    """
    span_id = _new_span_id()
    parent_span_id = current_span_id()
    started = time.monotonic()
    span_metadata = _span_metadata(name, metadata)
    logger.info(
        "span.start",
        span_name=name,
        span_id=span_id,
        parent_span_id=parent_span_id,
        **span_metadata,
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
            **span_metadata,
        )


@contextmanager
def sync_span(name: str, **metadata: Any) -> Iterator[str]:
    """Sync variant — same semantics as `span()` but for non-async code."""
    span_id = _new_span_id()
    parent_span_id = current_span_id()
    tokens = structlog.contextvars.bind_contextvars(span_id=span_id)
    started = time.monotonic()
    span_metadata = _span_metadata(name, metadata)
    logger.info(
        "span.start",
        span_name=name,
        span_id=span_id,
        parent_span_id=parent_span_id,
        **span_metadata,
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
            **span_metadata,
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


def rose_api_headers(
    api_key: str,
    anon_key: str,
    call_site: str,
    fallback_request_id: str,
    fallback_agent_id: Optional[str] = None,
) -> Dict[str, str]:
    """Headers for Rose/Research calls with trace propagation.

    Prefers the active trace context (X-Parent-Span-Id / X-Request-Id /
    X-Agent-Id from `tracing_headers()`) so research spans nest under the
    agent caller. Falls back to the provided request_id / agent_id when no
    trace context is bound (e.g. tests, ad-hoc scripts).
    """
    h: Dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {anon_key}",
        "x-api-key": api_key,
        "x-call-site": call_site,
        **tracing_headers(),
    }
    if "X-Request-Id" not in h:
        h["X-Request-Id"] = fallback_request_id
    if "X-Agent-Id" not in h and fallback_agent_id:
        h["X-Agent-Id"] = fallback_agent_id
    return h


def bind_request_id(request_id: str) -> Dict[str, Any]:
    """Bind a request_id so subsequent HTTP calls and logs inherit it.

    Returns the token dict from structlog so callers can restore the previous
    context via `structlog.contextvars.reset_contextvars(**token)` in a
    finally block. Callers that don't need to restore may ignore the return.
    """
    return structlog.contextvars.bind_contextvars(request_id=request_id)


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


def _extract_runtime_context(sig: inspect.Signature, args: tuple, kwargs: dict) -> Dict[str, Any]:
    try:
        bound = sig.bind_partial(*args, **kwargs)
    except TypeError:
        return {}

    runtime_context: Dict[str, Any] = {}
    for param in _RUNTIME_CONTEXT_PARAM_NAMES:
        if param not in bound.arguments:
            continue
        value = bound.arguments[param]
        if param == "messages_or_agent_id":
            if isinstance(value, str) and value:
                runtime_context["agent_id"] = value
            continue
        runtime_context[param] = value
    if "is_plan_loop" in bound.arguments and "phase" not in runtime_context:
        runtime_context["phase"] = "plan" if bound.arguments["is_plan_loop"] else "execute"
    if "call_site_override" in bound.arguments and bound.arguments["call_site_override"]:
        runtime_context.setdefault("call_site", bound.arguments["call_site_override"])
        runtime_context.setdefault(
            "agent_type",
            str(bound.arguments["call_site_override"]).removesuffix("_agent"),
        )
    return _sanitize_metadata(runtime_context)


def traced(
    name: str,
    *,
    span_key: Optional[str] = None,
    span_source: Optional[str] = None,
) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
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
        source = span_source or _function_source(fn)
        key = span_key or source

        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            tokens: Dict[str, Any] = {}
            runtime_token: Optional[Token[Dict[str, Any]]] = None
            if not current_agent_id():
                aid = _extract_agent_id(sig, args, kwargs)
                if aid:
                    tokens = structlog.contextvars.bind_contextvars(agent_id=aid)
            runtime_context = _extract_runtime_context(sig, args, kwargs)
            if runtime_context:
                runtime_token = bind_span_context(**runtime_context)
            dynamic_key = key
            if runtime_context.get("call_site"):
                dynamic_key = f"{key}:{runtime_context['call_site']}"
            temporal_metadata = _temporal_activity_metadata()
            try:
                async with span(name, span_key=dynamic_key, span_source=source, **temporal_metadata):
                    return await fn(*args, **kwargs)
            finally:
                if runtime_token:
                    reset_span_context(runtime_token)
                if tokens:
                    structlog.contextvars.reset_contextvars(**tokens)

        return wrapper

    return deco
