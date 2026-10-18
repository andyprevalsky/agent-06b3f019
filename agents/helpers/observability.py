"""Observability helpers for full LLM context dumps.

In dev runs (FLY_APP_NAME unset), `dump_llm_context()` persists the full
messages array, system prompt, tool schemas, and response format sent to
an LLM to `.llm-dumps/<agent_id>/<ts>-<span_id>-<call_site>.json`, then
emits a structured log event `llm.context.dumped` carrying the file path.

In production (FLY_APP_NAME set), local disk writes stay disabled. Full
contexts are emitted into the structured log stream for ClickHouse
materialization by default. `LLM_CONTEXT_DUMP_PROD=0` is an emergency kill
switch.

RoseClient also writes and updates dumps directly so direct `collect()` /
`complete()` callers do not bypass this coverage.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from helpers.trace_archive import archive_json
from helpers.tracing import current_agent_id, current_root_agent_id, current_span_id

logger = structlog.get_logger()


# Prod is detected the same way as helpers/messages.py — FLY_APP_NAME
# is only set by the Fly machine runtime.
_IS_PRODUCTION = os.environ.get("FLY_APP_NAME") is not None

# Dumps land at <repo-root>/.llm-dumps/. This file lives at
# agents/helpers/observability.py, so parents[2] walks up to the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DUMP_ROOT = _REPO_ROOT / ".llm-dumps"
_CLICKHOUSE_DUMP_SCHEME = "clickhouse://llm-context/"


def _falsey_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"0", "false", "no", "off"}


def _prod_clickhouse_dumps_enabled(agent_id: str) -> bool:
    if not _IS_PRODUCTION:
        return False
    return not _falsey_env("LLM_CONTEXT_DUMP_PROD")


def _prod_dump_max_bytes() -> int:
    raw = os.environ.get("LLM_CONTEXT_DUMP_MAX_BYTES", "").strip()
    if not raw:
        return 1_000_000
    try:
        return max(10_000, int(raw))
    except ValueError:
        return 1_000_000


def _safe_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":")).encode("utf-8")


def _emit_clickhouse_dump_event(
    *,
    event_name: str,
    payload: Dict[str, Any],
    agent_id: str,
    span_id: str,
    dump_id: str,
    call_site: str,
    model: Optional[str],
    message_count: int,
) -> Optional[str]:
    payload_bytes = _safe_json_bytes(payload)
    payload_size = len(payload_bytes)
    max_bytes = _prod_dump_max_bytes()
    if payload_size > max_bytes:
        logger.warning(
            "llm.context.dump_skipped",
            reason="payload_too_large",
            call_site=call_site,
            agent_id=agent_id,
            span_id=span_id,
            dump_id=dump_id,
            model=model,
            message_count=message_count,
            payload_bytes=payload_size,
            max_bytes=max_bytes,
        )
        return None

    compressed = gzip.compress(payload_bytes, compresslevel=6)
    logger.info(
        event_name,
        call_site=call_site,
        agent_id=agent_id,
        span_id=span_id,
        dump_id=dump_id,
        model=model,
        message_count=message_count,
        payload_encoding="gzip+base64",
        payload_sha256=hashlib.sha256(payload_bytes).hexdigest(),
        payload_bytes=payload_size,
        payload_compressed_bytes=len(compressed),
        payload_gzip_b64=base64.b64encode(compressed).decode("ascii"),
    )
    return f"{_CLICKHOUSE_DUMP_SCHEME}{agent_id}/{dump_id}"


def _safe_filename_segment(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in value)[:64] or "unbound"


def _archive_root_for(agent_id: str) -> str:
    return current_root_agent_id() or agent_id or "unbound"


def dump_llm_context(
    call_site: str,
    messages: List[Dict[str, Any]],
    *,
    agent_id: Optional[str] = None,
    model: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    output: Optional[Any] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Persist the full LLM context to disk or ClickHouse-backed prod logs.

    Returns the absolute dump path, clickhouse:// dump pointer, or None.
    Never raises — dump failure must not break the LLM call.
    """
    try:
        span_id = current_span_id() or uuid.uuid4().hex[:12]
        aid = agent_id or current_agent_id() or "unbound"
        archive_root_agent_id = _archive_root_for(aid)
        dump_id = uuid.uuid4().hex[:12]

        payload: Dict[str, Any] = {
            "call_site": call_site,
            "agent_id": aid,
            "root_agent_id": archive_root_agent_id,
            "span_id": span_id,
            "dump_id": dump_id,
            "model": model,
            "message_count": len(messages),
            "messages": messages,
        }
        if config is not None:
            payload["config"] = config
        if response_format is not None:
            payload["response_format"] = response_format
        if tools is not None:
            payload["tools"] = tools
        if output is not None:
            payload["output"] = output
        if extra:
            payload["extra"] = extra

        # Browser activities bind private refs in a task-local context. Apply
        # that policy before either the private archive or a public dump/log.
        from browser_tools.secret_refs import redact_current_secret_values
        payload = redact_current_secret_values(payload)

        archive_ref = archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"llm/{dump_id}.json.gz.enc",
            payload=payload,
        )
        if archive_ref:
            payload.setdefault("archive", {})["ref"] = archive_ref["ref"]
            payload["archive"]["metadata"] = archive_ref["metadata"]

        if _IS_PRODUCTION:
            if not _prod_clickhouse_dumps_enabled(aid):
                return str(archive_ref["ref"]) if archive_ref else None
            return _emit_clickhouse_dump_event(
                event_name="llm.context.dumped",
                payload=payload,
                agent_id=aid,
                span_id=span_id,
                dump_id=dump_id,
                call_site=call_site,
                model=model,
                message_count=len(messages),
            )

        agent_dir = _DUMP_ROOT / _safe_filename_segment(aid)
        agent_dir.mkdir(parents=True, exist_ok=True)

        # Timestamp sorts naturally; span_id + call_site disambiguate within
        # the same millisecond (e.g. 3 parallel sub-agents share a tick).
        filename = f"{int(time.time() * 1000)}-{span_id}-{_safe_filename_segment(call_site)}.json"
        path = agent_dir / filename

        # `default=str` handles Pydantic BaseModel, datetime, UUID, FilePointer,
        # etc. without needing bespoke serializers per call site.
        path.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2))

        total_chars = sum(len(str(m.get("content", ""))) for m in messages)
        logger.info(
            "llm.context.dumped",
            path=str(path),
            call_site=call_site,
            agent_id=aid,
            span_id=span_id,
            model=model,
            message_count=len(messages),
            total_chars=total_chars,
        )
        return str(path)
    except Exception as e:
        # Best-effort. Never fail the LLM call because the dump failed.
        logger.warning("llm.context.dump_failed", call_site=call_site, error=str(e)[:200])
        return None


def update_llm_dump(
    path: Optional[str],
    *,
    model: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    output: Optional[Any] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Merge late-arriving Rose response details into an existing dump."""
    if not path:
        return
    from browser_tools.secret_refs import redact_current_secret_values
    model = redact_current_secret_values(model)
    config = redact_current_secret_values(config)
    response_format = redact_current_secret_values(response_format)
    tools = redact_current_secret_values(tools)
    output = redact_current_secret_values(output)
    extra = redact_current_secret_values(extra)

    if path.startswith(_CLICKHOUSE_DUMP_SCHEME):
        try:
            parts = path.removeprefix(_CLICKHOUSE_DUMP_SCHEME).split("/", 1)
            agent_id = parts[0] if parts else "unbound"
            archive_root_agent_id = _archive_root_for(agent_id)
            dump_id = parts[1] if len(parts) > 1 else uuid.uuid4().hex[:12]
            span_id = current_span_id() or "unbound"
            patch_payload: Dict[str, Any] = {
                "agent_id": agent_id,
                "root_agent_id": archive_root_agent_id,
                "span_id": span_id,
                "dump_id": dump_id,
            }
            if model is not None:
                patch_payload["model"] = model
            if config is not None:
                patch_payload["config"] = config
            if response_format is not None:
                patch_payload["response_format"] = response_format
            if tools is not None:
                patch_payload["tools"] = tools
            if output is not None:
                patch_payload["output"] = output
            if extra:
                patch_payload["extra"] = extra
            archive_ref = archive_json(
                root_agent_id=archive_root_agent_id,
                path=f"llm-updates/{dump_id}-{int(time.time() * 1000)}-{_safe_filename_segment(str((extra or {}).get('call_site') or 'update'))}.json.gz.enc",
                payload=patch_payload,
            )
            if archive_ref:
                patch_payload.setdefault("archive", {})["ref"] = archive_ref["ref"]
                patch_payload["archive"]["metadata"] = archive_ref["metadata"]
            _emit_clickhouse_dump_event(
                event_name="llm.context.dump_updated",
                payload=patch_payload,
                agent_id=agent_id,
                span_id=span_id,
                dump_id=dump_id,
                call_site=str((extra or {}).get("call_site") or "update"),
                model=model,
                message_count=0,
            )
        except Exception as e:
            logger.warning("llm.context.dump_update_failed", path=path, error=str(e)[:200])
        return

    if _IS_PRODUCTION:
        return

    try:
        dump_path = Path(path)
        payload = json.loads(dump_path.read_text())
        if model is not None:
            payload["model"] = model
        if config is not None:
            merged_config = dict(payload.get("config") or {})
            merged_config.update(config)
            payload["config"] = merged_config
        if response_format is not None:
            payload["response_format"] = response_format
        if tools is not None:
            payload["tools"] = tools
        if output is not None:
            payload["output"] = output
        if extra:
            merged_extra = dict(payload.get("extra") or {})
            merged_extra.update(extra)
            payload["extra"] = merged_extra
            call_site = str(extra.get("call_site") or payload.get("call_site") or "update")
        else:
            call_site = str(payload.get("call_site") or "update")
        archive_root_agent_id = str(payload.get("root_agent_id") or _archive_root_for(str(payload.get("agent_id") or "unbound")))
        payload["root_agent_id"] = archive_root_agent_id
        archive_ref = archive_json(
            root_agent_id=archive_root_agent_id,
            path=f"llm-updates/{payload.get('dump_id') or dump_path.stem}-{int(time.time() * 1000)}-{_safe_filename_segment(call_site)}.json.gz.enc",
            payload=payload,
        )
        if archive_ref:
            payload.setdefault("archive_updates", []).append(
                {"ref": archive_ref["ref"], "metadata": archive_ref["metadata"]}
            )
        dump_path.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2))
    except Exception as e:
        logger.warning("llm.context.dump_update_failed", path=path, error=str(e)[:200])
