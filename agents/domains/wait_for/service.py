"""Wait-for domain service: business logic and orchestration.

Pure functions (format_duration, cap_evidence) and the Temporal activity
for lightweight LLM condition evaluation.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from temporalio import activity

from domains.wait_for.config import EVIDENCE_CHAR_BUDGET
from domains.wait_for.types import ConditionEvaluation

DEPLOY_INTERRUPTED_ERROR_CODE = "DEPLOY_INTERRUPTED"

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def cap_evidence(evidence: str) -> str:
    """Truncate evidence to fit within the token budget for condition evaluation."""
    if len(evidence) <= EVIDENCE_CHAR_BUDGET:
        return evidence
    return evidence[:EVIDENCE_CHAR_BUDGET] + "\n\n[...evidence truncated to fit context window]"


def format_duration(seconds: int) -> str:
    """Format seconds into human-readable duration."""
    if seconds < 60:
        return f"{seconds} second{'s' if seconds != 1 else ''}"
    elif seconds < 3600:
        minutes = seconds / 60
        if minutes == int(minutes):
            minutes = int(minutes)
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        return f"{minutes:.1f} minutes"
    elif seconds < 86400:
        hours = seconds / 3600
        if hours == int(hours):
            hours = int(hours)
            return f"{hours} hour{'s' if hours != 1 else ''}"
        return f"{hours:.1f} hours"
    else:
        days = seconds / 86400
        if days == int(days):
            days = int(days)
            return f"{days} day{'s' if days != 1 else ''}"
        return f"{days:.1f} days"


def _parse_target(until_timestamp: str) -> Optional[datetime]:
    """Parse an ISO 8601 wait target the same way the handler does.

    Offset-less (naive) timestamps are treated as UTC, matching
    ``WaitForManager._timestamp_mode`` so resume math agrees with the original
    wait exactly.
    """
    try:
        target = datetime.fromisoformat(str(until_timestamp).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    return target


def pending_timestamp_wait_to_resume(messages: list[dict[str, Any]]) -> Optional[str]:
    """Return the ``until_timestamp`` of a timestamp ``wait_for`` that must be resumed.

    When a deploy migrates an agent (workflow replacement), an in-flight
    ``wait_for`` timestamp sleep is torn down and its tool call is force-closed
    with the ``DEPLOY_INTERRUPTED`` sentinel. The replacement workflow must
    resolve that wait deterministically from its ORIGINAL absolute target so the
    agent picks up where it left off instead of the completion depending on the
    LLM re-issuing ``wait_for``.

    This pure decision scans the conversation and returns the target of the most
    recent timestamp wait that is (a) not completed normally and (b) interrupted
    by deployment or still in progress. It returns the target whether or not it
    has elapsed: the caller re-arms via ``wait_for`` with ``resume=True``, which
    sleeps the remaining delta for a future target or completes immediately (no
    error) for an already-elapsed one. Returns ``None`` only when there is
    nothing to resume — no timestamp wait, it already completed, or its target
    is unparseable.

    ``messages`` are conversation rows shaped like ``{"role", "metadata", ...}``
    where ``metadata`` carries ``waitForMode``, ``untilTimestamp``, ``toolCallId``,
    ``toolStatus`` and (when interrupted) ``errorCode``.
    """
    # Aggregate every timestamp-wait tool-call by its id, in arrival order.
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for msg in messages:
        if msg.get("role") != "TOOL":
            continue
        metadata = msg.get("metadata") or {}
        if metadata.get("waitForMode") != "timestamp":
            continue
        call_id = metadata.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            continue
        group = groups.get(call_id)
        if group is None:
            group = {"until": None, "completed": False, "interrupted": False, "seq": len(order)}
            groups[call_id] = group
            order.append(call_id)

        until = metadata.get("untilTimestamp")
        if isinstance(until, str) and until:
            group["until"] = until

        status = str(metadata.get("toolStatus") or "").upper()
        error_code = metadata.get("errorCode")
        if error_code == DEPLOY_INTERRUPTED_ERROR_CODE:
            group["interrupted"] = True
        elif status in ("FINISHED", "SUCCESS", "COMPLETED"):
            # A terminal wait_for that is NOT a deploy interruption is a normal
            # "Wait complete" — the wait already fired, nothing to resume.
            group["completed"] = True
        group["last_status"] = status

    # The most recently active timestamp wait wins.
    for call_id in reversed(order):
        group = groups[call_id]
        if group["completed"]:
            return None
        until = group["until"]
        if not isinstance(until, str) or not until:
            return None
        pending = group["interrupted"] or group.get("last_status") == "IN_PROGRESS"
        if not pending:
            return None
        # Only require the target be well-formed; elapsed vs future is the
        # caller's concern (resume=True completes an elapsed wait immediately).
        return until if _parse_target(until) is not None else None

    return None


# ---------------------------------------------------------------------------
# Temporal activity -- condition evaluation
# ---------------------------------------------------------------------------


@activity.defn
async def evaluate_condition_activity(
    condition: str,
    evidence: str,
    model: str,
    claude_token: Optional[str] = None,
) -> dict[str, Any]:
    """Lightweight LLM call to determine if a condition is satisfied given evidence.

    Requests JSON explicitly and parses it locally.  The lite-provider waterfall
    includes routes that do not support provider-native structured output, so
    passing ``response_model`` here can reject an otherwise valid JSON answer
    before this activity gets a chance to parse it.

    Returns:
        Dict with satisfied (bool), reasoning (str)
    """
    from helpers.llm import call_llm

    activity.heartbeat("Evaluating condition")

    system_prompt = (
        "You are a yes/no classifier. Given a condition and evidence gathered from "
        "the web, determine if the condition is currently satisfied. Return exactly "
        "one JSON object with this shape and no prose or markdown: "
        '{"satisfied": true, "reasoning": "brief reason"}'
    )

    user_prompt = f"Condition: {condition}\n\nEvidence:\n{evidence}"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    result = await call_llm(
        messages,
        model=model,
        max_tokens=200,
        claude_token=claude_token,
        skip_cache_write=True,  # Unique evidence each poll -- no cache reuse
        call_site="wait_for",
    )
    raw = result.get("content", "")

    parsed = _parse_condition_evaluation(raw)
    if parsed is not None:
        return {"satisfied": parsed.satisfied, "reasoning": parsed.reasoning}
    return {"satisfied": False, "reasoning": raw.strip()}


def _parse_condition_evaluation(raw: Any) -> ConditionEvaluation | None:
    """Extract the first valid condition object from a provider response.

    Some fallback models prefix valid JSON with prose or wrap it in a markdown
    fence.  ``JSONDecoder.raw_decode`` lets us accept that harmless formatting
    while still validating the resulting object with the domain schema.
    """

    if not isinstance(raw, str):
        return None

    decoder = json.JSONDecoder()
    for index, character in enumerate(raw):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(raw[index:])
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        try:
            return ConditionEvaluation.model_validate(value)
        except Exception:
            # Preserve the previous loose-JSON behavior for truthy numeric
            # booleans and missing/free-form reasoning.
            if "satisfied" in value:
                return ConditionEvaluation(
                    satisfied=bool(value.get("satisfied", False)),
                    reasoning=str(value.get("reasoning", raw.strip())),
                )
    return None
