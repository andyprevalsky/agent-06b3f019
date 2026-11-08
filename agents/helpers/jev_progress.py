"""Prefix-only JEV estimates; no decision-model messages or lifecycle writes.

Each loop owns bounded cancellable predictions. Workflow callers use an activity so
HTTP and prompt-file access never execute inside the deterministic workflow.
"""
from __future__ import annotations

import asyncio
import functools
import hashlib
import inspect
import json
import math
import os
import weakref
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import structlog
from temporalio import activity, workflow
from temporalio.common import RetryPolicy

from helpers.http_client import get_http_client
from helpers.update_status import publish_progress_estimate
from helpers.workflow_safe import safe_now

MODEL = "jev-1.13.0"
BINS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55]
ETA = {**{f"{i}m": i * 60 for i in range(1, 60)},
       **{f"{i}h": i * 3600 for i in range(1, 24)},
       **{f"{i}d": i * 86400 for i in range(1, 30)},
       **{f"{i}mo": i * 30 * 86400 for i in range(1, 12)}, "1y": 31536000}
logger = structlog.get_logger()
_limits: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


class JEVBudgetExceeded(ValueError):
    """The clipped prefix exceeds the frozen token budget; a longer prefix cannot fit."""


def clip(value: Any, limit: int = 2000) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit * 3 // 4] + " [OMITTED] " + value[-limit // 4:]
    if isinstance(value, list):
        return [clip(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: clip(v, limit) for k, v in value.items()}
    return value


def prefix_events(context: list[dict], task_id: str | None = None) -> list[dict]:
    """Allowlist observed own-call events; exclude child internals and metadata."""
    events = []
    own_calls = set()
    for msg in context:
        if not isinstance(msg, dict):
            continue
        md = msg.get("metadata") or {}
        if not isinstance(md, dict):
            md = {}
        owner = md.get("subAgentId") or md.get("taskId")
        if owner and owner != task_id:
            continue
        role = str(msg.get("role", "")).lower()
        calls = md.get("tool_calls") or msg.get("calls")
        if isinstance(calls, list):
            calls = [c for c in calls if isinstance(c, dict)]
        if role == "assistant" and isinstance(calls, list) and calls:
            own_calls.update(c.get("tool_call_id") or c.get("id") for c in calls)
            events.append({"role": role, "calls": clip(calls), "timestamp": msg.get("timestamp")})
        elif role in ("tool", "tool_result") and (md.get("toolCallId") or msg.get("call_id")) in own_calls:
            events.append({"role": "tool", "text": clip(msg.get("text", "")),
                           "call_id": md.get("toolCallId") or msg.get("call_id"),
                           "status": md.get("toolStatus") or msg.get("status"),
                           "tool": md.get("toolName") or msg.get("tool"), "timestamp": msg.get("timestamp")})
    return events


def browser_prefix_events(entries: list[dict]) -> list[dict]:
    """Project redacted action history, grouping actions with the same step."""
    batches: dict[Any, list[dict]] = {}
    for entry in entries:
        batches.setdefault(entry["step"], []).append(entry)
    events = []
    for step, actions in batches.items():
        calls = [{"tool": entry["action"], "id": f"{step}:{index}",
                  "arguments": clip(entry.get("params", {}))} for index, entry in enumerate(actions)]
        events.append({"role": "assistant", "calls": calls, "timestamp": actions[0].get("timestamp")})
        for call, entry in zip(calls, actions):
            result = entry.get("result") or {}
            events.append({"role": "tool", "tool": entry["action"], "call_id": call["id"],
                           "status": "FINISHED" if result.get("success", True) else "ERROR",
                           "text": json.dumps(clip(result), default=str), "timestamp": entry.get("timestamp")})
    return events


def request(snapshot: dict, prompt: dict) -> dict:
    """Only accepts a visible prefix, goal and schema. Never accepts labels/suffix."""
    events = [{k: e[k] for k in ("role", "calls", "text", "status", "tool", "call_id", "timestamp") if k in e}
              for e in snapshot["events"]]
    state = {"goal": snapshot["goal"], "output_schema": snapshot.get("output_schema"),
             "agent_kind": snapshot["kind"], "observed_batches": sum(e["role"] == "assistant" for e in events),
             "history": clip(events), "scope": prompt["scope"]}
    fmt = prompt.get("input_format", "history")
    if fmt not in ("history", "timeline", "compact"):
        raise ValueError("Unknown JEV input format")
    if fmt != "history":
        times = []
        for e in events:
            try:
                parsed = datetime.fromisoformat(str(e.get("timestamp")).replace("Z", "+00:00"))
                if parsed.tzinfo is not None:
                    times.append(parsed)
            except (ValueError, TypeError):
                pass
        state["elapsed_seconds"] = max(0, (times[-1] - times[0]).total_seconds()) if times else None
        counts: dict[str, int] = {}
        for e in events:
            for c in e.get("calls") or []:
                name = c.get("tool") or c.get("name") or c.get("function", {}).get("name", "unknown")
                counts[name] = counts.get(name, 0) + 1
        state["observed_tool_counts"] = counts
        if fmt == "compact":
            state["history"] = clip(events if len(events) <= 10 else events[:2] + events[-8:], 1200)
            state["omitted_event_count"] = max(0, len(events) - 10)
    if len(json.dumps(state).encode()) >= 20000:
        import tiktoken
        encoding = tiktoken.get_encoding("cl100k_base")
        for limit in (1200, 600, 300, 150, 80):
            if len(encoding.encode(json.dumps(state))) < 20000:
                break
            state["history"] = clip(state["history"], limit)
        if len(encoding.encode(json.dumps(state))) >= 24000:
            raise JEVBudgetExceeded("JEV prefix exceeds 24k token budget")
    if fmt == "timeline":
        state["history"] = "\n".join(json.dumps(e, ensure_ascii=False) for e in state["history"])
    return {"model": MODEL, "state": state, "questions": {
        "remaining_batches": {"type": "score", "instructions": prompt["progress"],
                              "criteria": [f"{n} remaining tool-call batches" for n in BINS[:-1]]
                              + ["55 or more remaining tool-call batches"]},
        "eta": {"type": "choice", "instructions": prompt["eta"],
                "criteria": {k: f"Approximately {v / 60:g} minutes remaining" for k, v in ETA.items()}}}}


def decode(raw: dict, snapshot: dict, prompt_version: str) -> dict:
    probs = raw["answers"]["remaining_batches"]["probabilities"]
    if set(probs) != {str(i) for i in range(len(BINS))}:
        raise ValueError("Unexpected JEV bins")
    if any(isinstance(v, bool) or not isinstance(v, (float, int)) for v in probs.values()):
        raise ValueError("Non-numeric JEV distribution")
    values = [probs[str(i)] for i in range(len(BINS))]
    if any(not math.isfinite(v) or not 0 <= v <= 1 for v in values) or abs(sum(values) - 1) > .03:
        raise ValueError("Invalid JEV distribution")
    choice = raw["answers"]["eta"]["choice"]
    if raw.get("model") != MODEL or choice not in ETA:
        raise ValueError("Wrong JEV model or ETA")
    observed = sum(e["role"] == "assistant" for e in snapshot["events"])
    remaining = sum(p * b for p, b in zip(values, BINS)) / sum(values)
    estimate = {"progress": observed / (observed + remaining) if observed + remaining else 0,
                "etaSeconds": ETA[choice], "observedAt": snapshot["observedAt"],
                "sequence": snapshot["sequence"], "model": MODEL, "promptVersion": prompt_version}
    if snapshot.get("taskId"):
        estimate["taskId"] = snapshot["taskId"]
    return estimate


def _prepare(snapshot: dict) -> tuple[dict, str]:
    """Pinned prompt plus the clipped request body: file, JSON and tokenizer work."""
    raw_prompt = (Path(__file__).resolve().parents[1] / "config/jev_progress_prompt.json").read_bytes()
    document = json.loads(raw_prompt)
    prompt = document.get("prompt", document)
    version = hashlib.sha256(json.dumps(prompt, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if document.get("model", MODEL) != MODEL or document.get("promptVersion", version) != version:
        raise ValueError("Invalid pinned JEV prompt")
    return request(snapshot, prompt), version


async def _predict_jev_progress_impl(snapshot: dict) -> dict | None:
    """Best effort, bounded HTTP; cancellation propagates through both requests.

    Returns {"stopSession": True} when this prefix can never be estimated: it
    exceeds the frozen token budget, or the provider refused it as a client
    error (HTTP 4xx other than 408/429; e.g. 400 max_tokens_exceeded). The
    session's own-call history only grows, so later prefixes would fail too.
    """
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return None
    loop = asyncio.get_running_loop()
    limiter = _limits.setdefault(loop, asyncio.Semaphore(4))
    stage = "prepare"
    try:
        async with asyncio.timeout(25):
            async with limiter:
                # Clipping a long prefix re-serializes and re-tokenizes it several
                # times; on the loop thread that stalled the agent's own loop.
                body, version = await asyncio.to_thread(_prepare, snapshot)
                stage = "predict"
                client = get_http_client()
                response = await client.post("https://api.typesafe.ai/v1/systemone", json=body,
                                             headers={"Authorization": f"Bearer {key}"}, timeout=20)
                response.raise_for_status()
                stage = "decode"
                estimate = decode(response.json(), snapshot, version)
                # Cancellation has no synchronous gap in which a terminal loop can race this publication.
                await asyncio.sleep(0)
                stage = "publish"
                await publish_progress_estimate(snapshot["agentId"], estimate)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Never log request bodies, credentials, or provider response content.
        fields: dict[str, Any] = {}
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            fields = {"status_code": status, "response_class": f"{status // 100}xx"}
        logger.warning("jev_progress.failed", agent_id=snapshot["agentId"], error_type=type(exc).__name__,
                       stage=stage, **fields)
        if isinstance(exc, JEVBudgetExceeded) or (
                stage == "predict" and 400 <= fields.get("status_code", 0) < 500
                and fields["status_code"] not in (408, 429)):
            return {"stopSession": True}
    return None


@activity.defn
async def predict_jev_progress(snapshot: dict) -> dict | None:
    # Remote Temporal cancellation is delivered at heartbeats. Local asyncio
    # cancellation propagates immediately through the same request coroutine.
    async def heartbeat() -> None:
        while True:
            activity.heartbeat("JEV progress estimate")
            await asyncio.sleep(1)
    heartbeat_task = asyncio.create_task(heartbeat()) if activity.in_activity() else None
    try:
        return await _predict_jev_progress_impl(snapshot)
    finally:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass


class JEVSession:
    """Two active predictions and one latest queued prefix; never await foreground.

    Scheduling every turn replaces only a waiting prefix, never an active HTTP
    request. Backend sequence guards reject out-of-order active completions.
    The own-call history only grows, so after one prefix exceeds the frozen token
    budget or is refused by the provider, every later prefix would be too: the
    session stops estimating.
    """
    def __init__(self, agent_id: str, task_id: str | None = None, kind: str = "normal_root"):
        self.agent_id, self.task_id, self.kind = agent_id, task_id, kind
        self.pending: set = set()
        self.queued = None
        self.closed = False
        self.stopped = False
        self.sequence = 0
        self.history: dict[tuple, dict] = {}

    def close(self) -> None:
        self.closed = True
        self.queued = None
        for future in self.pending:
            future.cancel()

    def schedule(self, goal: str, schema: Any, events: list[dict]) -> None:
        if self.closed or self.stopped:
            return
        try:
            for index, event in enumerate(events):
                ids = tuple(c.get("tool_call_id") or c.get("id") or str(index) for c in event.get("calls", []))
                identity = (event["role"], ids if ids else event.get("call_id", str(index)))
                self.history[identity] = event
            now = safe_now().astimezone(timezone.utc)
            self.sequence = max(self.sequence + 1, int(now.timestamp() * 1_000_000))
            snapshot = {"agentId": self.agent_id, "taskId": self.task_id, "kind": self.kind,
                        "goal": goal, "output_schema": schema, "events": list(self.history.values()),
                        "sequence": self.sequence, "observedAt": now.isoformat().replace("+00:00", "Z")}
            # Bound Temporal payloads without silently dropping event boundaries.
            encoded = json.dumps(snapshot)
            if len(encoded.encode()) > 1_500_000:
                logger.warning("jev_progress.prefix_too_large", agent_id=self.agent_id)
                return
            snapshot = json.loads(encoded)  # Freeze mutable schema and prefix before background execution.
            if len(self.pending) >= 2:
                self.queued = snapshot
            else:
                self._start(snapshot)
        except Exception as exc:
            logger.warning("jev_progress.schedule_failed", error_type=type(exc).__name__)

    def _start(self, snapshot: dict) -> None:
        if workflow.in_workflow():
            future = workflow.start_activity(predict_jev_progress, snapshot,
                start_to_close_timeout=timedelta(seconds=60), heartbeat_timeout=timedelta(seconds=5), retry_policy=RetryPolicy(maximum_attempts=1))
        else:
            future = asyncio.create_task(predict_jev_progress(snapshot))
        self.pending.add(future)
        future.add_done_callback(self._done)

    def _done(self, future: Any) -> None:
        self.pending.discard(future)
        if not future.cancelled() and future.exception() is None and (future.result() or {}).get("stopSession"):
            self.stopped = True
            self.queued = None
        if not self.closed and not self.stopped and self.queued is not None:
            snapshot, self.queued = self.queued, None
            self._start(snapshot)


def with_jev_session(fn):
    """Close on every return, pause, failure, handoff and cancellation path."""
    signature = inspect.signature(fn)
    @functools.wraps(fn)
    async def wrapped(*args, **kwargs):
        opts = signature.bind(*args, **kwargs).arguments
        if opts.get("fast_mode_cache_enabled"):
            # A DEMO replay makes no live calls: no remote JEV estimate, and no
            # per-turn history snapshot competing with the replay for the worker.
            return await fn(*args, **kwargs, _jev_session=None)
        kind = opts.get("jev_agent_kind") or ("explore" if opts.get("call_site_override") == "explore_agent" else "normal_root")
        session = JEVSession(opts["agent_id"], opts.get("task_id"), kind)
        try:
            return await fn(*args, **kwargs, _jev_session=session)
        finally:
            session.close()
    return wrapped
