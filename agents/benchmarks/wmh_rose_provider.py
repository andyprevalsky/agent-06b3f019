"""World Model Harness (WMH) inference provider backed by Rose completions.

The vendored `wmh.providers.anthropic.AnthropicProvider` calls Anthropic directly
(reads `ANTHROPIC_API_KEY`, no compute tokens, no rotation). This module supplies a
drop-in replacement — `RoseWMHProvider` — that routes the WMH's per-step LLM call
through the EXISTING agent-side Rose machinery instead:

    WMH step  ->  RoseWMHProvider.complete()  ->  RoseClient.collect(pool="rose-1-ultra")
                     |                                    |
                     |                                    +-- claudeAuth / gptAuth direct
                     |                                        compute-token routing + rotation
                     +-- leases a compute token per call via the SAME helpers the agent
                         uses (helpers.llm.fetch_compute_token_activity +
                         _build_compute_auth_context), which already wire the rotation
                         callbacks (fetch_fresh / mark_rate_limited / heartbeat_lease).

Nothing here re-implements token leasing or rotation: leasing is one call to
`fetch_compute_token_activity`, and rotation is owned entirely by `RoseClient` via the
callbacks baked into the `ComputeAuthContext` that `_build_compute_auth_context` returns.

Sync -> async bridge: WMH's `Provider.complete` is synchronous (the serve `/step` route
runs in a FastAPI threadpool, so there is no running event loop), while `RoseClient` is
async. All serve threads submit to one process-wide event loop: Fast Cache batches
asyncio futures and tasks that must stay on their owning loop.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
from copy import deepcopy
from dataclasses import dataclass
from typing import TYPE_CHECKING, List, Optional

import structlog

from benchmarks.wmh_outcomes import DISTRIBUTION_PROTOCOL, parse_distribution
from providers.fast_cache.context import FastCacheContext
from providers.rose import (
    ClaudeAuthContext,
    GptAuthContext,
    RoseClient,
)
from providers.rose.pricing import get_model_pricing
from providers.rose.types import StreamChunk
from utils.world_model_observation import effective_world_model_content

if TYPE_CHECKING:  # pragma: no cover - typing only
    from wmh.providers.base import Completion, Message

    from providers.rose.types import PoolName

logger = structlog.get_logger(__name__)

_WMH_ASYNC_LOOP: asyncio.AbstractEventLoop | None = None
_WMH_ASYNC_LOOP_LOCK = threading.Lock()
_WMH_NATIVE_JOIN_TIMEOUT_SECONDS = 10.0


def _wmh_async_loop() -> asyncio.AbstractEventLoop:
    """One event loop for all served WMH calls sharing Fast Cache async state."""
    global _WMH_ASYNC_LOOP
    with _WMH_ASYNC_LOOP_LOCK:
        if _WMH_ASYNC_LOOP is None:
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def run() -> None:
                asyncio.set_event_loop(loop)
                ready.set()
                loop.run_forever()

            threading.Thread(target=run, name="rose-wmh-async", daemon=True).start()
            if not ready.wait(timeout=5):
                raise RuntimeError("WMH async event loop failed to start")
            _WMH_ASYNC_LOOP = loop
        return _WMH_ASYNC_LOOP


# The benchmark user whose pooled compute tokens back WMH inference by default.
# Overridable via env so a different tenant's pool can be used.
_DEFAULT_WMH_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"

# WMH step prompts are single-shot env simulations. Reasoning-capable providers
# count hidden reasoning against this ceiling: an 8k ceiling can leave only a
# partial visible observation even when the requested manifest is compact. Give
# the model enough room to finish the terminal JSON rather than accepting a
# syntactically truncated environment result.
_WMH_MAX_TOKENS = 16_384

_TASK_MARKER = "TASK:\n"
_HISTORY_MARKER = "\n\nINTERACTION HISTORY:\n"
_ROOT_OBJECTIVE_MARKER = "ROOT OBJECTIVE:\n"
_DELEGATION_MARKER = "\n\nCURRENT DELEGATION:\n"
_ACTION_TIMESTAMP_RE = re.compile(r'("timestamp_ms"\s*:\s*)\d+')
_NATIVE_WMH_PROTOCOLS = {"text-world-model-v3", DISTRIBUTION_PROTOCOL}
_WMH_CALL_SITES = {
    "legacy": "wmh_world_model",
    "text-world-model-v3": "wmh_world_model_v3",
    DISTRIBUTION_PROTOCOL: "wmh_world_model_distribution_v1",
}


def _prompt_text(content: object) -> str:
    """Read pure text provider blocks without dropping any native evidence."""
    if isinstance(content, str):
        return content
    if isinstance(content, list) and content and all(
        isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        for block in content
    ):
        return "".join(block["text"] for block in content)
    raise TypeError("Native WMH evidence must contain only text")


def _wmh_cache_key_material(request: object) -> object:
    """Ignore action-envelope timestamps in cache keys, never in model input.

    WMH renders canonical actions as single ``arguments:`` or ``tool_call``
    lines. Their millisecond invocation timestamp changes on every DEMO run,
    even when the root objective and action are otherwise identical. Restrict
    this normalization to action lines so timestamps in observations and state
    remain behavior-shaping cache material.
    """
    if not isinstance(request, dict) or not isinstance(request.get("messages"), list):
        return request
    messages = []
    for message in request["messages"]:
        if (
            not isinstance(message, dict)
            or message.get("role") != "user"
        ):
            messages.append(message)
            continue
        try:
            text = _prompt_text(message.get("content"))
            native = json.loads(text)
        except TypeError:
            messages.append(message)
            continue
        except ValueError:
            native = None
        if isinstance(native, dict) and "candidate_response" in native:
            calls = native.get("candidate_response", {}).get("tool_calls", [])
            for call in calls:
                if isinstance(call.get("arguments"), dict):
                    call["arguments"].pop("timestamp_ms", None)
            messages.append(
                {**message, "content": json.dumps(native, ensure_ascii=False, sort_keys=True, separators=(",", ":"))}
            )
            continue
        lines = []
        for line in text.splitlines(keepends=True):
            if line.startswith("  arguments: ") or line.startswith("tool_call "):
                line = _ACTION_TIMESTAMP_RE.sub(r"\g<1><timestamp_ms>", line)
            lines.append(line)
        messages.append({**message, "content": "".join(lines)})
    material = {**request, "messages": messages}
    namespace = material.get("cache_namespace")
    if isinstance(namespace, str) and namespace.startswith("wmh:session:"):
        # Affinity is a provider routing hint, not simulation evidence. Retain
        # the old None-valued key shape so a new native session can replay an
        # otherwise exact request; call IDs, state and policy still bind it.
        material["cache_namespace"] = None
    return material


class _WMHFastCacheContext(FastCacheContext):
    """WMH-only cache fingerprint; the Rose completion still sees exact input."""

    @property
    def should_write(self) -> bool:
        # This context is installed only for a recognized DEMO goal. Isolated
        # benches keep ordinary agent write-through read-only against the shared
        # cache, but WHM predictions must populate their own DEMO keys.
        return bool(self.enabled and self.write_enabled)

    def llm_key(self, call_site: str, messages: object = None) -> str:
        if call_site in _WMH_CALL_SITES.values():
            messages = _wmh_cache_key_material(messages)
        if (
            call_site in {"wmh_world_model_v3", "wmh_world_model_distribution_v1"}
            and isinstance(messages, dict)
            and isinstance(messages.get("messages"), list)
        ):
            # Generic DEMO normalization removes UUIDs and clocks. Native output
            # is correlated to exact call IDs, and state/history clocks shape its
            # prediction. Bind those inputs before applying generic normalization.
            from benchmarks.wmh_execution_policy import cache_policy_identity

            policy = cache_policy_identity(messages["messages"])
            if policy is not None:
                messages = {**messages, "native_execution_policy": policy}
            material = json.dumps(messages["messages"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            messages = {**messages, "native_request_fingerprint": hashlib.sha256(material.encode()).hexdigest()}
        return super().llm_key(call_site, messages)


class _WMHInvalidPrediction(ValueError):
    """An unusable completion, retaining metering without retaining credentials."""

    def __init__(self, reason: str, usage: dict, actual_model: str) -> None:
        super().__init__(f"WMH prediction rejected: {reason}")
        self.usage = {
            key: usage[key] for key in ("prompt_tokens", "completion_tokens", "finish_reason") if key in usage
        }
        self.actual_model = actual_model


def _native_call_ids(messages: list[dict]) -> tuple[str, ...] | None:
    for message in messages:
        if message.get("role") != "user":
            continue
        try:
            evidence = json.loads(_prompt_text(message["content"]))
        except (ValueError, TypeError, KeyError):
            continue
        if isinstance(evidence, dict) and isinstance(evidence.get("candidate_response"), dict):
            return tuple(call["call_id"] for call in evidence["candidate_response"].get("tool_calls", ()))
    return None


def _native_environment_state(messages: list[dict]) -> dict | None:
    """Read the exact state bound to the native candidate, without a fallback.

    A missing, malformed or ambiguous request cannot supply an empty base state
    for a distribution's patches. Returning ``None`` lets the prediction
    boundary retain its normal rejection/metering behavior.
    """
    state = None
    found = False
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        try:
            evidence = json.loads(_prompt_text(message["content"]))
        except (ValueError, TypeError, KeyError):
            continue
        if not isinstance(evidence, dict) or "candidate_response" not in evidence:
            continue
        if found or not isinstance(evidence["candidate_response"], dict):
            return None
        found = True
        candidate_state = evidence.get("environment_state")
        if not isinstance(candidate_state, dict):
            return None
        try:
            json.dumps(candidate_state, allow_nan=False)
        except (ValueError, TypeError):
            return None
        state = candidate_state
    return state


def _prediction_call_ids(messages: list[dict], protocol: str) -> tuple[str, ...] | None:
    if protocol == "text-world-model-v3":
        return _native_call_ids(messages)
    if protocol != DISTRIBUTION_PROTOCOL:
        return None
    try:
        call_ids = _native_call_ids(messages)
    except (ValueError, TypeError, KeyError, AttributeError):
        return None
    if not call_ids or any(not isinstance(call_id, str) or not call_id for call_id in call_ids):
        return None
    return call_ids


def _require_wmh_prediction(
    content: str,
    usage: dict,
    actual_model: str,
    *,
    protocol: str = "legacy",
    expected_call_ids: tuple[str, ...] | None = None,
    base_state: dict | None = None,
) -> None:
    from helpers.world_model_runtime import parse_world_model_prediction

    reason = "empty visible content" if not content.strip() else None
    if reason is None and protocol == DISTRIBUTION_PROTOCOL:
        try:
            if base_state is None:
                raise ValueError("Missing or malformed native environment state")
            if expected_call_ids is None:
                raise ValueError("Missing native candidate call IDs")
            # Validate every possible result, including branches that will not
            # be sampled. No invalid branch may enter the shared response cache.
            parse_distribution(content, base_state=base_state, expected_call_ids=expected_call_ids)
        except (ValueError, TypeError, KeyError) as exc:
            reason = str(exc)
    elif reason is None and protocol == "text-world-model-v3":
        raw = content.strip()
        if raw.startswith("```") and raw.endswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        try:
            native = json.loads(raw)
            if not isinstance(native, dict) or set(native) != {"message", "tool_results", "state", "terminal"}:
                raise ValueError("Invalid native transition keys")
            if native["message"] != "" or native["terminal"] is not False or not isinstance(native["state"], dict):
                raise ValueError("Invalid native tool transition")
            if not isinstance(native["tool_results"], list) or not native["tool_results"]:
                raise ValueError("Missing native tool observations")
            for result in native["tool_results"]:
                if (
                    set(result) != {"call_id", "content", "is_error"}
                    or not isinstance(result["call_id"], str)
                    or not result["call_id"]
                    or not isinstance(result["content"], str)
                    or not effective_world_model_content(result["content"]).strip()
                    or type(result["is_error"]) is not bool
                ):
                    raise ValueError("Invalid native tool observation")
            if (
                expected_call_ids is not None
                and tuple(result["call_id"] for result in native["tool_results"]) != expected_call_ids
            ):
                raise ValueError("Native result call IDs differ from the candidate action")
            json.dumps(native, allow_nan=False)
        except (ValueError, TypeError, KeyError) as exc:
            reason = str(exc)
    elif reason is None:
        observation = parse_world_model_prediction(content)
        observation_content = effective_world_model_content(observation["content"])
        if not observation_content.strip():
            reason = "empty observation content"
    if reason is None and usage.get("finish_reason") == "length":
        reason = "completion token limit reached"
    if reason is not None:
        logger.warning("wmh.rose.invalid_prediction", reason=reason, actual_model=actual_model)
        raise _WMHInvalidPrediction(reason, usage, actual_model)


class _WMHCacheSafeRoseClient(RoseClient):
    """Keep leased credentials out of WMH's persisted DEMO response stream."""

    async def _complete_impl(self, **kwargs):
        call_site = kwargs.get("call_site")
        is_wmh = call_site in _WMH_CALL_SITES.values()
        protocol = next((name for name, site in _WMH_CALL_SITES.items() if site == call_site), "legacy")
        content_parts = []
        usage = {}
        actual_model = ""
        async for chunk in super()._complete_impl(**kwargs):
            if is_wmh:
                if chunk.kind == "content":
                    content_parts.append(chunk.data.get("text", ""))
                elif chunk.kind == "metadata":
                    actual_model = chunk.data.get("actual_model", "")
                elif chunk.kind == "usage":
                    usage = chunk.data
                elif chunk.kind == "done":
                    # Rose writes the DEMO cache on done. Reject unusable output
                    # before that marker, and before WMH can commit a step.
                    _require_wmh_prediction(
                        "".join(content_parts),
                        usage,
                        actual_model,
                        protocol=protocol,
                        expected_call_ids=_prediction_call_ids(kwargs.get("messages", []), protocol),
                        base_state=_native_environment_state(kwargs.get("messages", []))
                        if protocol == DISTRIBUTION_PROTOCOL
                        else None,
                    )
            if is_wmh and chunk.kind == "usage":
                token = chunk.data.get("compute_token_used")
                if isinstance(token, dict):
                    # WMH only needs these two fields for usage reporting. The
                    # underlying Rose call has already completed token rotation.
                    safe_token = {key: token[key] for key in ("type", "source") if key in token}
                    yield StreamChunk(
                        kind="usage",
                        data={**chunk.data, "compute_token_used": safe_token},
                    )
                    continue
            yield chunk


def _resolve_user_id(explicit: Optional[str]) -> str:
    """User id for the compute-token lease: explicit arg > env > benchmark default."""
    return explicit or os.environ.get("WMH_ROSE_USER_ID") or _DEFAULT_WMH_USER_ID


def _wmh_task_from_messages(messages: List["Message"]) -> Optional[str]:
    """Extract the task field from WMH's canonical environment prompt."""
    for message in messages:
        content = message.content
        if message.role != "user" or not isinstance(content, str):
            continue
        try:
            native = json.loads(content)
        except ValueError:
            native = None
        if isinstance(native, dict) and isinstance(native.get("task"), dict):
            instruction = native["task"].get("instruction")
            if isinstance(instruction, str) and instruction.strip():
                return instruction.strip()
        _prefix, marker, tail = content.partition(_TASK_MARKER)
        if not marker:
            continue
        task, history_marker, _history = tail.partition(_HISTORY_MARKER)
        if history_marker and task.strip() and task.strip() != "(none)":
            return task.strip()
    return None


def _demo_cache_goal_from_messages(messages: List["Message"]) -> Optional[str]:
    """Return the exact DEMO root goal carried by a WMH step, if any.

    Specialized-agent sessions retain the root objective plus the current
    delegation in the WMH task slot. Cache entries use the root goal so agent
    LLM calls and WMH prediction calls can be purged together after a bad demo
    trajectory.
    """
    from providers.fast_cache.normalize import demo_cache_allowed

    task = _wmh_task_from_messages(messages)
    if not task:
        return None
    candidates = [task]
    if task.startswith(_ROOT_OBJECTIVE_MARKER):
        root_goal, marker, _delegation = task.removeprefix(_ROOT_OBJECTIVE_MARKER).partition(_DELEGATION_MARKER)
        if marker and root_goal.strip():
            candidates.insert(0, root_goal.strip())
    return next((candidate for candidate in candidates if demo_cache_allowed(candidate)), None)


@dataclass(frozen=True)
class RoseUsageSnapshot:
    """An immutable view of the cumulative Rose inference usage for a served WMH."""

    total_cost_usd: float
    calls: int
    input_tokens: int
    output_tokens: int

    def as_dict(self) -> dict:
        return {
            "total_cost_usd": round(self.total_cost_usd, 6),
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
        }


class RoseUsageAccumulator:
    """Process-level, thread-safe tally of Rose inference cost + tokens.

    WMH steps run in a FastAPI threadpool (one thread per concurrent step), so the
    accumulator must be safe under concurrent `record()` calls. A single lock guards
    the counters — the critical section is a handful of additions, so contention is
    negligible relative to the LLM call it follows.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._total_cost_usd = 0.0
        self._calls = 0
        self._input_tokens = 0
        self._output_tokens = 0

    def record(self, *, cost_usd: float, input_tokens: int, output_tokens: int) -> None:
        with self._lock:
            self._total_cost_usd += cost_usd
            self._calls += 1
            self._input_tokens += input_tokens
            self._output_tokens += output_tokens

    def snapshot(self) -> RoseUsageSnapshot:
        with self._lock:
            return RoseUsageSnapshot(
                total_cost_usd=self._total_cost_usd,
                calls=self._calls,
                input_tokens=self._input_tokens,
                output_tokens=self._output_tokens,
            )


def _cost_usd_for_call(actual_model: str, input_tokens: int, output_tokens: int) -> float:
    """USD cost of one Rose call from token counts × the model's pricing.

    Rose's `usage` dict carries no cost field, so we derive it exactly the way the
    rest of the agents stack does: look up cents-per-1k for `actual_model` via the
    shared `providers.rose.pricing` table and multiply by the tokens.

    claudeAuth/gptAuth direct paths (`actual_model` ends `-claude`/`-gpt`) are priced
    at $0 in that table — the user's own subscription pays — so this correctly returns
    0.0 for the common WMH path. Waterfall models return their real averaged pool price.
    Unknown models return 0.0 (no invented numbers); the token counts are still tracked.
    """
    pricing = get_model_pricing(actual_model or "")
    if not pricing:
        return 0.0
    input_cost = (input_tokens / 1000.0) * pricing["input_cents_per_1k"]
    output_cost = (output_tokens / 1000.0) * pricing["output_cents_per_1k"]
    return (input_cost + output_cost) / 100.0  # cents → USD


# Process-level usage tally shared by every provider instance in the served app. The
# served WMH constructs one provider, but keeping the accumulator at module scope means
# the `/rose_usage` route can read it without threading the provider handle through the
# FastAPI app. Reset per process (a served WMH is one benchmark run).
GLOBAL_ROSE_USAGE = RoseUsageAccumulator()


class _RoseProviderConfig:
    """Minimal `config` object the WorldModel reads for metering.

    `wmh.engine.world_model.WorldModel.step` reads `self._provider.config.model` to
    attribute token usage to a model name. The vendored providers expose a full
    `ProviderConfig`; the WorldModel only ever touches `.model`, so a tiny shim
    suffices and keeps us free of the vendored `ProviderConfig` pydantic surface.
    """

    def __init__(self, model: str) -> None:
        self.model = model


@dataclass
class _NativeCompletion:
    text: str
    usage: object
    actual_model: str


class RoseWMHProvider:
    """WMH `Provider` whose `complete()` routes through Rose completions.

    Implements the subset of the `wmh.providers.base.Provider` protocol that serving
    exercises: `.config.model` (metering) and `.complete(system, messages)` (generation).
    Retrieval uses the offline `HashingEmbedder`, so `embed()` is never called during
    serving; `verify()` is not on the serve path either. Both raise clearly if invoked.
    """

    def __init__(
        self,
        *,
        pool: "PoolName" = "rose-1-ultra",
        user_id: Optional[str] = None,
        model_label: Optional[str] = None,
        client: Optional[RoseClient] = None,
        usage: Optional[RoseUsageAccumulator] = None,
        protocol: str = "legacy",
    ) -> None:
        self._pool: "PoolName" = pool
        if protocol not in _WMH_CALL_SITES:
            raise ValueError("Unknown world-model protocol")
        self._protocol = protocol
        self._user_id = _resolve_user_id(user_id)
        # `config.model` is a metering label only (no model resolution happens here —
        # the pool decides the real model). Default to the pool name so the metered
        # rows read e.g. "rose-1-ultra".
        self.config = _RoseProviderConfig(model_label or pool)
        self._client = client or _WMHCacheSafeRoseClient()
        # Cumulative Rose inference cost/tokens across every step this served WMH runs.
        # Defaults to the process-level accumulator the `/rose_usage` route reads; tests
        # inject their own to assert accumulation in isolation.
        self._usage = usage if usage is not None else GLOBAL_ROSE_USAGE
        # Native scope ownership lives exclusively on the shared provider loop.
        self._native_operations: dict[str, dict[str, tuple[str, asyncio.Task]]] = {}
        self._native_retirements: dict[str, asyncio.Task] = {}
        self._native_closed_scopes: set[str] = set()
        self._maximum_native_scopes = 16384

    # -- WMH Provider protocol -------------------------------------------------

    def complete(
        self,
        system: str,
        messages: List["Message"],
        *,
        temperature: float = 0.7,
        max_tokens: int = _WMH_MAX_TOKENS,
    ) -> "Completion":
        """Generate a completion for one WMH step through Rose.

        Sync entrypoint (called from the FastAPI threadpool). Concurrent calls run
        on a shared event loop so Fast Cache never passes futures between loops.
        `temperature` is accepted for protocol parity
        but not forwarded: rose-1-ultra's claudeAuth path (Anthropic) rejects sampling
        params, matching the vendored AnthropicProvider's behavior.
        """
        loop = _wmh_async_loop()
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is loop:
            raise RuntimeError("WMH synchronous complete cannot run on its async bridge loop")
        future = asyncio.run_coroutine_threadsafe(self._complete_async(system, messages, max_tokens=max_tokens), loop)
        return future.result()

    async def complete_scoped(
        self, session_id: str, prediction_id: str, system: str, messages: List["Message"], *, max_tokens: int
    ) -> "Completion":
        """Keep native work cancellable without moving Fast Cache between loops."""
        loop = _wmh_async_loop()
        coroutine = self._complete_scoped_on_loop(session_id, prediction_id, system, messages, max_tokens)
        if asyncio.get_running_loop() is loop:
            return await coroutine
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coroutine, loop))

    async def _complete_scoped_on_loop(self, session_id, prediction_id, system, messages, max_tokens):
        if session_id in self._native_closed_scopes:
            raise ValueError("Native provider session is retired")
        identity = hashlib.sha256(
            json.dumps(
                {"messages": _to_rose_messages(system, messages), "max_tokens": max_tokens},
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
        if session_id not in self._native_operations:
            if len(self._native_closed_scopes.union(self._native_operations)) >= self._maximum_native_scopes:
                raise ValueError("Native provider scope capacity reached")
            self._native_operations[session_id] = {}
        operations = self._native_operations[session_id]
        existing = operations.get(prediction_id)
        if existing:
            if existing[0] != identity:
                raise ValueError("Native prediction ID reused for a different request")
            task = existing[1]
        else:
            task = asyncio.create_task(
                self._complete_async(
                    system, messages, max_tokens=max_tokens, cache_namespace=f"wmh:session:{session_id}"
                )
            )
            operations[prediction_id] = (identity, task)

            def completed(done):
                # Retrieve failures even if an HTTP waiter disconnected. Explicit
                # retirement still joins the actual task, not its wrapper Future.
                if not done.cancelled():
                    done.exception()
                if operations.get(prediction_id, (None, None))[1] is done:
                    operations.pop(prediction_id, None)
                if not operations and self._native_operations.get(session_id) is operations:
                    self._native_operations.pop(session_id, None)

            task.add_done_callback(completed)
        return await asyncio.shield(task)

    async def retire_scope(self, session_id: str) -> dict:
        """Fence this scope and await actual provider cleanup before acknowledging."""
        loop = _wmh_async_loop()
        coroutine = self._retire_scope_on_loop(session_id)
        if asyncio.get_running_loop() is loop:
            return await coroutine
        # Losing this HTTP waiter cannot abandon a retirement already admitted.
        return await asyncio.shield(asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coroutine, loop)))

    async def _retire_scope_on_loop(self, session_id):
        existing = self._native_retirements.get(session_id)
        if existing is None:
            if (
                session_id not in self._native_closed_scopes
                and session_id not in self._native_operations
                and len(self._native_closed_scopes.union(self._native_operations)) >= self._maximum_native_scopes
            ):
                raise ValueError("Native provider retirement capacity reached")
            self._native_closed_scopes.add(session_id)

            async def join():
                tasks = [item[1] for item in self._native_operations.get(session_id, {}).values()]
                for task in tasks:
                    if not task.cancelling():
                        task.cancel()
                if tasks:
                    _, pending = await asyncio.wait(tasks, timeout=_WMH_NATIVE_JOIN_TIMEOUT_SECONDS)
                    if pending:
                        raise RuntimeError("Native provider tasks did not join during retirement")
                    await asyncio.gather(*tasks, return_exceptions=True)
                self._native_operations.pop(session_id, None)
                return {"session_id": session_id, "join_verified": True, "usage": self._usage.snapshot().as_dict()}

            existing = asyncio.create_task(join())
            # Duplicate retirement callers share this owner and its frozen receipt.
            self._native_retirements[session_id] = existing

            def completed(done):
                # Keep the compact admission fence, rather than retaining a failed
                # retirement traceback and its entire provider request indefinitely.
                if done.cancelled() or done.exception() is not None:
                    if self._native_retirements.get(session_id) is done:
                        self._native_retirements.pop(session_id, None)

            existing.add_done_callback(completed)
        return deepcopy(await asyncio.shield(existing))

    def embed(self, texts: List[str]) -> List[List[float]]:  # pragma: no cover - not on serve path
        raise NotImplementedError(
            "RoseWMHProvider has no embeddings API; WMH retrieval uses the offline "
            "HashingEmbedder, so serving never calls embed()."
        )

    def verify(self):  # pragma: no cover - not on serve path
        raise NotImplementedError("RoseWMHProvider does not implement verify(); it is not on the serve step path.")

    # -- internals -------------------------------------------------------------

    async def _complete_async(
        self,
        system: str,
        messages: List["Message"],
        *,
        max_tokens: int,
        cache_namespace: str | None = None,
    ) -> "Completion":
        # Import the vendored value types lazily so importing this module doesn't require
        # the `wmh` package (e.g. for unit tests that monkeypatch the client).
        from wmh.providers.base import Completion, TokenUsage

        from providers.fast_cache.context import (
            current_context,
            reset_context,
            set_context,
        )

        rose_messages = _to_rose_messages(system, messages)
        demo_goal = _demo_cache_goal_from_messages(messages)
        cache_token = None
        existing_cache_context = current_context()
        if demo_goal and (existing_cache_context is None or not existing_cache_context.active):
            cache_token = set_context(
                _WMHFastCacheContext(
                    enabled=True,
                    goal=demo_goal,
                    write_enabled=True,
                    root_goal=demo_goal,
                    provider_fast_mode=True,
                )
            )
        try:
            claude_auth, gpt_auth = await self._lease_auth()
            response = await self._client.collect(
                pool=self._pool,
                messages=rose_messages,
                max_tokens=max_tokens,
                claude_auth=claude_auth,
                gpt_auth=gpt_auth,
                call_site=_WMH_CALL_SITES[self._protocol],
                dump_context=False,
                cache_namespace=cache_namespace,
            )
        except _WMHInvalidPrediction as exc:
            self._record_usage(exc.usage, exc.actual_model)
            raise
        finally:
            if cache_token is not None:
                reset_context(cache_token)

        usage = response.usage or {}
        input_tokens, output_tokens = self._record_usage(usage, response.actual_model or "")
        # Cached responses bypass _complete_impl; validate them at the provider
        # boundary as well. A rejected prediction never reaches parse_observation.
        _require_wmh_prediction(
            response.content,
            usage,
            response.actual_model or "",
            protocol=self._protocol,
            expected_call_ids=_prediction_call_ids(rose_messages, self._protocol),
            base_state=_native_environment_state(rose_messages) if self._protocol == DISTRIBUTION_PROTOCOL else None,
        )

        completion_type = _NativeCompletion if self._protocol in _NATIVE_WMH_PROTOCOLS else Completion
        extra = {"actual_model": response.actual_model or ""} if self._protocol in _NATIVE_WMH_PROTOCOLS else {}
        return completion_type(
            text=response.content,
            usage=TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens),
            **extra,
        )

    def _record_usage(self, usage: dict, actual_model: str) -> tuple[int, int]:
        token_used = usage.get("compute_token_used")
        input_tokens = int(usage.get("prompt_tokens", 0) or 0)
        output_tokens = int(usage.get("completion_tokens", 0) or 0)
        # Rose returns no cost field, so derive it from tokens × the actual model's
        # pricing (claudeAuth/gptAuth direct = $0; waterfall = real pool price). This is
        # the only place WMH grounding cost is measured — surfaced via /rose_usage.
        cost_usd = _cost_usd_for_call(actual_model, input_tokens, output_tokens)
        self._usage.record(cost_usd=cost_usd, input_tokens=input_tokens, output_tokens=output_tokens)
        logger.info(
            "wmh.rose.complete",
            pool=self._pool,
            actual_model=actual_model,
            compute_token_used=bool(token_used),
            compute_token_type=(token_used or {}).get("type") if isinstance(token_used, dict) else None,
            compute_token_rotated=bool(usage.get("compute_token_rotated")),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=round(cost_usd, 6),
        )

        return input_tokens, output_tokens

    async def _lease_auth(self):
        """Lease one compute token and build the rotation-capable auth context.

        Reuses the agent-side lease + rotation wiring verbatim:
          - `fetch_compute_token_activity` leases a claude|gpt token from the backend.
          - `_build_compute_auth_context` returns a Claude/Gpt `ComputeAuthContext`
            with `fetch_fresh` / `mark_rate_limited` / `heartbeat_lease` already bound
            to the rotation activity functions. RoseClient drives rotation via those.

        Returns `(claude_auth, gpt_auth)` — exactly one is non-None (or both None if
        the user has no compute credentials, in which case Rose falls to the waterfall).
        """
        # Imported here (not at module top) so this benchmark-home module doesn't pull
        # the heavy helpers.llm graph on import; it's only needed when actually serving.
        from helpers.llm import (
            _build_compute_auth_context,
            fetch_compute_token_activity,
        )

        result = await fetch_compute_token_activity(self._user_id)
        if not result or not result.get("accessToken"):
            logger.info("wmh.rose.no_compute_token", user_id=self._user_id)
            return None, None

        ctx = _build_compute_auth_context(result, self._user_id)
        if isinstance(ctx, ClaudeAuthContext):
            return ctx, None
        if isinstance(ctx, GptAuthContext):
            return None, ctx
        return None, None


def _to_rose_messages(system: str, messages: List["Message"]) -> List[dict]:
    """Convert WMH `Message`s to Rose's OpenAI-style message dicts.

    Rose takes the system prompt as a leading `role: "system"` message (not a kwarg),
    then the user/assistant turns. WMH only ever sends a single user message for a
    step, but we forward all turns generically.
    """
    rose: List[dict] = []
    if system:
        rose.append({"role": "system", "content": system})
    for m in messages:
        content = m.content
        if m.role == "user" and isinstance(content, str):
            try:
                native = json.loads(content)
            except ValueError:
                native = None
            if (
                isinstance(native, dict)
                and "candidate_response" in native
                and isinstance(native.get("task"), dict)
            ):
                # The upstream sorted JSON puts the changing action first.
                # Keep all values, but place shared task context before it so
                # provider prompt caching can reuse more than the system alone.
                order = (
                    "task",
                    "grounding_schema_version",
                    "environment_state",
                    "visible_conversation",
                    "grounding_contexts",
                    "grounded_examples",
                )
                task = native["task"]
                if all(key in task for key in ("initial_context", "instruction", "task_id")):
                    content = _native_prompt_blocks(native)
                elif next(iter(native)) != "task":
                    ordered = {key: native[key] for key in order if key in native}
                    ordered.update({
                        key: value for key, value in native.items()
                        if key not in ordered and key != "candidate_response"
                    })
                    ordered["candidate_response"] = native["candidate_response"]
                    content = json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))
        rose.append({"role": m.role, "content": content})
    return rose


def _native_prompt_blocks(native: dict) -> List[dict]:
    """Mark exact shared context and completed history without dropping values."""
    def encode(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    task = native["task"]
    stable_keys = ("initial_context", "instruction", "task_id")
    stable = {key: task[key] for key in stable_keys}
    remainder = {key: value for key, value in task.items() if key not in stable}
    text = '{"task":' + encode(stable)[:-1]
    cuts = [len(text)]
    text += "," + encode(remainder)[1:] if remainder else "}"
    cuts.append(len(text))
    emitted = {"task"}

    def field(key: str) -> None:
        nonlocal text
        if key in native:
            text += "," + encode(key) + ":" + encode(native[key])
            emitted.add(key)

    field("grounding_schema_version")
    # Retrieval follows history for this measured layout.
    history = native.get("visible_conversation")
    if isinstance(history, list) and all(isinstance(entry, dict) for entry in history):
        # A boundary after each of the last two complete result batches retains
        # the previous exact prefix when a new assistant/tool batch is appended.
        boundaries = []
        pending = None
        for index, entry in enumerate(history):
            if entry.get("role") == "assistant":
                action = entry.get("assistant_action")
                calls = action.get("tool_calls") if isinstance(action, dict) else None
                ids = [call.get("call_id") for call in calls] if isinstance(calls, list) and all(isinstance(call, dict) for call in calls) else []
                valid = ids and all(isinstance(value, str) and value for value in ids)
                pending = set(ids) if valid and len(set(ids)) == len(ids) else None
            elif entry.get("role") == "tool" and pending is not None:
                result_id = entry.get("tool_call_id")
                if not isinstance(result_id, str) or result_id not in pending:
                    pending = None
                else:
                    pending.remove(result_id)
                    if not pending and (index + 1 == len(history) or history[index + 1].get("role") != "tool"):
                        boundaries.append(index)
                        pending = None
            else:
                pending = None
        selected = set(boundaries[-2:])
        text += ',"visible_conversation":['
        emitted.add("visible_conversation")
        for index, entry in enumerate(history):
            text += ("," if index else "") + encode(entry)
            if index in selected:
                cuts.append(len(text))
        # Keep the closing array bracket out of the cached history prefix.
        text += "]"
    else:
        field("visible_conversation")
    field("environment_state")
    field("grounding_contexts")
    field("grounded_examples")
    for key in native:
        if key not in emitted and key != "candidate_response":
            field(key)
    field("candidate_response")
    text += "}"
    blocks = []
    start = 0
    for end in cuts:
        blocks.append({"type": "text", "text": text[start:end], "cache_control": {"type": "ephemeral"}})
        start = end
    blocks.append({"type": "text", "text": text[start:]})
    return blocks
