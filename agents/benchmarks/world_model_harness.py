"""World Model Harness integration helpers for archived Rose trajectories.

The archive writer owns durability and encryption. This module is the read-side
bridge from a trace bundle to WMH's OpenTelemetry GenAI ingestion format:

  archive bundle -> canonical Rose transitions -> OTel GenAI JSONL -> WMH ingest/build

It deliberately keeps WMH-specific data in standard `gen_ai.*` attributes plus
WMH's documented `wmh.state.*`/`wmh.trace.metadata` enrichments so upstream
`world-model-harness` can ingest the output without a Rose-specific fork.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Optional

import httpx

from helpers.trace_archive import (
    decrypt_and_validate_artifact,
    read_archive_artifact,
)
from helpers.trace_archive import (
    list_archive_artifact_paths as list_backend_archive_artifact_paths,
)
from helpers.trace_archive import (
    list_archive_bundle_ids as list_backend_archive_bundle_ids,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_ARCHIVE_ROOT = _REPO_ROOT / ".context" / "trace-archive"
_WMH_REFERENCE_ROOT = _REPO_ROOT / ".context" / "reference" / "world-model-harness"
_DEFAULT_WMH_BUILD_ROOT = _REPO_ROOT / ".context" / "world-model"

_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|"
    r"compute_token_used|claude_token_error|gpt_token_error)",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|"
    r"[A-Za-z0-9+/]{32,}={0,2})"
)
_HIGH_CONFIDENCE_SECRET_VALUE_RE = re.compile(r"(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)")


JsonObject = dict[str, Any]
ProgressCallback = Callable[[JsonObject], None]
_FIDELITY_DIMENSIONS = (
    "schema_validity",
    "content_accuracy",
    "state_transition_correctness",
    "error_behavior",
    "artifact_refs",
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


@dataclass
class CanonicalObservation:
    """Rose observation schema carried in WMH Observation.content/metadata."""

    category: str
    content: str
    is_error: bool = False
    metadata: JsonObject = field(default_factory=dict)
    artifact_refs: list[str] = field(default_factory=list)
    timestamp_ms: Optional[int] = None

    def to_output_text(self) -> str:
        payload: JsonObject = {
            "schema": "rose.canonical_observation.v1",
            "category": self.category,
            "content": self.content,
            "is_error": self.is_error,
            "metadata": self.metadata,
        }
        if self.artifact_refs:
            payload["artifact_refs"] = self.artifact_refs
        if self.timestamp_ms is not None:
            payload["timestamp_ms"] = self.timestamp_ms
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)


@dataclass
class RoseTransition:
    """One `(state_before, action) -> observation` transition."""

    state_before: JsonObject
    scratchpad: str
    action: CanonicalAction
    observation: CanonicalObservation
    raw_span_ids: list[str] = field(default_factory=list)


ToolExecutor = Callable[[str, JsonObject, str], Awaitable[JsonObject]]


@dataclass
class FidelityStepScore:
    trace_id: str
    step_index: int
    action: str
    score: float
    dimensions: dict[str, float]
    actual: str
    predicted: str
    critique: str = ""

    def to_dict(self) -> JsonObject:
        return {
            "trace_id": self.trace_id,
            "step_index": self.step_index,
            "action": self.action,
            "score": self.score,
            "dimensions": self.dimensions,
            "actual": self.actual,
            "predicted": self.predicted,
            "critique": self.critique,
        }


def wmh_reference_available() -> bool:
    return (_WMH_REFERENCE_ROOT / "wmh" / "ingest" / "otel_genai.py").exists()


def list_archive_bundle_ids(root: Path | None = None) -> list[str]:
    if root is None:
        return list_backend_archive_bundle_ids()
    archive_root = root
    if not archive_root.exists():
        return []
    return sorted(p.name for p in archive_root.iterdir() if p.is_dir())


def read_archive_json(root_agent_id: str, path: str) -> JsonObject:
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        raise FileNotFoundError(f"archive artifact not found: {root_agent_id}/{path}")
    plaintext = decrypt_and_validate_artifact(*stored)
    value = json.loads(plaintext.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"archive artifact {path} is not a JSON object")
    return value


# Shadow runs execute real provider calls, so their observations are real signal.
_REAL_WORLD_MODEL_MODES = {"real", "shadow"}


def bundle_world_model_mode(root_agent_id: str) -> str:
    """World-model mode recorded in a bundle's manifest.

    Legacy bundles predate the marker and were real runs, so a missing field
    reads as "real". An unreadable manifest reads as "unknown" — such bundles
    can't be trusted for corpus grounding either way.
    """
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except Exception:
        return "unknown"
    mode = manifest.get("world_model_mode")
    if not isinstance(mode, str) or not mode.strip():
        return "real"
    return mode.strip().lower()


def partition_real_world_bundles(bundle_ids: list[str]) -> tuple[list[str], dict[str, str]]:
    """Split bundles into real-interaction bundles vs excluded (simulated/unknown).

    Simulated trajectories contain world-model-emulated observations; feeding
    them back into the corpus the world model grounds on would be self-training
    on its own outputs.
    """
    real: list[str] = []
    excluded: dict[str, str] = {}
    for root_agent_id in bundle_ids:
        mode = bundle_world_model_mode(root_agent_id)
        if mode in _REAL_WORLD_MODEL_MODES:
            real.append(root_agent_id)
        else:
            excluded[root_agent_id] = mode
    return real, excluded


def archive_artifact_paths(root_agent_id: str, root: Path | None = None) -> list[str]:
    if root is None:
        return list_backend_archive_artifact_paths(root_agent_id)
    archive_root = root
    bundle = archive_root / root_agent_id
    if not bundle.exists():
        return []
    paths: list[str] = []
    for item in bundle.rglob("*"):
        if not item.is_file() or item.name.endswith(".meta.json"):
            continue
        paths.append(item.relative_to(bundle).as_posix())
    return sorted(paths)


def bundle_agent_ids(root_agent_id: str) -> list[str]:
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except FileNotFoundError:
        return [root_agent_id]
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    correlations = manifest.get("correlations") if isinstance(manifest.get("correlations"), dict) else {}
    agent_ids = correlations.get("agent_ids") or run.get("agent_ids")
    if not isinstance(agent_ids, list):
        return [root_agent_id]
    ordered = [root_agent_id]
    for agent_id in agent_ids:
        if isinstance(agent_id, str) and agent_id not in ordered:
            ordered.append(agent_id)
    return ordered


def archive_artifact_paths_for_tree(root_agent_id: str) -> list[str]:
    paths: list[str] = []
    for agent_id in bundle_agent_ids(root_agent_id):
        for artifact_path in archive_artifact_paths(agent_id):
            if agent_id == root_agent_id:
                paths.append(artifact_path)
            else:
                paths.append(f"{agent_id}/{artifact_path}")
    return sorted(paths)


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


def public_json_has_secret(value: Any) -> bool:
    encoded = json.dumps(value, ensure_ascii=False, default=str)
    if "[REDACTED]" in encoded:
        encoded = encoded.replace("[REDACTED]", "")
    if _HIGH_CONFIDENCE_SECRET_VALUE_RE.search(encoded):
        return True
    return any(_SECRET_KEY_RE.search(key) for key in _json_keys(value))


def _json_keys(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, inner in value.items():
            yield str(key)
            yield from _json_keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from _json_keys(inner)


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


def _stable_hex(value: str, chars: int) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:chars]


def _timestamp_nano(base_ms: int | None, offset: int) -> str:
    ms = base_ms if base_ms is not None else int(time.time() * 1000)
    return str((ms * 1_000_000) + offset)


def _otel_attr(key: str, value: Any) -> JsonObject:
    if isinstance(value, bool):
        encoded: JsonObject = {"boolValue": value}
    elif isinstance(value, int):
        encoded = {"intValue": str(value)}
    elif isinstance(value, float):
        encoded = {"doubleValue": value}
    else:
        encoded = {"stringValue": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}
    return {"key": key, "value": encoded}


def _fixture_ref(root_agent_id: str, path: str) -> JsonObject | None:
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        return None
    _, metadata = stored
    return {
        "path": path,
        "plaintext_sha256": metadata.get("plaintext_sha256"),
        "plaintext_bytes": metadata.get("plaintext_bytes"),
    }


def _artifact_meta_ref(root_agent_id: str, path: str) -> JsonObject | None:
    stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
    if stored is None:
        return None
    _, metadata = stored
    return {
        "path": path,
        "category": _artifact_category(path, metadata.get("content_type")),
        "content_type": metadata.get("content_type"),
        "compression": metadata.get("compression"),
        "plaintext_sha256": metadata.get("plaintext_sha256"),
        "plaintext_bytes": metadata.get("plaintext_bytes"),
    }


def _artifact_category(path: str, content_type: Any = None) -> str:
    content = str(content_type or "")
    lower = path.lower()
    if content.startswith(("image/", "video/", "audio/")) or lower.endswith(
        (
            ".jpg.enc",
            ".jpeg.enc",
            ".png.enc",
            ".gif.enc",
            ".webp.enc",
            ".mp4.enc",
            ".m4a.enc",
            ".mp3.enc",
            ".wav.enc",
            ".m3u8.enc",
        )
    ):
        return "media"
    if lower.startswith("provider/") or "/provider/" in lower or "vapi" in lower:
        return "provider"
    if lower.startswith("browser/") or "/browser/" in lower or "dom" in lower or "screenshot" in lower:
        return "browser"
    if lower.startswith("db/"):
        return "db_fixture"
    return "artifact"


def _json_ref_paths(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, inner in value.items():
            key_text = str(key)
            if key_text.endswith("_ref") and isinstance(inner, str):
                refs.append(inner)
            elif key_text.endswith("_refs") and isinstance(inner, list):
                refs.extend(item for item in inner if isinstance(item, str))
            refs.extend(_json_ref_paths(inner))
    elif isinstance(value, list):
        for inner in value:
            refs.extend(_json_ref_paths(inner))
    return sorted(dict.fromkeys(refs))


def _initial_trace_state(root_agent_id: str, redaction_mode: str) -> JsonObject:
    try:
        payload = read_archive_json(root_agent_id, "trace/transitions.json.gz.enc")
    except FileNotFoundError:
        return {}
    raw_transitions = payload.get("transitions")
    if not isinstance(raw_transitions, list) or not raw_transitions:
        return {}
    first = raw_transitions[0]
    if not isinstance(first, dict):
        return {}
    state_before = first.get("state_before")
    return _maybe_redact(state_before, redaction_mode) if isinstance(state_before, dict) else {}


def reconstruct_initial_state(root_agent_id: str, *, redaction_mode: str = "public") -> JsonObject:
    start = read_archive_json(root_agent_id, "db/start.fixture.json.gz.enc")
    rows = start.get("rows") if isinstance(start.get("rows"), dict) else {}
    row_counts = {table: len(values) for table, values in rows.items() if isinstance(values, list)}
    root_agent_rows = rows.get("Agent") if isinstance(rows, dict) else []
    root_goal = None
    if isinstance(root_agent_rows, list):
        for row in root_agent_rows:
            if isinstance(row, dict) and row.get("id") == root_agent_id:
                root_goal = row.get("goal")
                break
    initial_trace_state = _initial_trace_state(root_agent_id, redaction_mode)
    refs = ["db/start.fixture.json.gz.enc", *_json_ref_paths(initial_trace_state)]
    artifact_refs = [ref for ref in (_artifact_meta_ref(root_agent_id, path) for path in refs) if ref is not None]
    state = {
        "schema": "rose.initial_state.v1",
        "root_agent_id": root_agent_id,
        "user_id": start.get("user_id"),
        "base_image": start.get("base_image"),
        "agent_ids": start.get("agent_ids", []),
        "root_goal": root_goal,
        "db_fixture_ref": _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc"),
        "db_fixture": {
            "restore": start.get("restore") if isinstance(start.get("restore"), dict) else {},
            "rows": rows,
        },
        "row_counts": row_counts,
        "state_before_first_action": initial_trace_state,
        "artifact_refs": artifact_refs,
        "provider_artifacts": [ref for ref in artifact_refs if ref.get("category") == "provider"],
        "media_artifacts": [ref for ref in artifact_refs if ref.get("category") == "media"],
    }
    return _maybe_redact(state, redaction_mode)


def _transition_from_raw(raw: JsonObject, root_agent_id: str, redaction_mode: str) -> RoseTransition:
    action_raw = raw.get("action") if isinstance(raw.get("action"), dict) else {}
    observation_raw = raw.get("observation") if isinstance(raw.get("observation"), dict) else {}
    state_raw = raw.get("state_before") if isinstance(raw.get("state_before"), dict) else {}
    action = CanonicalAction(
        category=str(action_raw.get("category") or "tool"),
        name=str(action_raw.get("name") or action_raw.get("tool_name") or "unknown"),
        arguments=_maybe_redact(action_raw.get("arguments") or {}, redaction_mode),
        agent_id=str(action_raw.get("agent_id") or root_agent_id),
        span_id=str(action_raw.get("span_id") or raw.get("span_id") or ""),
        tool_call_id=str(action_raw.get("tool_call_id") or ""),
        artifact_refs=list(action_raw.get("artifact_refs") or []),
        timestamp_ms=action_raw.get("timestamp_ms") if isinstance(action_raw.get("timestamp_ms"), int) else None,
    )
    observation = CanonicalObservation(
        category=str(observation_raw.get("category") or action.category),
        content=str(_maybe_redact(observation_raw.get("content") or "", redaction_mode)),
        is_error=bool(observation_raw.get("is_error")),
        metadata=_maybe_redact(observation_raw.get("metadata") or {}, redaction_mode),
        artifact_refs=list(observation_raw.get("artifact_refs") or []),
        timestamp_ms=observation_raw.get("timestamp_ms")
        if isinstance(observation_raw.get("timestamp_ms"), int)
        else None,
    )
    return RoseTransition(
        state_before=_maybe_redact(state_raw, redaction_mode),
        scratchpad=str(raw.get("scratchpad") or ""),
        action=action,
        observation=observation,
        raw_span_ids=[str(v) for v in raw.get("raw_span_ids") or []],
    )


def _is_fast_cache_replay_transition(raw: JsonObject) -> bool:
    """A transition whose observation was replayed from the fast cache.

    The fresh write that populated the cache is the original signal and is
    already in the corpus from the run that recorded it; replays are
    low-signal duplicates and must not re-enter the RAG.
    """
    if raw.get("from_fast_cache") is True:
        return True
    observation = raw.get("observation")
    if isinstance(observation, dict):
        metadata = observation.get("metadata")
        if isinstance(metadata, dict) and metadata.get("from_fast_cache") is True:
            return True
    return False


def _transitions_from_trace_artifact(root_agent_id: str, redaction_mode: str) -> list[RoseTransition]:
    try:
        payload = read_archive_json(root_agent_id, "trace/transitions.json.gz.enc")
    except FileNotFoundError:
        return []
    raw_transitions = payload.get("transitions")
    if not isinstance(raw_transitions, list):
        raise ValueError("trace/transitions.json.gz.enc must contain a transitions array")
    raw_dicts = [raw for raw in raw_transitions if isinstance(raw, dict)]
    replay_count = sum(1 for raw in raw_dicts if _is_fast_cache_replay_transition(raw))
    if replay_count:
        print(
            f"[WorldModel] Dropped {replay_count} fast-cache replay transition(s) from "
            f"{root_agent_id} (corpus keeps fresh interactions only)",
            flush=True,
        )
    return [
        _transition_from_raw(raw, root_agent_id, redaction_mode)
        for raw in raw_dicts
        if not _is_fast_cache_replay_transition(raw)
    ]


def _latest_update_by_dump_id(archive_agent_id: str) -> dict[str, JsonObject]:
    updates: dict[str, JsonObject] = {}
    for path in archive_artifact_paths(archive_agent_id):
        if not path.startswith("llm-updates/") or not path.endswith(".json.gz.enc"):
            continue
        payload = read_archive_json(archive_agent_id, path)
        dump_id = payload.get("dump_id")
        if isinstance(dump_id, str):
            updates[dump_id] = payload
    return updates


def _transitions_from_llm_dumps(
    root_agent_id: str,
    redaction_mode: str,
    initial_state: JsonObject,
) -> list[RoseTransition]:
    transitions: list[RoseTransition] = []
    replay_dump_count = 0
    for archive_agent_id in bundle_agent_ids(root_agent_id):
        updates = _latest_update_by_dump_id(archive_agent_id)
        for path in archive_artifact_paths(archive_agent_id):
            if not path.startswith("llm/") or not path.endswith(".json.gz.enc"):
                continue
            artifact_ref = path if archive_agent_id == root_agent_id else f"{archive_agent_id}/{path}"
            base = read_archive_json(archive_agent_id, path)
            base_payload = (
                base.get("payload")
                if base.get("kind") == "legacy-llm-dump" and isinstance(base.get("payload"), dict)
                else base
            )
            payload = updates.get(str(base_payload.get("dump_id")), base_payload)
            output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
            usage = output.get("usage") if isinstance(output.get("usage"), dict) else {}
            if usage.get("from_fast_cache"):
                # Replayed responses duplicate a fresh interaction already in the
                # corpus (the run that wrote the cache entry). Replays normally
                # never produce dumps at all — this guards the invariant if a
                # future refactor starts dumping them.
                replay_dump_count += 1
                continue
            tool_calls = output.get("tool_calls") if isinstance(output.get("tool_calls"), list) else []
            if not tool_calls:
                content = str(output.get("content") or "")
                if not content:
                    continue
                tool_calls = [{"name": "assistant_message", "arguments": {"content": content}, "id": ""}]
            for index, call in enumerate(tool_calls):
                if not isinstance(call, dict):
                    continue
                raw_args = call.get("arguments")
                if isinstance(raw_args, str):
                    try:
                        args: Any = json.loads(raw_args) if raw_args.strip() else {}
                    except json.JSONDecodeError:
                        args = {"value": raw_args}
                else:
                    args = raw_args or {}
                if not isinstance(args, dict):
                    args = {"value": args}
                timestamp_ms = None
                metadata = (
                    payload.get("archive", {}).get("metadata") if isinstance(payload.get("archive"), dict) else {}
                )
                if isinstance(metadata, dict) and isinstance(metadata.get("created_at_ms"), int):
                    timestamp_ms = metadata["created_at_ms"] + index
                action = CanonicalAction(
                    category="llm_tool_call",
                    name=str(call.get("name") or "unknown"),
                    arguments=_maybe_redact(args, redaction_mode),
                    agent_id=str(payload.get("agent_id") or archive_agent_id),
                    span_id=str(payload.get("span_id") or ""),
                    tool_call_id=str(call.get("id") or ""),
                    artifact_refs=[artifact_ref],
                    timestamp_ms=timestamp_ms,
                )
                observation = CanonicalObservation(
                    category="tool_result",
                    content="",
                    metadata={
                        "source": "llm_dump",
                        "dump_id": payload.get("dump_id"),
                        "call_site": payload.get("call_site"),
                        "model": payload.get("model"),
                        "result_unavailable": True,
                    },
                    artifact_refs=[artifact_ref],
                    timestamp_ms=timestamp_ms,
                )
                transitions.append(
                    RoseTransition(
                        state_before=initial_state,
                        scratchpad="",
                        action=action,
                        observation=observation,
                        raw_span_ids=[str(payload.get("span_id") or "")],
                    )
                )
    if replay_dump_count:
        print(
            f"[WorldModel] Dropped {replay_dump_count} fast-cache replay LLM dump(s) from "
            f"{root_agent_id} (corpus keeps fresh interactions only)",
            flush=True,
        )
    return transitions


def load_transitions(root_agent_id: str, *, redaction_mode: str = "public") -> list[RoseTransition]:
    initial_state = reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    transitions = _transitions_from_trace_artifact(root_agent_id, redaction_mode)
    if transitions:
        return transitions
    return _transitions_from_llm_dumps(root_agent_id, redaction_mode, initial_state)


def _span_status(is_error: bool) -> JsonObject:
    return {"code": "STATUS_CODE_ERROR" if is_error else "STATUS_CODE_OK"}


def write_eval_suite(
    output_dir: str | Path,
    *,
    trace_file: str | Path,
    title: str = "Rose archived trajectory replay",
    train_split: float = 0.7,
    sample_turns: str = "all",
    seed: int = 0,
    judge: str = "rubric",
) -> Path:
    """Write a WMH-style eval suite TOML next to an exported trace file."""

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_path = Path(trace_file)
    rel_trace = os.path.relpath(trace_path, out_dir)
    content = "\n".join(
        [
            f'title = "{_toml_escape(title)}"',
            'description = "Open-loop reconstruction fidelity over Rose archived trajectories."',
            f'files = ["{_toml_escape(rel_trace)}"]',
            f"train_split = {train_split}",
            f'sample_turns = "{_toml_escape(sample_turns)}"',
            f"seed = {seed}",
            f'judge = "{_toml_escape(judge)}"',
            "",
        ]
    )
    target = out_dir / "default.toml"
    target.write_text(content, encoding="utf-8")
    return target


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def provider_abstraction_decision() -> JsonObject:
    """Document the WMH provider boundary used by Rose integration code."""

    return {
        "schema": "rose.wmh_provider_abstraction.v1",
        "route": os.environ.get("ROSE_WMH_PROVIDER_ROUTE", "upstream"),
        "default": "upstream",
        "upstream_providers": ["anthropic", "bedrock", "azure", "openai", "openai_responses"],
        "rose_role": "trace_provenance_costs_and_attempt_trails",
    }


def _emit_progress(progress: ProgressCallback | None, title: str, status: str, **metadata: Any) -> None:
    event: JsonObject = {
        "title": title,
        "status": status,
        "metadata": {key: value for key, value in metadata.items() if value is not None},
    }
    if progress:
        progress(event)


def _read_delta_index(index_path: Path) -> JsonObject:
    if not index_path.exists():
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    try:
        value = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    if not isinstance(value, dict):
        return {"schema": "rose.wmh_delta_index.v1", "bundles": {}}
    bundles = value.get("bundles")
    if not isinstance(bundles, dict):
        value["bundles"] = {}
    value.setdefault("schema", "rose.wmh_delta_index.v1")
    return value


def _write_delta_index(index_path: Path, index: JsonObject) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix(index_path.suffix + ".tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(index_path)


def _bundle_signature(root_agent_id: str) -> JsonObject:
    # Archive listings also contain intentionally plaintext public projections
    # (for example manifest.public.json). Only encrypted artifacts participate
    # in this signature and therefore carry the metadata read below.
    paths = [path for path in archive_artifact_paths(root_agent_id) if path.endswith(".enc")]
    artifacts: list[JsonObject] = []
    plaintext_bytes = 0
    ciphertext_bytes = 0
    for path in paths:
        stored = read_archive_artifact(root_agent_id=root_agent_id, path=path)
        if stored is None:
            continue
        _, metadata = stored
        plain_bytes = int(metadata.get("plaintext_bytes") or 0)
        cipher_bytes = int(metadata.get("ciphertext_bytes") or 0)
        plaintext_bytes += plain_bytes
        ciphertext_bytes += cipher_bytes
        artifacts.append(
            {
                "path": path,
                "plaintext_sha256": metadata.get("plaintext_sha256"),
                "plaintext_bytes": plain_bytes,
            }
        )
    digest_source = json.dumps(artifacts, sort_keys=True, separators=(",", ":"))
    return {
        "root_agent_id": root_agent_id,
        "artifact_count": len(artifacts),
        "plaintext_bytes": plaintext_bytes,
        "ciphertext_bytes": ciphertext_bytes,
        "sha256": hashlib.sha256(digest_source.encode("utf-8")).hexdigest(),
    }


def _ensure_wmh_importable() -> None:
    if _WMH_REFERENCE_ROOT.exists():
        reference = str(_WMH_REFERENCE_ROOT)
        if reference not in sys.path:
            sys.path.insert(0, reference)


def build_world_model_from_archives(
    root_agent_ids: Iterable[str],
    output_dir: str | Path,
    *,
    name: str = "rose-archive",
    provider: str = "anthropic",
    model: str = "claude-opus-4-8",
    judge_model: str | None = None,
    gepa_budget: int = 10,
    train_split: float = 0.8,
    embed_dim: int = 512,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
) -> JsonObject:
    """Export archives to OTel JSONL and build a WMH model through upstream WMH."""

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_file = out_dir / "traces.otel.jsonl"
    real_bundle_ids, excluded_bundles = partition_real_world_bundles(list(root_agent_ids))
    if excluded_bundles:
        print(
            f"[WorldModel] Excluded {len(excluded_bundles)} non-real bundle(s) from corpus build "
            f"(modes: {sorted(set(excluded_bundles.values()))})",
            flush=True,
        )
    with trace_file.open("w", encoding="utf-8") as combined:
        for root_agent_id in real_bundle_ids:
            per_trace = out_dir / f"{root_agent_id}.otel.jsonl"
            export_archive_to_otel_jsonl(root_agent_id, per_trace, redaction_mode="public")
            text = per_trace.read_text(encoding="utf-8")
            if text.strip():
                combined.write(text.rstrip() + "\n")
    return build_world_model_from_otel_jsonl(
        trace_file,
        out_dir,
        name=name,
        provider=provider,
        model=model,
        judge_model=judge_model,
        gepa_budget=gepa_budget,
        train_split=train_split,
        embed_dim=embed_dim,
        upstream_build=upstream_build,
        config_factory=config_factory,
        serve_provider=serve_provider,
        judge_provider=judge_provider,
        embedder=embedder,
    )


def build_world_model_from_otel_jsonl(
    trace_file: str | Path,
    output_dir: str | Path,
    *,
    name: str = "rose-archive",
    provider: str = "anthropic",
    model: str = "claude-opus-4-8",
    judge_model: str | None = None,
    gepa_budget: int = 10,
    train_split: float = 0.8,
    embed_dim: int = 512,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
) -> JsonObject:
    """Build a WMH artifact from OTel JSONL using upstream `wmh.engine.build`.

    Tests can inject `upstream_build` and `config_factory`; production imports the real
    world-model-harness package and lets its GEPA optimizer do prompt evolution.
    """

    _ensure_wmh_importable()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    model_root = out_dir / "models" / name
    if upstream_build is None or config_factory is None:
        try:
            from wmh.config import HarnessConfig
            from wmh.engine.build import build as real_build
            from wmh.providers.base import EmbedderKind, ProviderKind
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "world-model-harness is not importable; install agents/requirements.txt "
                "or keep .context/reference/world-model-harness with its dependencies available"
            ) from exc
        upstream_build = upstream_build or real_build

        def real_config_factory(**kwargs: Any) -> Any:
            return HarnessConfig.for_build(
                serve_provider=ProviderKind(kwargs["provider"]),
                serve_model=kwargs["model"],
                region=os.environ.get("AWS_REGION"),
                embed_provider=EmbedderKind.HASHING,
                embed_model=None,
                embed_dim=kwargs["embed_dim"],
                gepa_budget=kwargs["gepa_budget"],
                train_split=kwargs["train_split"],
                judge_model=kwargs["judge_model"],
            )

        config_factory = config_factory or real_config_factory

    config = config_factory(
        provider=provider,
        model=model,
        judge_model=judge_model,
        gepa_budget=gepa_budget,
        train_split=train_split,
        embed_dim=embed_dim,
    )
    result = upstream_build(
        config,
        file=str(trace_file),
        root=str(model_root),
        serve_provider=serve_provider,
        judge_provider=judge_provider,
        embedder=embedder,
    )
    metrics = getattr(result, "metrics", None)
    if hasattr(metrics, "model_dump"):
        metrics_value = metrics.model_dump()
    elif isinstance(metrics, dict):
        metrics_value = metrics
    else:
        metrics_value = {}
    manifest: JsonObject = {
        "schema": "rose.wmh_build_manifest.v1",
        "name": name,
        "trace_file": str(Path(trace_file)),
        "model_root": str(model_root),
        "gepa_budget": gepa_budget,
        "train_split": train_split,
        "provider": provider,
        "model": model,
        "provider_abstraction": provider_abstraction_decision(),
        "metrics": metrics_value,
    }
    manifest_path = out_dir / "build.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def refresh_world_model_index(
    trace_file: str | Path,
    model_root: str | Path,
    *,
    embed_dim: int = 512,
) -> JsonObject:
    """Re-index the serving retriever from the aggregate trace file, keeping the built prompt.

    This is the cheap half of a WMH build: ingest + embed (offline HashingEmbedder, no LLM
    calls) + persist the retrieval index. The GEPA-optimized env prompt, config, and metrics
    under `model_root` are left untouched, so new gold traces become retrievable demos without
    paying for prompt re-evolution.
    """

    _ensure_wmh_importable()
    try:
        # Import the adapter class directly (not via get_adapter) so this works even when
        # wmh.ingest was partially loaded without its registration side effects.
        from wmh.ingest.otel_genai import OtelGenAIAdapter
        from wmh.retrieval import EmbeddingRetriever, HashingEmbedder
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "world-model-harness is not importable; install agents/requirements.txt "
            "or keep .context/reference/world-model-harness with its dependencies available"
        ) from exc

    traces = OtelGenAIAdapter().from_file(str(trace_file))
    retriever = EmbeddingRetriever(HashingEmbedder(dim=embed_dim))
    retriever.index(traces)
    index_path = Path(model_root) / "index"
    retriever.save(index_path)
    return {
        "indexed_traces": len(traces),
        "indexed_steps": sum(len(trace.steps) for trace in traces),
        "index_path": str(index_path),
    }


def transitions_to_otel_spans(
    root_agent_id: str,
    transitions: Iterable[RoseTransition],
    *,
    task: str | None = None,
    metadata: JsonObject | None = None,
) -> list[JsonObject]:
    trace_id = _stable_hex(root_agent_id, 32)
    trace_metadata = {
        "schema": "rose.wmh_trace_metadata.v1",
        "root_agent_id": root_agent_id,
        **(metadata or {}),
    }
    if task:
        trace_metadata["task"] = task

    spans: list[JsonObject] = []
    for index, transition in enumerate(transitions):
        action_id = _stable_hex(f"{root_agent_id}:{index}:action:{transition.action.tool_call_id}", 16)
        obs_id = _stable_hex(f"{root_agent_id}:{index}:observation:{transition.action.tool_call_id}", 16)
        base_ms = transition.action.timestamp_ms or transition.observation.timestamp_ms
        action_attrs = [
            _otel_attr("gen_ai.operation.name", "chat"),
            _otel_attr("gen_ai.tool.name", transition.action.to_wmh_tool_name()),
            _otel_attr("gen_ai.tool.call.arguments", transition.action.to_arguments()),
            _otel_attr("gen_ai.prompt", task or ""),
            _otel_attr("wmh.state.structured", transition.state_before),
            _otel_attr("wmh.state.scratchpad", transition.scratchpad),
            _otel_attr("wmh.trace.metadata", trace_metadata),
            _otel_attr("rose.root_agent_id", root_agent_id),
        ]
        obs_attrs = [
            _otel_attr("gen_ai.operation.name", "execute_tool"),
            _otel_attr("gen_ai.tool.name", transition.action.to_wmh_tool_name()),
            _otel_attr("gen_ai.tool.output", transition.observation.to_output_text()),
            _otel_attr("wmh.trace.metadata", trace_metadata),
            _otel_attr("rose.root_agent_id", root_agent_id),
        ]
        if transition.action.agent_id:
            action_attrs.append(_otel_attr("rose.agent_id", transition.action.agent_id))
            obs_attrs.append(_otel_attr("rose.agent_id", transition.action.agent_id))
        if transition.action.span_id:
            action_attrs.append(_otel_attr("rose.span_id", transition.action.span_id))
        if transition.action.tool_call_id:
            action_attrs.append(_otel_attr("rose.tool_call_id", transition.action.tool_call_id))
            obs_attrs.append(_otel_attr("rose.tool_call_id", transition.action.tool_call_id))
        spans.append(
            {
                "traceId": trace_id,
                "spanId": action_id,
                "name": f"chat {transition.action.to_wmh_tool_name()}",
                "startTimeUnixNano": _timestamp_nano(base_ms, index * 2),
                "endTimeUnixNano": _timestamp_nano(base_ms, index * 2 + 1),
                "attributes": action_attrs,
                "status": _span_status(False),
            }
        )
        spans.append(
            {
                "traceId": trace_id,
                "spanId": obs_id,
                "parentSpanId": action_id,
                "name": f"execute_tool {transition.action.to_wmh_tool_name()}",
                "startTimeUnixNano": _timestamp_nano(base_ms, index * 2 + 2),
                "endTimeUnixNano": _timestamp_nano(base_ms, index * 2 + 3),
                "attributes": obs_attrs,
                "status": _span_status(transition.observation.is_error),
            }
        )
    return spans


def export_archive_to_otel_jsonl(
    root_agent_id: str,
    output_path: str | Path,
    *,
    task: str | None = None,
    benchmark_task_name: str | None = None,
    redaction_mode: str = "public",
) -> Path:
    manifest: JsonObject = {}
    try:
        manifest = read_archive_json(root_agent_id, "manifest.json.gz.enc")
    except FileNotFoundError:
        pass
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    task_name = benchmark_task_name or manifest.get("benchmark_task_name")
    root_goal = task or run.get("root_goal") or task_name
    transitions = load_transitions(root_agent_id, redaction_mode=redaction_mode)
    spans = transitions_to_otel_spans(
        root_agent_id,
        transitions,
        task=str(root_goal or ""),
        metadata={
            "benchmark_task_name": task_name,
            "db_start_fixture_ref": _fixture_ref(root_agent_id, "db/start.fixture.json.gz.enc"),
            "db_end_fixture_ref": _fixture_ref(root_agent_id, "db/end.fixture.json.gz.enc"),
            "artifact_paths": archive_artifact_paths_for_tree(root_agent_id),
        },
    )
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "\n".join(json.dumps(span, ensure_ascii=False, sort_keys=True) for span in spans) + "\n", encoding="utf-8"
    )
    return out


def score_observation_prediction(
    actual: CanonicalObservation,
    predicted: JsonObject,
) -> tuple[float, dict[str, float], str]:
    """Score one predicted observation on WMH fidelity dimensions.

    This is intentionally deterministic and provider-free. When a real WMH model is configured,
    it grades that model's returned observation. When no model is configured, callers should return
    a disabled/not-configured report rather than pretending fidelity was measured.
    """

    schema_validity = 1.0 if isinstance(predicted.get("content"), str) else 0.0
    predicted_content = str(predicted.get("content") or "")
    predicted_metadata = predicted.get("metadata") if isinstance(predicted.get("metadata"), dict) else {}
    content_accuracy = _token_f1(actual.content, predicted_content)
    actual_note = actual.metadata.get("state_note")
    predicted_note = predicted_metadata.get("state_note")
    if actual_note is None:
        state_transition = 1.0
    else:
        state_transition = _token_f1(str(actual_note), str(predicted_note or ""))
    predicted_is_error = bool(predicted.get("is_error")) if "is_error" in predicted else False
    error_behavior = 1.0 if predicted_is_error == actual.is_error else 0.0
    artifact_refs = _artifact_ref_score(actual, predicted_content, predicted_metadata)
    dimensions = {
        "schema_validity": schema_validity,
        "content_accuracy": content_accuracy,
        "state_transition_correctness": state_transition,
        "error_behavior": error_behavior,
        "artifact_refs": artifact_refs,
    }
    score = sum(dimensions.values()) / len(dimensions)
    critique = "; ".join(f"{name}={value:.2f}" for name, value in dimensions.items() if value < 1.0)
    return score, dimensions, critique


def _token_f1(actual: str, predicted: str) -> float:
    actual_tokens = _tokens(actual)
    predicted_tokens = _tokens(predicted)
    if not actual_tokens and not predicted_tokens:
        return 1.0
    if not actual_tokens or not predicted_tokens:
        return 0.0
    actual_counts: dict[str, int] = {}
    for token in actual_tokens:
        actual_counts[token] = actual_counts.get(token, 0) + 1
    overlap = 0
    for token in predicted_tokens:
        count = actual_counts.get(token, 0)
        if count > 0:
            overlap += 1
            actual_counts[token] = count - 1
    if overlap == 0:
        return 0.0
    precision = overlap / len(predicted_tokens)
    recall = overlap / len(actual_tokens)
    return 2 * precision * recall / (precision + recall)


def _tokens(value: str) -> list[str]:
    return re.findall(r"[a-z0-9_.$:/-]+", value.lower())


def _artifact_ref_score(actual: CanonicalObservation, predicted_content: str, predicted_metadata: JsonObject) -> float:
    refs = set(actual.artifact_refs)
    for key in ("dom_ref", "screenshot_ref", "recording_ref", "provider_ref", "fixture_ref"):
        value = actual.metadata.get(key)
        if isinstance(value, str):
            refs.add(value)
    if not refs:
        return 1.0
    encoded_prediction = f"{predicted_content}\n{json.dumps(predicted_metadata, ensure_ascii=False, sort_keys=True)}"
    matched = sum(1 for ref in refs if ref in encoded_prediction)
    return matched / len(refs)


async def evaluate_archive_with_world_model(
    root_agent_id: str,
    *,
    world_model_name: str | None = None,
    base_url: str | None = None,
    redaction_mode: str = "public",
) -> JsonObject:
    """Replay an archived trajectory through a WMH server and score predictions.

    Returns a JSON-serializable result that can be stored directly in a benchmark run JSON. If no
    WMH server/model is configured, the result is explicit rather than silently skipped.
    """

    wmh_base_url = base_url or os.environ.get("WMH_BASE_URL") or os.environ.get("WORLD_MODEL_HARNESS_URL")
    model_name = world_model_name or os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME")
    enabled = os.environ.get("BENCHMARK_WMH_EVAL", "").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return {"status": "disabled", "reason": "BENCHMARK_WMH_EVAL is not enabled"}
    if not wmh_base_url or not model_name:
        return {"status": "not_configured", "reason": "WMH_BASE_URL and WMH_MODEL_NAME are required"}

    transitions = load_transitions(root_agent_id, redaction_mode=redaction_mode)
    if not transitions:
        return {"status": "no_steps", "reason": "archive contains no transitions"}
    initial_state = reconstruct_initial_state(root_agent_id, redaction_mode=redaction_mode)
    client = WMHHttpClient(wmh_base_url)
    session_id = await client.start_session(
        model_name,
        task=str(initial_state.get("root_goal") or ""),
        seed_state={"structured": initial_state, "scratchpad": ""},
    )
    trace_id = _stable_hex(root_agent_id, 32)
    step_scores: list[FidelityStepScore] = []
    for index, transition in enumerate(transitions):
        predicted = await client.step(model_name, session_id, transition.action)
        score, dimensions, critique = score_observation_prediction(transition.observation, predicted)
        step_scores.append(
            FidelityStepScore(
                trace_id=trace_id,
                step_index=index,
                action=transition.action.to_wmh_tool_name(),
                score=score,
                dimensions=dimensions,
                actual=transition.observation.content,
                predicted=str(predicted.get("content") or ""),
                critique=critique,
            )
        )
    mean_score = sum(step.score for step in step_scores) / len(step_scores)
    dimension_means = {
        name: sum(step.dimensions[name] for step in step_scores) / len(step_scores) for name in _FIDELITY_DIMENSIONS
    }
    result: JsonObject = {
        "status": "scored",
        "world_model": model_name,
        "base_url": wmh_base_url,
        "session_id": session_id,
        "mean_score": mean_score,
        "n_steps": len(step_scores),
        "dimensions": dimension_means,
        "steps": [step.to_dict() for step in step_scores],
    }
    if redaction_mode == "public":
        result = _redact(result)
        if public_json_has_secret(result):
            raise ValueError("WMH fidelity result contains unredacted secret-looking content")
    return result


async def evaluate_archives_with_world_model(
    root_agent_ids: Iterable[str] | None = None,
    *,
    world_model_name: str | None = None,
    base_url: str | None = None,
    redaction_mode: str = "public",
) -> JsonObject:
    """Score every requested local archive bundle and return aggregate fidelity."""

    bundle_ids = list(root_agent_ids) if root_agent_ids is not None else list_archive_bundle_ids()
    results: list[JsonObject] = []
    scored: list[JsonObject] = []
    for root_agent_id in bundle_ids:
        result = await evaluate_archive_with_world_model(
            root_agent_id,
            world_model_name=world_model_name,
            base_url=base_url,
            redaction_mode=redaction_mode,
        )
        result = {"root_agent_id": root_agent_id, **result}
        results.append(result)
        if result.get("status") == "scored":
            scored.append(result)
    aggregate: JsonObject = {
        "schema": "rose.wmh_prediction_batch.v1",
        "status": "scored" if scored else "no_scored_bundles",
        "bundle_count": len(bundle_ids),
        "scored_bundle_count": len(scored),
        "mean_score": None,
        "n_steps": sum(int(item.get("n_steps") or 0) for item in scored),
        "results": results,
    }
    if scored:
        total_steps = sum(int(item.get("n_steps") or 0) for item in scored)
        weighted = sum(float(item.get("mean_score") or 0) * int(item.get("n_steps") or 0) for item in scored)
        aggregate["mean_score"] = weighted / total_steps if total_steps > 0 else None
        dimensions: dict[str, float] = {}
        for name in _FIDELITY_DIMENSIONS:
            numerator = 0.0
            for item in scored:
                item_dimensions = item.get("dimensions") if isinstance(item.get("dimensions"), dict) else {}
                numerator += float(item_dimensions.get(name) or 0) * int(item.get("n_steps") or 0)
            dimensions[name] = numerator / total_steps if total_steps > 0 else 0.0
        aggregate["dimensions"] = dimensions
    if redaction_mode == "public":
        aggregate = _redact(aggregate)
        if public_json_has_secret(aggregate):
            raise ValueError("WMH batch fidelity result contains unredacted secret-looking content")
    return aggregate


def deterministic_split(trace_ids: Iterable[str], *, heldout_fraction: float = 0.2) -> dict[str, str]:
    if heldout_fraction <= 0 or heldout_fraction >= 1:
        raise ValueError("heldout_fraction must be between 0 and 1")
    split: dict[str, str] = {}
    for trace_id in sorted(trace_ids):
        digest = hashlib.blake2b(trace_id.encode("utf-8"), digest_size=8).digest()
        fraction = int.from_bytes(digest, "big") / 2**64
        split[trace_id] = "heldout" if fraction >= (1.0 - heldout_fraction) else "train"
    return split


def build_replay_corpus(
    bundle_ids: Iterable[str], output_dir: str | Path, *, heldout_fraction: float = 0.2
) -> JsonObject:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle_ids = list(bundle_ids)
    split = deterministic_split(bundle_ids, heldout_fraction=heldout_fraction)
    sessions: list[JsonObject] = []
    for root_agent_id in bundle_ids:
        sessions.append(_build_replay_session(root_agent_id, split[root_agent_id]))
    corpus = {"schema": "rose.wmh_replay_corpus.v1", "sessions": sessions}
    (out_dir / "sessions.json").write_text(json.dumps(corpus, indent=2, sort_keys=True), encoding="utf-8")
    return corpus


def _build_replay_session(root_agent_id: str, split: str) -> JsonObject:
    transitions = load_transitions(root_agent_id, redaction_mode="public")
    state = reconstruct_initial_state(root_agent_id, redaction_mode="public")
    keys = []
    for transition in transitions:
        keys.append(
            {
                "task": state.get("root_goal"),
                "state_summary_hash": hashlib.sha256(
                    json.dumps(transition.state_before, sort_keys=True).encode()
                ).hexdigest(),
                "tool_action": transition.action.to_wmh_tool_name(),
                "arguments_hash": hashlib.sha256(
                    json.dumps(transition.action.arguments, sort_keys=True).encode()
                ).hexdigest(),
                "environment_fixture_hash": (state.get("db_fixture_ref") or {}).get("plaintext_sha256"),
                "provider_domain": transition.observation.metadata.get("provider_domain"),
            }
        )
    return {
        "root_agent_id": root_agent_id,
        "split": split,
        "initial_state": state,
        "transition_count": len(transitions),
        "similarity_keys": keys,
    }


def update_world_model_for_simulation(
    *,
    output_dir: str | Path | None = None,
    root_agent_ids: Iterable[str] | None = None,
    name: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    judge_model: str | None = None,
    gepa_budget: int | None = None,
    train_split: float = 0.8,
    heldout_fraction: float = 0.2,
    embed_dim: int = 512,
    force: bool = False,
    progress: ProgressCallback | None = None,
    upstream_build: Callable[..., Any] | None = None,
    config_factory: Callable[..., Any] | None = None,
    serve_provider: Any | None = None,
    judge_provider: Any | None = None,
    embedder: Any | None = None,
    index_refresher: Callable[..., JsonObject] | None = None,
) -> JsonObject:
    """Incrementally update the local WMH corpus/model from archived gold bundles.

    The expensive archive reads and OTel/session exports are delta-based. Changed bundles
    trigger an index-only retriever refresh (offline embedding, zero LLM spend); the full
    upstream GEPA build runs only when no prior build manifest exists or `force=True`.
    """

    started = time.time()
    out_dir = Path(output_dir or os.environ.get("WMH_BUILD_DIR") or _DEFAULT_WMH_BUILD_ROOT)
    name = name or os.environ.get("WMH_MODEL_NAME") or os.environ.get("WORLD_MODEL_NAME") or "rose-archive"
    provider = provider or os.environ.get("WMH_BUILD_PROVIDER") or os.environ.get("WMH_PROVIDER") or "anthropic"
    model = model or os.environ.get("WMH_BUILD_MODEL") or os.environ.get("WMH_SERVE_MODEL") or "claude-opus-4-8"
    if gepa_budget is None:
        gepa_budget = int(os.environ.get("WMH_GEPA_BUDGET", "10"))
    index_path = out_dir / "delta-index.json"
    otel_dir = out_dir / "otel"
    session_dir = out_dir / "sessions"
    aggregate_trace_file = out_dir / "traces.otel.jsonl"
    aggregate_sessions_file = out_dir / "sessions.json"

    out_dir.mkdir(parents=True, exist_ok=True)
    otel_dir.mkdir(parents=True, exist_ok=True)
    session_dir.mkdir(parents=True, exist_ok=True)
    _emit_progress(
        progress,
        "World Model Updating",
        "IN_PROGRESS",
        output_dir=str(out_dir),
        archive_backend=os.environ.get("TRACE_ARCHIVE_BACKEND", "local"),
    )

    all_bundle_ids = sorted(list(root_agent_ids) if root_agent_ids is not None else list_archive_bundle_ids())
    index = _read_delta_index(index_path)
    old_bundles = index.get("bundles") if isinstance(index.get("bundles"), dict) else {}
    # Corpus cap for fast benchmark/cloud builds. The full R2 archive is large and
    # downloads slowly from some hosts (~KB/s); WMH_MAX_BUNDLES bounds the first
    # build to N bundles so a serving model is ready in minutes, not hours. A later
    # explicit --refresh-wmh (higher/unset cap) can grow it. 0/unset = no cap.
    _wmh_max_bundles = int(os.environ.get("WMH_MAX_BUNDLES", "0") or "0")
    candidate_bundle_ids = all_bundle_ids
    if _wmh_max_bundles > 0 and len(candidate_bundle_ids) > _wmh_max_bundles:
        # Keep already-indexed traces before deterministically admitting new
        # ones. Otherwise maintenance can evict the known-good corpus solely
        # because a UUID sorts outside the capped prefix. This selection must
        # happen before partition_real_world_bundles: classification reads each
        # encrypted manifest from R2 and was the uncapped refresh bottleneck.
        available = set(candidate_bundle_ids)
        retained = sorted(bundle_id for bundle_id in old_bundles if bundle_id in available)
        new = [bundle_id for bundle_id in candidate_bundle_ids if bundle_id not in old_bundles]
        limit = max(_wmh_max_bundles, len(retained))
        candidate_bundle_ids = (retained + new)[:limit]
    bundle_ids, excluded_bundles = partition_real_world_bundles(candidate_bundle_ids)
    split = deterministic_split(bundle_ids, heldout_fraction=heldout_fraction) if bundle_ids else {}
    changed: list[str] = []
    unchanged: list[str] = []
    signatures: dict[str, JsonObject] = {}
    total_plaintext_bytes = 0
    total_ciphertext_bytes = 0
    total_artifacts = 0

    for root_agent_id in bundle_ids:
        signature = _bundle_signature(root_agent_id)
        signatures[root_agent_id] = signature
        total_plaintext_bytes += int(signature["plaintext_bytes"])
        total_ciphertext_bytes += int(signature["ciphertext_bytes"])
        total_artifacts += int(signature["artifact_count"])
        otel_path = otel_dir / f"{root_agent_id}.otel.jsonl"
        session_path = session_dir / f"{root_agent_id}.session.json"
        previous = old_bundles.get(root_agent_id) if isinstance(old_bundles, dict) else None
        previous_sha = previous.get("sha256") if isinstance(previous, dict) else None
        if force or previous_sha != signature["sha256"] or not otel_path.exists() or not session_path.exists():
            changed.append(root_agent_id)
        else:
            unchanged.append(root_agent_id)

    _emit_progress(
        progress,
        "World Model RAG Populating",
        "IN_PROGRESS",
        total_traces=len(bundle_ids),
        traces_excluded_non_real=len(excluded_bundles),
        excluded_bundle_modes=sorted(set(excluded_bundles.values())),
        traces_to_update=len(changed),
        traces_unchanged=len(unchanged),
        artifact_count=total_artifacts,
        plaintext_bytes=total_plaintext_bytes,
        ciphertext_bytes=total_ciphertext_bytes,
    )

    exported_spans = 0
    exported_sessions = 0
    for root_agent_id in changed:
        otel_path = otel_dir / f"{root_agent_id}.otel.jsonl"
        export_archive_to_otel_jsonl(root_agent_id, otel_path, redaction_mode="public")
        exported_spans += sum(1 for line in otel_path.read_text(encoding="utf-8").splitlines() if line.strip())
        session = _build_replay_session(root_agent_id, split[root_agent_id])
        (session_dir / f"{root_agent_id}.session.json").write_text(
            json.dumps(session, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        exported_sessions += 1

    _emit_progress(
        progress,
        "World Model Trace Export",
        "IN_PROGRESS",
        updated_traces=len(changed),
        exported_spans=exported_spans,
        exported_sessions=exported_sessions,
    )

    sessions: list[JsonObject] = []
    with aggregate_trace_file.open("w", encoding="utf-8") as combined:
        for root_agent_id in bundle_ids:
            otel_path = otel_dir / f"{root_agent_id}.otel.jsonl"
            if otel_path.exists():
                text = otel_path.read_text(encoding="utf-8").strip()
                if text:
                    combined.write(text + "\n")
            session_path = session_dir / f"{root_agent_id}.session.json"
            if session_path.exists():
                try:
                    session = json.loads(session_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    session = _build_replay_session(root_agent_id, split[root_agent_id])
                if isinstance(session, dict):
                    sessions.append(session)
    aggregate_sessions_file.write_text(
        json.dumps({"schema": "rose.wmh_replay_corpus.v1", "sessions": sessions}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    aggregate_bytes = aggregate_trace_file.stat().st_size if aggregate_trace_file.exists() else 0
    session_bytes = aggregate_sessions_file.stat().st_size if aggregate_sessions_file.exists() else 0
    manifest_path = out_dir / "build.manifest.json"
    needs_build = force or not manifest_path.exists()
    needs_index_refresh = bool(changed) and not needs_build
    _emit_progress(
        progress,
        "World Model Build",
        "IN_PROGRESS",
        build_required=needs_build,
        index_refresh_required=needs_index_refresh,
        total_traces=len(bundle_ids),
        updated_traces=len(changed),
        aggregate_trace_bytes=aggregate_bytes,
        replay_corpus_bytes=session_bytes,
        model_name=name,
        provider=provider,
        serve_model=model,
        gepa_budget=gepa_budget,
        embed_dim=embed_dim,
    )

    build_manifest: JsonObject
    index_refresh: JsonObject | None = None
    if needs_build:
        build_manifest = build_world_model_from_otel_jsonl(
            aggregate_trace_file,
            out_dir,
            name=name,
            provider=provider,
            model=model,
            judge_model=judge_model,
            gepa_budget=gepa_budget,
            train_split=train_split,
            embed_dim=embed_dim,
            upstream_build=upstream_build,
            config_factory=config_factory,
            serve_provider=serve_provider,
            judge_provider=judge_provider,
            embedder=embedder,
        )
    else:
        build_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        build_manifest["build_skipped"] = True
        if needs_index_refresh:
            build_manifest["skip_reason"] = "index-only refresh (GEPA runs on first build or force)"
            refresh = index_refresher or refresh_world_model_index
            index_refresh = refresh(
                aggregate_trace_file,
                out_dir / "models" / name,
                embed_dim=embed_dim,
            )
            _emit_progress(
                progress,
                "World Model Index Refresh",
                "IN_PROGRESS",
                **index_refresh,
            )
        else:
            build_manifest["skip_reason"] = "no archive deltas"

    now_ms = int(time.time() * 1000)
    index["updated_at_ms"] = now_ms
    index["model_name"] = name
    index["trace_file"] = str(aggregate_trace_file)
    index["replay_corpus_file"] = str(aggregate_sessions_file)
    index["bundles"] = {
        root_agent_id: {
            **signatures[root_agent_id],
            "split": split[root_agent_id],
            "otel_file": str(otel_dir / f"{root_agent_id}.otel.jsonl"),
            "session_file": str(session_dir / f"{root_agent_id}.session.json"),
            "updated_at_ms": now_ms,
        }
        for root_agent_id in bundle_ids
    }
    _write_delta_index(index_path, index)

    elapsed_ms = int((time.time() - started) * 1000)
    result: JsonObject = {
        "schema": "rose.wmh_delta_update.v1",
        "status": "ready",
        "model_name": name,
        "output_dir": str(out_dir),
        "index_path": str(index_path),
        "trace_file": str(aggregate_trace_file),
        "replay_corpus_file": str(aggregate_sessions_file),
        "build_manifest_path": str(manifest_path),
        "total_traces": len(bundle_ids),
        "updated_traces": len(changed),
        "unchanged_traces": len(unchanged),
        "artifact_count": total_artifacts,
        "plaintext_bytes": total_plaintext_bytes,
        "ciphertext_bytes": total_ciphertext_bytes,
        "aggregate_trace_bytes": aggregate_bytes,
        "replay_corpus_bytes": session_bytes,
        "build_ran": needs_build,
        "index_refreshed": needs_index_refresh,
        "index_refresh": index_refresh,
        "elapsed_ms": elapsed_ms,
        "build_manifest": build_manifest,
    }
    _emit_progress(
        progress,
        "World Model Ready",
        "FINISHED",
        model_name=name,
        total_traces=len(bundle_ids),
        updated_traces=len(changed),
        unchanged_traces=len(unchanged),
        aggregate_trace_bytes=aggregate_bytes,
        replay_corpus_bytes=session_bytes,
        build_ran=needs_build,
        elapsed_ms=elapsed_ms,
    )
    return result


def compare_real_vs_world_model_benchmark(
    real_result: JsonObject,
    world_model_result: JsonObject,
    *,
    max_progress_delta: float = 10.0,
    min_fidelity_score: float = 0.0,
) -> JsonObject:
    """Compare one real benchmark task result with its world-model simulated run."""

    real_name = real_result.get("name")
    simulated_name = world_model_result.get("name")
    real_progress = float(real_result.get("progress_score") or 0)
    simulated_progress = float(world_model_result.get("progress_score") or 0)
    progress_delta = abs(real_progress - simulated_progress)
    fidelity = world_model_result.get("world_model_fidelity")
    fidelity_score = 0.0
    if isinstance(fidelity, dict) and fidelity.get("status") == "scored":
        fidelity_score = float(fidelity.get("mean_score") or 0)
    checks = {
        "task_name_match": real_name == simulated_name,
        "pass_outcome_match": bool(real_result.get("passed")) == bool(world_model_result.get("passed")),
        "terminal_status_match": str(real_result.get("status") or "") == str(world_model_result.get("status") or ""),
        "progress_within_delta": progress_delta <= max_progress_delta,
        "fidelity_above_threshold": fidelity_score >= min_fidelity_score,
        "world_model_mode_recorded": bool(
            world_model_result.get("world_model_mode") or world_model_result.get("world_model_fidelity")
        ),
    }
    comparison: JsonObject = {
        "schema": "rose.wmh_benchmark_comparison.v1",
        "task": real_name,
        "comparable": all(checks.values()),
        "checks": checks,
        "progress_delta": progress_delta,
        "fidelity_score": fidelity_score,
        "real_agent_id": real_result.get("agent_id"),
        "world_model_agent_id": world_model_result.get("agent_id"),
    }
    redacted = _redact(comparison)
    if public_json_has_secret(redacted):
        raise ValueError("WMH benchmark comparison contains unredacted secret-looking content")
    return redacted


class WMHHttpClient:
    """Small client for WMH's local HTTP serving API."""

    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def list_world_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(f"{self.base_url}/world_models")
            response.raise_for_status()
            data = response.json()
        models = data.get("world_models")
        return models if isinstance(models, list) else []

    async def start_session(
        self, world_model: str, *, task: str | None = None, seed_state: JsonObject | None = None
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
        if isinstance(action, CanonicalAction):
            wmh_action = {
                "kind": "tool_call",
                "name": action.to_wmh_tool_name(),
                "arguments": action.to_arguments(),
            }
        else:
            wmh_action = action
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

    def should_simulate(self, tool_name: str) -> bool:
        return self.mode == "simulate" and is_world_model_environment_boundary(tool_name)

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
        action = canonical_action_from_tool_call(
            tool_name,
            tool_args,
            tool_call_id,
            agent_id=self.agent_id,
        )
        if self.mode == "simulate":
            started = time.monotonic()
            observation = await self.client.step(self.world_model_name, self.session_id, action)
            wall_elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
            result = world_model_observation_to_tool_result(
                observation,
                simulated=True,
                wall_elapsed_ms=wall_elapsed_ms,
            )
            if _wmh_fallback_on_unavailable_enabled() and _wmh_result_unavailable(result):
                real_result = await real_executor(tool_name, tool_args, tool_call_id)
                if isinstance(real_result, dict):
                    real_result.setdefault("world_model_unavailable_fallback", True)
                    real_result.setdefault("world_model_unavailable_observation", observation)
                return real_result
            return result
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


def _wmh_fallback_on_unavailable_enabled() -> bool:
    return os.environ.get("BENCHMARK_WMH_FALLBACK_ON_UNAVAILABLE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


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
    content = observation.get("content")
    if isinstance(content, str) and content.strip():
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, dict):
            return decoded
    return None
