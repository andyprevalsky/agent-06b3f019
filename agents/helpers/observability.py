"""Observability helpers for full LLM context dumps.

In dev runs (FLY_APP_NAME unset), `dump_llm_context()` persists the full
messages array, system prompt, tool schemas, and response format sent to
an LLM to `.llm-dumps/<agent_id>/<ts>-<span_id>_<dump_id>-<call_site>.json`, then
emits a structured log event `llm.context.dumped` carrying the file path.

Every call is archived as schema-v2 start/final records in the ROOT agent's
encrypted trace bundle (`helpers/llm_archive_record.py`). The archive is the
authoritative store: the final (output) record is written from the dump
handle at any payload size. In production (FLY_APP_NAME set), local disk
writes stay disabled and a size-capped copy is also emitted into the
structured log stream for ClickHouse materialization; `LLM_CONTEXT_DUMP_PROD=0`
switches off only that secondary log copy.

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
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, unquote, urlencode

import structlog

from helpers.llm_archive_record import (
    UnboundArchiveIdentity,
    build_final_record,
    build_start_record,
    increment_counter,
    is_bound_id,
)
from helpers.llm_archive_record import identity as record_identity
from helpers.trace_archive import archive_json
from helpers.tracing import current_agent_id, current_bound_root_agent_id, current_span_id, current_workflow_agent_id

logger = structlog.get_logger()


# Prod is detected the same way as helpers/messages.py — FLY_APP_NAME
# is only set by the Fly machine runtime.
_IS_PRODUCTION = os.environ.get("FLY_APP_NAME") is not None

# Dumps land at <repo-root>/.llm-dumps/. This file lives at
# agents/helpers/observability.py, so parents[2] walks up to the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DUMP_ROOT = _REPO_ROOT / ".llm-dumps"


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
) -> bool:
    """Best-effort secondary log copy for ClickHouse; never gates the archive."""
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
        return False

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
    return True


def _safe_filename_segment(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in value)[:64] or "call"


# A dump handle names the archived start record, independent of ClickHouse or
# the local debug file. Finalization is driven by it, so an output record is
# written for every call whose start record was archived, at any size.
_ARCHIVE_HANDLE_SCHEME = "llm-archive://"


def _encode_handle(ident: Dict[str, Any], *, log_copy: bool = True) -> str:
    query = urlencode({"span": ident["span_id"], "call_site": ident["call_site"], **({} if log_copy else {"log": "0"})})
    return (
        f"{_ARCHIVE_HANDLE_SCHEME}{quote(ident['root_agent_id'], safe='')}/"
        f"{quote(ident['agent_id'], safe='')}/{quote(ident['dump_id'], safe='')}?{query}"
    )


def _decode_handle(handle: str) -> Optional[Dict[str, Any]]:
    if not handle.startswith(_ARCHIVE_HANDLE_SCHEME):
        return None
    body, _, query = handle.removeprefix(_ARCHIVE_HANDLE_SCHEME).partition("?")
    parts = [unquote(part) for part in body.split("/")]
    if len(parts) != 3:
        return None
    params = parse_qs(query)
    root, agent, dump_id = parts
    try:
        ident = record_identity(
            call_site=(params.get("call_site") or ["update"])[0],
            agent_id=agent,
            root_agent_id=root,
            span_id=(params.get("span") or [dump_id])[0],
            dump_id=dump_id,
        )
    except UnboundArchiveIdentity:
        return None
    ident["_log_copy"] = (params.get("log") or ["1"])[0] != "0"
    return ident


def _resolve_identity(call_site: str, agent_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """Bind a record to the acting agent and its tree root, or refuse it loudly."""
    aid = agent_id or current_agent_id() or current_workflow_agent_id()
    root = current_bound_root_agent_id()
    if is_bound_id(aid) and not is_bound_id(root):
        # Outside a workflow/activity header (CLI, scripts): the acting agent is
        # the only identity known. Root agents are their own root; record the
        # gap so an unbound sub-agent is visible rather than silently split.
        increment_counter("root_fallback_to_agent_id")
        logger.warning("llm.archive.root_unbound_fallback", call_site=call_site, agent_id=aid)
        root = aid
    span_id = current_span_id() or uuid.uuid4().hex[:12]
    dump_id = uuid.uuid4().hex[:12]
    try:
        return record_identity(
            call_site=call_site,
            agent_id=str(aid or ""),
            root_agent_id=str(root or ""),
            span_id=span_id,
            dump_id=dump_id,
        )
    except UnboundArchiveIdentity as exc:
        count = increment_counter("unbound_refused")
        logger.error("llm.archive.unbound_refused", call_site=call_site, refused=count, error=str(exc)[:200])
        return None


def _final_record_path(ident: Dict[str, Any]) -> str:
    return (
        f"llm-updates/{ident['dump_id']}-{int(time.time() * 1000)}-"
        f"{_safe_filename_segment(str(ident['call_site']))}.json.gz.enc"
    )


def _archive_final_record(
    ident: Dict[str, Any],
    *,
    model: Optional[str],
    output: Any,
    config: Optional[Dict[str, Any]] = None,
    response_format: Any = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    extra: Optional[Dict[str, Any]] = None,
    attempts: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    record = build_final_record(
        ident,
        output=output if output is not None else {},
        model=model,
        attempts=attempts,
        extra=extra,
        config=config,
        response_format=response_format,
        tools=tools,
    )
    archive_ref = archive_json(
        root_agent_id=ident["root_agent_id"],
        path=_final_record_path(ident),
        payload=record,
    )
    return record, archive_ref


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
    attempts: Optional[List[Dict[str, Any]]] = None,
    log_copy: bool = True,
) -> Optional[str]:
    """Archive a v2 start record (and a final record when `output` is known).

    `log_copy=False` keeps the call out of the ClickHouse log stream (callers
    whose provider content must never enter logs); the archive still has it.

    Returns a handle for `update_llm_dump`: the local debug dump path in dev,
    otherwise an `llm-archive://` handle. Returns None only when the identity
    is unbound (refused loudly) or the dump itself failed.
    Never raises — dump failure must not break the LLM call.
    """
    try:
        ident = _resolve_identity(call_site, agent_id)
        if ident is None:
            return None
        # Browser activities bind private refs in a task-local context. Apply
        # that policy before either the private archive or a public dump/log.
        from browser_tools.secret_refs import redact_current_secret_values

        start = redact_current_secret_values(
            build_start_record(
                ident,
                messages=messages,
                model=model,
                config=config,
                response_format=response_format,
                tools=tools,
                extra=extra,
            )
        )
        archive_ref = archive_json(
            root_agent_id=ident["root_agent_id"],
            path=f"llm/{ident['dump_id']}.json.gz.enc",
            payload=start,
        )
        final: Optional[Dict[str, Any]] = None
        redacted_output = redact_current_secret_values(output)
        if output is not None:
            final, _ = _archive_final_record(
                ident,
                model=model,
                output=redacted_output,
                extra=redact_current_secret_values(extra),
                attempts=redact_current_secret_values(attempts),
            )
        handle = _encode_handle(ident, log_copy=log_copy)

        if _IS_PRODUCTION:
            if log_copy and _prod_clickhouse_dumps_enabled(ident["agent_id"]):
                # Secondary, size-capped log channel; the archive is authoritative.
                payload = dict(start)
                if final is not None:
                    payload["output"] = final["output"]
                if archive_ref:
                    payload["archive"] = {"ref": archive_ref["ref"], "metadata": archive_ref["metadata"]}
                _emit_clickhouse_dump_event(
                    event_name="llm.context.dumped",
                    payload=payload,
                    agent_id=ident["agent_id"],
                    span_id=ident["span_id"],
                    dump_id=ident["dump_id"],
                    call_site=ident["call_site"],
                    model=model,
                    message_count=len(messages),
                )
            return handle

        # The local debug file keeps the caller's output verbatim; the archive
        # final record carries the schema-normalized view of the same output.
        local = dict(start)
        if output is not None:
            local["output"] = redacted_output
        if archive_ref:
            local["archive"] = {"ref": archive_ref["ref"], "metadata": archive_ref["metadata"]}
        try:
            agent_dir = _DUMP_ROOT / _safe_filename_segment(ident["agent_id"])
            agent_dir.mkdir(parents=True, exist_ok=True)
            # Timestamp sorts naturally. The dump_id rides the span segment so two
            # calls in one span, call site and millisecond never share a handle
            # (the later write would re-key the earlier call's final record);
            # the span prefix and call_site segment still parse as before.
            filename = (
                f"{int(time.time() * 1000)}-{ident['span_id']}_{ident['dump_id']}-"
                f"{_safe_filename_segment(ident['call_site'])}.json"
            )
            path = agent_dir / filename
            # `default=str` handles Pydantic BaseModel, datetime, UUID, FilePointer,
            # etc. without needing bespoke serializers per call site.
            path.write_text(json.dumps(local, ensure_ascii=False, default=str, indent=2))
        except Exception as exc:
            logger.warning("llm.context.local_dump_failed", call_site=call_site, error=str(exc)[:200])
            return handle

        total_chars = sum(len(str(m.get("content", ""))) for m in messages if isinstance(m, dict))
        logger.info(
            "llm.context.dumped",
            path=str(path),
            call_site=ident["call_site"],
            agent_id=ident["agent_id"],
            span_id=ident["span_id"],
            model=model,
            message_count=len(messages),
            total_chars=total_chars,
        )
        return str(path)
    except Exception as e:
        # Best-effort. Never fail the LLM call because the dump failed.
        logger.warning("llm.context.dump_failed", call_site=call_site, error=str(e)[:200])
        return None


def _identity_from_local_dump(payload: Dict[str, Any], fallback_dump_id: str) -> Optional[Dict[str, Any]]:
    agent = str(payload.get("agent_id") or "")
    root = str(payload.get("root_agent_id") or agent)
    dump_id = str(payload.get("dump_id") or fallback_dump_id)
    try:
        return record_identity(
            call_site=str(payload.get("call_site") or "update"),
            agent_id=agent,
            root_agent_id=root,
            span_id=str(payload.get("span_id") or dump_id),
            dump_id=dump_id,
        )
    except UnboundArchiveIdentity:
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
    attempts: Optional[List[Dict[str, Any]]] = None,
) -> None:
    """Archive the v2 final record for a dump handle (any size, any env)."""
    if not path:
        return
    from browser_tools.secret_refs import redact_current_secret_values

    model = redact_current_secret_values(model)
    config = redact_current_secret_values(config)
    response_format = redact_current_secret_values(response_format)
    tools = redact_current_secret_values(tools)
    output = redact_current_secret_values(output)
    extra = redact_current_secret_values(extra)
    attempts = redact_current_secret_values(attempts)

    try:
        ident = _decode_handle(path)
        dump_path: Optional[Path] = None
        local_payload: Optional[Dict[str, Any]] = None
        if ident is None:
            dump_path = Path(path)
            local_payload = json.loads(dump_path.read_text())
            ident = _identity_from_local_dump(local_payload, dump_path.stem)
        if ident is None:
            count = increment_counter("unbound_refused")
            logger.error("llm.archive.unbound_refused", call_site="update", refused=count, path=path[:200])
            return
        log_copy = bool(ident.pop("_log_copy", True))
        final, archive_ref = _archive_final_record(
            ident,
            model=model,
            output=output,
            config=config,
            response_format=response_format,
            tools=tools,
            extra=extra,
            attempts=attempts,
        )

        if log_copy and _IS_PRODUCTION and _prod_clickhouse_dumps_enabled(ident["agent_id"]):
            payload = dict(final)
            if archive_ref:
                payload["archive"] = {"ref": archive_ref["ref"], "metadata": archive_ref["metadata"]}
            _emit_clickhouse_dump_event(
                event_name="llm.context.dump_updated",
                payload=payload,
                agent_id=ident["agent_id"],
                span_id=ident["span_id"],
                dump_id=ident["dump_id"],
                call_site=ident["call_site"],
                model=model,
                message_count=0,
            )

        if dump_path is None or local_payload is None:
            return
        # Dev convenience: keep the local debug dump merged and readable.
        if model is not None:
            local_payload["model"] = model
        if config is not None:
            merged_config = dict(local_payload.get("config") or {})
            merged_config.update(config)
            local_payload["config"] = merged_config
        if response_format is not None:
            local_payload["response_format"] = response_format
        if tools is not None:
            local_payload["tools"] = tools
        if output is not None:
            local_payload["output"] = output
        if attempts:
            local_payload["attempts"] = final.get("attempts")
        if extra:
            merged_extra = dict(local_payload.get("extra") or {})
            merged_extra.update(extra)
            local_payload["extra"] = merged_extra
        local_payload["root_agent_id"] = ident["root_agent_id"]
        if archive_ref:
            local_payload.setdefault("archive_updates", []).append(
                {"ref": archive_ref["ref"], "metadata": archive_ref["metadata"]}
            )
        dump_path.write_text(json.dumps(local_payload, ensure_ascii=False, default=str, indent=2))
    except Exception as e:
        logger.warning("llm.context.dump_update_failed", path=path, error=str(e)[:200])
