"""Standard archived LLM call record (schema v2) for the Python writers.

Contract: `shared/llm-archive-record/record.schema.json`. One model call is
archived as two encrypted artifacts in the ROOT agent's trace bundle:

    llm/<dump_id>.json.gz.enc                                  record="start"
    llm-updates/<dump_id>-<epoch_ms>-<call_site>.json.gz.enc   record="final"

The start record carries every input sent to the provider (messages, config,
tools including declared-only context tools, response format). The final
record carries everything needed to reconstruct the trajectory: content,
reasoning text, provider reasoning blocks (signatures / redacted thinking /
encrypted items), tool calls, usage including reasoning tokens.

```
  RoseClient / browser-use / JEV / WMH / fallback
            │ identity (agent_id, root_agent_id, span_id, dump_id, call_site)
            ▼
  build_start_record ──► archive llm/<dump_id>          (root bundle)
  build_final_record ──► archive llm-updates/<dump_id>- (root bundle)
            ▲
  unbound identity ──► refused: log `llm.archive.unbound_refused` + counter
```

Field names follow the pre-v2 Python layout so existing readers keep working;
`is_v2_record()` / `record_output()` let readers accept both shapes.
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from typing import Any, Dict, Iterable, List, Mapping, Optional

SCHEMA_VERSION = 2
START = "start"
FINAL = "final"

# Identity values that never name a real agent. The schema rejects them too.
_UNBOUND_IDS = frozenset({"", "unbound", "none", "null", "undefined"})
_UNSPECIFIED_CALL_SITES = frozenset({"", "unspecified", "unknown"})

_COUNTERS: Counter[str] = Counter()
_COUNTERS_LOCK = threading.Lock()


class UnboundArchiveIdentity(ValueError):
    """Raised when a record would not land in a real agent's root bundle."""


def increment_counter(name: str, amount: int = 1) -> int:
    with _COUNTERS_LOCK:
        _COUNTERS[name] += amount
        return _COUNTERS[name]


def archive_counters() -> Dict[str, int]:
    """Process-local archive integrity counters (refusals, spills, overflows)."""
    with _COUNTERS_LOCK:
        return dict(_COUNTERS)


def reset_archive_counters() -> None:
    with _COUNTERS_LOCK:
        _COUNTERS.clear()


def is_bound_id(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() not in _UNBOUND_IDS


def normalize_call_site(call_site: Any) -> str:
    text = str(call_site or "").strip()
    return "unattributed_call" if text.lower() in _UNSPECIFIED_CALL_SITES else text


def now_ms() -> int:
    return int(time.time() * 1000)


def _first_int(*values: Any) -> Optional[int]:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
    return None


def _details(usage: Mapping[str, Any], *keys: str) -> Mapping[str, Any]:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, Mapping):
            return value
    return {}


def normalize_usage(usage: Any) -> Dict[str, Any]:
    """Return the schema usage view while keeping every provider-reported key.

    Accepts Rose usage chunks (prompt_tokens/completion_tokens), Anthropic
    (input_tokens/output_tokens), OpenAI Responses (input/output details) and
    OpenRouter (completion_tokens_details.reasoning_tokens) shapes.
    """
    raw: Mapping[str, Any] = usage if isinstance(usage, Mapping) else {}
    completion_details = _details(raw, "completion_tokens_details", "output_tokens_details")
    prompt_details = _details(raw, "prompt_tokens_details", "input_tokens_details")
    normalized: Dict[str, Any] = dict(raw)
    normalized["prompt"] = _first_int(raw.get("prompt"), raw.get("prompt_tokens"), raw.get("input_tokens"))
    normalized["completion"] = _first_int(raw.get("completion"), raw.get("completion_tokens"), raw.get("output_tokens"))
    normalized["total"] = _first_int(raw.get("total"), raw.get("total_tokens"))
    if normalized["total"] is None and normalized["prompt"] is not None and normalized["completion"] is not None:
        normalized["total"] = normalized["prompt"] + normalized["completion"]
    normalized["reasoning"] = _first_int(
        raw.get("reasoning"),
        raw.get("reasoning_tokens"),
        completion_details.get("reasoning_tokens"),
    )
    normalized["cache_creation"] = _first_int(
        raw.get("cache_creation"),
        raw.get("cache_creation_tokens"),
        raw.get("cache_creation_input_tokens"),
        raw.get("cache_write_tokens"),
        prompt_details.get("cache_write_tokens"),
    )
    normalized["cache_read"] = _first_int(
        raw.get("cache_read"),
        raw.get("cache_read_tokens"),
        raw.get("cache_read_input_tokens"),
        raw.get("cached_tokens"),
        prompt_details.get("cached_tokens"),
    )
    finish = raw.get("finish_reason")
    normalized["finish_reason"] = finish if isinstance(finish, str) else None
    return normalized


def _normalize_tool_call(call: Any) -> Dict[str, Any]:
    if not isinstance(call, Mapping):
        return {"name": "", "arguments": call}
    out = dict(call)
    function = call.get("function") if isinstance(call.get("function"), Mapping) else {}
    name = call.get("name") or function.get("name") or ""
    out["name"] = str(name)
    if "arguments" not in out:
        out["arguments"] = function.get("arguments", call.get("input", ""))
    return out


def _reasoning_blocks_from_codex_items(items: Iterable[Any]) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        blocks.append(
            {
                "type": "openai_reasoning_item",
                "id": item.get("id") if isinstance(item.get("id"), str) else None,
                "encrypted_content": (
                    item.get("encrypted_content") if isinstance(item.get("encrypted_content"), str) else None
                ),
                "summary": item.get("summary"),
                "raw": dict(item),
            }
        )
    return blocks


def normalize_output(output: Any) -> Dict[str, Any]:
    """Schema-shaped output; unknown caller keys are preserved verbatim."""
    raw: Mapping[str, Any] = output if isinstance(output, Mapping) else {"value": output}
    out: Dict[str, Any] = dict(raw)
    content = raw.get("content")
    out["content"] = content if isinstance(content, str) else ("" if content is None else str(content))
    reasoning = raw.get("reasoning")
    out["reasoning"] = reasoning if isinstance(reasoning, str) else ("" if reasoning is None else str(reasoning))
    tool_calls = raw.get("tool_calls")
    out["tool_calls"] = [_normalize_tool_call(call) for call in tool_calls] if isinstance(tool_calls, list) else []
    out["usage"] = normalize_usage(raw.get("usage"))
    actual_model = raw.get("actual_model")
    out["actual_model"] = actual_model if isinstance(actual_model, str) and actual_model else None
    blocks = raw.get("reasoning_blocks")
    reasoning_blocks: List[Dict[str, Any]] = (
        [dict(block) for block in blocks if isinstance(block, Mapping)] if isinstance(blocks, list) else []
    )
    codex_items = raw.get("codex_reasoning_items")
    if isinstance(codex_items, list) and codex_items:
        out["codex_reasoning_items"] = list(codex_items)
        if not any(block.get("type") == "openai_reasoning_item" for block in reasoning_blocks):
            reasoning_blocks.extend(_reasoning_blocks_from_codex_items(codex_items))
    out["reasoning_blocks"] = reasoning_blocks
    error = raw.get("error")
    if error is not None and not isinstance(error, Mapping):
        out["error"] = {"type": type(error).__name__, "message": str(error)}
    elif isinstance(error, Mapping):
        out["error"] = {**error, "type": str(error.get("type") or "Error"), "message": str(error.get("message") or "")}
    return out


def identity(
    *,
    call_site: str,
    agent_id: str,
    root_agent_id: str,
    span_id: str,
    dump_id: str,
) -> Dict[str, Any]:
    if not is_bound_id(agent_id) or not is_bound_id(root_agent_id):
        raise UnboundArchiveIdentity(
            f"archive record for {call_site!r} has unbound identity "
            f"(agent_id={agent_id!r}, root_agent_id={root_agent_id!r})"
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "call_site": normalize_call_site(call_site),
        "agent_id": agent_id,
        "root_agent_id": root_agent_id,
        "span_id": span_id or dump_id,
        "dump_id": dump_id,
    }


def build_start_record(
    ident: Mapping[str, Any],
    *,
    messages: List[Any],
    model: Optional[str],
    config: Optional[Mapping[str, Any]] = None,
    response_format: Any = None,
    tools: Optional[List[Any]] = None,
    extra: Optional[Mapping[str, Any]] = None,
    started_at_ms: Optional[int] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        **ident,
        "record": START,
        "started_at_ms": started_at_ms if started_at_ms is not None else now_ms(),
        "model": model,
        "message_count": len(messages),
        "messages": messages,
        "config": dict(config or {}),
    }
    if response_format is not None:
        record["response_format"] = response_format
    if tools is not None:
        record["tools"] = tools
    if extra:
        record["extra"] = dict(extra)
    return record


def build_final_record(
    ident: Mapping[str, Any],
    *,
    output: Any,
    model: Optional[str] = None,
    attempts: Optional[List[Mapping[str, Any]]] = None,
    extra: Optional[Mapping[str, Any]] = None,
    config: Optional[Mapping[str, Any]] = None,
    response_format: Any = None,
    tools: Optional[List[Any]] = None,
    finished_at_ms: Optional[int] = None,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        **ident,
        "record": FINAL,
        "finished_at_ms": finished_at_ms if finished_at_ms is not None else now_ms(),
        "model": model,
        "output": normalize_output(output),
    }
    if attempts:
        record["attempts"] = [
            {
                "model": attempt.get("model"),
                "pool_name": attempt.get("pool_name"),
                "outcome": attempt.get("outcome") or "lost_race",
                "output": normalize_output(attempt.get("output")),
            }
            for attempt in attempts
            if isinstance(attempt, Mapping)
        ]
    if extra:
        record["extra"] = dict(extra)
    # Late-resolved request details (legacy update_llm_dump kwargs) stay in the
    # final record so nothing a caller supplies is dropped.
    if config is not None:
        record["config"] = dict(config)
    if response_format is not None:
        record["response_format"] = response_format
    if tools is not None:
        record["tools"] = tools
    return record


def is_v2_record(payload: Any) -> bool:
    return isinstance(payload, Mapping) and payload.get("schema_version") == SCHEMA_VERSION


def record_output(payload: Any) -> Dict[str, Any]:
    """Output dict from a v2 final record or a legacy dump/update payload."""
    if not isinstance(payload, Mapping):
        return {}
    output = payload.get("output")
    return dict(output) if isinstance(output, Mapping) else {}


def record_timestamp_ms(payload: Any) -> Optional[int]:
    """Best record clock: v2 start/finish stamps, else the archive metadata."""
    if not isinstance(payload, Mapping):
        return None
    for key in ("started_at_ms", "finished_at_ms"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    archive = payload.get("archive")
    metadata = archive.get("metadata") if isinstance(archive, Mapping) else None
    created = metadata.get("created_at_ms") if isinstance(metadata, Mapping) else None
    return created if isinstance(created, int) else None
