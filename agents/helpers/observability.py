"""DEV-only observability helpers — full LLM context dumps to disk.

In dev runs (FLY_APP_NAME unset), `dump_llm_context()` persists the full
messages array, system prompt, tool schemas, and response format sent to
an LLM to `.llm-dumps/<agent_id>/<ts>-<span_id>-<call_site>.json`, then
emits a structured log event `llm.context.dumped` carrying the file path.

In production (FLY_APP_NAME set), the helper is a no-op: prod truncates
payloads inline via existing `[:200]` patterns and relies on exporters,
not local disk.

Why here and not inline at the call site: every agent-side LLM request
goes through `call_llm_structured_streaming` / `_call_llm_verifier` in
`helpers/llm.py`. Instrumenting those two funnels covers the main loop,
planner, verifier, param populator, reasoning, spawn_agent explore, and
the spawn_claude_code preflight — so one dump hook catches every path.
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
    response_format: Optional[Dict[str, Any]] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
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
        if response_format is not None:
            payload["response_format"] = response_format
        if tools is not None:
            payload["tools"] = tools
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
