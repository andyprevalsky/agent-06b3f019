"""Wait-for domain service: business logic and orchestration.

Pure functions (format_duration, cap_evidence) and the Temporal activity
for lightweight LLM condition evaluation.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from temporalio import activity

from domains.wait_for.config import EVIDENCE_CHAR_BUDGET
from domains.wait_for.types import ConditionEvaluation

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

    Uses structured output (Pydantic schema) for reliable boolean extraction.

    Returns:
        Dict with satisfied (bool), reasoning (str)
    """
    from helpers.llm import call_llm, prepare_schema_for_openai

    activity.heartbeat("Evaluating condition")

    schema = prepare_schema_for_openai(ConditionEvaluation)

    system_prompt = (
        "You are a yes/no classifier. Given a condition and evidence gathered from "
        "the web, determine if the condition is currently satisfied."
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
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "ConditionEvaluation",
                "schema": schema,
                "strict": True,
            },
        },
        claude_token=claude_token,
        skip_cache_write=True,  # Unique evidence each poll -- no cache reuse
        call_site="wait_for",
    )
    raw = result.get("content", "")

    try:
        parsed = ConditionEvaluation.model_validate_json(raw)
        return {"satisfied": parsed.satisfied, "reasoning": parsed.reasoning}
    except Exception:
        # Fallback: try loose JSON parse
        try:
            data = json.loads(raw)
            return {
                "satisfied": bool(data.get("satisfied", False)),
                "reasoning": str(data.get("reasoning", raw.strip())),
            }
        except (json.JSONDecodeError, TypeError):
            return {"satisfied": False, "reasoning": raw.strip()}
