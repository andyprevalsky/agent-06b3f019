"""Native upstream framing/retrieval with Rose's concurrent shared-world commits.

Python 3.12 service -> upstream request -> loopback Rose provider (Python 3.11)
                   -> strict upstream parser -> revision-checked commit -> Rose observation

The upstream public application's session-wide inference lock is deliberately not
used. Session locks cover only immutable snapshots, receipts and atomic commits.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from itertools import count
from typing import Awaitable, Callable

import numpy as np
from exp.common.core.artifacts import sha256_json, stable_id
from exp.common.models import AssistantAction, ModelCapabilities, ModelMessage, ToolCall
from exp.common.tasks import TaskCase, ToolSchema
from exp.simulation.engines.text.prompt import (
    TextWorldModelProtocolError,
    build_world_model_request,
    parse_world_model_transition,
    retry_world_model_request,
    validate_transition_action,
)
from exp.simulation.engines.text.tokens import Utf8UpperBoundTokenCounter
from exp.simulation.retrieval import RAGAction, RAGMatch, RAGQuery
from exp.simulation.retrieval.embedding import default_rag_embedder, embed_rag_texts
from exp.simulation.retrieval.transitions import render_rag_key
from exp.simulation.world_model.runtime import PreparedGroundedWorldModelCall, WorldModelCapacityError

from benchmarks.wmh_execution_policy import (
    DEFAULT_EXECUTION_POLICY,
    validate_execution_identity,
)
from benchmarks.wmh_execution_policy import (
    execution_policy as select_execution_policy,
)
from benchmarks.wmh_outcomes import (
    DISTRIBUTION_PROTOCOLS,
    OUTCOME_V4_PROTOCOL,
    SCHEDULED_EVENTS_KEY,
    TIMED_PROTOCOLS,
    _pointer,
    apply_state_patch,
    mark_delivered,
    parse_distribution,
    restore_hidden_events,
    select_outcome,
    visible_world_state,
)
from benchmarks.wmh_world_clock import WorldClock
from utils.world_model_observation import effective_world_model_content

CANONICAL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "schema": {"const": "rose.canonical_action.v1"},
        "category": {"type": "string"},
        "name": {"type": "string"},
        "arguments": {"type": "object"},
        "agent_id": {"type": "string"},
        "span_id": {"type": "string"},
        "tool_call_id": {"type": "string"},
        "artifact_refs": {"type": "array", "items": {"type": "string"}},
        "timestamp_ms": {"type": "integer"},
    },
    "required": ["schema", "category", "name", "arguments"],
    "additionalProperties": False,
}


def canonical_tool_schema(name: str) -> ToolSchema:
    """Declare Rose's actual canonical envelope, without inferring nested arguments."""
    return ToolSchema(
        name=name,
        description="Simulate this Rose environment boundary using the complete delegated arguments and goal; return its canonical observation.",
        input_schema=CANONICAL_INPUT_SCHEMA,
    )


def action_from_canonical(action: dict) -> AssistantAction:
    """Preserve the complete Rose action and correlate its result with the real call."""
    args = action.get("arguments")
    if (
        action.get("kind") != "tool_call"
        or not isinstance(args, dict)
        or args.get("schema") != "rose.canonical_action.v1"
    ):
        raise ValueError("Expected a canonical Rose tool-call action")
    name = action.get("name")
    if name != f"rose.{args.get('category')}.{args.get('name')}".replace(" ", "_") or not isinstance(
        args.get("arguments"), dict
    ):
        raise ValueError("Canonical tool name/arguments do not match the envelope")
    call_id = args.get("tool_call_id") or args.get("span_id")
    if not isinstance(call_id, str) or not call_id:
        raise ValueError("A simulated call requires a stable tool_call_id or span_id")
    return AssistantAction(tool_calls=(ToolCall(call_id=call_id, name=name, arguments=args),))


def lineage_id(root: str) -> str:
    return stable_id("rose-lineage", {"root_agent_id": root})


def _tool_group(name: str) -> str:
    if name in {"rose.code.spawn_claude_code_agent", "rose.code.spawn_codex_code_agent"}:
        return "rose.code.spawn_code_agent"
    return name


class RoseNativeRetriever:
    """Vectorized, same-tool retrieval over digest-verified native immutable records."""

    def __init__(self, loaded):
        self.loaded = loaded
        self.binding = default_rag_embedder(loaded.index.embedding_dimension)
        if self.binding.snapshot != loaded.index.embedder:
            raise ValueError("Native index embedder identity does not match")
        self.matrix = np.asarray([v.values for v in loaded.vectors], dtype=np.float32)
        self.rows = {}
        for i, transition in enumerate(loaded.transitions):
            self.rows.setdefault(_tool_group(transition.action.tool_name or ""), []).append(i)
        self.rows = {key: np.asarray(value, dtype=np.int64) for key, value in self.rows.items()}

    def retrieve(self, query: RAGQuery) -> tuple[RAGMatch, ...]:
        rows = self.rows.get(_tool_group(query.action.tool_name or ""))
        if rows is None:
            return ()
        key = render_rag_key(task=query.task, initial_context=query.initial_context, action=query.action)
        vector = np.asarray(
            embed_rag_texts(self.binding, (key,), maximum_chunk_bytes=self.loaded.index.embedding_chunk_bytes)[0],
            dtype=np.float32,
        )
        scores = self.matrix[rows] @ vector
        order = np.argsort(-scores, kind="stable")
        excluded = set(query.excluded_lineage_ids)
        selected = []
        seen = set()
        for position in order:
            item = self.loaded.transitions[int(rows[position])]
            if item.lineage_id in excluded or item.trace_id in seen:
                continue
            seen.add(item.trace_id)
            selected.append(RAGMatch(transition=item, score=float(scores[position])))
            if len(selected) == (query.top_k or self.loaded.index.default_top_k):
                break
        return tuple(selected)


def _world_start_ms(seed_state):
    """A world starts at its seed's as_of_utc; otherwise at creation time."""
    structured = seed_state.get("structured") if isinstance(seed_state, dict) else None
    as_of = structured.get("as_of_utc") if isinstance(structured, dict) else None
    if isinstance(as_of, str):
        try:
            parsed = datetime.fromisoformat(as_of.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed is not None and parsed.tzinfo is not None:
            return int(parsed.timestamp() * 1000)
    return time.time_ns() // 1_000_000


def _adds_new_records(state_patch, state):
    """True when every operation appends to a list or creates a key absent from ``state`` (empty included).

    JSON Patch ``add`` on an existing key replaces it, so that is never a new record.
    """
    if state_patch is None:
        return False
    for operation in state_patch:
        path = operation.get("path")
        if operation.get("op") != "add" or not isinstance(path, str):
            return False
        if path.endswith("/-"):
            continue
        node = state
        for part in _pointer(path):
            if isinstance(node, dict) and part in node:
                node = node[part]
            elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
                node = node[int(part)]
            else:
                break
        else:
            return False
    return True


# Bound for one retirement attempt to join its cancelled operations. A slow
# drain fails that attempt with 500 while the session stays fenced; the owner
# retries retirement (run 7, 2026-10-20).
NATIVE_SESSION_JOIN_SECONDS = 10


@dataclass
class NativeSession:
    id: str
    task: str
    initial_context: dict
    state: dict
    scope: str | None = None
    excluded_lineage: str = ""
    messages: tuple = ()
    history: tuple = ()
    revision: int = 0
    closed: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    receipts: dict = field(default_factory=dict)
    sampling_draws: dict = field(default_factory=dict)
    retirement: asyncio.Task | None = None
    durability_failed: bool = False
    # Live invocations whose prediction was discarded, in conflict order. While
    # any exist only the oldest may predict and commit, so a slow prediction
    # cannot be rebased forever by a stream of faster commits.
    contended: dict = field(default_factory=dict)
    conflicts: int = 0
    turn: asyncio.Event = field(default_factory=asyncio.Event)
    # Per committed revision: whether its state change only added new records.
    additive: list = field(default_factory=list)
    # One world clock per root; actions run at their agent's world time.
    clock: WorldClock = field(default_factory=lambda: WorldClock(0))


class RetiredWorldModelScope(ValueError):
    """A stale worker cannot reopen a retired root's world as an empty session."""


class NativeOwnedCancellation(asyncio.CancelledError):
    def __init__(self, result):
        self.result = result


class NativeDurabilityError(RuntimeError):
    """An owned prediction writer failed before retirement could acknowledge it."""


class ParallelWorldModel:
    """One shared world per root, overlapping inference and idempotent native retries."""

    def __init__(
        self,
        complete: Callable[..., Awaitable[str]],
        retriever,
        *,
        top_k=5,
        maximum_sessions=16384,
        maximum_steps=4096,
        capabilities=None,
        record_prediction=None,
        complete_scoped=None,
        retire_provider=None,
        record_retirement=None,
        load_retirement=None,
        execution_policy=DEFAULT_EXECUTION_POLICY,
        execution_identity=None,
        sample_uniform=None,
    ):
        self.complete = complete
        self.retriever = retriever
        self.top_k = top_k
        self.maximum_sessions = maximum_sessions
        self.maximum_steps = maximum_steps
        self.capabilities = capabilities or ModelCapabilities(supports_tools=False, maximum_output_tokens=16384)
        self.token_counter = Utf8UpperBoundTokenCounter()
        self.execution_policy = select_execution_policy(execution_policy)
        self._timed = self.execution_policy.response_protocol in TIMED_PROTOCOLS
        self.sample_uniform = sample_uniform or secrets.SystemRandom().random
        if execution_policy != DEFAULT_EXECUTION_POLICY and execution_identity is None:
            raise ValueError("Activated WMH policy requires a verified artifact-bound execution identity")
        self.execution_identity = (
            validate_execution_identity(execution_identity, execution_policy)
            if execution_identity is not None
            else None
        )
        self.record_prediction = record_prediction
        self.complete_scoped = complete_scoped
        self.retire_provider = retire_provider
        if (record_retirement is None) != (load_retirement is None):
            raise ValueError("Native retirement persistence requires both writer and loader")
        self.record_retirement = record_retirement
        self.load_retirement = load_retirement
        self.sessions = {}
        self.scopes = {}
        self.retired = {}
        self.closed_scopes = set()
        self.audit = deque(maxlen=4096)
        self.retrieval_calls = 0

    def new_session(self, task: str, seed_state: dict, scope: str | None = None) -> NativeSession:
        if getattr(self, "_closing", False):
            raise ValueError("Native model is closing")
        if scope is not None and (not isinstance(scope, str) or not scope.strip() or len(scope) > 128):
            raise ValueError("Native session scope must be a nonempty bounded identity")
        if scope and scope in self.closed_scopes:
            raise RetiredWorldModelScope("Native root scope is retired; an explicit new generation is required")
        if scope and scope in self.scopes:
            return self.sessions[self.scopes[scope]]
        if not isinstance(task, str) or not task.strip() or not isinstance(seed_state, dict):
            raise ValueError("Session requires its root task and JSON initial state")
        if len(self.sessions) + len(self.retired) >= self.maximum_sessions:
            raise ValueError("Native session capacity reached")
        session = NativeSession(uuid.uuid4().hex, task, deepcopy(seed_state), deepcopy(seed_state), scope)
        session.clock = WorldClock(_world_start_ms(seed_state))
        if self._timed and isinstance(session.state.get("structured"), dict):
            session.state["structured"].setdefault(SCHEDULED_EVENTS_KEY, [])
        structured = seed_state.get("structured") if isinstance(seed_state.get("structured"), dict) else seed_state
        source_root = structured.get("root_agent_id")
        session.excluded_lineage = lineage_id(scope or source_root or session.id)
        self.sessions[session.id] = session
        if scope:
            self.scopes[scope] = session.id
        return session

    async def step(self, session_id: str, action: dict, invocation: str | None = None) -> dict:
        if getattr(self, "_closing", False):
            raise ValueError("Native model is closing")
        session = self.sessions[session_id]
        candidate = action_from_canonical(action)
        # Timestamp is observation context, never native operation identity.
        identity = deepcopy(action)
        identity["arguments"].pop("timestamp_ms", None)
        identity = sha256_json(identity)
        key = invocation or candidate.tool_calls[0].call_id
        async with session.lock:
            if session.closed:
                raise ValueError("Native world session is closed")
            existing = session.receipts.get(key)
            if existing:
                if existing[0] != identity:
                    raise ValueError("Invocation reused for a different action")
                operation = existing[1]
            else:
                if len(session.receipts) >= self.maximum_steps:
                    raise ValueError("Native session step capacity reached")
                draw = None
                if self.execution_policy.response_protocol in DISTRIBUTION_PROTOCOLS:
                    prior = session.sampling_draws.get(key)
                    if prior is not None:
                        if prior[0] != identity:
                            raise ValueError("Invocation reused for a different action")
                        draw = prior[1]
                    else:
                        if len(session.sampling_draws) >= self.maximum_steps:
                            raise ValueError("Native session sampling capacity reached")
                        draw = self.sample_uniform()
                        if type(draw) not in (int, float) or not 0 <= draw < 1:
                            raise ValueError("Outcome draw must be a finite number in [0, 1)")
                        session.sampling_draws[key] = (identity, draw)
                operation = asyncio.create_task(self._step(session, key, action, candidate, draw))
                session.receipts[key] = (identity, operation)

                def completed(task):
                    # Cleanup belongs to the operation, even if every HTTP caller
                    # disconnected. All receipts are owned by this event loop.
                    if task.cancelled() or task.exception() is not None:
                        if session.receipts.get(key, (None, None))[1] is task:
                            session.receipts.pop(key, None)

                operation.add_done_callback(completed)
        # A lost HTTP response must not cancel an already admitted prediction.
        return deepcopy(await asyncio.shield(operation))

    async def _owned_thread_call(self, function, *args):
        # Existing WHM recovery opt-in only; ordinary callers keep their path.
        if not (self.execution_identity or {}).get("runtime_config", {}).get("validation_recovery"):
            return await asyncio.to_thread(function, *args)
        # Keep the actual concurrent future, not a cancellable asyncio proxy.
        try:
            executor = getattr(self, "_owned_executor", None)
            if executor is None:
                executor = self._owned_executor = ThreadPoolExecutor()
            context = copy_context()
            operation = executor.submit(context.run, function, *args)
        except BaseException as error:
            if function is self.record_prediction or function is self.record_retirement:
                raise NativeDurabilityError("Native durability owner admission failed") from error
            raise
        cancelled = False
        while True:
            proxy = asyncio.wrap_future(operation)
            try:
                result = await asyncio.shield(proxy)
                break
            except asyncio.CancelledError:
                cancelled = True
                if operation.done() and not operation.cancelled():
                    try:
                        result = operation.result()
                    except BaseException as error:
                        if function is self.record_prediction or function is self.record_retirement:
                            raise NativeDurabilityError("Native prediction durability failed") from error
                        raise
                    break
                if operation.cancelled():
                    if function is self.record_prediction or function is self.record_retirement:
                        raise NativeDurabilityError("Native prediction durability owner cancelled")
                    raise RuntimeError("Native executor owner cancelled before execution")
                # A cancelled asyncio proxy cannot attest actual thread join.
                # Re-wrap the retained concurrent future until it really finishes.
            except Exception as error:
                if function is self.record_prediction or function is self.record_retirement:
                    raise NativeDurabilityError("Native prediction durability failed") from error
                raise
        if cancelled:
            raise NativeOwnedCancellation(result)
        return result

    async def _step(self, session, key, action, candidate, draw):
        # No operation deadline: every provider call carries Rose's own deadline,
        # an operation rebases at most once and repairs its protocol once, and the
        # turn queue only waits on such bounded operations. A caller whose HTTP
        # request timed out rejoins the same operation through its invocation.
        try:
            return await self._step_with_rebase(session, key, action, candidate, draw)
        except NativeDurabilityError:
            session.durability_failed = True
            raise
        finally:
            # Synchronous on the session's loop, so a second cancellation cannot
            # strand the turn on a finished operation.
            if session.contended.pop(key, None) is not None:
                self._advance_turn(session)

    @staticmethod
    def _awaiting_turn(session, key):
        """Under the session lock: the event to wait on while another conflicted operation owns the turn."""
        if session.contended and min(session.contended, key=session.contended.__getitem__) != key:
            return session.turn
        return None

    @staticmethod
    def _append_merge(session, revision, state_patch, base):
        """Under the session lock: the current state with this record-adding patch, or None to rebase."""
        if (
            not all(session.additive[revision:])
            or not _adds_new_records(state_patch, base)
            or not _adds_new_records(state_patch, session.state)
        ):
            return None
        try:
            return apply_state_patch(session.state, state_patch)
        except ValueError:
            return None

    @staticmethod
    def _advance_turn(session):
        session.turn.set()
        session.turn = asyncio.Event()

    async def _step_with_rebase(self, session, key, action, candidate, draw):
        call = candidate.tool_calls[0]
        intervals = []
        actor = world_started = None
        if self._timed:
            # The action happens at its agent's world time, whatever the
            # caller's wall clock said; retries keep their first start.
            actor = str(call.arguments.get("agent_id") or session.scope or session.id)
            world_started = session.clock.action_time(actor)
            action = deepcopy(action)
            action["arguments"]["timestamp_ms"] = world_started
            candidate = action_from_canonical(action)
            call = candidate.tool_calls[0]
        # Conflicts are resolved oldest first: a discarded operation predicts
        # again only when it owns the turn, and no other operation commits
        # meanwhile, so each operation rebases at most once. Operations that
        # have not conflicted predict at once and yield only at commit, so a
        # wide fan-out keeps predicting beside a rebase (run 7, 2026-10-12).
        for attempt in count():
            while True:
                async with session.lock:
                    if session.closed:
                        raise ValueError("Native world session ended before prediction")
                    turn = self._awaiting_turn(session, key) if key in session.contended else None
                    if turn is None:
                        base = session.state
                        messages = session.messages
                        revision = session.revision
                        break
                await turn.wait()
            view, hidden = visible_world_state(base, at_ms=world_started) if self._timed else (base, [])
            task = TaskCase(
                task_id=stable_id("rose-task", {"scope": session.scope or session.id}),
                lineage_group_id=session.excluded_lineage,
                partition="held_out",
                instruction=session.task,
                initial_context=session.initial_context,
                tools=(canonical_tool_schema(call.name),),
                workload_weight=1,
                source_trace_ids=(session.scope or session.id,),
            )
            query = RAGQuery(
                task=session.task,
                initial_context=session.initial_context,
                action=RAGAction(kind="tool_call", tool_name=call.name, tool_arguments=call.arguments),
                excluded_lineage_ids=(session.excluded_lineage,),
                top_k=self.top_k,
            )
            demos = await self._owned_thread_call(self.retriever.retrieve, query)
            if (self.execution_identity or {}).get("runtime_config", {}).get("exclude_failed_tool_examples"):
                from benchmarks.wmh_grounding_filter import failed_tool_result

                demos = tuple(
                    match
                    for match in demos
                    if not (
                        match.transition.observation.kind == "tool_result"
                        and failed_tool_result(match.transition.observation.model_dump(mode="json"))
                    )
                )
            request = build_world_model_request(
                task,
                visible_messages=messages,
                candidate_response=candidate,
                grounded_examples=demos,
                maximum_output_tokens=16384,
                state=view,
            )
            # The public packer preserves this system message and counts it.
            request = self.execution_policy.apply(request)
            prepared = PreparedGroundedWorldModelCall(request=request, matches=demos, action=candidate).fit_context(
                self.capabilities, self.token_counter
            )
            request = prepared.request
            demos = prepared.matches
            # Only malformed protocol is repaired here; semantic outcomes are not graded.
            original = request
            selection = None
            state_patch = None
            for repair in range(2):
                try:
                    context = self.capabilities.context_window_tokens
                    if (
                        context is not None
                        and self.token_counter.count(request) + request.maximum_output_tokens > context
                    ):
                        raise WorldModelCapacityError(
                            "Required world-model task, state and history exceed declared context capacity"
                        )
                    request_payload = request.model_dump(mode="json")
                    request_sha256 = sha256_json(request_payload)
                    started = time.time_ns() // 1_000_000
                    prediction_id = uuid.uuid4().hex
                    response = None
                    failure = None
                    capture_token = None
                    if (self.execution_identity or {}).get("runtime_config", {}).get("validation_recovery"):
                        from benchmarks.wmh_provider_capture import NATIVE_CAPTURE_TEMPLATE

                        capture_token = NATIVE_CAPTURE_TEMPLATE.set(
                            {
                                "schema": "rose.wmh_native_prediction.v1",
                                "session_id": session.id,
                                "call_id": call.call_id,
                                "started_at_ms": started,
                                "snapshot_revision": revision,
                                "request_sha256": request_sha256,
                                "state_retries": attempt,
                                "protocol_repair": repair,
                                "prediction_id": prediction_id,
                                "request": request_payload,
                                "execution_identity": deepcopy(self.execution_identity),
                            }
                        )
                    try:
                        if self.complete_scoped:
                            response = await self.complete_scoped(session.id, prediction_id, request)
                        else:
                            response = await self.complete(request)
                    except BaseException as exc:
                        failure = exc
                        raise
                    finally:
                        if capture_token is not None:
                            NATIVE_CAPTURE_TEMPLATE.reset(capture_token)
                        interval = {
                            "started_at_ms": started,
                            "finished_at_ms": time.time_ns() // 1_000_000,
                            "snapshot_revision": revision,
                            "request_sha256": request_sha256,
                            "state_retries": attempt,
                            "protocol_repair": repair,
                            "prediction_id": prediction_id,
                        }
                        record = {
                            "schema": "rose.wmh_native_prediction.v1",
                            "session_id": session.id,
                            "call_id": call.call_id,
                            **interval,
                            "request": request_payload,
                            "execution_identity": deepcopy(self.execution_identity),
                        }
                        if failure is not None:
                            interval["error_type"] = type(failure).__name__
                            record["error"] = {"type": type(failure).__name__, "message": str(failure)}
                            if getattr(failure, "rejected_response", None) is not None:
                                record["rejected_response"] = deepcopy(failure.rejected_response)
                        else:
                            record["response"] = response
                        intervals.append(interval)
                        if self.record_prediction:
                            await self._owned_thread_call(self.record_prediction, record)
                    raw = response["content"] if isinstance(response, dict) else response
                    if self.execution_policy.response_protocol in DISTRIBUTION_PROTOCOLS:
                        try:
                            distribution = parse_distribution(
                                raw,
                                base_state=view,
                                expected_call_ids=tuple(c.call_id for c in candidate.tool_calls),
                                timed=self._timed,
                                protocol=self.execution_policy.response_protocol,
                                at_ms=world_started,
                                action_category=call.arguments.get("category"),
                                action_arguments=call.arguments,
                                reserved_event_ids=frozenset(
                                    e["id"] for e in hidden if isinstance(e, dict) and isinstance(e.get("id"), str)
                                ),
                            )
                        except (ValueError, TypeError, KeyError) as exc:
                            raise TextWorldModelProtocolError(str(exc)) from exc
                        # Every proposed branch must satisfy the pinned native
                        # transition contract before any random selection.
                        for outcome in distribution["outcomes"]:
                            proposed = parse_world_model_transition(
                                AssistantAction(content=json.dumps(outcome["transition"], allow_nan=False))
                            )
                            validate_transition_action(proposed, candidate)
                        selected, selection = select_outcome(distribution, draw)
                        state_patch = next(
                            outcome["state_patch"]
                            for outcome in distribution["outcomes"]
                            if outcome["id"] == selection["selected_outcome_id"]
                        )
                        raw = json.dumps(selected, allow_nan=False)
                        selection.update(
                            prediction_id=prediction_id,
                            request_sha256=request_sha256,
                            snapshot_revision=revision,
                        )
                        # The caller receives the selected receipt. Counterfactual
                        # descriptions stay in the private prediction/audit log.
                        interval["outcome_selection"] = {
                            key: deepcopy(value) for key, value in selection.items() if key != "outcomes"
                        }
                        if self.record_prediction:
                            # A proposal record is not a commit receipt. The final
                            # history/retirement receipt establishes the commit.
                            await self._owned_thread_call(
                                self.record_prediction,
                                {
                                    "schema": "rose.wmh_outcome_selection.v1",
                                    "session_id": session.id,
                                    "call_id": call.call_id,
                                    "status": "validated_proposal",
                                    "selection": deepcopy(selection),
                                    "execution_identity": deepcopy(self.execution_identity),
                                },
                            )
                    transition = parse_world_model_transition(AssistantAction(content=raw))
                    validate_transition_action(transition, candidate)
                    try:
                        json.dumps(transition.state, allow_nan=False)
                    except ValueError as exc:
                        raise TextWorldModelProtocolError("World state must contain finite JSON values") from exc
                    if not effective_world_model_content(transition.tool_results[0].content).strip():
                        raise TextWorldModelProtocolError("Empty tool observation")
                    break
                except TextWorldModelProtocolError as exc:
                    if repair:
                        raise
                    if self.execution_policy.response_protocol in DISTRIBUTION_PROTOCOLS:
                        correction = ModelMessage(
                            role="user",
                            content=(
                                f"The previous simulator distribution was invalid: {exc}. "
                                "Return a complete replacement outcome distribution with exactly the keys "
                                "in the system contract, using the original evidence and unchanged action. "
                                "Include complete tool results and valid state_patch arrays for every outcome. "
                                "Use finite probabilities that sum to 1. This is format feedback only; "
                                "do not increase success probabilities to pass validation. "
                                f"Every outcome's call_id values must be exactly {[c.call_id for c in candidate.tool_calls]}, "
                                "in that order."
                            ),
                        )
                        request = original.model_copy(update={"messages": (*original.messages, correction)})
                    else:
                        request = retry_world_model_request(original, candidate, str(exc))
            result = transition.tool_results[0]
            observation = {
                "content": result.content,
                "is_error": result.is_error,
                "reward": None,
                "metadata": {
                    "protocol": "text-world-model-v3",
                    "execution_identity": deepcopy(self.execution_identity),
                    "snapshot_revision": revision,
                    "state_retries": attempt,
                    "prediction_attempts": deepcopy(intervals),
                },
            }
            if isinstance(response, dict):
                observation["metadata"]["actual_model"] = response.get("actual_model")
            elapsed = 0
            if self._timed:
                elapsed = selection.get("elapsed_ms", 0) if selection else 0
                observation["metadata"].update(
                    world_time_ms=world_started, elapsed_ms=elapsed, world_time_after_ms=world_started + elapsed
                )
            if selection is not None:
                observation["metadata"]["prediction_protocol"] = self.execution_policy.response_protocol
                observation["metadata"]["outcome_selection"] = deepcopy(interval["outcome_selection"])

            def preview(text):
                return text[:500] if isinstance(text, str) else json.dumps(text, ensure_ascii=False)[:500]

            # Prepare diagnostics before committing; a logging error must never
            # turn an already committed mutation into a failed invocation receipt.
            audit = {
                "session_id": session.id,
                "action": {"name": call.name, "arguments": preview(call.arguments)},
                "snapshot_revision": revision,
                "execution_identity": deepcopy(self.execution_identity),
                "demos": [
                    {
                        "source": "real_world_archive",
                        "transition_id": m.transition.transition_id,
                        "trace_id": m.transition.trace_id,
                        "lineage_id": m.transition.lineage_id,
                        "raw_span_ids": [m.transition.action_span_id, m.transition.observation_span_id],
                        "task": preview(m.transition.task),
                        "initial_context_sha256": sha256_json(m.transition.initial_context),
                        "action": preview(m.transition.action.model_dump(mode="json")),
                        "observation": {"content": preview(m.transition.observation.content)},
                        **({} if m.transition.elapsed_ms is None else {"elapsed_ms": m.transition.elapsed_ms}),
                    }
                    for m in demos
                ],
                "state_retries": attempt,
            }
            if selection is not None:
                audit["outcome_selection"] = deepcopy(selection)
            while True:
                async with session.lock:
                    if session.closed:
                        raise ValueError("Native world session ended before commit")
                    # The predictor reads the whole state and history. Disjoint writes
                    # do not prove independence: both can depend on a shared balance.
                    # The one exception (user-approved append-merge): a prediction
                    # that only adds new records commits over commits that also
                    # only added records, without predicting again.
                    merged = None
                    if session.revision != revision:
                        merged = self._append_merge(session, revision, state_patch, base)
                        if merged is None:
                            interval["discarded_due_to_revision"] = session.revision
                            if key not in session.contended:
                                session.conflicts += 1
                                session.contended[key] = session.conflicts
                            break
                    # A prediction that started before a conflict yields to it.
                    turn = self._awaiting_turn(session, key)
                    if turn is None:
                        if len(session.history) >= self.maximum_steps:
                            raise ValueError("Native session step capacity reached")
                        state_before, state_after = base, restore_hidden_events(transition.state, hidden)
                        if merged is not None:
                            state_before, state_after = session.state, merged
                            observation["metadata"]["append_merged_from_revision"] = revision
                            audit["append_merged_from_revision"] = revision
                        delivered = False
                        if self.execution_policy.response_protocol == OUTCOME_V4_PROTOCOL and selection:
                            # The runner, not the model, records that a due event was observed.
                            state_after, delivered = mark_delivered(
                                state_after, selection.get("delivered_event_ids"), at_ms=world_started
                            )
                        observation["metadata"]["committed_revision"] = session.revision + 1
                        step = {
                            "action": deepcopy(action),
                            "observation": deepcopy(observation),
                            "state_before": deepcopy(state_before),
                            "task": session.task,
                        }
                        session.messages = (
                            *session.messages,
                            ModelMessage(role="assistant", assistant_action=candidate),
                            *transition.visible_messages,
                        )
                        session.history = (*session.history, step)
                        session.state = deepcopy(state_after)
                        session.additive.append(not delivered and _adds_new_records(state_patch, state_before))
                        if self._timed:
                            session.clock.commit(actor, started_ms=world_started, elapsed_ms=elapsed)
                        session.revision += 1
                        self.retrieval_calls += 1
                        audit["committed_revision"] = session.revision
                        self.audit.append(audit)
                        return observation
                await turn.wait()
        raise AssertionError("Unreachable state retry boundary")

    def _clock_session(self, session_id):
        session = self.sessions[session_id]
        if session.closed:
            raise ValueError("Native world session is closed")
        return session

    def clock_register(self, session_id, agent_id, parent=None):
        session = self._clock_session(session_id)
        return {"agent_id": agent_id, "time_ms": session.clock.register(agent_id, parent)}

    def clock_finish(self, session_id, agent_id):
        session = self._clock_session(session_id)
        session.clock.finish(agent_id)
        return {"agent_id": agent_id, "time_ms": session.clock.time_of(agent_id)}

    def clock_hold(self, session_id, agent_id, hold_id):
        session = self._clock_session(session_id)
        return {"agent_id": agent_id, "time_ms": session.clock.hold(agent_id, hold_id)}

    def clock_release(self, session_id, agent_id, hold_id, children):
        session = self._clock_session(session_id)
        return {"agent_id": agent_id, "time_ms": session.clock.release(agent_id, hold_id, children)}

    async def clock_wait(self, session_id, agent_id, wait_id, *, until_ms=None, duration_ms=None, poll_seconds=50):
        session = self._clock_session(session_id)
        return await session.clock.wait(
            agent_id, wait_id, until_ms=until_ms, duration_ms=duration_ms, poll_seconds=poll_seconds
        )

    def clock_snapshot(self, session_id):
        return self.sessions[session_id].clock.snapshot()

    async def end_session(self, session_id):
        if session_id in self.retired:
            stored = self.retired[session_id]
            receipt = await asyncio.to_thread(self.load_retirement, stored[0]) if self.load_retirement else stored[0]
            if sha256_json(receipt) != stored[1]:
                raise RuntimeError("Native frozen retirement receipt changed after publication")
            return deepcopy(receipt)
        session = self.sessions[session_id]
        async with session.lock:
            session.closed = True
            if session.scope:
                self.closed_scopes.add(session.scope)
            closing = session.retirement
            if closing is None or (closing.done() and (closing.cancelled() or closing.exception() is not None)):
                session.retirement = asyncio.create_task(self._retire_session(session))
            closing = session.retirement
        return deepcopy(await asyncio.shield(closing))

    async def _retire_session(self, session):
        tasks = [item[1] for item in session.receipts.values() if not item[1].done()]
        for task in tasks:
            if not task.cancelling():
                task.cancel()
        usage = None
        if self.retire_provider:
            provider = await self.retire_provider(session.id)
            if provider.get("session_id") != session.id or provider.get("join_verified") is not True:
                raise RuntimeError("Native provider retirement did not verify the exact session join")
            usage = provider.get("usage")
        if tasks:
            if (self.execution_identity or {}).get("runtime_config", {}).get("validation_recovery"):
                # Fence/cancel inference first, then join its durable owners.
                # Rose provider admission/deadlines remain unchanged.
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for result in results:
                    if isinstance(result, NativeDurabilityError):
                        raise result
            else:
                _, pending = await asyncio.wait(tasks, timeout=NATIVE_SESSION_JOIN_SECONDS)
                if pending:
                    raise RuntimeError("Native session operations did not join during retirement")
                await asyncio.gather(*tasks, return_exceptions=True)
        if session.durability_failed:
            raise NativeDurabilityError("Native prediction durability failed before retirement")
        receipt = {
            "ended": session.id,
            "engine": "experiential",
            "session_scope_id": session.scope,
            "session_id": session.id,
            "revision": session.revision,
            "state": deepcopy(session.state),
            "history": deepcopy(list(session.history)),
            "usage": deepcopy(usage),
            "join_verified": True,
        }
        if self.execution_identity is not None:
            receipt["execution_identity"] = deepcopy(self.execution_identity)
        if self._timed:
            receipt["world_clock"] = session.clock.snapshot()
        cancelled = False
        try:
            stored = await self._owned_thread_call(self.record_retirement, receipt) if self.record_retirement else receipt
        except NativeOwnedCancellation as error:
            stored, cancelled = error.result, True
        except NativeDurabilityError:
            session.durability_failed = True
            raise
        # Publication is synchronous on this loop after all owned work has joined.
        self.retired[session.id] = (stored, sha256_json(receipt))
        self.sessions.pop(session.id, None)
        if session.scope:
            self.scopes.pop(session.scope, None)
        session.receipts.clear()
        session.sampling_draws.clear()
        session.messages = ()
        session.initial_context = {}
        session.state = {}
        session.history = ()
        if cancelled:
            raise asyncio.CancelledError()
        return receipt

    async def close(self):
        if not (self.execution_identity or {}).get("runtime_config", {}).get("validation_recovery"):
            for session_id in list(self.sessions):
                await self.end_session(session_id)
            return
        task = getattr(self, "_close_owner", None)
        if task is None or (task.done() and task.cancelled()):
            self._closing = True
            task = self._close_owner = asyncio.create_task(self._close_owned())
        return await asyncio.shield(task)

    async def _close_owned(self):
        cancelled = False
        async def join(tasks):
            nonlocal cancelled
            while True:
                proxy = asyncio.gather(*(asyncio.shield(task) for task in tasks), return_exceptions=True)
                try:
                    return await asyncio.shield(proxy)
                except asyncio.CancelledError:
                    cancelled = True
                    # A canceled gather is only a proxy. Keep the actual task
                    # owners and create a fresh wait; never spin on that proxy.
                    proxy.cancel()
                    def consume(future):
                        try:
                            future.exception()
                        except asyncio.CancelledError:
                            pass
                    proxy.add_done_callback(consume)
        retirements = [asyncio.create_task(self.end_session(sid)) for sid in list(self.sessions)]
        results = await join(retirements) if retirements else []
        errors = [result for result in results if isinstance(result, BaseException)]
        pending = {item[1] for session in self.sessions.values() for item in session.receipts.values() if not item[1].done()}
        pending.update(session.retirement for session in self.sessions.values() if session.retirement is not None and not session.retirement.done())
        if pending:
            await join(pending)
        executor = getattr(self, "_owned_executor", None)
        if executor is not None:
            try:
                executor.shutdown(wait=True)
            except BaseException as error:
                if errors:
                    raise errors[0] from error
                raise
            self._owned_executor = None
        if errors:
            raise errors[0]
        if cancelled:
            raise asyncio.CancelledError()
