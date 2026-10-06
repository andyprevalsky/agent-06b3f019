"""Native upstream framing/retrieval with Rose's concurrent shared-world commits.

Python 3.12 service -> upstream request -> loopback Rose provider (Python 3.11)
                   -> strict upstream parser -> revision-checked commit -> Rose observation

The upstream public application's session-wide inference lock is deliberately not
used. Session locks cover only immutable snapshots, receipts and atomic commits.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
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
    ):
        self.complete = complete
        self.retriever = retriever
        self.top_k = top_k
        self.maximum_sessions = maximum_sessions
        self.maximum_steps = maximum_steps
        self.capabilities = capabilities or ModelCapabilities(supports_tools=False, maximum_output_tokens=16384)
        self.token_counter = Utf8UpperBoundTokenCounter()
        self.record_prediction = record_prediction
        self.sessions = {}
        self.scopes = {}
        self.audit = deque(maxlen=4096)
        self.retrieval_calls = 0

    def new_session(self, task: str, seed_state: dict, scope: str | None = None) -> NativeSession:
        if scope and scope in self.scopes:
            return self.sessions[self.scopes[scope]]
        if not isinstance(task, str) or not task.strip() or not isinstance(seed_state, dict):
            raise ValueError("Session requires its root task and JSON initial state")
        if len(self.sessions) >= self.maximum_sessions:
            raise ValueError("Native session capacity reached")
        session = NativeSession(uuid.uuid4().hex, task, deepcopy(seed_state), deepcopy(seed_state), scope)
        structured = seed_state.get("structured") if isinstance(seed_state.get("structured"), dict) else seed_state
        source_root = structured.get("root_agent_id")
        session.excluded_lineage = lineage_id(scope or source_root or session.id)
        self.sessions[session.id] = session
        if scope:
            self.scopes[scope] = session.id
        return session

    async def step(self, session_id: str, action: dict, invocation: str | None = None) -> dict:
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
                operation = asyncio.create_task(self._step(session, action, candidate))
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

    async def _step(self, session, action, candidate):
        async with asyncio.timeout(600):
            return await self._step_with_rebase(session, action, candidate)

    async def _step_with_rebase(self, session, action, candidate):
        call = candidate.tool_calls[0]
        intervals = []
        # The enclosing 600-second budget bounds rebases. A fixed attempt count
        # would turn valid same-root fanout into failures after a few commits.
        for attempt in count():
            async with session.lock:
                if session.closed:
                    raise ValueError("Native world session ended before prediction")
                base = session.state
                messages = session.messages
                revision = session.revision
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
            demos = await asyncio.to_thread(self.retriever.retrieve, query)
            request = build_world_model_request(
                task,
                visible_messages=messages,
                candidate_response=candidate,
                grounded_examples=demos,
                maximum_output_tokens=16384,
                state=base,
            )
            prepared = PreparedGroundedWorldModelCall(request=request, matches=demos, action=candidate).fit_context(
                self.capabilities, self.token_counter
            )
            request = prepared.request
            demos = prepared.matches
            # Only malformed protocol is repaired here; semantic outcomes are not graded.
            original = request
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
                    started = time.time_ns() // 1_000_000
                    response = None
                    failure = None
                    try:
                        response = await self.complete(request)
                    except BaseException as exc:
                        failure = exc
                        raise
                    finally:
                        interval = {
                            "started_at_ms": started,
                            "finished_at_ms": time.time_ns() // 1_000_000,
                            "snapshot_revision": revision,
                            "state_retries": attempt,
                            "protocol_repair": repair,
                        }
                        record = {
                            "schema": "rose.wmh_native_prediction.v1",
                            "session_id": session.id,
                            "call_id": call.call_id,
                            **interval,
                            "request": request.model_dump(mode="json"),
                        }
                        if failure is not None:
                            interval["error_type"] = type(failure).__name__
                            record["error"] = {"type": type(failure).__name__, "message": str(failure)}
                        else:
                            record["response"] = response
                        intervals.append(interval)
                        if self.record_prediction:
                            await asyncio.to_thread(self.record_prediction, record)
                    raw = response["content"] if isinstance(response, dict) else response
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
                    request = retry_world_model_request(original, candidate, str(exc))
            result = transition.tool_results[0]
            observation = {
                "content": result.content,
                "is_error": result.is_error,
                "reward": None,
                "metadata": {
                    "protocol": "text-world-model-v3",
                    "snapshot_revision": revision,
                    "state_retries": attempt,
                    "prediction_attempts": deepcopy(intervals),
                },
            }
            if isinstance(response, dict):
                observation["metadata"]["actual_model"] = response.get("actual_model")

            def preview(text):
                return text[:500] if isinstance(text, str) else json.dumps(text, ensure_ascii=False)[:500]

            # Prepare diagnostics before committing; a logging error must never
            # turn an already committed mutation into a failed invocation receipt.
            audit = {
                "session_id": session.id,
                "action": {"name": call.name, "arguments": preview(call.arguments)},
                "snapshot_revision": revision,
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
                    }
                    for m in demos
                ],
                "state_retries": attempt,
            }
            async with session.lock:
                if session.closed:
                    raise ValueError("Native world session ended before commit")
                # The predictor reads the whole state and history. Disjoint writes
                # do not prove independence: both can depend on a shared balance.
                if session.revision != revision:
                    continue
                if len(session.history) >= self.maximum_steps:
                    raise ValueError("Native session step capacity reached")
                observation["metadata"]["committed_revision"] = session.revision + 1
                step = {
                    "action": deepcopy(action),
                    "observation": deepcopy(observation),
                    "state_before": deepcopy(base),
                    "task": session.task,
                }
                session.messages = (
                    *session.messages,
                    ModelMessage(role="assistant", assistant_action=candidate),
                    *transition.visible_messages,
                )
                session.history = (*session.history, step)
                session.state = deepcopy(transition.state)
                session.revision += 1
                self.retrieval_calls += 1
                audit["committed_revision"] = session.revision
                self.audit.append(audit)
            return observation
        raise AssertionError("Unreachable state retry boundary")

    async def end_session(self, session_id):
        session = self.sessions[session_id]
        async with session.lock:
            session.closed = True
            self.sessions.pop(session_id)
            if session.scope:
                self.scopes.pop(session.scope, None)
            tasks = [item[1] for item in session.receipts.values() if not item[1].done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self):
        for session_id in list(self.sessions):
            await self.end_session(session_id)
