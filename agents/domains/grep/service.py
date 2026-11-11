"""Grep domain service - business logic orchestration."""

import time
from datetime import timedelta
from typing import Any, Dict, Optional

import structlog
from temporalio import workflow
from temporalio.common import RetryPolicy

from domains.grep.config import (
    ACTIVITY_BACKOFF_COEFFICIENT,
    ACTIVITY_INITIAL_INTERVAL_SECONDS,
    ACTIVITY_MAX_ATTEMPTS,
    ACTIVITY_MAX_INTERVAL_SECONDS,
    ACTIVITY_TIMEOUT_SECONDS,
    BROADCAST_GREP_PARAMS,
    DISPLAY_PATTERN_MAX_LENGTH,
    LOG_PATTERN_MAX_LENGTH,
    SOURCE_FILTER_KEYS,
)
from domains.grep.repo import grep_activity
from domains.grep.types import ExecuteActivityCallable
from helpers.handle_tool_event import handle_tool_event
from tools.base import EventType, MessageStatus, ToolEvent, format_error_message, format_tool_message
from tools.gate import source_status_activity

logger = structlog.get_logger()

_GREP_DISPLAY_KEY_ALIASES = {
    "before": "-B",
    "after": "-A",
    "context_c": "-C",
    "line_numbers": "-n",
    "case_insensitive": "-i",
}
_GREP_INTERNAL_DISPLAY_KEYS = {"tool", "tool_call_id"}
_GREP_AGENT_ONLY_KEYS = {"require_source_access"}


def _safe_time() -> float:
    """Get current time, returning 0 if in workflow sandbox."""
    try:
        return time.time()
    except Exception:
        return 0.0


def _truncate_pattern(pattern: str) -> str:
    """Truncate pattern for display in tool events."""
    if len(pattern) <= DISPLAY_PATTERN_MAX_LENGTH:
        return pattern
    return pattern[: DISPLAY_PATTERN_MAX_LENGTH - 3] + "..."


def _format_source(source: str) -> str:
    return source.replace("_", " ") if source else "messages"


# Sources whose pattern-less search lists messages; any other source lists its own records.
_MESSAGE_TITLE_SOURCES = {"", "messages", "email", "gmail", "imessage", "whatsapp"}


# Every backend grep source name; a `filters` key with one of these names is
# that source's nested filter block (backend validate.normalize.ts).
_GREP_SOURCES = set(SOURCE_FILTER_KEYS)
_MESSAGE_FAMILY_SOURCES = {"messages", "email", "gmail", "imessage", "whatsapp"}


def _filters(tool_call: Dict[str, Any]) -> Dict[str, Any]:
    filters = tool_call.get("filters")
    return filters if isinstance(filters, dict) else {}


def _sources_named_by_filters(tool_call: Dict[str, Any]) -> list:
    """Sources the filters select when the caller names none: nested blocks, then a printed path."""
    filters = _filters(tool_call)
    named = [key for key, value in filters.items() if key in _GREP_SOURCES and isinstance(value, dict) and value]
    path = filters.get("path")
    if isinstance(path, str):
        root = path.split("/", 1)[0]
        if root in _GREP_SOURCES and root not in named:
            named.append(root)
    return named


def _narrowed_to(search_call: Dict[str, Any], kept_sources: list) -> Dict[str, Any]:
    """Drop the filters only skipped sources accepted: their nested blocks, and
    flat or top-level keys no kept source accepts (the backend rejects both)."""
    kept_keys = {key for source in kept_sources for key in SOURCE_FILTER_KEYS.get(source, ())}
    kept_family = any(source in _MESSAGE_FAMILY_SOURCES for source in kept_sources)
    narrowed = {
        key: value
        for key, value in search_call.items()
        if key not in BROADCAST_GREP_PARAMS or key in kept_keys
    }
    filters = search_call.get("filters")
    if isinstance(filters, dict):

        def kept(key: str) -> bool:
            if key in _GREP_SOURCES:
                return key in kept_sources or (key == "messages" and kept_family)
            return key in kept_keys

        narrowed["filters"] = {key: value for key, value in filters.items() if kept(key)}
    return narrowed


def _title_source(tool_call: Dict[str, Any]) -> str:
    """Source label for the tool card: the legacy single source, else the requested list."""
    single = tool_call.get("source")
    if single:
        return str(single)
    return ", ".join(_extract_sources(tool_call))


def _format_grep_title(prefix: str, pattern: str, source: str) -> str:
    display_pattern = _truncate_pattern(pattern)
    source_label = _format_source(source) if source else "all local data"
    if display_pattern:
        return f'{prefix} {source_label} for "{display_pattern}"'
    if source.lower() in _MESSAGE_TITLE_SOURCES:
        return f"{prefix} {source_label} for all messages"
    return f"{prefix} {source_label}"


def _public_grep_params(tool_call: Dict[str, Any]) -> Dict[str, Any]:
    params: Dict[str, Any] = {}
    for key, value in tool_call.items():
        if key in _GREP_INTERNAL_DISPLAY_KEYS or key in _GREP_AGENT_ONLY_KEYS or value is None:
            continue
        params[_GREP_DISPLAY_KEY_ALIASES.get(key, key)] = value
    return params


def _backend_grep_call(tool_call: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in tool_call.items() if key not in _GREP_AGENT_ONLY_KEYS}


# Local, always-available sources: no external connector, so they never gate
# and don't need a connectivity probe.
_LOCAL_SOURCES = {"messages", "network", "agent_network", "agent_trajectories", "shared_project_agents", "summary"}
_DOCUMENT_PROVIDER_ALIASES = {
    "chat_gpt": "chatgpt",
    "chatgpy": "chatgpt",
    "notes": "apple_notes",
    "apple_notes": "apple_notes",
    "apple": "apple_notes",
}


def _normalize_source_key(value: Any) -> str:
    source = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return _DOCUMENT_PROVIDER_ALIASES.get(source, source)


def _document_provider(tool_call: Dict[str, Any]) -> Optional[str]:
    filters = _filters(tool_call)
    nested = filters.get("documents")
    nested_provider = nested.get("document_source") if isinstance(nested, dict) else None
    raw_provider = nested_provider or filters.get("document_source")
    if not raw_provider:
        return None
    return _normalize_source_key(raw_provider)


def _requires_source_access(tool_call: Dict[str, Any]) -> bool:
    return tool_call.get("require_source_access") is True


def _extract_sources(tool_call: Dict[str, Any]) -> list:
    """The explicit source list the caller asked for.

    Supports the multi-source ``sources: [...]`` form and the legacy single
    ``source``. Empty means "no explicit source" — the backend defaults to the
    local corpus (messages/network/agent_network), which never gates.
    """
    raw = tool_call.get("sources")
    if isinstance(raw, list) and raw:
        return [str(s) for s in raw if s]
    single = tool_call.get("source")
    if single:
        return [str(single)]
    # A nested filter block or a printed path names its own source (the
    # backend resolves it the same way), so the connection check covers it too.
    return _sources_named_by_filters(tool_call)


def _source_status_targets(tool_call: Dict[str, Any]) -> tuple[list, Dict[str, set]]:
    """Map requested grep sources to concrete connector keys for gate probing.

    `documents` is a searchable corpus, not a real connector. If the caller
    narrows documents to a provider, probe that provider and map an unavailable
    provider back to the `documents` search source so the backend grep is
    skipped until the concrete connector is resolved.
    """
    requested_sources = _extract_sources(tool_call)
    # Team availability is authorized by the backend per account. A reader's
    # missing personal connector must not block another member's shared inbox.
    if tool_call.get("scope") == "shared" or tool_call.get("team_id") or tool_call.get("owner_user_id"):
        requested_sources = [source for source in requested_sources if source not in {"email", "gmail", "imessage"}]
    document_provider = _document_provider(tool_call)
    targets: list = []
    target_to_search_sources: Dict[str, set] = {}
    for source in requested_sources:
        normalized_source = _normalize_source_key(source)
        if normalized_source in _LOCAL_SOURCES:
            continue
        if normalized_source == "documents":
            if not document_provider or not _requires_source_access(tool_call):
                continue
            target = document_provider
        else:
            target = normalized_source
        if not target:
            continue
        targets.append(target)
        target_to_search_sources.setdefault(target, set()).add(source)
    return list(dict.fromkeys(targets)), target_to_search_sources


def _unavailable_marker(unavailable: list) -> str:
    names = ", ".join(str(u.get("source")) for u in unavailable)
    return (
        f"⚠️ Source(s) not connected: {names}. These were skipped — do NOT retry them. "
        "A one-time connect request will be sent to the user after this exploration "
        "finishes; continue with any other available sources and report what you "
        "could and could not complete."
    )


async def execute_grep(
    execute_activity: ExecuteActivityCallable,
    tool_call: Dict[str, Any],
    tool_call_id: str,
    agent_id: str,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute grep search and post events via handle_tool_event."""
    pattern = tool_call.get("pattern") or ""
    source = _title_source(tool_call)

    progress_title = _format_grep_title("Searching", pattern, source)
    completed_title = _format_grep_title("Searched", pattern, source)
    failed_title = _format_grep_title("Grep failed searching", pattern, source)

    start_time = _safe_time()

    # IN_PROGRESS
    await handle_tool_event(
        event=ToolEvent(
            type=EventType.POST_MESSAGE,
            title=progress_title,
            message="",
            status=MessageStatus.IN_PROGRESS,
        ),
        agent_id=agent_id,
        tool_call_id=tool_call_id,
        tool_name="grep",
        execute_activity=execute_activity,
        user_id=user_id,
    )

    try:
        # Per-source connectivity: any explicitly-named source whose connector
        # isn't connected is a "source_unavailable" — skip it here (activities
        # can't pause) and hand the marker up. The parent workflow raises the
        # blocking source_connect gate after the explore agent returns.
        requested_sources = _extract_sources(tool_call)
        gateable_sources, gate_target_search_sources = _source_status_targets(tool_call)
        unavailable: list = []
        search_call = _backend_grep_call(tool_call)
        if gateable_sources:
            statuses = (
                await execute_activity(
                    source_status_activity,
                    args=[user_id or "", gateable_sources],
                    start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
                    retry_policy=RetryPolicy(maximum_attempts=ACTIVITY_MAX_ATTEMPTS),
                )
                or []
            )
            unavailable = [s for s in statuses if isinstance(s, dict) and not s.get("connected", True)]
            if unavailable:
                unavailable_targets = {str(s.get("source")) for s in unavailable}
                unavailable_search_sources = set()
                for target in unavailable_targets:
                    unavailable_search_sources.update(gate_target_search_sources.get(target, set()))
                # Everything requested minus the unavailable ones stays searchable
                # (keeps local sources + any connected external source).
                connected_sources = [s for s in requested_sources if s not in unavailable_search_sources]
                if not connected_sources:
                    # Nothing searchable — return an unavailable-only marker and
                    # skip the backend grep entirely.
                    marker = _unavailable_marker(unavailable)
                    await handle_tool_event(
                        event=ToolEvent(
                            type=EventType.POST_MESSAGE,
                            title=completed_title,
                            message=marker,
                            status=MessageStatus.FINISHED,
                        ),
                        agent_id=agent_id,
                        tool_call_id=tool_call_id,
                        tool_name="grep",
                        execute_activity=execute_activity,
                        user_id=user_id,
                    )
                    return {
                        "result": marker,
                        "usage": {"llm": [], "service": []},
                        "unavailable_sources": unavailable,
                    }
                # Partial: search only the connected sources this call.
                search_call = _narrowed_to(
                    {**_backend_grep_call(tool_call), "sources": connected_sources}, connected_sources
                )
                search_call.pop("source", None)

        logger.info(
            "Calling grep_activity",
            pattern=pattern[:LOG_PATTERN_MAX_LENGTH],
            source=source,
        )

        result = await execute_activity(
            grep_activity,
            args=[search_call, user_id, agent_id],
            start_to_close_timeout=timedelta(seconds=ACTIVITY_TIMEOUT_SECONDS),
            retry_policy=RetryPolicy(
                maximum_attempts=ACTIVITY_MAX_ATTEMPTS,
                backoff_coefficient=ACTIVITY_BACKOFF_COEFFICIENT,
                initial_interval=timedelta(seconds=ACTIVITY_INITIAL_INTERVAL_SECONDS),
                maximum_interval=timedelta(seconds=ACTIVITY_MAX_INTERVAL_SECONDS),
            ),
        )

        elapsed_time = _safe_time() - start_time

        message = format_tool_message(
            params=_public_grep_params(search_call),
            result=result,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )
        if unavailable:
            message = f"{message}\n\n{_unavailable_marker(unavailable)}"

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=completed_title,
                message=message,
                status=MessageStatus.FINISHED,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="grep",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        return {
            "result": result,
            "usage": {
                "llm": [],
                "service": [],
            },
            "unavailable_sources": unavailable,
        }

    except Exception as e:
        elapsed_time = _safe_time() - start_time

        error_message = format_error_message(
            params=_public_grep_params(tool_call),
            error=e,
            time_elapsed=elapsed_time,
            cost_cents=0,
        )

        await handle_tool_event(
            event=ToolEvent(
                type=EventType.POST_MESSAGE,
                title=failed_title,
                message=error_message,
                status=MessageStatus.ERROR,
            ),
            agent_id=agent_id,
            tool_call_id=tool_call_id,
            tool_name="grep",
            execute_activity=execute_activity,
            user_id=user_id,
        )

        raise


async def execute_grep_with_workflow(
    workflow_instance: Any,
    tool_call: Dict[str, Any],
    tool_call_id: str,
) -> Dict[str, Any]:
    """Workflow-aware grep path — a thin pass-through to ``execute_grep``.

    Source-connect gating no longer lives here. The main agent has no direct
    grep tool; grep runs inside the explore activity, where per-source
    connectivity is detected (``execute_grep`` returns a ``source_unavailable``
    marker) and the blocking gate is raised by the parent workflow after the
    explore agent returns (see ``spawn_agent`` + the ``gate`` domain).
    """
    return await execute_grep(
        execute_activity=workflow.execute_activity,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        agent_id=workflow_instance.agent_id,
        user_id=workflow_instance.user_id,
    )
