"""Admit complete text attachments against the materialized request's budget."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TypeVar

from helpers.context_limits import AUTOCOMPACT_BUFFER_TOKENS, MAX_LLM_ESCALATION_TOKENS
from helpers.model_info import _DEFAULT_CONTEXT_WINDOW

T = TypeVar("T")


class AttachmentContextLimitError(ValueError):
    """A worker cannot access a required attached source within its context."""


def serialized_token_upper_bound(value: Any) -> int:
    """A UTF-8 byte is at most one byte-token; JSON also covers text framing.

    This deliberately avoids a model-specific text tokenizer approximation.
    Image/PDF model costs are provider-specific; their serialized size alone
    does not establish a bound on their decoded multimodal token usage.
    """
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


@dataclass(frozen=True)
class PreparedTextAttachment:
    inline: str
    metadata: str
    filename: str = ""


async def admit_text_attachments(
    render: Callable[[Callable[[PreparedTextAttachment], str]], Awaitable[T]],
    *,
    max_context_tokens: int = _DEFAULT_CONTEXT_WINDOW,
    request_overhead: Any = None,
    max_output_tokens: int = MAX_LLM_ESCALATION_TOKENS,
    require_inline: bool = False,
) -> T:
    """Render the same request measured by admission, preserving every source.

    The first projection contains metadata only. A second projection includes
    whole admitted bodies. Reference resolution can change their rendered cost;
    the final complete projection must fit too, otherwise use metadata only.
    No renderer or persistent file contents are truncated or rewritten.
    """
    candidates: list[PreparedTextAttachment] = []

    def collect(candidate: PreparedTextAttachment) -> str:
        candidates.append(candidate)
        return candidate.metadata

    baseline = await render(collect)
    limit = max(0, max_context_tokens - max_output_tokens - AUTOCOMPACT_BUFFER_TOKENS)
    baseline_cost = serialized_token_upper_bound({"messages": baseline, "overhead": request_overhead})
    if not candidates:
        return baseline
    remaining = limit - baseline_cost
    selected: set[int] = set()
    for index, candidate in enumerate(candidates):
        cost = max(0, serialized_token_upper_bound(candidate.inline) - serialized_token_upper_bound(candidate.metadata))
        if cost <= remaining:
            selected.add(index)
            remaining -= cost
    unavailable = [candidate.filename for index, candidate in enumerate(candidates) if index not in selected]
    if require_inline and unavailable:
        raise AttachmentContextLimitError(
            "Required text attachments exceed this worker's context allowance: " + ", ".join(unavailable)
        )
    if not selected:
        return baseline
    index = 0
    projection_valid = True

    def project(candidate: PreparedTextAttachment) -> str:
        nonlocal index, projection_valid
        if index >= len(candidates) or candidate != candidates[index]:
            projection_valid = False
            return candidate.metadata
        chosen = index in selected
        index += 1
        return candidate.inline if chosen else candidate.metadata

    projected = await render(project)
    if (
        not projection_valid
        or index != len(candidates)
        or serialized_token_upper_bound({"messages": projected, "overhead": request_overhead}) > limit
    ):
        if require_inline:
            raise AttachmentContextLimitError(
                "Required text attachments exceed the allowance after reference resolution: "
                + ", ".join(candidate.filename for candidate in candidates)
            )
        return baseline
    return projected


def attachment_request_overhead(response_model: Any, extra_user_message: str | None = None) -> Any:
    """Reserve both actual schema projections; either provider can serve this call."""
    from providers.rose.schema import build_anthropic_tools_from_response_model, build_openai_response_format

    return {
        "tools": build_anthropic_tools_from_response_model(response_model),
        "response_format": build_openai_response_format(response_model),
        "extra_user_message": extra_user_message,
    }
