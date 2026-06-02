"""DEV-only observability helpers — full LLM context dumps to disk.

In dev runs (FLY_APP_NAME unset), `dump_llm_context()` persists the full
messages array, system prompt, tool schemas, and response format sent to
an LLM to `.llm-dumps/<agent_id>/<ts>-<span_id>-<call_site>.json`, then
emits a structured log event `llm.context.dumped` carrying the file path.

In production (FLY_APP_NAME set), the helper is a no-op: prod truncates
payloads inline via existing `[:200]` patterns and relies on exporters,
not local disk.

RoseClient also writes and updates dumps directly so direct `collect()` /
`complete()` callers do not bypass this coverage.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from helpers.tracing import current_agent_id, current_span_id

logger = structlog.get_logger()


# Prod is detected the same way as helpers/messages.py — FLY_APP_NAME
# is only set by the Fly machine runtime.
_IS_PRODUCTION = os.environ.get("FLY_APP_NAME") is not None

# Dumps land at <repo-root>/.llm-dumps/. This file lives at
# agents/helpers/observability.py, so parents[2] walks up to the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DUMP_ROOT = _REPO_ROOT / ".llm-dumps"


def _safe_filename_segment(value: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in value)[:64] or "unbound"


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
    """Persist the full LLM context to disk (dev) and log a pointer to it.

    Returns the absolute dump path, or None in production / on any failure.
    Never raises — dump failure must not break the LLM call.
    """
    if _IS_PRODUCTION:
        return None

    try:
        span_id = current_span_id() or uuid.uuid4().hex[:12]
        aid = agent_id or current_agent_id() or "unbound"

        agent_dir = _DUMP_ROOT / _safe_filename_segment(aid)
        agent_dir.mkdir(parents=True, exist_ok=True)

        # Timestamp sorts naturally; span_id + call_site disambiguate within
        # the same millisecond (e.g. 3 parallel sub-agents share a tick).
        filename = f"{int(time.time() * 1000)}-{span_id}-{_safe_filename_segment(call_site)}.json"
        path = agent_dir / filename

        payload: Dict[str, Any] = {
            "call_site": call_site,
            "agent_id": aid,
            "span_id": span_id,
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
    if _IS_PRODUCTION or not path:
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
        dump_path.write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2))
    except Exception as e:
        logger.warning("llm.context.dump_update_failed", path=path, error=str(e)[:200])
