"""Bundle -> trimmed transcript for the compressor.

The archived `db/end.fixture` carries every Message row of the run (root and
its browser/explore work streams). Lifecycle chips, waits, evaluate calls and
in-progress duplicates carry no decision information, so they are dropped
deterministically before the LLM sees the run. What remains is the ordered
list of decisions (assistant tool calls) and their observed results.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, Optional

import structlog

from helpers.background_agents import is_agent_authored_user_metadata
from helpers.environment_context import is_environment_context_metadata
from providers.planner_memory.bundle import read_bundle_json, redact_reference_text
from providers.planner_memory.records import Transcript, TranscriptRow

logger = structlog.get_logger(__name__)

MAX_ROWS = 70
HEAD_ROWS = 20
MAX_ROW_TEXT = 320
MAX_TITLE = 160
MAX_CALL_GOAL = 360
MAX_TRANSCRIPT_CHARS = 48_000

_LIFECYCLE_TITLE_RE = re.compile(
    r"^(initializ|initialized|browser recording|browser network recording|browser diagnostics|"
    r"browser session ready|task started|starting up a browser|browser agent in progress|"
    r"credential referenced|waited |waiting |evaluate|navback|⚖️ verifying|saving|saved )",
    re.IGNORECASE,
)
_DROP_TOOLS = {"agent_init", "browser_session_auth"}
_CALL_KEYS = ("tool", "type", "start_url", "goal", "url", "query", "source", "attachments", "condition")
_SPAWN_PLANNER_TOOLS = {
    "browser": "spawn_browser_agent",
    "code": "spawn_code_agent",
    "explore": "spawn_explore_agent",
    "general_purpose": "spawn_general_purpose_agent",
    "for_each": "spawn_general_purpose_agent_for_each",
}


def _metadata(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("metadata")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _clip(text: Any, limit: int) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _compact_call(call: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in _CALL_KEYS:
        value = call.get(key)
        if value in (None, "", [], {}):
            continue
        if key == "goal":
            out[key] = _clip(redact_reference_text(str(value)), MAX_CALL_GOAL)
        elif isinstance(value, (str, int, float, bool)):
            out[key] = _clip(redact_reference_text(str(value)), MAX_ROW_TEXT)
        else:
            out[key] = _clip(redact_reference_text(json.dumps(value, default=str)), MAX_ROW_TEXT)
    # Archived assistant messages use the internal ``spawn_agent`` dispatcher,
    # but also retain its exact type. Resolve that pair here, where the evidence
    # is lossless, instead of guessing later from whichever tool labels survived
    # LLM compression.
    if out.get("tool") == "spawn_agent":
        planner_tool = _SPAWN_PLANNER_TOOLS.get(str(call.get("type") or "").strip().lower())
        if planner_tool:
            out["tool"] = planner_tool
    return out


def trim_rows(messages: list[dict[str, Any]]) -> tuple[list[TranscriptRow], int]:
    """Deterministic trim: keep decisions and observed results, drop lifecycle noise.

    Returns ``(rows, dropped_count)``. In-progress rows are dropped except a
    trailing one (the run may have ended waiting on the user).
    """
    ordered = sorted(messages, key=lambda r: (str(r.get("createdAt") or ""), str(r.get("id") or "")))
    kept: list[TranscriptRow] = []
    dropped = 0
    # The browser's current URL is stamped on progress rows that are dropped as
    # noise; carry it forward so every kept tool row knows where it happened.
    last_url: Optional[str] = None
    for index, row in enumerate(ordered):
        role = str(row.get("role") or "").upper()
        meta = _metadata(row)
        if isinstance(meta.get("browser_url"), str) and meta["browser_url"].strip():
            last_url = meta["browser_url"].strip()
        text = _clip(redact_reference_text(str(row.get("message") or "")), MAX_ROW_TEXT)
        tool = meta.get("toolName") if isinstance(meta.get("toolName"), str) else None
        if tool == "spawn_agent":
            planned_tool = meta.get("plannedToolName")
            if isinstance(planned_tool, str) and planned_tool in _SPAWN_PLANNER_TOOLS.values():
                tool = planned_tool
            else:
                tool = _SPAWN_PLANNER_TOOLS.get(str(meta.get("agentType") or "").strip().lower(), tool)
        status = meta.get("toolStatus") if isinstance(meta.get("toolStatus"), str) else None
        title = _clip(meta.get("title"), MAX_TITLE) if meta.get("title") else None
        if role == "SYSTEM" or (role == "USER" and is_environment_context_metadata(meta)):
            # Environment rows restate run-time state; they are not decisions or results.
            dropped += 1
            continue
        if role == "USER" and is_agent_authored_user_metadata(meta):
            # Agent notifications / agent-to-agent messages are not user turns.
            kept.append(
                TranscriptRow(
                    index=index,
                    role="tool",
                    tool=str(meta.get("toolName") or "agent_message"),
                    status=None,
                    title=None,
                    text=text,
                )
            )
            continue
        if role == "USER":
            if index == 0 or text:
                kept.append(TranscriptRow(index=index, role="user", tool=None, status=None, title=None, text=text))
            else:
                dropped += 1
            continue
        if role == "ASSISTANT":
            calls = tuple(_compact_call(call) for call in (meta.get("tool_calls") or []) if isinstance(call, dict))
            if not text and not calls:
                dropped += 1
                continue
            kept.append(
                TranscriptRow(index=index, role="assistant", tool=None, status=None, title=None, text=text, calls=calls)
            )
            continue
        # TOOL rows
        is_last = index == len(ordered) - 1
        if tool in _DROP_TOOLS or (title and _LIFECYCLE_TITLE_RE.match(title)):
            dropped += 1
            continue
        if status == "IN_PROGRESS" and not is_last:
            dropped += 1
            continue
        if not title and not text:
            dropped += 1
            continue
        url = last_url if tool == "spawn_browser_agent" or isinstance(meta.get("browser_url"), str) else None
        kept.append(
            TranscriptRow(
                index=index,
                role="tool",
                tool=tool,
                status=status,
                title=title,
                text=text,
                url=_clip(redact_reference_text(url), 300) if url else None,
            )
        )
    return kept, dropped


def _bound(rows: list[TranscriptRow]) -> tuple[list[TranscriptRow], int]:
    """Cap the row count (head + tail, the terminal path matters most) and total chars."""
    dropped = 0
    if len(rows) > MAX_ROWS:
        tail = MAX_ROWS - HEAD_ROWS
        dropped = len(rows) - MAX_ROWS
        rows = rows[:HEAD_ROWS] + rows[-tail:]
    while rows and sum(len(json.dumps(r.to_dict())) for r in rows) > MAX_TRANSCRIPT_CHARS:
        # Drop from the middle first: the first rows carry the goal and entry, the last the outcome.
        middle = len(rows) // 2
        del rows[middle]
        dropped += 1
    return rows, dropped


def build_transcript(
    *,
    root_agent_id: str,
    goal: str,
    messages: list[dict[str, Any]],
    passed: Optional[bool],
    root_status: Optional[str],
    failure_reason: Optional[str] = None,
    benchmark_task_name: Optional[str] = None,
) -> Transcript:
    rows, dropped = trim_rows(messages)
    tool_inventory = sorted(
        {
            tool
            for row in rows
            for tool in ([row.tool] if row.tool else []) + [str(call["tool"]) for call in row.calls if call.get("tool")]
        }
    )
    rows, dropped_more = _bound(rows)
    outcome: Literal["passed", "failed"]
    if passed is True or (passed is None and str(root_status or "").upper() == "COMPLETED"):
        outcome = "passed"
    else:
        outcome = "failed"
    note = ""
    if outcome == "failed":
        note = _clip(redact_reference_text(failure_reason or f"root status {root_status or 'unknown'}"), 400)
    return Transcript(
        root_agent_id=root_agent_id,
        goal=redact_reference_text(goal.strip()),
        outcome=outcome,
        outcome_note=note,
        benchmark_task_name=benchmark_task_name,
        rows=rows,
        tool_inventory=tuple(tool_inventory),
        total_rows=len(messages),
        dropped_rows=dropped + dropped_more,
    )


def load_bundle_transcript(root_agent_id: str) -> Optional[Transcript]:
    """Read one archived bundle (manifest + end fixture) and build its transcript."""
    manifest = read_bundle_json(root_agent_id, "manifest.json.gz.enc")
    if manifest is None:
        logger.warning("planner_memory.transcript.no_manifest", root_agent_id=root_agent_id)
        return None
    fixture = read_bundle_json(root_agent_id, "db/end.fixture.json.gz.enc")
    if fixture is None:
        logger.warning("planner_memory.transcript.no_end_fixture", root_agent_id=root_agent_id)
        return None
    rows = fixture.get("rows") if isinstance(fixture.get("rows"), dict) else {}
    messages = rows.get("Message") if isinstance(rows.get("Message"), list) else []
    run = manifest.get("run") if isinstance(manifest.get("run"), dict) else {}
    benchmark = manifest.get("benchmark_result") if isinstance(manifest.get("benchmark_result"), dict) else {}
    goal = run.get("root_goal")
    if not isinstance(goal, str) or not goal.strip():
        logger.warning("planner_memory.transcript.no_goal", root_agent_id=root_agent_id)
        return None
    task_name = manifest.get("benchmark_task_name")
    return build_transcript(
        root_agent_id=root_agent_id,
        goal=goal,
        messages=[m for m in messages if isinstance(m, dict)],
        passed=benchmark.get("passed") if isinstance(benchmark.get("passed"), bool) else None,
        root_status=run.get("root_status") if isinstance(run.get("root_status"), str) else None,
        failure_reason=benchmark.get("failure_reason") if isinstance(benchmark.get("failure_reason"), str) else None,
        benchmark_task_name=task_name if isinstance(task_name, str) and task_name else None,
    )
