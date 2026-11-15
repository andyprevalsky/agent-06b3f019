"""Serve a built World Model Harness model with the Rose inference provider.

This REPLACES `wmh serve` for our stack. `wmh serve` builds the direct-Anthropic
provider from the model's config.toml (`get_provider(config.serve_provider_config())`);
this CLI loads the same artifact but injects `RoseWMHProvider`, so every WMH step's
LLM call goes through the agent-side Rose machinery (compute tokens + claudeAuth +
rotation) instead of a raw Anthropic key.

Everything else matches `wmh serve`:
  - root/name resolution via `WorldModelStore(root).resolve(name)`,
  - the same FastAPI app from `wmh.serving.server.create_app`,
  - the same `/healthz` + `/world_models/{name}/sessions/.../step` routes,
  - `uvicorn.run(host="127.0.0.1", port=...)`.

Usage:
    python -m benchmarks.serve_world_model --name <model> --port <port> --root <dir> [--pool rose-1-ultra]
"""

from __future__ import annotations

import argparse
import contextvars
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from collections import Counter, defaultdict
from concurrent.futures import Future

import numpy as np
import structlog

logger = structlog.get_logger(__name__)

_ROSE_SESSION_SCOPE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "rose_wmh_session_scope",
    default=None,
)
_ROSE_STEP_INVOCATION: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "rose_wmh_step_invocation",
    default=None,
)

_RETRIEVAL_STOPWORDS = frozenset(
    (
        "a an and are as at be by can do for from how in into is it its of on or our "
        "the their them this to use using via what where which who with without you your "
        "find get give make report research search show source sources result results "
        "agent agents task tool current exact all each every include provide"
    ).split()
)


def _retrieval_action_key(name: str) -> str:
    """Group equivalent code-spawn names used by real and simulated tool paths."""
    if name in {
        "rose.code.spawn_code_agent",
        "rose.code.spawn_claude_code_agent",
        "rose.code.spawn_codex_code_agent",
    }:
        return "rose.code.spawn_code_agent"
    return name


def _delegated_action_terms(action) -> frozenset[str]:
    """Index the requested operation, not the bulky fixture's row counts/refs."""
    arguments = action.arguments if isinstance(action.arguments, dict) else {}
    nested = arguments.get("arguments")
    nested = nested if isinstance(nested, dict) else arguments
    subject = next(
        (
            nested[key]
            for key in ("goal", "task", "query", "url")
            if isinstance(nested.get(key), str) and nested[key].strip()
        ),
        "",
    )
    return frozenset(
        token[:-1] if len(token) > 4 and token.endswith("s") else token
        for token in re.findall(r"[a-z0-9]{3,}", subject.casefold())
        if token not in _RETRIEVAL_STOPWORDS
    )


def _preview(value, limit: int = 500):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= limit else text[:limit] + f"… [{len(text)} chars]"


def _action_summary(action) -> dict:
    arguments = action.arguments if isinstance(action.arguments, dict) else {}
    delegated = arguments.get("arguments")
    delegated = delegated if isinstance(delegated, dict) else arguments
    safe_keys = (
        "goal",
        "task",
        "url",
        "query",
        "selector",
        "action",
        "request",
        "agent_id",
        "artifact_refs",
    )
    return {
        "kind": getattr(action.kind, "value", str(action.kind)),
        "name": action.name,
        "arguments": {key: _preview(delegated[key]) for key in safe_keys if key in delegated},
        "argument_keys": sorted(arguments),
    }


def _step_summary(step, *, source: str) -> dict:
    structured = step.state_before.structured if isinstance(step.state_before.structured, dict) else {}
    metadata = step.observation.metadata if isinstance(step.observation.metadata, dict) else {}
    return {
        "source": source,
        "task": _preview(step.task or ""),
        "root_agent_id": structured.get("root_agent_id"),
        "state": {
            key: structured[key] for key in ("schema", "root_goal", "row_counts", "url", "title") if key in structured
        },
        "action": _action_summary(step.action),
        "observation": {
            "content": _preview(step.observation.content),
            "is_error": step.observation.is_error,
            "metadata": {
                key: metadata[key] for key in ("source", "result_unavailable", "state_note", "url") if key in metadata
            },
        },
        "raw_span_ids": list(step.raw_span_ids),
    }


class RetrievalAuditRetriever:
    """Serve same-tool, distinct real-world examples and audit each prediction.

    Session history already carries generated observations. Adding those predictions
    to the example index would make a hallucination look like archived ground truth.
    """

    def __init__(self, retriever) -> None:
        self._retriever = retriever
        self._load_offline_index()
        self._events: list[dict] = []
        self._lock = threading.Lock()

    def _load_offline_index(self) -> None:
        # `sample` is a deterministic prefix in WMH. Request the full index: a
        # fixed sample size would silently drop later real-world trajectories.
        self._offline_steps = self._retriever.sample(sys.maxsize)
        self._offline_step_ids = {id(step) for step in self._offline_steps}
        self._rows_by_action: dict[str, list[int]] = defaultdict(list)
        for row, step in enumerate(self._offline_steps):
            self._rows_by_action[_retrieval_action_key(step.action.name)].append(row)
        matrix = getattr(self._retriever, "_matrix", None)
        self._row_norms = np.linalg.norm(matrix, axis=1) if matrix is not None else None
        self._lexical_by_action: dict[str, tuple[list[frozenset[str]], Counter[str]]] = {}

    def _action_lexical_index(self, name: str, rows: list[int]):
        cached = self._lexical_by_action.get(name)
        if cached is None:
            terms = [_delegated_action_terms(self._offline_steps[row].action) for row in rows]
            frequency: Counter[str] = Counter(token for item in terms for token in item)
            cached = (terms, frequency)
            self._lexical_by_action[name] = cached
        return cached

    def index(self, traces) -> None:
        self._retriever.index(traces)
        self._load_offline_index()

    def _rank_offline(self, state, action, k: int):
        """Rank only archived rows for this exact provider boundary."""
        action_key = _retrieval_action_key(action.name)
        rows = self._rows_by_action.get(action_key, [])
        matrix = getattr(self._retriever, "_matrix", None)
        if k <= 0 or not rows:
            return []
        if matrix is None or self._row_norms is None:
            # Small test doubles can lack embedding internals; still enforce provenance.
            candidates = self._retriever.topk(state, action, len(self._offline_steps))
        else:
            from wmh.core.types import Observation, Step

            query = self._retriever._embed_steps(
                [Step(state_before=state, action=action, observation=Observation(content=""))]
            )[0]
            if query.shape[0] != matrix.shape[1]:
                raise ValueError("WHM query embedding does not match the archived index")
            row_array = np.asarray(rows, dtype=np.intp)
            norms = self._row_norms[row_array] * np.linalg.norm(query)
            dots = matrix[row_array] @ query
            scores = np.divide(dots, norms, out=np.zeros_like(dots), where=norms > 0)
            query_terms = _delegated_action_terms(action)
            if query_terms:
                terms_by_row, frequency = self._action_lexical_index(action_key, rows)
                lexical_scores = np.fromiter(
                    (
                        sum(
                            math.log1p((len(rows) + 1) / (frequency[token] + 1))
                            for token in query_terms.intersection(terms)
                        )
                        / math.sqrt(max(1, len(terms)))
                        for terms in terms_by_row
                    ),
                    dtype=np.float64,
                    count=len(rows),
                )
                # Action subject dominates fixture-state similarity; the original
                # embedding still breaks ties and handles actions without a goal.
                scores += 5.0 * lexical_scores
            order = np.argsort(scores)[::-1]
            candidates = [self._offline_steps[rows[int(rank)]] for rank in order]

        selected = []
        seen_roots = set()
        seen_tasks = set()
        for step in candidates:
            if id(step) not in self._offline_step_ids or _retrieval_action_key(step.action.name) != action_key:
                continue
            structured = step.state_before.structured
            root = structured.get("root_agent_id") if isinstance(structured, dict) else None
            # An unlabelled step cannot prove it is from a different real-world run.
            if not isinstance(root, str) or not root or root in seen_roots:
                continue
            task = " ".join((step.task or "").casefold().split())
            if task and task in seen_tasks:
                continue
            seen_roots.add(root)
            if task:
                seen_tasks.add(task)
            selected.append(step)
            if len(selected) == k:
                break
        return selected

    def topk(self, state, action, k: int):
        demos = self._rank_offline(state, action, k)
        with self._lock:
            self._events.append(
                {
                    "sequence": len(self._events) + 1,
                    "query": {
                        "action": _action_summary(action),
                        "state_keys": sorted(state.structured) if isinstance(state.structured, dict) else [],
                        "scratchpad_chars": len(state.scratchpad),
                    },
                    "demos": [
                        _step_summary(
                            step,
                            source=(
                                "real_world_archive" if id(step) in self._offline_step_ids else "generated_session"
                            ),
                        )
                        for step in demos
                    ],
                }
            )
        return demos

    def add(self, step) -> None:
        # Generated observations remain in Session.history, never in real-world demos.
        return None

    def sample(self, n: int):
        if n <= 0:
            return []
        return self._offline_steps[:n]

    def snapshot(self) -> dict:
        with self._lock:
            events = list(self._events)
        archive_demos = sum(1 for event in events for demo in event["demos"] if demo["source"] == "real_world_archive")
        return {
            "schema": "rose.wmh_retrieval_audit.v1",
            "query_count": len(events),
            "offline_index_steps": len(self._offline_step_ids),
            "eligible_index_steps": len(self._offline_step_ids),
            "real_world_demo_uses": archive_demos,
            "events": events,
        }


def _parallel_pinned_wmh_step(world_model, session_id, action, session_lock, on_commit=None):
    """Run the pinned WMH prediction on a snapshot, then commit under the session lock.

    Parallel DAG actions share the state visible when each request starts. Their
    observations and state notes are appended in completion order. Keep this
    adapter aligned with the pinned `WorldModel.step` in agents/requirements.txt.
    """
    from wmh.core.types import Observation, Step
    from wmh.engine.prompts import build_env_prompt
    from wmh.providers.base import Message
    from wmh.telemetry import capture
    from wmh.tracking import Phase

    from helpers.world_model_runtime import parse_world_model_prediction

    started = time.monotonic()
    step_id = uuid.uuid4().hex
    action_args = action.arguments if isinstance(action.arguments, dict) else {}
    agent_id = action_args.get("agent_id")
    agent_id = agent_id if isinstance(agent_id, str) else None
    tool_call_id = action_args.get("tool_call_id")
    tool_call_id = tool_call_id if isinstance(tool_call_id, str) else None
    with session_lock:
        snapshot_lock_wait_ms = round((time.monotonic() - started) * 1000)
        session = world_model._sessions[session_id]
        snapshot = session.model_copy(deep=True)
    snapshot_ms = round((time.monotonic() - started) * 1000) - snapshot_lock_wait_ms

    demos = world_model._retriever.topk(snapshot.state, action, world_model._top_k)
    system, user = build_env_prompt(world_model._env_prompt, snapshot, action, demos)
    prediction_started = time.monotonic()
    logger.info(
        "wmh_step_prediction_started",
        step_id=step_id,
        session_id=session_id,
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        action_name=action.name,
        snapshot_lock_wait_ms=snapshot_lock_wait_ms,
        snapshot_ms=snapshot_ms,
    )
    try:
        completion = world_model._provider.complete(system, [Message(role="user", content=user)])
    except Exception:
        capture(
            "wmh generated step failed",
            {"success": False, "duration_seconds": round(time.monotonic() - started, 3)},
            root=world_model._telemetry_root,
        )
        raise
    observation = Observation.model_validate(parse_world_model_prediction(completion.text))
    prediction_ms = round((time.monotonic() - prediction_started) * 1000)

    commit_queued_at = time.monotonic()
    with session_lock:
        commit_lock_wait_ms = round((time.monotonic() - commit_queued_at) * 1000)
        if world_model._sessions.get(session_id) is not session:
            raise KeyError("WMH session ended before prediction committed")
        tracker = world_model._trackers.get(session_id)
        usage_cost_usd = None
        if tracker is not None:
            usage_event = tracker.record(Phase.SERVE, world_model._provider.config.model, completion.usage)
            usage_cost_usd = usage_event.cost_usd
        # WMH's _advance uses the live state as state_before. Concurrent calls
        # must instead record the snapshot actually shown to each prediction.
        step = Step(action=action, observation=observation, state_before=snapshot.state, task=snapshot.task)
        session.history.append(step)
        world_model._update_state(session, step)
        if on_commit is not None:
            on_commit(observation)
        world_model._retriever.add(step)
        session_step_count = len(session.history)

    logger.info(
        "wmh_step_committed",
        step_id=step_id,
        session_id=session_id,
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        action_name=action.name,
        snapshot_ms=snapshot_ms,
        snapshot_lock_wait_ms=snapshot_lock_wait_ms,
        prediction_ms=prediction_ms,
        commit_lock_wait_ms=commit_lock_wait_ms,
        elapsed_ms=round((time.monotonic() - started) * 1000),
    )
    capture(
        "wmh generated step completed",
        {
            "success": True,
            "generated_step_count": 1,
            "session_step_count": session_step_count,
            "duration_seconds": round(time.monotonic() - started, 3),
            "input_tokens": completion.usage.input_tokens,
            "output_tokens": completion.usage.output_tokens,
            "cost_usd": round(usage_cost_usd, 6) if usage_cost_usd is not None else None,
        },
        root=world_model._telemetry_root,
    )
    return observation


def _install_root_scoped_sessions(app, world_model_name: str, world_model) -> None:
    """Make WMH sessions root-tree scoped across Temporal worker processes.

    Worker-local caches remain an optimization. The common served WMH owns the
    authoritative scope mapping. Per-session locks protect snapshots and commits
    while the pinned WMH's LLM predictions run concurrently.
    """

    from starlette.requests import Request
    from wmh.engine.world_model import WorldModel

    from helpers.tracing import archive_scope

    original_new_session = world_model.new_session
    original_step = world_model.step
    scope_sessions: dict[str, object] = {}
    session_scopes: dict[str, str] = {}
    session_locks: dict[str, threading.Lock] = {}
    invocation_receipts: dict[str, dict[str, Future]] = {}
    state_lock = threading.Lock()

    def scoped_new_session(task=None, seed_state=None):
        scope = _ROSE_SESSION_SCOPE.get()
        if not scope:
            return original_new_session(task=task, seed_state=seed_state)
        with state_lock:
            existing = scope_sessions.get(scope)
            if existing is not None:
                return existing
            session = original_new_session(task=task, seed_state=seed_state)
            scope_sessions[scope] = session
            session_scopes[str(session.id)] = scope
            session_locks.setdefault(str(session.id), threading.Lock())
            return session

    def concurrent_step(session_id, action):
        # Native retry -> session invocation receipt -> one prediction/commit.
        # Distinct native activities still predict concurrently in the same world.
        invocation = _ROSE_STEP_INVOCATION.get()
        session_key = str(session_id)
        with state_lock:
            # The world's root scope owns its model calls in the trace archive.
            world_root = session_scopes.get(session_key)
            step_lock = session_locks.setdefault(session_key, threading.Lock())
            receipts = invocation_receipts.setdefault(session_key, {}) if invocation else {}
            receipt = receipts.get(invocation) if invocation else None
            owns_prediction = receipt is None
            if invocation and owns_prediction:
                receipt = Future()
                receipts[invocation] = receipt
        if not owns_prediction:
            return receipt.result()
        try:
            with archive_scope(world_root):
                if isinstance(world_model, WorldModel):
                    observation = _parallel_pinned_wmh_step(
                        world_model,
                        session_id,
                        action,
                        step_lock,
                        on_commit=receipt.set_result if receipt is not None else None,
                    )
                else:
                    with step_lock:
                        observation = original_step(session_id, action)
        except BaseException as exc:
            if invocation and not receipt.done():
                with state_lock:
                    receipts.pop(invocation, None)
                receipt.set_exception(exc)
            raise
        if receipt is not None and not receipt.done():
            receipt.set_result(observation)
        return observation

    world_model.new_session = scoped_new_session
    world_model.step = concurrent_step
    original_end_session = getattr(world_model, "end_session", None)
    if original_end_session is not None:

        def scoped_end_session(session_id):
            session_key = str(session_id)
            with state_lock:
                step_lock = session_locks.setdefault(session_key, threading.Lock())
            with step_lock:
                result = original_end_session(session_id)
                with state_lock:
                    scope = session_scopes.pop(session_key, None)
                    if scope:
                        scope_sessions.pop(scope, None)
                    session_locks.pop(session_key, None)
                    invocation_receipts.pop(session_key, None)
                return result

        world_model.end_session = scoped_end_session
    session_path = f"/world_models/{world_model_name}/sessions"

    @app.middleware("http")
    async def bind_root_session_scope(request: Request, call_next):
        if (
            request.method == "POST"
            and request.url.path.startswith(session_path + "/")
            and request.url.path.endswith("/step")
        ):
            invocation = request.headers.get("X-Rose-WMH-Invocation")
            if invocation:
                token = _ROSE_STEP_INVOCATION.set(invocation)
                try:
                    return await call_next(request)
                finally:
                    _ROSE_STEP_INVOCATION.reset(token)
        if request.method != "POST" or request.url.path != session_path:
            return await call_next(request)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return await call_next(request)
        scope = payload.get("session_scope_id") if isinstance(payload, dict) else None
        if not isinstance(scope, str) or not scope.strip():
            return await call_next(request)
        token = _ROSE_SESSION_SCOPE.set(scope.strip())
        try:
            return await call_next(request)
        finally:
            _ROSE_SESSION_SCOPE.reset(token)


def build_app(name: str, root: str, pool: str):
    """Load the model at `root/models/<name>` with the Rose provider and return a FastAPI app.

    Mirrors `wmh serve`'s resolution: `WorldModelStore(root).resolve(name)` picks the
    artifact dir (validating the name and existence), then `WorldModel.load(dir, provider=...)`
    rebuilds the model with our provider injected in place of the config's Anthropic one.
    """
    from wmh.config import WorldModelStore
    from wmh.engine.world_model import WorldModel

    from benchmarks.wmh_rose_provider import GLOBAL_ROSE_USAGE, RoseWMHProvider

    store = WorldModelStore(root)
    model_dir = store.resolve(name)  # raises FileNotFoundError/ValueError on bad --name/--root

    provider = RoseWMHProvider(pool=pool)
    world_model = WorldModel.load(
        str(model_dir),
        provider=provider,
        telemetry_root=store.root,
    )
    # WorldModel.load owns retriever construction. Wrap that loaded retriever without modifying
    # vendored WMH so post-run evidence can show the exact real-world demos used per prediction.
    retrieval_audit = RetrievalAuditRetriever(world_model._retriever)
    world_model._retriever = retrieval_audit

    from wmh.serving.server import create_app

    app = create_app(world_models={name: world_model})
    _install_root_scoped_sessions(app, name, world_model)
    _add_rose_usage_route(app, GLOBAL_ROSE_USAGE)
    _add_retrieval_audit_route(app, retrieval_audit)
    return app


def _add_rose_usage_route(app, usage) -> None:
    """Expose cumulative Rose inference cost/tokens for this served WMH.

    The vendored `create_app` has no cost endpoint; we extend the returned FastAPI app
    with `GET /rose_usage` so the benchmark controller can attribute WMH grounding cost
    to a run. Reads the process-level accumulator the provider records into on each step.
    """

    @app.get("/rose_usage")
    def rose_usage() -> dict:  # pragma: no cover - exercised via TestClient in tests
        return usage.snapshot().as_dict()


def _add_retrieval_audit_route(app, audit) -> None:
    @app.get("/retrieval_audit")
    def retrieval_audit() -> dict:  # pragma: no cover - exercised via TestClient in tests
        return audit.snapshot()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Serve a WMH model with the Rose inference provider (replaces `wmh serve`)."
    )
    parser.add_argument("--name", required=True, help="World model name to serve.")
    parser.add_argument("--port", type=int, required=True, help="Port for the local backend.")
    parser.add_argument("--root", required=True, help="Project dir holding models/<name>/.")
    parser.add_argument("--engine", choices=("legacy", "experiential"), default=os.environ.get("WMH_ENGINE", "legacy"))
    parser.add_argument(
        "--pool",
        default=os.environ.get("WMH_ROSE_POOL") or "rose-1-ultra",
        help="Rose pool backing WMH inference (default: WMH_ROSE_POOL or rose-1-ultra).",
    )
    args = parser.parse_args(argv)

    if args.engine != "experiential" and os.environ.get("WMH_EXECUTION_POLICY", "upstream") != "upstream":
        parser.error("WMH_EXECUTION_POLICY requires --engine experiential")
    if args.engine == "experiential":
        from benchmarks.experiential_bridge import serve_native

        return serve_native(args.name, args.root, args.pool, args.port)

    try:
        app = build_app(args.name, args.root, args.pool)
    except (ValueError, FileNotFoundError) as err:
        # Bad --name/--root is a usage error, not a traceback (matches `wmh serve`).
        print(f"error: {err}", file=sys.stderr)
        return 2

    logger.info(
        "wmh.serve_world_model.start",
        name=args.name,
        port=args.port,
        root=args.root,
        pool=args.pool,
    )

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
