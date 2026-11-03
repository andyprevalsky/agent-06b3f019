"""Error handling utilities for unwrapping Temporal error wrappers."""

from typing import Any, Optional

from pydantic import ValidationError


def _selected_tool_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Discard errors from union branches whose tool discriminator did not match.

    Pydantic reports every branch of a tool union, in declaration order. A
    summary of the first few errors can otherwise omit the one field the chosen
    tool actually needs, leaving a structured-output retry without useful
    feedback. Keep all branches when the discriminator is absent or ambiguous.

    A branch whose only complaint is a model-level validator (for example
    ``check_spawn_agent_constraints`` raising "output_schema is required when
    type='browser'") reports its error at ``("tool_calls", i, "<branch>")`` —
    three parts, no field. That branch matched the discriminator and is exactly
    the one the retry must hear about, so a three-part loc is a branch entry
    too; only a four-part ``…tool`` literal mismatch marks a branch as foreign.
    """
    branches: dict[int, set[str]] = {}
    mismatched: set[tuple[int, str]] = set()
    for item in errors:
        loc = item.get("loc", ())
        if len(loc) < 3 or loc[0] != "tool_calls" or not isinstance(loc[1], int):
            continue
        branch = str(loc[2])
        branches.setdefault(loc[1], set()).add(branch)
        if len(loc) >= 4 and loc[-1] == "tool" and item.get("type") == "literal_error":
            mismatched.add((loc[1], branch))

    selected: dict[int, str] = {}
    for index, names in branches.items():
        matches = names - {branch for call_index, branch in mismatched if call_index == index}
        if len(matches) == 1:
            selected[index] = next(iter(matches))

    return [
        item
        for item in errors
        if not (
            len(item.get("loc", ())) >= 3
            and item["loc"][0] == "tool_calls"
            and isinstance(item["loc"][1], int)
            and item["loc"][1] in selected
            and str(item["loc"][2]) != selected[item["loc"][1]]
        )
    ]


def _prioritize_tool_call_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Show one error per tool call before spending the remaining summary slots."""
    first_by_call: dict[int, dict[str, Any]] = {}
    for item in errors:
        loc = item.get("loc", ())
        if len(loc) >= 2 and loc[0] == "tool_calls" and isinstance(loc[1], int):
            first_by_call.setdefault(loc[1], item)
    priority = list(first_by_call.values())
    prioritized_ids = {id(item) for item in priority}
    return priority + [item for item in errors if id(item) not in prioritized_ids]


def _safe_error_text(e: BaseException) -> str:
    """Return a compact error string without recursively rendering huge inputs."""
    if isinstance(e, ValidationError):
        errors = _prioritize_tool_call_errors(_selected_tool_errors(e.errors(include_input=False, include_url=False)))
        details: list[str] = []
        for item in errors[:5]:
            loc = ".".join(str(part) for part in item.get("loc", ()))
            msg = item.get("msg") or item.get("type") or "validation error"
            details.append(f"{loc}: {msg}" if loc else str(msg))
        suffix = ""
        remaining = len(errors) - len(details)
        if remaining > 0:
            suffix = f"; ... {remaining} more"
        return f"{len(errors)} validation error(s): " + "; ".join(details) + suffix

    try:
        msg = str(e)
    except Exception:
        msg = ""
    if len(msg) > 2000:
        return msg[:2000] + "... [truncated]"
    return msg


def _next_cause(e: BaseException) -> Any:
    cause = getattr(e, "cause", None)
    if cause is not None:
        return cause
    return getattr(e, "__cause__", None)


def error_chain_has_type(e: BaseException, error_type: str) -> bool:
    """Return whether a wrapped exception chain contains an application error type."""
    current: Any = e
    seen: set[int] = set()

    while isinstance(current, BaseException) and id(current) not in seen:
        seen.add(id(current))
        if type(current).__name__ == error_type or getattr(current, "type", None) == error_type:
            return True
        current = _next_cause(current)

    return False


def excluded_models_from_error(e: BaseException) -> frozenset[str]:
    """Models a structured-output failure already excluded, from anywhere in its chain.

    In-process the ``LLMStructuredOutputError`` carries ``excluded_models``; across
    the Temporal activity boundary the same set rides in ``ApplicationError.details``
    as ``{"excluded_models": [...]}``. The agent loop unions this into the next
    attempt's ``_skip_models`` so a model excluded after two invalid replies is not
    re-selected by the outer retry.
    """
    current: Any = e
    seen: set[int] = set()
    found: set[str] = set()
    while isinstance(current, BaseException) and id(current) not in seen:
        seen.add(id(current))
        direct = getattr(current, "excluded_models", None)
        if isinstance(direct, (set, frozenset, list, tuple)):
            found.update(str(model) for model in direct)
        details = getattr(current, "details", None)
        if isinstance(details, (list, tuple)):
            for detail in details:
                if isinstance(detail, dict) and isinstance(detail.get("excluded_models"), (list, tuple)):
                    found.update(str(model) for model in detail["excluded_models"])
        current = _next_cause(current)
    return frozenset(found)


def extract_error_message(e: Exception) -> str:
    """
    Extract the actual error message from an exception, unwrapping Temporal wrappers.

    Temporal wraps activity failures in ActivityError/ApplicationError which have
    generic messages like "Activity task failed". The real error is in .cause.
    """
    current = e
    messages = []
    seen: set[int] = set()
    deepest_specific_type: Optional[str] = None
    generic_types = {"Exception", "BaseException", "ActivityError", "ApplicationError"}

    while current is not None and id(current) not in seen:
        seen.add(id(current))
        msg = _safe_error_text(current)
        if msg and msg not in ("Activity task failed", ""):
            messages.append(msg)
        type_name = type(current).__name__
        if type_name and type_name not in generic_types:
            deepest_specific_type = type_name

        current = _next_cause(current)

    if messages:
        return messages[-1] if len(messages) > 1 else messages[0]
    # httpx.ReadTimeout and similar often have empty str(e); never hide the type.
    # Prefer the deepest non-generic type so Temporal wrappers do not mask the leaf.
    if deepest_specific_type:
        return deepest_specific_type
    type_name = type(e).__name__
    if type_name and type_name not in generic_types:
        return type_name
    return _safe_error_text(e) or "Unknown error"
