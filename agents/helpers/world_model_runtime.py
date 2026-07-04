"""World-model runtime helpers shared by benchmarks and agent workflows."""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx
from temporalio import activity

JsonObject = dict[str, Any]
ToolExecutor = Callable[[str, JsonObject, str], Awaitable[JsonObject]]

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|"
    r"compute_token_used|claude_token_error|gpt_token_error)",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|"
    r"[A-Za-z0-9+/]{32,}={0,2})"
)

_BROWSER_ORCHESTRATION_TOOLS = {"spawn_browser_agent", "spawn_browser_agent_activity_v3", "browser"}
_BROWSER_BOUNDARY_TOOLS = {"browser_action", "browser_click", "browser_type", "browser_http"}
_BROWSER_TOOLS = _BROWSER_ORCHESTRATION_TOOLS | _BROWSER_BOUNDARY_TOOLS
_CODE_TOOLS = {"spawn_claude_code_agent", "spawn_codex_code_agent", "claude_code", "codex_code"}
_MESSAGE_TOOLS = {"message_person", "send_message_to_user", "send_sms", "send_direct_sms", "notify_sms_event"}
_PAYMENT_TOOLS = {"request_payment_card", "payment_lookup", "payment_mint", "x402", "purchase", "purchase_item"}
_VAPI_ORCHESTRATION_TOOLS = {"call_phone_number", "vapi"}
_VAPI_BOUNDARY_TOOLS = {"vapi_create_call", "vapi_poll_call", "vapi_recording_fetch"}
_VAPI_TOOLS = _VAPI_ORCHESTRATION_TOOLS | _VAPI_BOUNDARY_TOOLS
_GREP_TOOLS = {"grep", "web_search", "web_fetch", "web_fetch_download", "people_search"}
_FAST_CACHE_TOOLS = {"fast_cache_read", "fast_cache_write"}
# Fast cache is intentionally NOT an environment boundary: simulated runs keep
# the real cache active (WMH steps are expensive) and are isolated from real-run
# entries by the world-model scope segment in every cache key
# (fast_cache/normalize.py:world_model_cache_scope).
_ENVIRONMENT_BOUNDARY_TOOLS = (
    _BROWSER_ORCHESTRATION_TOOLS
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

    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

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
    ) -> str:
        body: JsonObject = {"task": task, "seed_state": seed_state}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{self.base_url}/world_models/{world_model}/sessions", json=body)
            response.raise_for_status()
            data = response.json()
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("WMH session response did not include session_id")
        return session_id

    async def step(self, world_model: str, session_id: str, action: CanonicalAction | JsonObject) -> JsonObject:
        wmh_action = action.to_wmh_action() if isinstance(action, CanonicalAction) else action
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.base_url}/world_models/{world_model}/sessions/{session_id}/step",
                json={"action": wmh_action},
            )
            response.raise_for_status()
            data = response.json()
        observation = data.get("observation")
        if not isinstance(observation, dict):
            raise ValueError("WMH step response did not include observation")
        return observation


def canonical_category_for_tool(tool_name: str) -> str:
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
    if tool_name in _FAST_CACHE_TOOLS or "cache" in tool_name:
        return "fast_cache"
    if tool_name in {"request_user_approval", "request_user_signup", "request_user_auth"}:
        return "auth_approval"
    return "tool"


def is_world_model_environment_boundary(tool_name: str) -> bool:
    """Return true only for provider/environment calls, not agent-facing tools."""

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
    ) -> None:
        if mode not in {"real", "shadow", "simulate"}:
            raise ValueError("mode must be one of: real, shadow, simulate")
        self.mode = mode
        self.client = client
        self.world_model_name = world_model_name
        self.session_id = session_id
        self.agent_id = agent_id

    @classmethod
    def from_env(cls, *, agent_id: str | None = None) -> "WorldModelToolExecutionAdapter":
        mode = os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real").strip().lower() or "real"
        base_url = os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
        model_name = os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
        session_id = os.environ.get("WMH_SESSION_ID") or os.environ.get("WORLD_MODEL_SESSION_ID")
        client = WMHHttpClient(base_url) if base_url else None
        return cls(
            mode=mode,
            client=client,
            world_model_name=model_name,
            session_id=session_id,
            agent_id=agent_id,
        )

    def action_for_tool(self, tool_name: str, tool_args: JsonObject, tool_call_id: str) -> CanonicalAction:
        return canonical_action_from_tool_call(
            tool_name,
            tool_args,
            tool_call_id,
            agent_id=self.agent_id,
        )

    def should_simulate(self, tool_name: str) -> bool:
        return self.mode == "simulate" and is_world_model_environment_boundary(tool_name)

    async def execute(
        self,
        tool_name: str,
        tool_args: JsonObject,
        tool_call_id: str,
        real_executor: ToolExecutor,
    ) -> JsonObject:
        if self.mode == "real" or not is_world_model_environment_boundary(tool_name):
            return await real_executor(tool_name, tool_args, tool_call_id)
        if not self.client or not self.world_model_name or not self.session_id:
            raise RuntimeError("WMH simulation requires WMH_BASE_URL, WMH_MODEL_NAME, and WMH_SESSION_ID")
        action = self.action_for_tool(tool_name, tool_args, tool_call_id)
        if self.mode == "simulate":
            started = time.monotonic()
            observation = await self.client.step(self.world_model_name, self.session_id, action)
            wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
            return world_model_observation_to_tool_result(
                observation,
                simulated=True,
                wall_elapsed_ms=wall_elapsed_ms,
            )
        real_result = await real_executor(tool_name, tool_args, tool_call_id)
        started = time.monotonic()
        try:
            observation = await self.client.step(self.world_model_name, self.session_id, action)
        except Exception as exc:
            observation = {"error": str(exc)[:300], "is_error": True}
        wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
        if isinstance(real_result, dict):
            real_result.setdefault("world_model_shadow", observation)
            real_result.setdefault("world_model_shadow_wall_elapsed_ms", wall_elapsed_ms)
        return real_result


def _coerce_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        if value < 0:
            return None
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = float(stripped)
        except ValueError:
            return None
        if parsed < 0:
            return None
        return int(parsed)
    return None


def predicted_latency_ms_from_observation(observation: JsonObject) -> int | None:
    """Extract the WMH-predicted action duration from common envelope fields."""

    for source in (observation, observation.get("metadata") if isinstance(observation.get("metadata"), dict) else {}):
        for key in ("predicted_latency_ms", "sim_latency_ms", "latency_ms", "duration_ms", "elapsed_ms"):
            coerced = _coerce_non_negative_int(source.get(key))
            if coerced is not None:
                return coerced
    return None


def world_model_observation_to_tool_result(
    observation: JsonObject,
    *,
    simulated: bool,
    wall_elapsed_ms: int | None = None,
) -> JsonObject:
    is_error = bool(observation.get("is_error") or observation.get("error"))
    content = observation.get("content")
    if not isinstance(content, str):
        content = json.dumps(observation, ensure_ascii=False, sort_keys=True)
    predicted_latency_ms = predicted_latency_ms_from_observation(observation)
    payload = _observation_tool_result_payload(observation)
    if isinstance(payload, dict):
        result = dict(payload)
        result.setdefault("success", not is_error)
        result.setdefault("message", content)
        result.setdefault("world_model_observation", observation)
    else:
        result = {
            "success": not is_error,
            "message": content,
            "result": observation,
        }
    if is_error:
        result["error"] = True
    if simulated:
        result["world_model_simulated"] = True
    if predicted_latency_ms is not None:
        result["predicted_latency_ms"] = predicted_latency_ms
    if wall_elapsed_ms is not None:
        result["world_model_wall_elapsed_ms"] = max(0, int(wall_elapsed_ms))
        result["simulated_elapsed_ms"] = max(0, int(wall_elapsed_ms)) + (predicted_latency_ms or 0)
    return result


def _observation_tool_result_payload(observation: JsonObject) -> Any:
    metadata = observation.get("metadata")
    candidates = [
        observation.get("tool_result"),
        observation.get("result"),
        metadata.get("tool_result") if isinstance(metadata, dict) else None,
        metadata.get("result") if isinstance(metadata, dict) else None,
    ]
    for candidate in candidates:
        if candidate is not None:
            return candidate
    return None


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
