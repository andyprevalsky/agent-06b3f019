"""World-model runtime helpers shared by benchmarks and agent workflows."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx
from temporalio import activity

from utils.world_model_observation import (
    _coerce_non_negative_int as _coerce_non_negative_int,
)
from utils.world_model_observation import (
    _observation_tool_result_payload as _observation_tool_result_payload,
)
from utils.world_model_observation import (
    _world_model_content_payload as _world_model_content_payload,
)
from utils.world_model_observation import (
    normalize_world_model_observation as normalize_world_model_observation,
)
from utils.world_model_observation import (
    predicted_latency_ms_from_observation as predicted_latency_ms_from_observation,
)
from utils.world_model_observation import (
    world_model_observation_to_tool_result as world_model_observation_to_tool_result,
)

JsonObject = dict[str, Any]
ToolExecutor = Callable[[str, JsonObject, str], Awaitable[JsonObject]]

# A WMH step can contain one full Rose provider completion. Rose permits that
# completion to run for 590 seconds, including provider rotation, so the HTTP
# transport must outlive it and still leave time to serialize the observation.
WMH_HTTP_TIMEOUT_DEFAULT_SECONDS = 660.0

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|"
    r"compute_token_used|claude_token_error|gpt_token_error)",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|"
    r"[A-Za-z0-9+/]{32,}={0,2})"
)

_EXPLORE_ORCHESTRATION_TOOLS = {"spawn_explore_agent", "explore"}
_FOR_EACH_ORCHESTRATION_TOOLS = {"spawn_general_purpose_agent_for_each", "for_each"}
_BROWSER_ORCHESTRATION_TOOLS = {"spawn_browser_agent", "spawn_browser_agent_activity_v3", "browser"}
_BROWSER_BOUNDARY_TOOLS = {"browser_action", "browser_click", "browser_type", "browser_http"}
_BROWSER_TOOLS = _BROWSER_ORCHESTRATION_TOOLS | _BROWSER_BOUNDARY_TOOLS
_CODE_TOOLS = {
    "spawn_code_agent",
    "spawn_claude_code_agent",
    "spawn_codex_code_agent",
    "claude_code",
    "codex_code",
}
_MESSAGE_TOOLS = {"message_person", "send_message_to_user", "send_sms", "send_direct_sms", "notify_sms_event"}
_PAYMENT_TOOLS = {"request_payment_card", "payment_lookup", "payment_mint", "x402", "purchase", "purchase_item"}
_VAPI_ORCHESTRATION_TOOLS = {"call_phone_number", "vapi"}
_VAPI_BOUNDARY_TOOLS = {"vapi_create_call", "vapi_poll_call", "vapi_recording_fetch"}
_VAPI_TOOLS = _VAPI_ORCHESTRATION_TOOLS | _VAPI_BOUNDARY_TOOLS
_GREP_TOOLS = {"grep", "web_search", "web_fetch", "web_fetch_download", "people_search"}
_DEMO_CACHE_TOOLS = {"fast_cache_read", "fast_cache_write"}
# DEMO cache is intentionally NOT an environment boundary: simulated runs keep
# the real cache active (WMH steps are expensive) and are isolated from real-run
# entries by the world-model scope segment in every cache key
# (demo_cache/normalize.py:world_model_cache_scope).
_ENVIRONMENT_BOUNDARY_TOOLS = (
    _EXPLORE_ORCHESTRATION_TOOLS
    | _CODE_TOOLS
    | _BROWSER_ORCHESTRATION_TOOLS
    | _BROWSER_BOUNDARY_TOOLS
    | _VAPI_ORCHESTRATION_TOOLS
    | _VAPI_BOUNDARY_TOOLS
    | {
        "web_search",
        "web_fetch",
        "web_fetch_download",
        "people_search",
        "send_direct_sms",
        "notify_sms_event",
        "payment_lookup",
        "payment_mint",
        "provider_request",
        "provider_response",
        "search_provider_request",
        "search_provider_response",
        "fetch_provider_request",
        "fetch_provider_response",
        "message_transport_send",
        "payment_provider_request",
        "payment_provider_response",
    }
)


@dataclass
class CanonicalAction:
    """Rose action schema carried inside WMH's generic tool_call Action."""

    category: str
    name: str
    arguments: JsonObject = field(default_factory=dict)
    agent_id: Optional[str] = None
    span_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    artifact_refs: list[str] = field(default_factory=list)
    timestamp_ms: Optional[int] = None

    def to_wmh_tool_name(self) -> str:
        return f"rose.{self.category}.{self.name}".replace(" ", "_")

    def to_arguments(self) -> JsonObject:
        payload: JsonObject = {
            "schema": "rose.canonical_action.v1",
            "category": self.category,
            "name": self.name,
            "arguments": self.arguments,
        }
        if self.agent_id:
            payload["agent_id"] = self.agent_id
        if self.span_id:
            payload["span_id"] = self.span_id
        if self.tool_call_id:
            payload["tool_call_id"] = self.tool_call_id
        if self.artifact_refs:
            payload["artifact_refs"] = self.artifact_refs
        if self.timestamp_ms is not None:
            payload["timestamp_ms"] = self.timestamp_ms
        return payload

    def to_wmh_action(self) -> JsonObject:
        return {
            "kind": "tool_call",
            "name": self.to_wmh_tool_name(),
            "arguments": self.to_arguments(),
        }


class WMHHttpClient:
    """Small client for the upstream World Model Harness HTTP runtime."""

    def __init__(self, base_url: str, *, timeout: float | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        configured_timeout = timeout
        if configured_timeout is None:
            configured_timeout = float(
                os.environ.get("WMH_HTTP_TIMEOUT_SECONDS", str(WMH_HTTP_TIMEOUT_DEFAULT_SECONDS))
            )
        if configured_timeout <= 0:
            raise ValueError("WMH HTTP timeout must be greater than zero")
        self.timeout = configured_timeout

    async def list_world_models(self) -> list[JsonObject]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}/world_models")
            response.raise_for_status()
            data = response.json()
        models = data.get("world_models") if isinstance(data, dict) else data
        if not isinstance(models, list):
            raise ValueError("WMH response did not include a world_models list")
        return models

    async def create_session(
        self,
        world_model: str,
        *,
        task: str | None = None,
        seed_state: JsonObject | None = None,
        session_scope_id: str | None = None,
    ) -> str:
        body: JsonObject = {"task": task, "seed_state": seed_state}
        if session_scope_id:
            # The Rose server makes this key idempotent, so Temporal workers in
            # separate processes still resolve one root tree to one WMH session.
            body["session_scope_id"] = session_scope_id
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{self.base_url}/world_models/{world_model}/sessions", json=body)
            response.raise_for_status()
            data = response.json()
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("WMH session response did not include session_id")
        return session_id

    async def end_session(self, world_model: str, session_id: str) -> JsonObject:
        """Retire an owned world and retain the server's joined terminal receipt."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.delete(f"{self.base_url}/world_models/{world_model}/sessions/{session_id}")
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict) or data.get("ended") != session_id:
            raise ValueError("WMH retirement response did not match the owned session")
        return data

    async def step(self, world_model: str, session_id: str, action: CanonicalAction | JsonObject) -> JsonObject:
        wmh_action = action.to_wmh_action() if isinstance(action, CanonicalAction) else action
        # Native activity -> stable invocation header -> shared session receipt.
        # Attempt numbers and generated wall timestamps are not operation identity.
        headers = {}
        if activity.in_activity():
            info = activity.info()
            arguments = dict(wmh_action.get("arguments") or {})
            arguments.pop("timestamp_ms", None)
            identity = [
                info.workflow_id,
                info.workflow_run_id,
                info.activity_id,
                {**wmh_action, "arguments": arguments},
            ]
            headers["X-Rose-WMH-Invocation"] = hashlib.sha256(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        # The owned run retires this native operation. Socket reads must not
        # abandon it merely because retrieval/rebase plus inference is slow.
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, read=None)) as client:
            response = await client.post(
                f"{self.base_url}/world_models/{world_model}/sessions/{session_id}/step",
                json={"action": wmh_action},
                headers=headers,
            )
            response.raise_for_status()
            data = response.json()
        observation = data.get("observation")
        if not isinstance(observation, dict):
            raise ValueError("WMH step response did not include observation")
        return observation


class _NoWorldSession(LookupError):
    """The root has no live WMH world yet, so there is no shared clock to use."""


async def _clock_request(base_url: str, path: str, payload: JsonObject, timeout: float) -> JsonObject:
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(f"{base_url.rstrip('/')}{path}", json=payload)
    if response.status_code == 404:
        raise _NoWorldSession(path)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("WMH world clock returned a non-object response")
    return data


def canonical_category_for_tool(tool_name: str) -> str:
    if tool_name in _EXPLORE_ORCHESTRATION_TOOLS:
        return "explore"
    if tool_name in _FOR_EACH_ORCHESTRATION_TOOLS:
        return "for_each"
    if tool_name in _BROWSER_TOOLS or tool_name.startswith("browser_"):
        return "browser"
    if tool_name in _CODE_TOOLS or "code" in tool_name:
        return "code"
    if tool_name in _MESSAGE_TOOLS or tool_name.startswith("message_"):
        return "message"
    if tool_name in _PAYMENT_TOOLS or "payment" in tool_name or "write_lock" in tool_name:
        return "payment"
    if tool_name in _VAPI_TOOLS or tool_name.startswith("vapi_"):
        return "vapi"
    if tool_name in _GREP_TOOLS or tool_name.startswith("grep"):
        return "grep"
    if tool_name in _DEMO_CACHE_TOOLS or "cache" in tool_name:
        return "fast_cache"
    if tool_name in {"request_user_approval", "request_user_signup", "request_user_auth"}:
        return "auth_approval"
    return "tool"


def is_world_model_environment_boundary(tool_name: str) -> bool:
    """Return true for simulated boundaries, including specialized subagents.

    General-purpose agents are intentionally absent: their agent loops and
    for-each batches remain real in simulator mode. Explore/browser/code
    delegation is represented by one terminal WMH observation.
    """

    return tool_name in _ENVIRONMENT_BOUNDARY_TOOLS


def canonical_action_from_tool_call(
    tool_name: str,
    tool_args: JsonObject,
    tool_call_id: str,
    *,
    agent_id: str | None = None,
    span_id: str | None = None,
    redaction_mode: str = "public",
    timestamp_ms: int | None = None,
) -> CanonicalAction:
    return CanonicalAction(
        category=canonical_category_for_tool(tool_name),
        name=tool_name,
        arguments=_maybe_redact(tool_args, redaction_mode),
        agent_id=agent_id,
        span_id=span_id,
        tool_call_id=tool_call_id,
        timestamp_ms=timestamp_ms if timestamp_ms is not None else current_world_model_timestamp_ms(),
    )


def current_world_model_timestamp_ms() -> int:
    """Return the timestamp to stamp on WMH actions.

    Sim-clock work can provide an authoritative logical clock through env. Until
    that coordinator exists, wall clock remains the fallback.
    """

    for env_name in ("WMH_SIM_TIME_MS", "WORLD_MODEL_SIM_TIME_MS"):
        raw = os.environ.get(env_name)
        if raw is None or not raw.strip():
            continue
        try:
            return int(raw)
        except ValueError as exc:
            raise ValueError(f"{env_name} must be an integer millisecond timestamp") from exc
    return int(time.time() * 1000)


def _maybe_redact(value: Any, redaction_mode: str) -> Any:
    if redaction_mode == "none":
        return value
    if redaction_mode != "public":
        raise ValueError("redaction_mode must be 'public' or 'none'")
    return _redact(value)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        out: JsonObject = {}
        for key, inner in value.items():
            if _SECRET_KEY_RE.search(str(key)):
                out[key] = "[REDACTED]"
            else:
                out[key] = _redact(inner)
        return out
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        return _SECRET_VALUE_RE.sub("[REDACTED]", value)
    return value


# The adapter is constructed per tool call (each handler calls `from_env().execute()`),
# so WMH sessions are cached at module level keyed by (root-agent scope, world_model).
# Every real general-purpose child in one agent tree must observe and mutate the same
# simulated world as its root while retaining its own agent_id in canonical actions.
# Direct benchmark activity calls may omit the scope and fall back to the action agent
# (or the worker's single-run "default" session) for backward compatibility.
_WMH_SESSION_CACHE: dict[tuple[str, str], str] = {}
# One lock per key: a slow create for one agent tree must not block another tree's
# first boundary. A key's lock is dropped once its session is cached.
_WMH_SESSION_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


async def ensure_world_model_session(
    client: "WMHHttpClient",
    world_model_name: str,
    session_scope_id: str | None,
    *,
    task: str | None = None,
    seed_state: JsonObject | None = None,
) -> str:
    """Return a cached WMH session for (root-agent scope, world model)."""
    key = (session_scope_id or "default", world_model_name)
    cached = _WMH_SESSION_CACHE.get(key)
    if cached:
        return cached
    lock = _WMH_SESSION_LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _WMH_SESSION_CACHE.get(key)
        if cached:
            return cached
        session_id = await client.create_session(
            world_model_name,
            task=task,
            seed_state=seed_state,
            session_scope_id=session_scope_id,
        )
        _WMH_SESSION_CACHE[key] = session_id
        _WMH_SESSION_LOCKS.pop(key, None)
        return session_id


class WorldModelToolExecutionAdapter:
    """Adapter for WMH simulation at provider/environment boundaries."""

    def __init__(
        self,
        *,
        mode: str = "real",
        client: WMHHttpClient | None = None,
        world_model_name: str | None = None,
        session_id: str | None = None,
        agent_id: str | None = None,
        session_scope_id: str | None = None,
        timestamp_ms: int | None = None,
    ) -> None:
        if mode not in {"real", "shadow", "simulate"}:
            raise ValueError("mode must be one of: real, shadow, simulate")
        self.mode = mode
        self.client = client
        self.world_model_name = world_model_name
        self.session_id = session_id
        self.agent_id = agent_id
        self._explicit_session_scope = bool(session_scope_id)
        self.session_scope_id = session_scope_id or agent_id
        self.timestamp_ms = timestamp_ms

    @classmethod
    def from_env(
        cls,
        *,
        agent_id: str | None = None,
        session_scope_id: str | None = None,
        inherit_explicit_session: bool = True,
        mode: str | None = None,
        timestamp_ms: int | None = None,
    ) -> "WorldModelToolExecutionAdapter":
        resolved_mode = (mode or os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real")).strip().lower() or "real"
        base_url = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
        model_name = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
        session_id = None
        if inherit_explicit_session:
            session_id = os.environ.get("WMH_SESSION_ID") or os.environ.get("WORLD_MODEL_SESSION_ID")
        client = WMHHttpClient(base_url) if base_url else None
        return cls(
            mode=resolved_mode,
            client=client,
            world_model_name=model_name,
            session_id=session_id,
            agent_id=agent_id,
            session_scope_id=session_scope_id,
            timestamp_ms=timestamp_ms,
        )

    def action_for_tool(self, tool_name: str, tool_args: JsonObject, tool_call_id: str) -> CanonicalAction:
        return canonical_action_from_tool_call(
            tool_name,
            tool_args,
            tool_call_id,
            agent_id=self.agent_id,
            timestamp_ms=self.timestamp_ms,
        )

    def should_simulate(self, tool_name: str) -> bool:
        return self.mode == "simulate" and is_world_model_environment_boundary(tool_name)

    async def ensure_session(
        self,
        *,
        task: str | None = None,
        seed_state: JsonObject | None = None,
    ) -> str:
        """Resolve this adapter's stateful WMH session without taking an action."""

        if self.session_id:
            return self.session_id
        if not self.client or not self.world_model_name:
            raise RuntimeError("WMH simulation requires WMH_BASE_URL and WMH_MODEL_NAME")
        # Activity actor -> durable agent tree -> root-scoped WMH session.
        # Workflow tracing contextvars are not inherited by Temporal activities.
        if not self._explicit_session_scope and activity.in_activity():
            from providers.demo_cache.client import resolve_agent_fast_mode

            if not self.agent_id:
                raise RuntimeError("WMH activity requires its acting agent identity")
            _read, _goal, _write, root_id, root_goal, _fast = await resolve_agent_fast_mode(self.agent_id)
            if not root_id:
                raise RuntimeError("WMH activity could not resolve its durable root agent")
            self.session_scope_id = root_id
            if seed_state is not None:
                structured = {**seed_state.get("structured", {}), "root_agent_id": root_id}
                if root_goal:
                    structured.setdefault("root_goal", root_goal)
                seed_state = {**seed_state, "structured": structured}
        self.session_id = await ensure_world_model_session(
            self.client,
            self.world_model_name,
            self.session_scope_id,
            task=task,
            seed_state=seed_state,
        )
        return self.session_id

    async def execute(
        self,
        tool_name: str,
        tool_args: JsonObject,
        tool_call_id: str,
        real_executor: ToolExecutor,
        *,
        allow_real_fallback: bool = True,
    ) -> JsonObject:
        if self.mode == "real" or not is_world_model_environment_boundary(tool_name):
            return await real_executor(tool_name, tool_args, tool_call_id)
        if not self.client or not self.world_model_name:
            raise RuntimeError("WMH simulation requires WMH_BASE_URL and WMH_MODEL_NAME")
        # Session is created lazily on first boundary tool and cached per
        # (root-agent scope, model); an explicit WMH_SESSION_ID still wins.
        session_id = await self.ensure_session(
            task=_world_model_task_for_tool(tool_name, tool_args),
            seed_state=_world_model_seed_state_for_tool(tool_args, self.session_scope_id, tool_name),
        )
        action = self.action_for_tool(tool_name, tool_args, tool_call_id)
        if self.mode == "simulate":
            started = time.monotonic()
            observation = await self.client.step(self.world_model_name, session_id, action)
            wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
            result = world_model_observation_to_tool_result(
                observation,
                simulated=True,
                wall_elapsed_ms=wall_elapsed_ms,
            )
            result.setdefault("world_model_session_id", session_id)
            result.setdefault("world_model_name", self.world_model_name)
            result.setdefault("world_model_boundary", tool_name)
            result.setdefault("world_model_timestamp_ms", action.timestamp_ms)
            if allow_real_fallback and _wmh_fallback_on_unavailable_enabled() and _wmh_result_unavailable(result):
                real_result = await real_executor(tool_name, tool_args, tool_call_id)
                if isinstance(real_result, dict):
                    real_result.setdefault("world_model_unavailable_fallback", True)
                    real_result.setdefault("world_model_unavailable_observation", observation)
                return real_result
            return result
        real_result = await real_executor(tool_name, tool_args, tool_call_id)
        started = time.monotonic()
        try:
            observation = await self.client.step(self.world_model_name, session_id, action)
        except Exception as exc:
            observation = {"error": str(exc)[:300], "is_error": True}
        wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
        if isinstance(real_result, dict):
            real_result.setdefault("world_model_shadow", observation)
            real_result.setdefault("world_model_shadow_wall_elapsed_ms", wall_elapsed_ms)
        return real_result


def parse_world_model_prediction(content: str) -> JsonObject:
    """Preserve production receipts before the pinned parser drops extra fields."""
    from wmh.core.parsing import parse_observation

    payload = _world_model_content_payload(content)
    if isinstance(payload, dict) and not set(payload).issubset({"output", "is_error", "state_note"}):
        return {"content": content.strip(), "is_error": payload.get("is_error") is True, "metadata": {}}
    return normalize_world_model_observation(parse_observation(content).model_dump(mode="json"))


def _world_model_task_for_tool(tool_name: str, tool_args: JsonObject) -> str | None:
    """Give a lazily-created WMH session both the root and delegated goals.

    Specialized-agent sessions are lazy and their first action is often a
    narrow discovery check.  Using only that check as WMH's ``TASK`` loses the
    long-horizon objective even though the action arguments carry it.  Keep the
    root objective in the task slot (where WMH gives it strongest precedence)
    while retaining the concrete delegation that determines this transition.
    """

    root_goal = _world_model_root_goal_for_tool(tool_name, tool_args)
    delegated_goal = next(
        (
            value.strip()
            for key in ("goal", "task", "query", "condition")
            if isinstance((value := tool_args.get(key)), str) and value.strip()
        ),
        None,
    )
    if isinstance(root_goal, str) and root_goal.strip():
        root_goal = root_goal.strip()
        if delegated_goal and delegated_goal != root_goal:
            return f"ROOT OBJECTIVE:\n{root_goal}\n\nCURRENT DELEGATION:\n{delegated_goal}"
        return root_goal
    if delegated_goal:
        return delegated_goal
    return tool_name or None


def _world_model_seed_state_for_tool(
    tool_args: JsonObject,
    session_scope_id: str | None,
    tool_name: str | None = None,
) -> JsonObject:
    """Seed the simulated world with task identity, never a live environment snapshot."""
    structured: JsonObject = {
        "schema": "rose.runtime_initial_state.v1",
    }
    if session_scope_id:
        structured["root_agent_id"] = session_scope_id
    root_goal = _world_model_root_goal_for_tool(tool_name, tool_args)
    if isinstance(root_goal, str) and root_goal.strip():
        structured["root_goal"] = root_goal.strip()
    return {"structured": structured, "scratchpad": ""}


def _world_model_root_goal_for_tool(tool_name: str | None, tool_args: JsonObject) -> str | None:
    """Recover the root objective from an agent-started lifecycle notification.

    The startup SMS is often the first simulated boundary and creates the shared
    WMH session before the agent's first tool call. Its goal is nested in
    ``payload`` rather than top-level ``root_goal``; without this, the session
    task becomes ``notify_sms_event`` for the entire agent tree.
    """
    root_goal = tool_args.get("root_goal")
    if isinstance(root_goal, str) and root_goal.strip():
        return root_goal.strip()
    if tool_name == "notify_sms_event" and tool_args.get("event_type") == "agent_started":
        payload = tool_args.get("payload")
        if isinstance(payload, dict):
            goal = payload.get("goal")
            if isinstance(goal, str) and goal.strip():
                return goal.strip()
    return None


def _wmh_fallback_on_unavailable_enabled() -> bool:
    return os.environ.get("BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def wmh_fallback_on_unavailable_enabled() -> bool:
    return _wmh_fallback_on_unavailable_enabled()


def _wmh_result_unavailable(value: Any) -> bool:
    if isinstance(value, dict):
        metadata = value.get("metadata")
        if isinstance(metadata, dict) and metadata.get("result_unavailable") is True:
            return True
        if value.get("result_unavailable") is True:
            return True
        for key in ("content", "message"):
            content = value.get(key)
            if isinstance(content, str) and content.strip():
                try:
                    parsed = json.loads(content)
                except json.JSONDecodeError:
                    continue
                if _wmh_result_unavailable(parsed):
                    return True
        for key in ("result", "tool_result", "world_model_observation"):
            if _wmh_result_unavailable(value.get(key)):
                return True
    return False


def wmh_result_unavailable(value: Any) -> bool:
    return _wmh_result_unavailable(value)


@activity.defn
async def world_model_step_activity(
    world_model_name: str,
    session_id: str,
    action: JsonObject,
    base_url: str | None = None,
) -> JsonObject:
    """Run one WMH runtime step as a Temporal activity."""

    resolved_base_url = base_url or os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
    if not resolved_base_url:
        raise RuntimeError("WMH step requires WMH_BASE_URL or WORLD_MODEL_HARNESS_URL")
    return await WMHHttpClient(resolved_base_url).step(world_model_name, session_id, action)


class WorldClockUnavailable(RuntimeError):
    """A WMH is configured but this agent's world clock could not be read."""


_WORLD_TIME_ATTEMPTS = 3
_WORLD_TIME_RETRY_DELAY_S = 1.0


async def world_time_ms(agent_id: str | None) -> int | None:
    """This agent's time on its world's shared clock, or None outside a simulated world.

    None means no world: no WMH is configured, or the WMH has no world for this
    agent's root. Any other failure raises WorldClockUnavailable so a simulated
    planner never falls back to the real date; transient reads retry first.
    """
    base_url = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
    model = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
    if not base_url or not model or not agent_id:
        return None
    from providers.demo_cache.client import resolve_agent_fast_mode

    scope = (await resolve_agent_fast_mode(agent_id))[3]
    if not scope:
        raise WorldClockUnavailable("World clock could not resolve its durable root agent")
    url = f"{base_url.rstrip('/')}/world_models/{model}/scopes/{scope}/clock"
    failure = "no response"
    for attempt in range(_WORLD_TIME_ATTEMPTS):
        if attempt:
            await asyncio.sleep(attempt * _WORLD_TIME_RETRY_DELAY_S)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
        except httpx.HTTPError as exc:
            failure = type(exc).__name__
            continue
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            failure = f"HTTP {response.status_code}"
            continue
        try:
            snapshot = response.json()
        except ValueError as exc:
            raise WorldClockUnavailable("World clock returned invalid JSON") from exc
        return _snapshot_time_ms(snapshot, agent_id)
    raise WorldClockUnavailable(f"World clock unavailable after {_WORLD_TIME_ATTEMPTS} attempts: {failure}")


def _snapshot_time_ms(snapshot: Any, agent_id: str) -> int:
    if not isinstance(snapshot, dict):
        raise WorldClockUnavailable("World clock returned a non-object snapshot")
    for agent in snapshot.get("agents") or []:
        if isinstance(agent, dict) and agent.get("agent_id") == agent_id and type(agent.get("time_ms")) is int:
            return agent["time_ms"]
    fallback = snapshot.get("shared_time_ms")
    if fallback is None:
        fallback = snapshot.get("start_ms")
    if type(fallback) is not int:
        raise WorldClockUnavailable("World clock snapshot has no integer time")
    return fallback


@activity.defn
async def world_clock_activity(
    operation: str,
    agent_id: str,
    parent_agent_id: str | None = None,
    wait: JsonObject | None = None,
    session_scope_id: str | None = None,
) -> JsonObject:
    """Register, finish, wait for, hold/release on children or read ("time") one agent on its world's shared clock.

    Waits long-poll the WMH (resumed=false after each poll) and heartbeat, so a
    retried activity rejoins the same wait_id. A root without a live world, or
    a run without a WMH, reports ``skipped`` and the caller keeps its private clock.
    """

    base_url = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
    model = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
    if not base_url or not model:
        return {"skipped": "no_world_model"}
    if operation == "time":
        # This agent's own world time, the same reading the planner uses.
        time_ms = await world_time_ms(agent_id)
        return {"skipped": "no_world_session"} if time_ms is None else {"agent_id": agent_id, "time_ms": time_ms}
    scope = session_scope_id
    if not scope:
        from providers.demo_cache.client import resolve_agent_fast_mode

        scope = (await resolve_agent_fast_mode(agent_id))[3]
        if not scope:
            # A failed lookup must retry: a child's own scope has no world, so
            # it would keep a private clock and move ahead of its siblings.
            raise RuntimeError("World clock could not resolve its durable root agent")
    path = f"/world_models/{model}/scopes/{scope}/clock/agents/{agent_id}/{operation}"
    try:
        if operation == "register":
            return await _clock_request(base_url, path, {"parent": parent_agent_id}, 30)
        if operation == "finish":
            return await _clock_request(base_url, path, {}, 30)
        if operation == "hold" and isinstance(wait, dict):
            return await _clock_request(base_url, path, {"hold_id": wait.get("hold_id")}, 30)
        if operation == "release" and isinstance(wait, dict):
            payload = {"hold_id": wait.get("hold_id"), "children": list(wait.get("children") or [])}
            return await _clock_request(base_url, path, payload, 30)
        if operation != "wait" or not isinstance(wait, dict):
            raise ValueError("World clock operation must be register, finish, wait, hold, release or time")
        payload = {key: wait[key] for key in ("wait_id", "until_ms", "duration_ms") if wait.get(key) is not None}
        payload["poll_seconds"] = 50
        while True:
            result = await _clock_request(base_url, path, payload, 90)
            if result.get("resumed"):
                return result
            activity.heartbeat(result)
    except _NoWorldSession:
        return {"skipped": "no_world_session"}


@activity.defn
async def world_model_specialized_agent_activity(
    world_model_mode: str,
    agent_id: str,
    tool_name: str,
    tool_args: JsonObject,
    tool_call_id: str,
    timestamp_ms: int | None = None,
    session_scope_id: str | None = None,
) -> JsonObject:
    """Resolve one simulated agent-orchestration call as a WMH observation.

    This activity is the workflow-safe orchestration boundary for simulator
    mode. It must never fall back to a real explore, browser, or code agent.
    General-purpose orchestration does not call this activity.
    """

    adapter = WorldModelToolExecutionAdapter.from_env(
        agent_id=agent_id,
        session_scope_id=session_scope_id,
        mode=world_model_mode,
        timestamp_ms=timestamp_ms,
    )

    async def forbidden_real_specialized_agent(
        _tool_name: str,
        _tool_args: JsonObject,
        _tool_call_id: str,
    ) -> JsonObject:
        raise RuntimeError("Simulator mode forbids launching this real subagent path")

    return await adapter.execute(
        tool_name,
        tool_args,
        tool_call_id,
        forbidden_real_specialized_agent,
        allow_real_fallback=False,
    )
