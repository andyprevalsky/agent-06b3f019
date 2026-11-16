"""Critical-path compressor: one LLM call per bundle, result cached forever.

The prompt is generic on purpose (no task names, no merchant names, no
benchmark vocabulary): the same prompt compresses every run in the archive.
A structural test pins the prompt to at most ``COMPRESSOR_PROMPT_MAX_LINES``
lines so it cannot quietly grow into a per-scenario rulebook.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Mapping, Optional

import structlog

from providers.planner_memory.bundle import sanitize_memory_text
from providers.planner_memory.records import CriticalPath, Transcript

logger = structlog.get_logger(__name__)

COMPRESSOR_VERSION = "cp-v7"
COMPRESSOR_PROMPT_MAX_LINES = 100
COMPRESSOR_CALL_SITE = "memory_compressor"
COMPRESSOR_MODEL = os.environ.get("PLANNER_MEMORY_COMPRESSOR_MODEL", "rose-labs/rose-1-ultra")
# call_llm credentials a caller may lend the compressor: the planner activity's own
# leased compute token, so a plan-time compression rides the same lease.
COMPRESSOR_AUTH_KWARGS = (
    "claude_token",
    "claude_token_source",
    "claude_token_pool_id",
    "claude_token_user_id",
    "gpt_token",
    "gpt_account_id",
    "gpt_token_source",
    "gpt_token_pool_id",
    "gpt_token_user_id",
    "compute_token_lineage_key",
)

COMPRESSOR_PROMPT = """You are given the transcript of one completed agent run and the goal it pursued.
Extract the shortest path that actually produced the outcome. Return JSON only.

Rules
- A step is kept only if removing it would have prevented the outcome.
- Collapse exploration that was later abandoned (navigating back, re-searching,
  switching hosts, retrying a rejected action) into one detour entry: what was
  tried, why it failed, how many transcript rows it cost.
- Prefer concrete entry points: the exact URL opened first, the tool used, the
  form selections made. Only include URLs that appear verbatim in the transcript.
- "tool" on a step is the exact tool name the transcript shows for that step
  (a tool row's tool, an assistant call's tool, or an action named in a title);
  use "reasoning" for a decision the agent made without a tool. Never a role
  such as "assistant" or "root agent".
- Never output the archive-internal name "spawn_agent". Assistant calls already
  expose its exact planner-facing tool (for example "spawn_browser_agent").
- Record the terminal condition: the exact state the run stopped in (for example
  "stopped at payment approval, order not placed").
- If the run failed, still extract the path taken and name the first requirement
  of the goal that the run did not satisfy.
- Pitfalls are things the next run must avoid or must do to reach the same
  outcome faster. Only include what the transcript shows.
- Never include credentials, card numbers, one-time codes, session tokens, or
  personal data beyond what the goal itself states.
- Limits: at most 8 steps, 5 detours, 5 pitfalls; every string under 200 chars.

Transcript rows are ordered. "calls" on assistant rows are the tool calls the
agent made; tool rows are the observed results (title = UI chip, text = result).
"tool_inventory" lists every exact tool retained before long transcripts are
head/tail bounded; output tool names must come from that list or be "reasoning".
"""

_USER_TEMPLATE = "GOAL: {goal}\n\nRUN:\n{payload}"


def compressor_prompt_line_count() -> int:
    return len(COMPRESSOR_PROMPT.strip("\n").splitlines())


def build_compressor_messages(transcript: Transcript) -> list[dict[str, Any]]:
    payload = json.dumps(transcript.to_prompt_payload(), ensure_ascii=False, separators=(",", ":"))
    return [
        {"role": "system", "content": COMPRESSOR_PROMPT},
        {"role": "user", "content": _USER_TEMPLATE.format(goal=transcript.goal, payload=payload)},
    ]


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_memory_text(value)
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if isinstance(value, dict):
        return {key: _scrub(item) for key, item in value.items()}
    return value


def parse_critical_path(content: str) -> CriticalPath:
    """Validate, clamp, and scrub the compressor output (credentials, emails, phones never persist)."""
    record = CriticalPath.model_validate_json(content).clamped()
    tools = [entry.tool for entry in record.entry_points] + [step.tool for step in record.critical_path]
    if any(tool.strip().lower() == "spawn_agent" for tool in tools):
        raise ValueError("memory compressor returned archive-internal spawn_agent instead of a planner-facing tool")
    return CriticalPath.model_validate(_scrub(record.model_dump()))


async def compress_transcript(
    transcript: Transcript,
    *,
    model: Optional[str] = None,
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
    llm_auth: Optional[Mapping[str, Any]] = None,
) -> CriticalPath:
    """Run the compressor LLM once for ``transcript`` and return the clamped record.

    ``llm_auth`` carries the caller's leased compute token (``COMPRESSOR_AUTH_KWARGS``).
    """
    from helpers.llm import call_llm

    auth = {key: value for key, value in (llm_auth or {}).items() if key in COMPRESSOR_AUTH_KWARGS and value}
    started = time.perf_counter()
    result = await call_llm(
        build_compressor_messages(transcript),
        model=model or COMPRESSOR_MODEL,
        temperature=0.1,
        # Reasoning tokens share this budget on the waterfall; 4k truncated the JSON mid-string.
        max_tokens=16000,
        response_model=CriticalPath,
        call_site=COMPRESSOR_CALL_SITE,
        agent_id=agent_id,
        user_id=user_id,
        skip_cache_write=True,
        **auth,
    )
    content = result.get("content") if isinstance(result, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("memory compressor returned no content")
    record = parse_critical_path(content)
    if transcript.outcome != record.outcome:
        # The transcript's outcome comes from the benchmark verdict / root status; it wins.
        record = CriticalPath(**{**record.model_dump(), "outcome": transcript.outcome})
    logger.info(
        "planner_memory.compressed",
        root_agent_id=transcript.root_agent_id,
        outcome=record.outcome,
        steps=len(record.critical_path),
        detours=len(record.detours),
        rows_in=len(transcript.rows),
        elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
        model=(result or {}).get("model") if isinstance(result, dict) else None,
    )
    return record
