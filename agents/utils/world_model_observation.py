"""Pure WMH receipt decoding shared by the caller and both simulator processes.

Prediction -> known outer envelope -> canonical observation -> original tool receipt
"""

from __future__ import annotations

import json
import math
from typing import Any

JsonObject = dict[str, Any]


def _coerce_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        # NaN/Infinity decode from open WMH JSON; int() would raise on them.
        if isinstance(value, float) and not math.isfinite(value):
            return None
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
        if not math.isfinite(parsed) or parsed < 0:
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


def _world_model_content_payload(content: Any) -> Any:
    if not isinstance(content, str) or "{" not in content:
        return None
    try:
        payload, _ = json.JSONDecoder().raw_decode(content[content.index("{") :])
    except json.JSONDecodeError:
        return None
    return payload


def _observation_metadata(observation: JsonObject) -> JsonObject:
    # The observation is an open WMH record; a non-object metadata field is ignored.
    metadata = observation.get("metadata")
    return dict(metadata) if isinstance(metadata, dict) else {}


def normalize_world_model_observation(observation: JsonObject, *, canonical: bool = False) -> JsonObject:
    """Decode WMH's output envelope; optionally expose canonical fidelity fields."""
    payload = _world_model_content_payload(observation.get("content"))
    if isinstance(payload, dict) and set(payload).issubset({"output", "is_error", "state_note"}):
        output = payload.get("output")
        if isinstance(output, (str, dict, list)):
            metadata = _observation_metadata(observation)
            if isinstance(payload.get("state_note"), str) and payload["state_note"].strip():
                metadata["state_note"] = payload["state_note"]
            observation = {
                **observation,
                "content": output
                if isinstance(output, str)
                else json.dumps(output, ensure_ascii=False, sort_keys=True),
                "is_error": bool(observation.get("is_error")) or payload.get("is_error") is True,
                "metadata": metadata,
            }
            payload = _world_model_content_payload(observation.get("content"))
    if not canonical:
        return observation
    try:
        payload = json.loads(observation.get("content", ""))
    except (ValueError, TypeError):
        payload = None
    if (
        isinstance(payload, dict)
        and payload.get("schema") == "rose.canonical_observation.v1"
        and isinstance(payload.get("content"), str)
    ):
        metadata = _observation_metadata(observation)
        if isinstance(payload.get("metadata"), dict):
            metadata.update(payload["metadata"])
        return {
            **observation,
            "content": payload["content"],
            "is_error": bool(observation.get("is_error")) or payload.get("is_error") is True,
            "metadata": metadata,
            "artifact_refs": payload.get("artifact_refs", observation.get("artifact_refs", [])),
        }
    return observation


def world_model_observation_to_tool_result(
    observation: JsonObject,
    *,
    simulated: bool,
    wall_elapsed_ms: int | None = None,
) -> JsonObject:
    original_observation = observation
    observation = normalize_world_model_observation(observation)
    is_error = bool(observation.get("is_error") or observation.get("error"))
    content = observation.get("content")
    if not isinstance(content, str):
        content = json.dumps(observation, ensure_ascii=False, sort_keys=True)
    predicted_latency_ms = predicted_latency_ms_from_observation(observation)
    payload = _observation_tool_result_payload(observation)
    payload, content, is_error = _unwrap_training_envelope(payload, content, is_error)
    if isinstance(payload, dict):
        result = dict(payload)
        if is_error:
            result["success"] = False
        else:
            result.setdefault("success", True)
        result.setdefault("message", content)
        result.setdefault("world_model_observation", original_observation)
    else:
        result = {
            "success": not is_error,
            "message": content,
            "result": observation,
        }
    if is_error:
        # Keep provider error payloads textual.  Several workflow handlers pass
        # ``result["error"]`` straight into a typed ``post_agent_message``
        # activity; replacing a model-provided error code/message with the
        # boolean ``True`` makes Temporal reject that later activity argument.
        # The observation envelope already carries ``is_error`` for callers
        # that need a boolean failure flag.
        error = result.get("error")
        if not isinstance(error, str) or not error.strip():
            message = result.get("message")
            result["error"] = (
                message
                if isinstance(message, str) and message.strip()
                else content or "World-model environment action failed"
            )
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
    # The real WMH server serializes its generated environment result into
    # Observation.content.  Test doubles historically put tool_result directly
    # on the envelope, which hid this production integration gap.  Decode only
    # object-shaped JSON so ordinary text observations retain their old shape.
    content = observation.get("content")
    if isinstance(content, str) and content.strip():
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, dict):
            return decoded
    return None


def _unwrap_training_envelope(payload, content, is_error):
    if isinstance(payload, dict) and isinstance(payload.get("output"), str):
        try:
            nested = json.loads(payload["output"])
        except json.JSONDecodeError:
            nested = None
        if isinstance(nested, dict) and nested.get("schema") == "rose.canonical_observation.v1":
            is_error = is_error or payload.get("is_error") is True
            payload = nested
    if isinstance(payload, dict) and payload.get("schema") == "rose.canonical_observation.v1":
        # The offline corpus stores production results inside an OTel training
        # envelope. The live caller needs the inner result, not that envelope.
        is_error = is_error or payload.get("is_error") is True
        inner = payload.get("content")
        if isinstance(inner, str):
            content = inner
            try:
                inner = json.loads(inner)
            except json.JSONDecodeError:
                pass
        payload = inner if isinstance(inner, dict) else {"result": inner}
    return payload, content, is_error


def effective_world_model_content(content: str) -> str:
    """Decode the same known envelopes the live caller removes before displaying output."""
    observation = normalize_world_model_observation({"content": content, "is_error": False})
    payload = _observation_tool_result_payload(observation)
    _, decoded, _ = _unwrap_training_envelope(payload, observation["content"], False)
    return decoded
