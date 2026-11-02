#!/usr/bin/env python3
"""Summarize /deploy, /RCA, and /descend timing from factory telemetry."""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import re
import sqlite3
import statistics
import subprocess
import sys
import webbrowser
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from itertools import pairwise
from pathlib import Path
from typing import Any

DEFAULT_DB = Path.home() / "Library/Application Support/com.conductor.app/conductor.db"
DEFAULT_REPO = "navi-whisper-lux-v2"
DEFAULT_FACTORY_LEDGER = Path("agents/benchmarks/history/factory_events.jsonl")
DEFAULT_TELEMETRY_ROOT = Path(".context")
DEFAULT_HISTORY_DIR = Path("agents/benchmarks/history")
DEFAULT_CATALOG = Path("agents/benchmarks/tasks.json")
# Same-branch predeploy attempts further apart than this are separate deploys.
PREDEPLOY_DEPLOY_GAP_SECONDS = 6 * 60 * 60
# Attempts without a branch-named span file are clustered by this time gap.
PREDEPLOY_UNATTRIBUTED_GAP_SECONDS = 2 * 60 * 60
PREDEPLOY_WINDOW_DAYS = 30
SPAN_BRANCH_FILE_RE = re.compile(r"^span_durations\.(\d{8})\.(.+)\.jsonl$")
SPAN_UNBRANCHED_SUFFIX_RE = re.compile(r"\d+|overflow")
DEFAULT_DEPLOY_SINCE = "2026-07-11"
DEFAULT_DESCEND_HISTORY = (
    Path(__file__).resolve().parents[1]
    / "agents/benchmarks/history/descend_steps.jsonl"
)
COMMAND_RE = re.compile(r"^\s*/(deploy|rca)\b", re.IGNORECASE)
FACTORY_EVENT_RE = re.compile(
    r"^\s*(?:python(?:3)?|[^\s]*/python(?:3)?)\s+"
    r"(?:(?:\./)?scripts/|[^\s]*/scripts/)record_factory_event\.py\s+"
    r"(deploy|rca)\s+([a-z-]+)\s+([a-z-]+)(?:\s+--detail(?:=|\s+)[^\s;&|]+)*\s*$",
    re.IGNORECASE,
)
APPROVAL_REQUEST_RE = re.compile(
    r"please\s+(?:explicitly\s+)?approve|"
    r"(?:explicit|human|your)\s+approval\s+(?:is\s+)?(?:required|needed)|"
    r"(?:need|awaiting)\s+(?:your\s+)?(?:explicit\s+)?approval|"
    r"reply.{0,120}\bapprove\b",
    re.IGNORECASE | re.DOTALL,
)
APPROVAL_GATE_CONTEXT_RE = re.compile(
    r"\bprompt\b|\bllm-visible\b|\bagent[- ]behavior\b|"
    r"\brecovery\b|\bterminal[- ]behavior\b|"
    r"\bmandatory\b.{0,50}\b(?:approval|guard)\b|"
    r"\bapproval\b.{0,30}\bguard\b|/deploy",
    re.IGNORECASE | re.DOTALL,
)
NON_BLOCKING_APPROVAL_RE = re.compile(
    r"if\s+you\s+want\s+(?:it|this|that)\s+included|"
    r"(?:i(?:'ll|\s+will)\s+)?continue\s+(?:this\s+)?deploy.{0,120}\bmeanwhile\b|"
    r"(?:does\s+not|doesn't|won't|will\s+not)\s+block\s+(?:this\s+)?deploy|"
    r"(?:this\s+)?/deploy\s+is\s+not\s+blocked|"
    r"\bwill\s+continue\s+now\b|"
    r"\boptional\b.{0,80}\b(?:approval|follow-up)\b",
    re.IGNORECASE | re.DOTALL,
)
APPROVAL_REJECTION_RE = re.compile(
    r"^\s*(?:(?:no|ok(?:ay)?)[,!.]?\s+)?"
    r"(?:(?:i\s+)?(?:do\s+not|don't)\s+approve|"
    r"(?:i\s+)?reject(?:ed)?|not\s+approved)"
    r"(?:\s+(?:it|this\b.*|that\b.*|these\b.*|the\b.*|and\b.*)|\s*[-—]\s*.*)?"
    r"[.!]?\s*$",
    re.IGNORECASE,
)
APPROVAL_DECISION_RE = re.compile(
    r"^\s*(?:(?:yes|ok(?:ay)?)[,!.]?\s+)?"
    r"(?:(?:i\s+)?(?:actually\s+)?approve(?:d)?|approved)"
    r"(?:\s+(?:it|this\b.*|that\b.*|these\b.*|the\b.*|fine|and\b.*)|\s*[-—]\s*.*)?"
    r"[.!]?\s*$",
    re.IGNORECASE,
)
ASSISTANT_APPROVAL_DECISION_RE = re.compile(
    r"\b(?:treating|treated|treat)\b.{0,120}\bas\s+(?:an?\s+)?(?:approval|rejection)\b|"
    r"(?:^|[.!?]\s+)(?:the\s+)?(?:approval|rejection)\s+"
    r"(?:(?:has|had)\s+been|was|is)\s+"
    r"(?:received|recorded|confirmed)\b",
    re.IGNORECASE | re.DOTALL,
)
ASSISTANT_APPROVAL_NEGATION_RE = re.compile(
    r"\b(?:approval|rejection)\b.{0,30}\b(?:not|never)\b.{0,30}"
    r"\b(?:received|recorded|confirmed)\b|"
    r"\b(?:not|never)\b.{0,30}\b(?:approved|rejected)\b",
    re.IGNORECASE | re.DOTALL,
)
MAX_APPROVAL_RESUME_SECONDS = 24 * 60 * 60

APPROVAL_GATES = {
    "prompt-approval",
    "agent-behavior-approval",
    "llm-trajectory-injection-approval",
}
AUTO_FIX_GATES = {
    "prettier",
    "eslint-fix",
    "research-fix",
    "mac-format",
    "mac-lint-fix",
}
STATIC_VERIFY_GATES = {
    "eslint",
    "typescript",
    "structural",
    "mac-static",
    "research-static",
    "credential-health",
}
COVERAGE_GATES = {
    "backend-coverage",
    "frontend-coverage",
    "agents-coverage",
    "mac-coverage",
    "unresolved-coverage",
}
BLACKBOX_GATES = {
    "backend-blackbox",
    "agents-blackbox",
    "mac-blackbox",
    "backend-coverage",
    "frontend-coverage",
    "agents-coverage",
    "mac-coverage",
    "credential-health",
}
MULTI_FAMILY_GATES = {
    "backend-coverage",
    "frontend-coverage",
    "agents-coverage",
    "mac-coverage",
    "credential-health",
}
AGENTCARD_GATES = {
    "agentcard-lifecycle",
}
SMOKE_GATES = {"smoke", "targeted-smoke"}
SEMANTIC_GATES = {"semantic"}
NON_EXECUTING_PREFIXES = (
    "grep ",
    "rg ",
    "sed ",
    "find ",
    "cat ",
    "head ",
    "tail ",
    "ps ",
    "lsof ",
    "git add ",
    "git commit ",
    "gh pr create ",
    "gh pr edit ",
    "gh pr comment ",
    "gh api ",
)

DEPLOY_FAMILIES = {
    "Approval guards": APPROVAL_GATES,
    "Auto-fix": AUTO_FIX_GATES,
    "Static verify": STATIC_VERIFY_GATES,
    "Coverage": COVERAGE_GATES,
    "Runtime blackbox": BLACKBOX_GATES,
    "Smoke benchmarks": SMOKE_GATES,
    "AgentCard lifecycle": AGENTCARD_GATES,
    "Semantic tests": SEMANTIC_GATES,
}
DEPLOY_STEP_LABELS = [
    "Approval guards",
    "Auto-fix",
    "Static verify",
    "Coverage",
    "Runtime blackbox",
    "Code review",
    "Smoke benchmarks",
    "AgentCard lifecycle",
    "Semantic tests",
    "Production verify",
]
DEPLOY_GROUP_SUMMARIES = {
    "Group 3 wall clock": (
        "Static verify",
        "Coverage",
        "Runtime blackbox",
    ),
    "Group 4 wall clock": (
        "Code review",
        "Smoke benchmarks",
        "AgentCard lifecycle",
        "Semantic tests",
    ),
}
# Sub-stages such as cooperative-cutover nest inside production-verify, so only
# these top-level lifecycles must pair back-to-back for an instrumented deploy.
DEPLOY_LIFECYCLE_STAGES = frozenset(
    {"runtime-blackbox", "code-review", "production-verify"}
)
HISTORICAL_UNSPLIT_LABEL = "Historical unsplit calls"
DUAL_ATTRIBUTION_LABEL = "Combined coverage-blackbox attribution"
DEPLOY_VALUE_LABELS = [
    "Approval guards",
    "Auto-fix",
    HISTORICAL_UNSPLIT_LABEL,
    *DEPLOY_STEP_LABELS[2:],
]
DEPLOY_REPORT_LABELS = [
    "Approval guards",
    "Auto-fix",
    "Static verify",
    "Coverage",
    "Runtime blackbox",
    "Group 3 wall clock",
    "Code review",
    "Smoke benchmarks",
    "AgentCard lifecycle",
    "Semantic tests",
    "Group 4 wall clock",
    "Production verify",
    "Total",
]

RCA_LABELS = ["Evidence + trace", "Reproduce + diagnose", "Verify + handoff"]
DEPLOY_PHASES = {
    "Approval guards": 1,
    "Auto-fix": 2,
    "Static verify": 3,
    "Coverage": 3,
    "Runtime blackbox": 3,
    "Smoke benchmarks": 4,
    "AgentCard lifecycle": 4,
    "Semantic tests": 4,
}
STAGE_BADGES = {
    "deploy": {
        "Approval guards": ("1", "stage-neutral"),
        "Auto-fix": ("2", "stage-neutral"),
        "Static verify": ("3", "parallel-1"),
        "Coverage": ("3", "parallel-1"),
        "Runtime blackbox": ("3", "parallel-1"),
        "Group 3 wall clock": ("3", "parallel-1"),
        "Smoke benchmarks": ("4", "parallel-2"),
        "Code review": ("4", "parallel-2"),
        "AgentCard lifecycle": ("4", "parallel-2"),
        "Semantic tests": ("4", "parallel-2"),
        "Group 4 wall clock": ("4", "parallel-2"),
        "Production verify": ("5", "stage-neutral"),
        "Total": ("Total", "stage-special"),
    },
    "rca": {
        "Evidence + trace": ("1", "stage-neutral"),
        "Reproduce + diagnose": ("2", "stage-neutral"),
        "Verify + handoff": ("3", "stage-neutral"),
    },
}
STEP_DESCRIPTIONS = {
    "deploy": {
        "Approval guards": "Approval requested → approved or rejected.",
        "Auto-fix": "Formats files and applies lint fixes.",
        "Static verify": "Lint, types, structure, and focused live credentials.",
        "Coverage": "Thresholds for backend, frontend, agents, and mac.",
        "Runtime blackbox": (
            "Four suites under coverage, then focused credential and Amplitude probes."
        ),
        "Group 3 wall clock": "Wall clock while any Group 3 lane was running.",
        "Code review": (
            "Immutable-HEAD CodeRabbit or Claude review; at most three cycles."
        ),
        "Smoke benchmarks": "Agent benchmarks on isolated local stacks.",
        "AgentCard lifecycle": "Payment issuance, recovery, and cleanup E2E.",
        "Semantic tests": "Playwright flows on the full local stack.",
        "Group 4 wall clock": "Wall clock while any Group 4 lane was running.",
        "Production verify": (
            "Merge → last verified production signal; explicit lifecycle hooks "
            "replace inference going forward."
        ),
        "Total": "Logical deploy, including cross-turn approval waits.",
    },
    "rca": {
        "Evidence + trace": "Read runtime evidence and trace the first-bad boundary.",
        "Reproduce + diagnose": "Fail the local repro and prove the deepest owned cause.",
        "Verify + handoff": (
            "Pass the unchanged repro, cement it, and complete review or publication."
        ),
    },
}
TREND_SCALES = {"weekly": 12, "monthly": 12, "quarterly": 8}


@dataclass(frozen=True)
class Invocation:
    tool_id: str
    name: str
    detail: str
    result: str
    start: float
    end: float
    is_error: bool

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class Turn:
    command: str
    workspace: str
    session_id: str
    turn_id: str
    started_at: str
    duration: float
    status: str
    final_text: str
    invocations: tuple[Invocation, ...]
    # Resolved approval waits whose request originated in this /deploy attempt.
    approval_durations: tuple[float, ...] = ()
    # Resolved waits proven to have been consumed by this completed /deploy.
    consumed_approval_durations: tuple[float, ...] = ()
    lifecycle_duration: float | None = None
    approval_events: tuple[ApprovalLifecycle, ...] = ()


@dataclass(frozen=True)
class ApprovalLifecycle:
    workspace: str
    session_id: str
    request_turn_id: str
    deploy_started_at: str
    requested_at: str
    decided_at: str
    decision: str
    request_source: str = "inferred"
    decision_source: str = "user"

    @property
    def duration(self) -> float:
        return max(
            0.0,
            (
                parse_time(self.decided_at) - parse_time(self.requested_at)
            ).total_seconds(),
        )


@dataclass(frozen=True)
class StepTiming:
    runs: int
    durations: tuple[float, ...]
    wall_seconds: float
    incomplete: bool = False
    intervals: tuple[tuple[float, float], ...] = ()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def message_blocks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    message = payload.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict)]


def text_blocks(payload: dict[str, Any]) -> Iterable[str]:
    for block in message_blocks(payload):
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            yield block["text"]


def assistant_message_text(content: str) -> str:
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return ""
    if payload.get("type") != "assistant":
        return ""
    return "\n".join(text_blocks(payload))


def user_approval_decision(text: str) -> str | None:
    if APPROVAL_REJECTION_RE.search(text):
        return "rejected"
    if APPROVAL_DECISION_RE.search(text):
        return "approved"
    return None


def assistant_approval_decision(text: str) -> str | None:
    if ASSISTANT_APPROVAL_NEGATION_RE.search(text):
        return None
    if not ASSISTANT_APPROVAL_DECISION_RE.search(text):
        return None
    return (
        "rejected" if re.search(r"\brejection\b", text, re.IGNORECASE) else "approved"
    )


def parse_factory_event_command(command: str) -> tuple[str, str, str] | None:
    match = FACTORY_EVENT_RE.fullmatch(command)
    if match is None:
        return None
    return tuple(value.lower() for value in match.groups())


def factory_event_confirmation(result: str, expected: tuple[str, str, str]) -> bool:
    for line in result.splitlines():
        if not line.startswith("FACTORY_EVENT "):
            continue
        try:
            payload = json.loads(line.removeprefix("FACTORY_EVENT "))
        except (json.JSONDecodeError, TypeError):
            continue
        observed = tuple(
            str(payload.get(key, "")).lower() for key in ("workflow", "event", "value")
        )
        if observed == expected:
            return True
    return False


def factory_event(invocation: Invocation) -> tuple[str, str, str] | None:
    if invocation.is_error:
        return None
    event = parse_factory_event_command(shell_command(invocation))
    if event is None or not factory_event_confirmation(invocation.result, event):
        return None
    return event


def message_payload(content: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def tool_result_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(tool_result_text(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "content", "output"):
            if key in value:
                return tool_result_text(value[key])
        return json.dumps(value, sort_keys=True)
    return str(value)


def find_approval_lifecycles(
    rows: Sequence[sqlite3.Row],
    command_by_turn: dict[tuple[str, str], tuple[str, str]],
) -> list[ApprovalLifecycle]:
    """Find request-to-human-decision spans, including decisions in later turns."""
    pending: dict[str, dict[str, str]] = {}
    active_deploy: dict[str, dict[str, str]] = {}
    latest_user: dict[str, tuple[str, str]] = {}
    pending_factory_tools: dict[tuple[str, str], tuple[tuple[str, str, str], str]] = {}
    lifecycles: list[ApprovalLifecycle] = []
    for row in rows:
        session_id = str(row["session_id"])
        turn_id = str(row["turn_id"] or "")
        created_at = str(row["created_at"])
        role = str(row["role"])
        content = str(row["content"] or "")
        payload = message_payload(content)
        blocks = message_blocks(payload) if payload is not None else []
        confirmed_events: list[tuple[tuple[str, str, str], str]] = []
        for block in blocks:
            if block.get("type") == "tool_use":
                tool_id = str(block.get("id", ""))
                tool_input = block.get("input")
                if not tool_id or not isinstance(tool_input, dict):
                    continue
                command = next(
                    (
                        value
                        for key in ("command", "cmd")
                        if isinstance((value := tool_input.get(key)), str)
                    ),
                    "",
                )
                event = parse_factory_event_command(command)
                if event is not None:
                    pending_factory_tools[(session_id, tool_id)] = (
                        event,
                        created_at,
                    )
            elif block.get("type") == "tool_result":
                tool_id = str(block.get("tool_use_id", ""))
                pending_tool = pending_factory_tools.pop((session_id, tool_id), None)
                if pending_tool is None or bool(block.get("is_error", False)):
                    continue
                event, invoked_at = pending_tool
                result = tool_result_text(block.get("content", ""))
                if factory_event_confirmation(result, event):
                    confirmed_events.append((event, invoked_at))

        is_machine_message = bool(blocks)
        if role == "user" and not is_machine_message:
            command_info = command_by_turn.get((session_id, turn_id))
            if command_info is not None and command_info[0] == "deploy":
                active_deploy[session_id] = {
                    "workspace": str(row["directory_name"]),
                    "session_id": session_id,
                    "request_turn_id": turn_id,
                    "deploy_started_at": command_info[1],
                }
            latest_user[session_id] = (created_at, content)
            if session_id in pending:
                decision = user_approval_decision(content)
                if decision:
                    item = pending.pop(session_id)
                    lifecycles.append(
                        ApprovalLifecycle(
                            **item,
                            decided_at=created_at,
                            decision=decision,
                            decision_source="user",
                        )
                    )
            continue

        assistant_text = assistant_message_text(content)
        request_event_seen = False
        for (workflow, event, value), invoked_at in confirmed_events:
            if workflow != "deploy":
                continue
            if event == "approval-request" and session_id in active_deploy:
                pending[session_id] = {
                    **active_deploy[session_id],
                    "requested_at": invoked_at,
                    "request_source": "event",
                }
                request_event_seen = True
            elif event == "approval-decision" and session_id in pending:
                decision_row = latest_user.get(session_id)
                if decision_row and parse_time(decision_row[0]) >= parse_time(
                    pending[session_id]["requested_at"]
                ):
                    item = pending.pop(session_id)
                    lifecycles.append(
                        ApprovalLifecycle(
                            **item,
                            decided_at=decision_row[0],
                            decision=value,
                            decision_source="event",
                        )
                    )
        if not assistant_text:
            continue
        is_approval_request = bool(
            APPROVAL_REQUEST_RE.search(assistant_text)
            and APPROVAL_GATE_CONTEXT_RE.search(assistant_text)
            and not NON_BLOCKING_APPROVAL_RE.search(assistant_text)
        )
        pending_event = pending.get(session_id)
        event_is_current = bool(
            pending_event
            and pending_event.get("request_source") == "event"
            and (
                parse_time(created_at) - parse_time(pending_event["requested_at"])
            ).total_seconds()
            < 60
        )
        if (
            is_approval_request
            and session_id in active_deploy
            and not request_event_seen
            and not event_is_current
        ):
            # A later snapshot-scoped request supersedes an older unresolved
            # request. Measure the wait for the snapshot the human decided on.
            pending[session_id] = {
                **active_deploy[session_id],
                "requested_at": created_at,
                "request_source": "inferred",
            }
            continue

        assistant_decision = assistant_approval_decision(assistant_text)
        if session_id in pending and assistant_decision:
            decision_row = latest_user.get(session_id)
            if decision_row and parse_time(decision_row[0]) >= parse_time(
                pending[session_id]["requested_at"]
            ):
                item = pending.pop(session_id)
                lifecycles.append(
                    ApprovalLifecycle(
                        **item,
                        decided_at=decision_row[0],
                        decision=assistant_decision,
                        decision_source="assistant",
                    )
                )
    return lifecycles


def consumes_decision(turn: Turn, lifecycle: ApprovalLifecycle) -> bool:
    approval_commands = [
        shell_command(invocation)
        for invocation in turn.invocations
        if classify_deploy_gates(invocation) & APPROVAL_GATES
    ]
    if lifecycle.decision == "rejected":
        return bool(approval_commands)
    return any(
        re.search(
            r"(?:--)?mandatory-human-approval-retrieved=true",
            command,
        )
        for command in approval_commands
    )


def attach_approval_lifecycles(
    turns: Sequence[Turn], lifecycles: Sequence[ApprovalLifecycle]
) -> list[Turn]:
    """Attach every observation to its request and proven consumption to completion."""
    observations: dict[tuple[str, str], list[ApprovalLifecycle]] = defaultdict(list)
    consumptions: dict[tuple[str, str], list[ApprovalLifecycle]] = defaultdict(list)
    for lifecycle in lifecycles:
        observations[(lifecycle.session_id, lifecycle.request_turn_id)].append(
            lifecycle
        )

        same_turn = next(
            (
                turn
                for turn in turns
                if turn.command == "deploy"
                and turn.status == "completed"
                and turn.turn_id == lifecycle.request_turn_id
                and turn.session_id == lifecycle.session_id
                and consumes_decision(turn, lifecycle)
                and parse_time(lifecycle.decided_at)
                <= parse_time(turn.started_at) + timedelta(seconds=turn.duration)
            ),
            None,
        )
        candidates = [
            turn
            for turn in turns
            if turn.command == "deploy"
            and turn.status == "completed"
            and turn.session_id == lifecycle.session_id
            and parse_time(turn.started_at) >= parse_time(lifecycle.decided_at)
            and (
                parse_time(turn.started_at) - parse_time(lifecycle.decided_at)
            ).total_seconds()
            <= MAX_APPROVAL_RESUME_SECONDS
            and consumes_decision(turn, lifecycle)
        ]
        target = same_turn or min(
            candidates, key=lambda turn: parse_time(turn.started_at), default=None
        )
        if target is not None:
            consumptions[(target.session_id, target.turn_id)].append(lifecycle)

    attached = []
    for turn in turns:
        key = (turn.session_id, turn.turn_id)
        observed = observations.get(key, [])
        consumed = consumptions.get(key, [])
        if not observed and not consumed:
            attached.append(turn)
            continue
        changes: dict[str, Any] = {
            "approval_durations": tuple(item.duration for item in observed),
            "consumed_approval_durations": tuple(item.duration for item in consumed),
            "approval_events": tuple(observed),
        }
        if consumed:
            turn_end = parse_time(turn.started_at) + timedelta(seconds=turn.duration)
            lifecycle_start = min(
                parse_time(item.deploy_started_at) for item in consumed
            )
            changes["lifecycle_duration"] = max(
                turn.duration, (turn_end - lifecycle_start).total_seconds()
            )
        attached.append(replace(turn, **changes))
    return attached


def deploy_duration(turn: Turn) -> float:
    return (
        turn.lifecycle_duration
        if turn.lifecycle_duration is not None
        else turn.duration
    )


def tool_detail(tool_input: dict[str, Any]) -> str:
    for key in ("command", "cmd"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value
    parts = [
        str(tool_input.get(key, ""))
        for key in ("file_path", "path", "pattern", "description", "prompt")
        if tool_input.get(key)
    ]
    return " ".join(parts) or json.dumps(tool_input, sort_keys=True)


def failure_separated_groups(
    invocations: Sequence[Invocation], grace_seconds: float = 0.0
) -> list[list[Invocation]]:
    """Split a step when work restarts after a failed pass."""
    if not invocations:
        return []
    groups: list[list[Invocation]] = [[]]
    failed_until: float | None = None
    for item in sorted(invocations, key=lambda value: value.start):
        if failed_until is not None and item.start >= failed_until + grace_seconds:
            groups.append([])
            failed_until = None
        groups[-1].append(item)
        if item.is_error:
            failed_until = max(failed_until or item.end, item.end)
    return groups


def retry_runs(invocations: Sequence[Invocation], grace_seconds: float = 0.0) -> int:
    return len(failure_separated_groups(invocations, grace_seconds))


def overlapping_groups(
    invocations: Sequence[Invocation], grace_seconds: float = 5.0
) -> list[list[Invocation]]:
    """Group parallel or immediately adjacent calls into one lifecycle."""
    groups: list[list[Invocation]] = []
    current_end = 0.0
    for item in sorted(invocations, key=lambda value: value.start):
        if not groups or item.start > current_end + grace_seconds:
            groups.append([item])
            current_end = item.end
        else:
            groups[-1].append(item)
            current_end = max(current_end, item.end)
    return groups


def interval_union_seconds(intervals: Sequence[tuple[float, float]]) -> float:
    if not intervals:
        return 0.0
    ordered = sorted(intervals)
    total = 0.0
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    return total + current_end - current_start


def grouped_timing(groups: Sequence[Sequence[Invocation]]) -> StepTiming:
    if not groups:
        return StepTiming(0, (), 0.0)
    intervals = [
        (
            min(item.start for item in group),
            max(item.end for item in group),
        )
        for group in groups
    ]
    durations = tuple(max(0.0, end - start) for start, end in intervals)
    return StepTiming(
        runs=len(groups),
        durations=durations,
        wall_seconds=interval_union_seconds(intervals),
        intervals=tuple(intervals),
    )


def invocation_timing(invocations: Sequence[Invocation]) -> StepTiming:
    """Measure execution bursts without adding parallel tool durations."""
    return grouped_timing(overlapping_groups(invocations))


def bounded_state_timing(
    invocations: Sequence[Invocation], start: float, end: float
) -> StepTiming:
    """Partition an inferred RCA state into start-to-end lifecycle spans."""
    groups = failure_separated_groups(invocations)
    retry_starts = [min(item.start for item in group) for group in groups[1:] if group]
    starts = [start, *[value for value in retry_starts if start < value < end]]
    ends = [*starts[1:], end]
    durations = tuple(max(0.0, finish - begin) for begin, finish in zip(starts, ends))
    return StepTiming(
        runs=len(durations),
        durations=durations,
        wall_seconds=max(0.0, end - start),
        intervals=tuple(zip(starts, ends)),
    )


def shell_command(invocation: Invocation) -> str:
    if invocation.name.lower() not in {"bash", "exec", "terminal", "exec_command"}:
        return ""
    return invocation.detail.lower()


def classify_deploy_gates(invocation: Invocation) -> set[str]:
    if "reused passed deploy stage" in invocation.result.lower():
        return set()
    command = shell_command(invocation)
    if not command:
        return set()
    if command.strip().startswith(NON_EXECUTING_PREFIXES):
        return set()
    gates: set[str] = set()
    wrapped = re.findall(r"run-deploy-stage\s+([a-z0-9-]+)", command)
    wrapped_names = {
        "prompt-approval": "prompt-approval",
        "agent-behavior-approval": "agent-behavior-approval",
        "prettier": "prettier",
        "eslint-fix": "eslint-fix",
        "eslint": "eslint",
        "typescript": "typescript",
        "backend-structural": "structural",
        "deploy-command-structural": "structural",
        "backend-coverage": "backend-coverage",
        "backend-coverage-blackbox": "backend-coverage",
        "frontend-coverage": "frontend-coverage",
        "frontend-coverage-blackbox": "frontend-coverage",
        "agents-coverage": "agents-coverage",
        "agents-coverage-blackbox": "agents-coverage",
        "mac-format": "mac-format",
        "mac-lint-fix": "mac-lint-fix",
        "mac-static": "mac-static",
        "mac-coverage": "mac-coverage",
        "mac-coverage-blackbox": "mac-coverage",
        "mac-blackbox": "mac-blackbox",
        "research-static": "research-static",
        "research-fix": "research-fix",
        "credential-health": "credential-health",
        "amplitude-live": "credential-health",
        "chat-router-failover-live": "credential-health",
        "migration-preflight": "credential-health",
        "backend-blackbox": "backend-blackbox",
        "smoke": "smoke",
        "semantic": "semantic",
        "agentcard-lifecycle": "agentcard-lifecycle",
        "agentcard-test-shop": "agentcard-lifecycle",
        "agentcard-setup-resume": "agentcard-lifecycle",
        "agentcard-idempotent-abandonment": "agentcard-lifecycle",
        "agentcard-abandonment": "agentcard-lifecycle",
    }
    gates.update(wrapped_names[name] for name in wrapped if name in wrapped_names)
    if "run_deploy_live_probes.py" in command:
        gates.add("credential-health")
    if wrapped:
        return gates

    if "check-prompt-human-approval.sh" in command:
        gates.add("prompt-approval")
    if "check-agent-behavior-approval.sh" in command and ".test.sh" not in command:
        gates.add("agent-behavior-approval")
    if "check-llm-trajectory-injection-approval.sh" in command and ".test.sh" not in command:
        gates.add("llm-trajectory-injection-approval")
    if re.search(
        r"\bnpx\s+prettier\s+--(?:write|check)\b|\bnpm\s+run\s+format(?::check)?\b",
        command,
    ):
        gates.add("mac-format" if "cd mac-app" in command else "prettier")
    if re.search(
        r"\bnpx\s+eslint\b|\bnpm\s+run\s+lint(?::fix)?\b|\bnode\s+scripts/lint-affected\.mjs\b",
        command,
    ):
        is_fix = bool(re.search(r"--fix\b|\blint:fix\b", command))
        if "cd mac-app" in command and is_fix:
            gates.add("mac-lint-fix")
        else:
            gates.add("eslint-fix" if is_fix else "eslint")
    if re.search(r"\bnpx\s+tsc\s+--noemit\b|\bnpm\s+run\s+type-check\b", command):
        gates.add("typescript")
    if re.search(
        r"\bnpx\s+tsx\s+[^\s]*tests/structural/|\bpytest\b[^\n;]*(?:structural|cloudbench_dependency_sync_test)|"
        r"bash\s+scripts/tests/(?:workspace-env|semantic-deploy-gate|check-agent-behavior-approval|check-llm-trajectory-injection-approval)\.test\.sh",
        command,
    ):
        gates.add("structural")
    if "bash scripts/lint-check.sh" in command:
        gates.add("research-fix" if "--fix" in command else "research-static")
    if re.search(r"\bnpx\s+tsx\s+[^\s]*integration-health\.blackbox\.ts\b", command):
        gates.add("credential-health")

    if re.search(
        r"\bnpm\s+run\s+test:coverage\b|\bbash\s+scripts/run-coverage\.sh\b", command
    ):
        if "cd back-end" in command or "backend-coverage" in command:
            gates.add("backend-coverage")
        elif "cd front-end" in command or "frontend-coverage" in command:
            gates.add("frontend-coverage")
        elif "cd mac-app" in command or "mac-coverage" in command:
            gates.add("mac-coverage")
        elif (
            "cd agents" in command
            or "agents-coverage" in command
            or "source venv/bin/activate" in command
        ):
            gates.add("agents-coverage")
        else:
            gates.add("unresolved-coverage")

    if re.search(
        r"\bbash\s+(?:[^\s]+/)?scripts/run-blackbox-tests\.sh(?:\s|$)", command
    ):
        gates.add("mac-blackbox" if "mac-app" in command else "backend-blackbox")
    if re.search(r"\bpython(?:3)?\s+scripts/run_blackbox_tests\.py\b", command):
        gates.add("agents-blackbox")
    if re.search(
        r"(?:\bpython(?:3)?|\bvenv/bin/python)\s+benchmarks/run_benchmark\.py\b[^\n]*(?:--suite\s+smoke)|"
        r"\bbash\s+scripts/run-predeploy-(?:local|cloud)\b|"
        r"\bbash\s+scripts/run-bench\b[^\n]*(?:--full|--local)",
        command,
    ):
        gates.add("smoke")
    if re.search(
        r"(?:\bpython(?:3)?|\bvenv/bin/python)\s+benchmarks/run_benchmark\.py\b[^\n]*--task\s+",
        command,
    ):
        gates.add("targeted-smoke")
    if re.search(
        r"\bbash\s+front-end/scripts/run-semantic-tests\.sh(?:\s*(?:$|[;&|>]))", command
    ):
        gates.add("semantic")
    return gates


PRODUCTION_SIGNAL_RE = re.compile(
    r"deploy-agents(?:\.yml)?|Deploy Agents to Fly\.io|"
    r"release-mac-app(?:\.yml)?|Release Mac App|auto-tag-mac-app(?:\.yml)?|"
    r"chat-lifecycle-ratchet(?:\.yml)?|Production Semantic Frontend Gate|"
    r"prod-endpoint-smoke|prod-health\.ts|agent-payment-production-abandonment|"
    r"api\.render\.com/v1/(?:services/.+?/deploys|logs)|"
    r"RENDER_(?:API_KEY|SERVICE_ID|OWNER_ID)|"
    r"repos/.+?/deployments(?:\?|/)|vercel\s+(?:inspect|logs|ls)|"
    r"gh\s+release\s+(?:view|list)|roselabs\.ai|navi-j9a9\.onrender\.com",
    re.IGNORECASE,
)
PRODUCTION_ROLLOVER_RE = re.compile(
    r"new_branch_with_context|\bgit\s+(?:switch|checkout)\b[^\n]*"
    r"(?:origin/main|--create|-[bc]\b)",
    re.IGNORECASE,
)


def production_signal(invocation: Invocation) -> bool:
    return bool(
        PRODUCTION_SIGNAL_RE.search(
            f"{invocation.name} {invocation.detail}\n{invocation.result}"
        )
    )


def deploy_stage(invocation: Invocation) -> str:
    detail = f"{invocation.name} {invocation.detail}"
    if re.search(r"\bgh\s+pr\s+merge\b", detail, re.IGNORECASE) or production_signal(
        invocation
    ):
        return "production"
    return "other"


def historical_production_timing(
    invocations: Sequence[Invocation],
) -> StepTiming:
    """Backfill merge-to-verification wall time without enveloping pre-merge work.

    Old transcripts predate explicit production stage events. Each successful
    merge starts one lifecycle; provider/workflow/probe evidence closes it. A
    bare ``gh run watch`` is accepted only before branch rollover, where it is
    the deploy workflow selected immediately after merge. Named production
    signals remain valid after rollover because old agents sometimes started a
    new branch while concurrently polling the still-running release jobs.
    """

    ordered = sorted(invocations, key=lambda value: value.start)
    merge_indexes = [
        index
        for index, item in enumerate(ordered)
        if re.search(r"\bgh\s+pr\s+merge\b", shell_command(item), re.IGNORECASE)
    ]
    if not merge_indexes:
        return StepTiming(0, (), 0.0, incomplete=True)

    intervals: list[tuple[float, float]] = []
    incomplete = False
    for position, merge_index in enumerate(merge_indexes):
        merge = ordered[merge_index]
        next_merge_index = (
            merge_indexes[position + 1]
            if position + 1 < len(merge_indexes)
            else len(ordered)
        )
        after_merge = ordered[merge_index + 1 : next_merge_index]
        rollover_start = next(
            (
                item.start
                for item in after_merge
                if PRODUCTION_ROLLOVER_RE.search(shell_command(item))
            ),
            float("inf"),
        )
        verified = [
            item
            for item in after_merge
            if production_signal(item)
            or (
                item.start < rollover_start
                and re.search(
                    r"\bgh\s+run\s+watch\b", shell_command(item), re.IGNORECASE
                )
            )
        ]
        if not verified:
            incomplete = True
            continue
        intervals.append((merge.start, max(item.end for item in verified)))

    durations = tuple(max(0.0, end - start) for start, end in intervals)
    return StepTiming(
        runs=len(intervals),
        durations=durations,
        wall_seconds=interval_union_seconds(intervals),
        incomplete=incomplete,
        intervals=tuple(intervals),
    )


def deploy_invocation_labels(invocation: Invocation) -> tuple[str, ...]:
    gates = classify_deploy_gates(invocation)
    candidates = [
        label for label, gate_names in DEPLOY_FAMILIES.items() if gates & gate_names
    ]
    stage = deploy_stage(invocation)
    if stage == "review":
        candidates.append("Code review")
    elif stage == "production":
        candidates.append("Production verify")
    unique = list(dict.fromkeys(candidates))
    if len(unique) <= 1:
        return tuple(unique)
    if gates and gates <= MULTI_FAMILY_GATES:
        return tuple(unique)
    return (HISTORICAL_UNSPLIT_LABEL,)


def deploy_invocation_label(invocation: Invocation) -> str | None:
    """Compatibility helper for callers that expect one semantic family."""
    labels = deploy_invocation_labels(invocation)
    return labels[0] if len(labels) == 1 else HISTORICAL_UNSPLIT_LABEL


def combine_timings(timings: Sequence[StepTiming]) -> StepTiming:
    intervals = tuple(
        interval for timing in timings for interval in timing.intervals
    )
    return StepTiming(
        runs=sum(timing.runs for timing in timings),
        durations=tuple(
            duration for timing in timings for duration in timing.durations
        ),
        wall_seconds=(
            interval_union_seconds(intervals)
            if intervals
            else sum(timing.wall_seconds for timing in timings)
        ),
        incomplete=any(timing.incomplete for timing in timings),
        intervals=intervals,
    )


def explicit_deploy_stage_timing(
    invocations: Sequence[Invocation], event_value: str
) -> StepTiming | None:
    intervals: list[tuple[float, float]] = []
    pending_start: float | None = None
    saw_event = False
    incomplete = False
    for item in sorted(invocations, key=lambda value: value.start):
        event = factory_event(item)
        if event is None or event[0] != "deploy" or event[2] != event_value:
            continue
        saw_event = True
        if event[1] == "stage-start":
            if pending_start is not None:
                incomplete = True
            pending_start = item.start
        elif event[1] == "stage-finish":
            if pending_start is None:
                incomplete = True
            else:
                intervals.append((pending_start, item.start))
                pending_start = None
    if not saw_event:
        return None
    if pending_start is not None:
        incomplete = True
    durations = tuple(max(0.0, end - start) for start, end in intervals)
    return StepTiming(
        runs=len(intervals),
        durations=durations,
        wall_seconds=interval_union_seconds(intervals),
        incomplete=incomplete,
        intervals=tuple(intervals),
    )


def deploy_group_wall_clock(
    values: dict[str, StepTiming], members: Sequence[str]
) -> StepTiming:
    """Union member lifecycle envelopes without adding parallel lanes."""
    intervals = tuple(
        interval
        for member in members
        for interval in values[member].intervals
    )
    return StepTiming(
        runs=0,
        durations=(),
        wall_seconds=interval_union_seconds(intervals),
        incomplete=any(values[member].incomplete for member in members),
        intervals=intervals,
    )


def deploy_cycle_timings(
    invocations: Sequence[Invocation],
) -> dict[str, StepTiming]:
    """Measure one lifecycle per canonical pass through each deploy phase."""
    cycle = 0
    highest_phase = 0
    cycle_items: dict[str, dict[int, list[Invocation]]] = defaultdict(
        lambda: defaultdict(list)
    )
    canonical_cycle_items: dict[str, dict[int, list[Invocation]]] = defaultdict(
        lambda: defaultdict(list)
    )
    special_items: dict[str, list[Invocation]] = defaultdict(list)
    for item in sorted(invocations, key=lambda value: value.start):
        labels = deploy_invocation_labels(item)
        if not labels:
            continue
        special_labels = {
            HISTORICAL_UNSPLIT_LABEL,
            "Code review",
            "Production verify",
        }
        if any(label in special_labels for label in labels):
            special_label = (
                labels[0] if len(labels) == 1 else HISTORICAL_UNSPLIT_LABEL
            )
            special_items[special_label].append(item)
            continue
        phases = [DEPLOY_PHASES[label] for label in labels]
        phase = min(phases)
        if highest_phase and phase < highest_phase and phase <= 3:
            cycle += 1
            highest_phase = 0
        for label in labels:
            cycle_items[label][cycle].append(item)
        canonical_label = "Coverage" if "Coverage" in labels else labels[0]
        canonical_cycle_items[canonical_label][cycle].append(item)
        highest_phase = max(highest_phase, *phases)

    values: dict[str, StepTiming] = {}
    for label in DEPLOY_VALUE_LABELS:
        if label == "Code review":
            # Git pushes, PR reads, and polling commands are not reviewer
            # lifecycles. Historical transcripts do not expose a reliable
            # CodeRabbit start/end boundary, so report them as unavailable
            # instead of manufacturing a push-to-last-poll envelope.
            values[label] = StepTiming(0, (), 0.0, incomplete=True)
        elif label == "Production verify":
            values[label] = historical_production_timing(invocations)
        elif label == HISTORICAL_UNSPLIT_LABEL:
            values[label] = invocation_timing(special_items[label])
        else:
            values[label] = combine_timings(
                [
                    grouped_timing(failure_separated_groups(items))
                    for _, items in sorted(cycle_items[label].items())
                ]
            )
    canonical_runs = {
        label: combine_timings(
            [
                grouped_timing(failure_separated_groups(items))
                for _, items in sorted(canonical_cycle_items[label].items())
            ]
        ).runs
        for label in DEPLOY_PHASES
    }
    values[DUAL_ATTRIBUTION_LABEL] = StepTiming(
        runs=sum(
            max(0, values[label].runs - canonical_runs[label])
            for label in DEPLOY_PHASES
        ),
        durations=(),
        wall_seconds=0.0,
    )
    structured_events = [
        event
        for event in (factory_event(item) for item in invocations)
        if event is not None and event[0] == "deploy"
    ]
    explicit_stages = {
        "Runtime blackbox": "runtime-blackbox",
        "Code review": "code-review",
        "Production verify": "production-verify",
    }
    runtime_observed = bool(values["Runtime blackbox"].runs) or any(
        event[2] == "runtime-blackbox" for event in structured_events
    )
    for label, event_value in explicit_stages.items():
        explicit = explicit_deploy_stage_timing(invocations, event_value)
        if explicit is not None:
            values[label] = explicit
        elif structured_events and (
            label in {"Code review", "Production verify"}
            or (label == "Runtime blackbox" and runtime_observed)
        ):
            values[label] = StepTiming(0, (), 0.0, incomplete=True)
    return values


def deploy_measurement_mode(turn: Turn) -> str:
    events = [
        event
        for event in (
            factory_event(item)
            for item in sorted(turn.invocations, key=lambda value: value.start)
        )
        if event is not None and event[0] == "deploy"
    ]
    if not events:
        return "inferred"
    values = deploy_cycle_timings(turn.invocations)
    outcome_indexes = [
        index for index, event in enumerate(events) if event[1] == "outcome"
    ]
    outcome_is_last = (
        len(outcome_indexes) == 1
        and outcome_indexes[0] == len(events) - 1
        and events[outcome_indexes[0]][2] == "completed"
    )
    stage_events = [
        (event[1], event[2])
        for event in events
        if event[1] in {"stage-start", "stage-finish"}
        and event[2] in DEPLOY_LIFECYCLE_STAGES
    ]
    ordered_pairs: list[str] = []
    if len(stage_events) % 2 == 0:
        for index in range(0, len(stage_events), 2):
            start_event, finish_event = stage_events[index : index + 2]
            if (
                start_event[0] != "stage-start"
                or finish_event[0] != "stage-finish"
                or start_event[1] != finish_event[1]
            ):
                ordered_pairs = []
                break
            ordered_pairs.append(start_event[1])
    last_review = max(
        (index for index, value in enumerate(ordered_pairs) if value == "code-review"),
        default=-1,
    )
    ordered_final_pass = bool(
        last_review >= 0
        and ordered_pairs[last_review + 1 :]
        and all(
            value == "production-verify" for value in ordered_pairs[last_review + 1 :]
        )
    )
    # ordered_final_pass already proves a paired code-review lifecycle exists
    # before production verification. Do not also require a historical review
    # duration: older transcripts intentionally report that timing unavailable.
    required = [values["Production verify"]]
    runtime = values["Runtime blackbox"]
    if runtime.runs or runtime.incomplete:
        required.append(runtime)
    if (
        outcome_is_last
        and ordered_final_pass
        and all(timing.runs > 0 and not timing.incomplete for timing in required)
    ):
        return "instrumented"
    return "incomplete"


def classify_status(
    command: str, final_text: str, invocations: Sequence[Invocation]
) -> str:
    text = final_text.lower()
    tools = "\n".join(item.detail for item in invocations).lower()
    results = "\n".join(item.result for item in invocations).lower()
    outcomes = [
        event
        for event in (factory_event(item) for item in invocations)
        if event is not None and event[0] == command and event[1] == "outcome"
    ]
    if outcomes:
        value = outcomes[-1][2]
        if command == "deploy":
            return "completed" if value == "completed" else "blocked"
        return {
            "fixed": "completed",
            "diagnosis-ready": "diagnosis-ready",
            "blocked": "blocked",
        }[value]
    if command == "deploy":
        blocked_markers = (
            "deployment is paused",
            "deploy is paused",
            "blocked on",
            "cannot proceed",
            "awaiting approval",
            "gate is red",
            "deployment is not complete",
        )
        if any(marker in text for marker in blocked_markers):
            return "blocked"
        merged = "gh pr merge" in tools or "merged pull request" in results
        deployed_markers = (
            "deployment complete",
            "deployed successfully",
            "merged and deployed",
            "deploy is substantively complete",
            "pr has been merged",
            "pr merged",
            "production semantic",
            "production probes",
            "is live",
            "are live",
            "shipped & verified",
        )
        if merged and any(marker in text for marker in deployed_markers):
            return "completed"
        return "merged-unverified" if merged else "incomplete"

    has_root = "root cause" in text
    has_repro = any(
        marker in text for marker in ("repro", "failed before", "pre-fix", "same test")
    )
    has_fix = any(
        marker in text for marker in ("post-fix", "now passes", "fix", "implemented")
    )
    if has_root and has_repro and has_fix:
        return "completed"
    if has_root and has_repro:
        return "diagnosis-ready"
    if any(
        marker in text
        for marker in ("approval", "blocked", "observability gap", "preliminary")
    ):
        return "blocked"
    return "incomplete"


def extract_turn(
    conn: sqlite3.Connection,
    *,
    command: str,
    workspace: str,
    session_id: str,
    turn_id: str,
    started_at: str,
) -> Turn:
    rows = conn.execute(
        """
        SELECT created_at, content
        FROM session_messages
        WHERE session_id = ? AND turn_id = ?
        ORDER BY created_at ASC, rowid ASC
        """,
        (session_id, turn_id),
    ).fetchall()
    start_time = parse_time(started_at)
    end_time = max((parse_time(row["created_at"]) for row in rows), default=start_time)
    uses: dict[str, tuple[datetime, str, str]] = {}
    results: dict[str, tuple[datetime, bool, str]] = {}
    assistant_texts: list[str] = []
    for row in rows:
        try:
            payload = json.loads(row["content"])
        except (json.JSONDecodeError, TypeError):
            continue
        timestamp = parse_time(row["created_at"])
        if payload.get("type") == "assistant":
            assistant_texts.extend(text_blocks(payload))
        for block in message_blocks(payload):
            block_type = block.get("type")
            if block_type == "tool_use":
                tool_id = str(block.get("id", ""))
                tool_input = block.get("input")
                if tool_id and isinstance(tool_input, dict):
                    uses[tool_id] = (
                        timestamp,
                        str(block.get("name", "")),
                        tool_detail(tool_input),
                    )
            elif block_type == "tool_result":
                tool_id = str(block.get("tool_use_id", ""))
                result_value = block.get("content", "")
                if not isinstance(result_value, str):
                    result_value = json.dumps(result_value, sort_keys=True)
                if tool_id:
                    results[tool_id] = (
                        timestamp,
                        bool(block.get("is_error", False)),
                        result_value,
                    )

    invocations = []
    for tool_id, (tool_start, name, detail) in sorted(
        uses.items(), key=lambda value: value[1][0]
    ):
        tool_end, is_error, result = results.get(tool_id, (tool_start, False, ""))
        invocations.append(
            Invocation(
                tool_id=tool_id,
                name=name,
                detail=detail,
                result=result,
                start=max(0.0, (tool_start - start_time).total_seconds()),
                end=max(0.0, (tool_end - start_time).total_seconds()),
                is_error=is_error,
            )
        )
    final_text = assistant_texts[-1] if assistant_texts else ""
    status = classify_status(command, final_text, invocations)
    return Turn(
        command=command,
        workspace=workspace,
        session_id=session_id,
        turn_id=turn_id,
        started_at=started_at,
        duration=max(0.0, (end_time - start_time).total_seconds()),
        status=status,
        final_text=final_text,
        invocations=tuple(invocations),
    )


def load_turns(db_path: Path, repo_name: str) -> list[Turn]:
    if not db_path.exists():
        raise RuntimeError(f"Conductor database not found: {db_path}")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        repo = conn.execute(
            "SELECT id FROM repos WHERE name = ?", (repo_name,)
        ).fetchone()
        if repo is None:
            raise RuntimeError(f"Conductor repository not found: {repo_name}")
        session_rows = conn.execute(
            """
            SELECT s.id AS session_id, w.directory_name
            FROM sessions s
            JOIN workspaces w ON w.id = s.workspace_id
            WHERE w.repository_id = ?
            """,
            (repo["id"],),
        ).fetchall()
        prompt_rows: list[dict[str, Any]] = []
        workspace_by_session = {
            str(row["session_id"]): str(row["directory_name"]) for row in session_rows
        }
        for session_id, directory_name in workspace_by_session.items():
            rows = conn.execute(
                """
                SELECT session_id, turn_id, created_at, content
                FROM session_messages
                WHERE session_id = ? AND role = 'user'
                  AND (
                    LOWER(LTRIM(content)) LIKE '/deploy%'
                    OR LOWER(LTRIM(content)) LIKE '/rca%'
                  )
                ORDER BY created_at ASC
                """,
                (session_id,),
            ).fetchall()
            prompt_rows.extend(
                {**dict(row), "directory_name": directory_name} for row in rows
            )
        prompt_rows.sort(key=lambda row: str(row["created_at"]))
        turns = []
        command_by_turn: dict[tuple[str, str], tuple[str, str]] = {}
        for row in prompt_rows:
            match = COMMAND_RE.match(row["content"] or "")
            if match is None or not row["turn_id"]:
                continue
            command = match.group(1).lower()
            command_by_turn[(str(row["session_id"]), str(row["turn_id"]))] = (
                command,
                str(row["created_at"]),
            )
            turns.append(
                extract_turn(
                    conn,
                    command=command,
                    workspace=row["directory_name"],
                    session_id=row["session_id"],
                    turn_id=row["turn_id"],
                    started_at=row["created_at"],
                )
            )
        deploy_commands = [
            (key, value)
            for key, value in command_by_turn.items()
            if value[0] == "deploy"
        ]
        lifecycles: list[ApprovalLifecycle] = []
        if deploy_commands:
            deploy_sessions = sorted({key[0] for key, _ in deploy_commands})
            earliest_deploy = min(value[1] for _, value in deploy_commands)
            message_rows: list[dict[str, Any]] = []
            for session_id in deploy_sessions:
                rows = conn.execute(
                    """
                    SELECT session_id, turn_id, created_at, role, content
                    FROM session_messages
                    WHERE session_id = ? AND created_at >= ?
                      AND (
                        role = 'user'
                        OR (
                          role = 'assistant'
                          AND (
                            LOWER(content) LIKE '%approv%'
                            OR LOWER(content) LIKE '%reject%'
                          )
                        )
                      )
                    ORDER BY created_at ASC, rowid ASC
                    """,
                    (session_id, earliest_deploy),
                ).fetchall()
                message_rows.extend(
                    {
                        **dict(row),
                        "directory_name": workspace_by_session[session_id],
                    }
                    for row in rows
                )
            message_rows.sort(key=lambda row: str(row["created_at"]))
            lifecycles = find_approval_lifecycles(message_rows, command_by_turn)
        return attach_approval_lifecycles(turns, lifecycles)
    finally:
        conn.close()


def _factory_ledger_module(name: str = "factory_ledger") -> Any:
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(f"{name}.py")
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def remote_main_text(path: Path, ref: str = "origin/main") -> str:
    """The ledger as last fetched from main; deploys publish there directly."""
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{path.as_posix()}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return ""


def load_ledger_rows(
    ledger: Path, roots: Sequence[Path], extra_texts: Sequence[str] = ()
) -> list[dict[str, Any]]:
    """Tracked ledger rows (working tree and main) plus unpublished local telemetry."""
    module = _factory_ledger_module()
    rows: dict[tuple[Any, ...], dict[str, Any]] = {}
    sources = [module.read_jsonl(ledger), *(module.parse_jsonl(text) for text in extra_texts)]
    diagnostics = _factory_ledger_module("factory_diagnostics")
    candidates = [row for source in sources for row in source]
    for root in roots:
        candidates.extend((*module.stage_rows(root), *module.event_rows(root)))
    rejected = 0
    for row in candidates:
        if row.get("kind") not in {"deploy-stage", "factory-event"}:
            continue
        if not diagnostics.valid_ledger_row(row):
            rejected += 1
            continue
        rows.setdefault(module.row_key(row), row)

    class LedgerRows(list):
        pass

    result = LedgerRows(sorted(rows.values(), key=module.row_epoch))
    result.rejected_rows = rejected
    return result


def _epoch_iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _ledger_event_invocation(
    identifier: str, row: dict[str, Any], origin: float
) -> Invocation:
    workflow, event, value = (str(row.get(key, "")) for key in ("workflow", "event", "value"))
    at = float(row["recorded_epoch"]) - origin
    return Invocation(
        identifier,
        "Bash",
        f"python3 scripts/record_factory_event.py {workflow} {event} {value}",
        "FACTORY_EVENT "
        + json.dumps(
            {"workflow": workflow, "event": event, "value": value},
            separators=(",", ":"),
        ),
        at,
        at,
        False,
    )


def _ledger_approvals(
    events: Sequence[dict[str, Any]], workspace: str, session_id: str, turn_id: str, started_at: str
) -> list[ApprovalLifecycle]:
    lifecycles: list[ApprovalLifecycle] = []
    requested: float | None = None
    for row in events:
        if row.get("event") == "approval-request":
            # A fresh snapshot request restarts the human wait.
            requested = float(row["recorded_epoch"])
        elif row.get("event") == "approval-decision" and requested is not None:
            lifecycles.append(
                ApprovalLifecycle(
                    workspace=workspace,
                    session_id=session_id,
                    request_turn_id=turn_id,
                    deploy_started_at=started_at,
                    requested_at=_epoch_iso(requested),
                    decided_at=_epoch_iso(float(row["recorded_epoch"])),
                    decision=str(row.get("value", "")),
                    request_source="event",
                    decision_source="event",
                )
            )
            requested = None
    return lifecycles


def _ledger_deploy_groups(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("kind") != "deploy-stage":
            continue
        run = runs.setdefault(
            str(row["run_id"]),
            {"key": str(row["run_id"]), "branch": str(row.get("branch") or ""), "stages": [], "events": []},
        )
        run["stages"].append(row)
    for run in runs.values():
        run["start"] = min(float(stage["started_epoch"]) for stage in run["stages"])
    by_branch: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in sorted(runs.values(), key=lambda value: value["start"]):
        by_branch[run["branch"]].append(run)

    orphans: list[dict[str, Any]] = []
    open_orphan: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("kind") != "factory-event" or row.get("workflow") != "deploy":
            continue
        epoch = float(row["recorded_epoch"])
        branch = str(row.get("branch") or "")
        owner = None
        for run in by_branch.get(branch, []):
            if run["start"] <= epoch:
                owner = run
        if owner is not None and (
            branch not in open_orphan or open_orphan[branch]["start"] < owner["start"]
        ):
            owner["events"].append(row)
        else:
            group = open_orphan.get(branch)
            if group is None:
                group = {"key": f"{branch or 'unknown'}@{int(epoch)}", "branch": branch, "stages": [], "events": [], "start": epoch}
                orphans.append(group)
                open_orphan[branch] = group
            group["events"].append(row)
        if row.get("event") == "outcome":
            open_orphan.pop(branch, None)
    return sorted([*runs.values(), *orphans], key=lambda value: value["start"])


def ledger_deploy_turns(rows: Sequence[dict[str, Any]]) -> list[Turn]:
    turns: list[Turn] = []
    for group in _ledger_deploy_groups(rows):
        stage_bounds = [
            (float(stage["started_epoch"]), float(stage["finished_epoch"])) for stage in group["stages"]
        ]
        event_times = [float(event["recorded_epoch"]) for event in group["events"]]
        origin = min([start for start, _ in stage_bounds] + event_times)
        finish = max([end for _, end in stage_bounds] + event_times)
        invocations = [
            Invocation(
                f"ledger-stage-{group['key']}-{index}",
                "Bash",
                f"bash scripts/run-deploy-stage {stage['stage']} -- recorded",
                "",
                float(stage["started_epoch"]) - origin,
                float(stage["finished_epoch"]) - origin,
                stage.get("status") != "passed",
            )
            for index, stage in enumerate(group["stages"])
            # An exact-input or lane-scoped reuse executed nothing; diagnostics count it.
            if stage.get("status") not in ("reused", "reused-scoped")
        ]
        invocations.extend(
            _ledger_event_invocation(f"ledger-event-{group['key']}-{index}", event, origin)
            for index, event in enumerate(group["events"])
        )
        invocations.sort(key=lambda value: (value.start, value.end))
        workspace = group["branch"] or "unknown-branch"
        session_id = f"ledger:{workspace}"
        started_at = _epoch_iso(origin)
        approvals = _ledger_approvals(group["events"], workspace, session_id, group["key"], started_at)
        turns.append(
            Turn(
                command="deploy",
                workspace=workspace,
                session_id=session_id,
                turn_id=group["key"],
                started_at=started_at,
                duration=finish - origin,
                status=classify_status("deploy", "", invocations),
                final_text="",
                invocations=tuple(invocations),
                approval_durations=tuple(event.duration for event in approvals),
                approval_events=tuple(approvals),
            )
        )
    # A completed deploy that resumes blocked attempts on the same branch is one
    # logical deploy: it spans the first blocked start and consumes their waits.
    logical: list[Turn] = []
    blocked: dict[str, list[Turn]] = defaultdict(list)
    for turn in turns:
        if turn.status == "blocked":
            blocked[turn.workspace].append(turn)
            logical.append(turn)
            continue
        if turn.status != "completed":
            logical.append(turn)
            continue
        earlier = blocked.pop(turn.workspace, [])
        consumed = tuple(
            duration for prior in (*earlier, turn) for duration in prior.approval_durations
        )
        lifecycle = None
        if earlier:
            lifecycle = (
                parse_time(turn.started_at) - parse_time(earlier[0].started_at)
            ).total_seconds() + turn.duration
        logical.append(
            replace(turn, consumed_approval_durations=consumed, lifecycle_duration=lifecycle)
        )
    return logical


def ledger_rca_turns(rows: Sequence[dict[str, Any]]) -> list[Turn]:
    segments: list[list[dict[str, Any]]] = []
    open_segment: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("kind") != "factory-event" or row.get("workflow") != "rca":
            continue
        key = (str(row.get("workspace") or ""), str(row.get("branch") or ""))
        segment = open_segment.get(key)
        if segment is None:
            segment = []
            segments.append(segment)
            open_segment[key] = segment
        segment.append(row)
        if row.get("event") == "outcome":
            open_segment.pop(key, None)
    turns = []
    for segment in segments:
        origin = float(segment[0]["recorded_epoch"])
        invocations = tuple(
            _ledger_event_invocation(f"ledger-rca-{int(origin)}-{index}", row, origin)
            for index, row in enumerate(segment)
        )
        workspace = str(segment[0].get("branch") or segment[0].get("workspace") or "unknown")
        turns.append(
            Turn(
                command="rca",
                workspace=workspace,
                session_id=f"ledger:{workspace}",
                turn_id=f"rca@{int(origin)}",
                started_at=_epoch_iso(origin),
                duration=float(segment[-1]["recorded_epoch"]) - origin,
                status=classify_status("rca", "", invocations),
                final_text="",
                invocations=invocations,
            )
        )
    return turns


def load_ledger_turns(
    ledger: Path, roots: Sequence[Path], extra_texts: Sequence[str] = ()
) -> list[Turn]:
    rows = load_ledger_rows(ledger, roots, extra_texts)
    return sorted(
        [*ledger_deploy_turns(rows), *ledger_rca_turns(rows)],
        key=lambda turn: turn.started_at,
    )


def metric_row(
    label: str,
    runs: int,
    durations: Sequence[float],
    wall_seconds: float,
    command_count: int,
    incomplete_commands: int = 0,
) -> dict[str, Any]:
    denominator = command_count or 1
    # No source command means no measurement: render "—", never a zero.
    unavailable = command_count == 0 or bool(
        incomplete_commands == command_count
        and runs == 0
        and not durations
        and wall_seconds == 0
    )
    return {
        "step": label,
        "samples": len(durations),
        "commands": command_count,
        "runs": runs / denominator,
        "avg_minutes": (sum(durations) / len(durations) / 60 if durations else 0.0),
        "total_minutes": wall_seconds / denominator / 60,
        "incomplete_commands": incomplete_commands,
        "unavailable": unavailable,
    }


def deploy_turn_values(turn: Turn) -> dict[str, StepTiming]:
    values = deploy_cycle_timings(turn.invocations)
    values["Approval guards"] = StepTiming(
        runs=len(turn.consumed_approval_durations),
        durations=turn.consumed_approval_durations,
        wall_seconds=sum(turn.consumed_approval_durations),
    )
    for label, members in DEPLOY_GROUP_SUMMARIES.items():
        values[label] = deploy_group_wall_clock(values, members)
    total_duration = deploy_duration(turn)
    values["Total"] = StepTiming(
        runs=(
            sum(values[label].runs for label in DEPLOY_STEP_LABELS)
            - values[DUAL_ATTRIBUTION_LABEL].runs
        ),
        durations=(total_duration,),
        wall_seconds=total_duration,
    )
    return values


def approval_turn_values(turn: Turn) -> dict[str, StepTiming]:
    return {
        "Approval guards": StepTiming(
            runs=len(turn.approval_durations),
            durations=turn.approval_durations,
            wall_seconds=sum(turn.approval_durations),
        )
    }


def deploy_metrics(turns: Sequence[Turn]) -> dict[str, Any]:
    if not turns:
        return {
            "completed": 0,
            "instrumented": 0,
            "inferred": 0,
            "incomplete": 0,
            "end_to_end_minutes": 0.0,
            "steps": [
                metric_row(label, 0, (), 0.0, 0) for label in DEPLOY_REPORT_LABELS
            ],
            "historical_unclassified": metric_row(
                HISTORICAL_UNSPLIT_LABEL, 0, (), 0.0, 0
            ),
        }
    per_turn = [deploy_turn_values(turn) for turn in turns]
    steps = []
    for label in DEPLOY_REPORT_LABELS:
        total_runs = sum(values[label].runs for values in per_turn)
        durations = [
            duration for values in per_turn for duration in values[label].durations
        ]
        total_wall = sum(values[label].wall_seconds for values in per_turn)
        incomplete_commands = sum(values[label].incomplete for values in per_turn)
        steps.append(
            metric_row(
                label,
                total_runs,
                durations,
                total_wall,
                len(turns),
                incomplete_commands,
            )
        )

    unsplit_runs = sum(values[HISTORICAL_UNSPLIT_LABEL].runs for values in per_turn)
    unsplit_durations = [
        duration
        for values in per_turn
        for duration in values[HISTORICAL_UNSPLIT_LABEL].durations
    ]
    unsplit_wall = sum(
        values[HISTORICAL_UNSPLIT_LABEL].wall_seconds for values in per_turn
    )

    end_to_end = statistics.fmean(deploy_duration(turn) for turn in turns) / 60
    return {
        "completed": len(turns),
        "instrumented": sum(
            deploy_measurement_mode(turn) == "instrumented" for turn in turns
        ),
        "inferred": sum(deploy_measurement_mode(turn) == "inferred" for turn in turns),
        "incomplete": sum(
            deploy_measurement_mode(turn) == "incomplete" for turn in turns
        ),
        "end_to_end_minutes": end_to_end,
        "steps": steps,
        "historical_unclassified": metric_row(
            HISTORICAL_UNSPLIT_LABEL,
            unsplit_runs,
            unsplit_durations,
            unsplit_wall,
            len(turns),
        ),
    }


def rca_label(invocation: Invocation) -> str:
    detail = f"{invocation.name} {invocation.detail}"
    if re.search(
        r"spawn_agent|general-purpose|collab__|adversarial", detail, re.IGNORECASE
    ):
        return "review"
    if re.search(
        r"pytest|vitest|npm\s+(run\s+)?test|blackbox|semantic|coverage|lint|tsc|post-fix",
        detail,
        re.IGNORECASE,
    ):
        return "review"
    if re.search(r"repro|fixture|replay|test.*fail|fail.*test", detail, re.IGNORECASE):
        return "reproduce"
    if re.search(
        r"agent_latency|agent_logs|git\s+(log|show|blame|bisect)|grep|rg\b|find\b|read\b|sed\b|trace|"
        r"query-db|sqlite|curl|render|clickhouse|docker\s+logs",
        detail,
        re.IGNORECASE,
    ):
        return "trace"
    return "other"


RCA_EVENT_LABELS = {
    "evidence-trace": "Evidence + trace",
    "reproduce-diagnose": "Reproduce + diagnose",
    "verify-handoff": "Verify + handoff",
}


def rca_measurement_mode(turn: Turn) -> str:
    events = [
        event
        for event in (
            factory_event(item)
            for item in sorted(turn.invocations, key=lambda value: value.start)
        )
        if event is not None and event[0] == "rca"
    ]
    if not events:
        return "inferred"
    stage_values = [
        event[2]
        for event in events
        if event[1] == "stage" and event[2] in RCA_EVENT_LABELS
    ]
    outcome_indexes = [
        index for index, event in enumerate(events) if event[1] == "outcome"
    ]
    has_complete_stage_set = set(stage_values) == set(RCA_EVENT_LABELS)
    outcome_is_last = (
        len(outcome_indexes) == 1 and outcome_indexes[0] == len(events) - 1
    )
    stage_ranks = {
        "evidence-trace": 0,
        "reproduce-diagnose": 1,
        "verify-handoff": 2,
    }
    transitions_are_valid = all(
        stage_ranks[current] - stage_ranks[previous] <= 1
        for previous, current in pairwise(stage_values)
    )
    if (
        stage_values
        and stage_values[0] == "evidence-trace"
        and stage_values[-1] == "verify-handoff"
        and has_complete_stage_set
        and transitions_are_valid
        and outcome_is_last
    ):
        return "instrumented"
    return "incomplete"


def explicit_rca_state_rows(turn: Turn) -> list[StepTiming] | None:
    if rca_measurement_mode(turn) != "instrumented":
        return None
    return rca_marker_state_rows(turn)


def rca_marker_state_rows(turn: Turn) -> list[StepTiming] | None:
    markers: list[tuple[str, float]] = []
    for item in sorted(turn.invocations, key=lambda value: value.start):
        event = factory_event(item)
        if (
            event is not None
            and event[0] == "rca"
            and event[1] == "stage"
            and event[2] in RCA_EVENT_LABELS
        ):
            markers.append((RCA_EVENT_LABELS[event[2]], item.start))
    if not markers:
        return None

    state_durations: dict[str, list[float]] = defaultdict(list)
    for index, (label, marker_start) in enumerate(markers):
        start = 0.0 if index == 0 else marker_start
        end = markers[index + 1][1] if index + 1 < len(markers) else turn.duration
        state_durations[label].append(max(0.0, end - start))
    return [
        StepTiming(
            runs=len(state_durations[label]),
            durations=tuple(state_durations[label]),
            wall_seconds=sum(state_durations[label]),
        )
        for label in RCA_LABELS
    ]


def rca_state_rows(turn: Turn) -> list[StepTiming]:
    explicit = explicit_rca_state_rows(turn)
    if explicit is not None:
        return explicit
    if turn.invocations and all(factory_event(item) for item in turn.invocations):
        # Ledger turns hold only stage events, with no tool calls to infer
        # boundaries from: time the recorded stages and flag the gaps.
        recorded = rca_marker_state_rows(turn)
        if recorded is not None:
            return [replace(timing, incomplete=True) for timing in recorded]
    categorized = [(rca_label(item), item) for item in turn.invocations]
    reproductions = [item for label, item in categorized if label == "reproduce"]
    reviews = [item for label, item in categorized if label == "review"]
    first_boundary = reproductions[0].start if reproductions else turn.duration * 0.55
    later_reviews = [item for item in reviews if item.start > first_boundary]
    if later_reviews:
        second_boundary = later_reviews[0].start
    else:
        diagnostic_ends = [
            item.end for label, item in categorized if label in {"trace", "reproduce"}
        ]
        second_boundary = max(diagnostic_ends, default=turn.duration * 0.85)
    first_boundary = min(max(0.0, first_boundary), turn.duration)
    second_boundary = min(max(first_boundary, second_boundary), turn.duration)
    states = [
        [item for _, item in categorized if item.start < first_boundary],
        [
            item
            for _, item in categorized
            if first_boundary <= item.start < second_boundary
        ],
        [item for _, item in categorized if item.start >= second_boundary],
    ]
    boundaries = (0.0, first_boundary, second_boundary, turn.duration)
    timings = [
        bounded_state_timing(states[index], boundaries[index], boundaries[index + 1])
        for index in range(len(RCA_LABELS))
    ]
    if rca_measurement_mode(turn) == "incomplete":
        return [replace(timing, incomplete=True) for timing in timings]
    return timings


def rca_metrics(turns: Sequence[Turn]) -> dict[str, Any]:
    if not turns:
        return {
            "completed": 0,
            "instrumented": 0,
            "inferred": 0,
            "incomplete": 0,
            "end_to_end_minutes": 0.0,
            "steps": [],
        }
    per_turn = [rca_state_rows(turn) for turn in turns]
    steps = []
    for index, label in enumerate(RCA_LABELS):
        timings = [values[index] for values in per_turn]
        total_runs = sum(timing.runs for timing in timings)
        durations = [duration for timing in timings for duration in timing.durations]
        total_wall = sum(timing.wall_seconds for timing in timings)
        steps.append(
            metric_row(
                label,
                total_runs,
                durations,
                total_wall,
                len(turns),
                sum(timing.incomplete for timing in timings),
            )
        )
    return {
        "completed": len(turns),
        "instrumented": sum(
            rca_measurement_mode(turn) == "instrumented" for turn in turns
        ),
        "inferred": sum(rca_measurement_mode(turn) == "inferred" for turn in turns),
        "incomplete": sum(rca_measurement_mode(turn) == "incomplete" for turn in turns),
        "end_to_end_minutes": statistics.fmean(turn.duration for turn in turns) / 60,
        "steps": steps,
    }


def rca_turn_values(turn: Turn) -> dict[str, StepTiming]:
    timings = rca_state_rows(turn)
    return {label: timings[index] for index, label in enumerate(RCA_LABELS)}


def trend_bucket(value: datetime, scale: str) -> date:
    current = value.date()
    if scale == "weekly":
        return current - timedelta(days=current.weekday())
    if scale == "monthly":
        return current.replace(day=1)
    quarter_month = ((current.month - 1) // 3) * 3 + 1
    return current.replace(month=quarter_month, day=1)


def trend_label(period: date, scale: str) -> str:
    if scale == "weekly":
        return period.strftime("%b %-d")
    if scale == "monthly":
        return period.strftime("%b %Y")
    return f"Q{((period.month - 1) // 3) + 1} {period.year}"


def build_trends(
    turns: Sequence[Turn],
    labels: Sequence[str],
    value_fn: Callable[[Turn], dict[str, StepTiming]],
    *,
    command_kind: str = "completed",
    measurement_fn: Callable[[Turn], str] | None = None,
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    trends = {label: {scale: [] for scale in TREND_SCALES} for label in labels}
    per_turn = [
        (
            turn,
            value_fn(turn),
            measurement_fn(turn) if measurement_fn is not None else None,
        )
        for turn in turns
    ]
    for scale, period_limit in TREND_SCALES.items():
        buckets: dict[date, list[tuple[Turn, dict[str, StepTiming], str | None]]] = (
            defaultdict(list)
        )
        for turn, values, measurement_mode in per_turn:
            buckets[trend_bucket(parse_time(turn.started_at), scale)].append(
                (turn, values, measurement_mode)
            )
        for period in sorted(buckets)[-period_limit:]:
            turns_for_period = buckets[period]
            command_count = len(turns_for_period)
            for label in labels:
                total_runs = sum(
                    values[label].runs for _, values, _ in turns_for_period
                )
                durations = [
                    duration
                    for _, values, _ in turns_for_period
                    for duration in values[label].durations
                ]
                total_wall = sum(
                    values[label].wall_seconds for _, values, _ in turns_for_period
                )
                trends[label][scale].append(
                    {
                        "period_start": period.isoformat(),
                        "label": trend_label(period, scale),
                        "commands": command_count,
                        "command_kind": command_kind,
                        "source_turn_ids": [
                            turn.turn_id for turn, _, _ in turns_for_period
                        ],
                        "instrumented_commands": sum(
                            mode == "instrumented" for _, _, mode in turns_for_period
                        ),
                        "inferred_commands": sum(
                            mode == "inferred" for _, _, mode in turns_for_period
                        ),
                        "incomplete_measurement_commands": sum(
                            mode == "incomplete" for _, _, mode in turns_for_period
                        ),
                        "incomplete_commands": sum(
                            values[label].incomplete
                            for _, values, _ in turns_for_period
                        ),
                        "total_runs": total_runs,
                        "duration_samples": len(durations),
                        "total_run_minutes": sum(durations) / 60,
                        "total_wall_minutes": total_wall / 60,
                        "runs": total_runs / command_count,
                        "avg_minutes": (
                            sum(durations) / len(durations) / 60 if durations else 0.0
                        ),
                        "total_minutes": total_wall / command_count / 60,
                        "unavailable": bool(
                            all(values[label].incomplete for _, values, _ in turns_for_period)
                            and total_runs == 0
                            and not durations
                            and total_wall == 0
                        ),
                    }
                )
    return trends


def percentage_change(recent: float | None, previous: float | None) -> float | None:
    if recent is None or previous is None or previous == 0:
        return None
    return round((recent - previous) / previous * 100, 1)


def descend_trend(values: Sequence[float], window: int) -> dict[str, Any]:
    recent_values = values[-window:]
    previous_values = values[-2 * window : -window]
    recent = round(statistics.median(recent_values), 3) if recent_values else None
    previous = round(statistics.median(previous_values), 3) if previous_values else None
    return {
        "samples": len(values),
        "latest_seconds": round(values[-1], 3) if values else None,
        "recent_median_seconds": recent,
        "previous_median_seconds": previous,
        "change_percent": percentage_change(recent, previous),
    }


def load_descend_factory_events(
    path: Path, extra_texts: Sequence[str] = ()
) -> list[dict[str, Any]]:
    texts = [path.read_text(errors="replace")] if path.exists() else []
    texts.extend(extra_texts)
    records: dict[str, dict[str, Any]] = {}
    numbered = (
        (line_number, line)
        for text in texts
        for line_number, line in enumerate(text.splitlines(), 1)
    )
    for line_number, line in numbered:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(
                f"invalid JSONL at {path}:{line_number}: {error}"
            ) from error
        if record.get("workflow") != "descend":
            continue
        if record.get("record_type") != "factory_event":
            continue
        identifier = record.get("record_id")
        if isinstance(identifier, str):
            records.setdefault(identifier, record)
            continue
        raise ValueError(
            f"missing descend factory-event record_id at {path}:{line_number}"
        )
    return sorted(
        records.values(),
        key=lambda record: (
            float(record.get("recorded_epoch", 0)),
            record["record_id"],
        ),
    )


def descend_metrics(
    records: Sequence[dict[str, Any]], window: int = 5
) -> dict[str, Any]:
    canonical = [
        record
        for record in records
        if record.get("workflow") == "descend"
        and record.get("record_type") == "factory_event"
        and record.get("lane") == "main"
    ]
    finishes = [
        record
        for record in canonical
        if record.get("event") == "stage-finish"
        and record.get("status") == "completed"
        and isinstance(record.get("duration_seconds"), (int, float))
    ]
    by_step: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in finishes:
        by_step[str(record.get("value") or record.get("step"))].append(record)

    steps = []
    for step, step_records in by_step.items():
        step_records.sort(key=lambda record: float(record.get("recorded_epoch", 0)))
        durations = [float(record["duration_seconds"]) for record in step_records]
        steps.append({"step": step, **descend_trend(durations, window)})
    steps.sort(
        key=lambda row: (
            row["change_percent"] is None,
            -(row["change_percent"] or 0),
            row["step"],
        )
    )

    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in canonical:
        run_id = record.get("run_id")
        if isinstance(run_id, str):
            by_run[run_id].append(record)
    runs = []
    for run_id, run_records in by_run.items():
        outcomes = [
            record
            for record in run_records
            if record.get("event") == "outcome" and record.get("value") == "completed"
        ]
        starts = [
            record
            for record in run_records
            if record.get("event") == "stage-start"
            and isinstance(record.get("recorded_epoch"), (int, float))
        ]
        if not outcomes or not starts:
            continue
        outcome = max(
            outcomes, key=lambda record: float(record.get("recorded_epoch", 0))
        )
        started_epoch = min(float(record["recorded_epoch"]) for record in starts)
        finished_epoch = float(outcome.get("recorded_epoch", started_epoch))
        if finished_epoch < started_epoch:
            continue
        runs.append(
            {
                "run_id": run_id,
                "slice": outcome.get("slice", ""),
                "status": "completed",
                "finished_at": outcome.get("recorded_at", ""),
                "duration_seconds": round(finished_epoch - started_epoch, 3),
            }
        )
    runs.sort(key=lambda run: run["finished_at"])
    wall_clock = descend_trend([float(run["duration_seconds"]) for run in runs], window)
    wall_clock["completed_runs"] = len(runs)
    return {
        "history_file": "agents/benchmarks/history/descend_steps.jsonl",
        "window": window,
        "step_records": len(finishes),
        "run_wall_clock": wall_clock,
        "steps": steps,
        "runs": runs,
    }


def span_agent_branches(history_dir: Path) -> dict[str, str]:
    """Map benchmark agent IDs to the deploy branch named by their span ledger."""
    branches: dict[str, str] = {}
    for path in sorted(history_dir.glob("span_durations.*.jsonl")):
        match = SPAN_BRANCH_FILE_RE.match(path.name)
        if match is None or SPAN_UNBRANCHED_SUFFIX_RE.fullmatch(match.group(2)):
            continue
        branch = match.group(2)
        previous = b""
        with path.open("rb") as handle:
            for line in handle:
                if not line.startswith(b'{"agent_id": "'):
                    continue
                agent_id = line[14:50]
                if agent_id != previous:
                    branches.setdefault(agent_id.decode(errors="replace"), branch)
                    previous = agent_id
    return branches


def _percentile(values: Sequence[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))]


def _cluster_deploys(
    attempts: Sequence[dict[str, Any]], gap_seconds: float, label: str
) -> list[list[dict[str, Any]]]:
    clusters: list[list[dict[str, Any]]] = []
    last_end: float | None = None
    for attempt in sorted(attempts, key=lambda value: value["start"]):
        if last_end is None or attempt["start"] - last_end > gap_seconds:
            clusters.append([])
        clusters[-1].append({**attempt, "deploy_branch": label})
        last_end = max(last_end or attempt["end"], attempt["end"])
    return clusters


def catalog_categories(catalog_path: Path) -> dict[str, tuple[str, bool]]:
    """Deploy category and smoke flag per task, as the predeploy selector derives them."""
    spec = importlib.util.spec_from_file_location(
        "select_predeploy_benches",
        Path(__file__).resolve().parents[1] / "agents/benchmarks/select_predeploy_benches.py",
    )
    assert spec and spec.loader
    selector = sys.modules.get(spec.name)
    if selector is None:
        selector = importlib.util.module_from_spec(spec)
        # Its dataclasses resolve annotations through sys.modules.
        sys.modules[spec.name] = selector
        spec.loader.exec_module(selector)
    try:
        tasks = selector.load_tasks(catalog_path)
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    result = {}
    for task in tasks:
        floor = list(getattr(selector, "FLOOR_CATEGORIES", ()))
        derived = sorted(
            selector.categories_for_task(task) - {"harness"},
            key=lambda name: (floor.index(name) if name in floor else len(floor), name),
        )
        category = task.deploy_category or (derived[0] if derived else None)
        if category is None and task.is_smoke:
            category = "harness"
        result[task.name] = (category or "uncategorized", task.is_smoke)
    return result


def predeploy_consumption(
    history_dir: Path, catalog_path: Path, *, now: datetime | None = None
) -> dict[str, Any]:
    """Measured resource use of each predeploy benchmark trajectory per deploy."""
    attempts = []
    for row in _factory_ledger_module().read_jsonl(history_dir / "task_attempts.jsonl"):
        if row.get("suite") != "predeploy" or not row.get("task") or not row.get("timestamp"):
            continue
        try:
            end = parse_time(str(row["timestamp"])).timestamp()
            duration = max(0.0, float(row.get("duration_seconds") or 0.0))
        except (TypeError, ValueError):
            continue
        attempts.append(
            {
                "task": str(row["task"]),
                "agent_id": str(row.get("agent_id") or ""),
                "passed": bool(row.get("passed")),
                "cost_cents": float(row.get("cost_cents") or 0.0),
                "duration": duration,
                "start": end - duration,
                "end": end,
            }
        )
    if not attempts:
        return {"attempts": 0, "deploys": 0, "tasks": [], "categories": [], "windows": []}
    branches = span_agent_branches(history_dir)
    by_branch: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for attempt in attempts:
        by_branch[branches.get(attempt["agent_id"], "")].append(attempt)
    deploys: list[list[dict[str, Any]]] = []
    for branch, members in by_branch.items():
        if branch:
            deploys.extend(_cluster_deploys(members, PREDEPLOY_DEPLOY_GAP_SECONDS, branch))
        else:
            deploys.extend(
                _cluster_deploys(members, PREDEPLOY_UNATTRIBUTED_GAP_SECONDS, "unattributed")
            )
    deploys.sort(key=lambda members: min(item["start"] for item in members))

    categories = catalog_categories(catalog_path)

    deploy_summaries = []
    task_deploys: dict[str, int] = defaultdict(int)
    task_failed_deploys: dict[str, int] = defaultdict(int)
    for index, members in enumerate(deploys):
        tasks = {item["task"] for item in members}
        for task in tasks:
            task_deploys[task] += 1
            if not any(item["passed"] for item in members if item["task"] == task):
                task_failed_deploys[task] += 1
        deploy_summaries.append(
            {
                "index": index,
                "branch": members[0]["deploy_branch"],
                "started_at": _epoch_iso(min(item["start"] for item in members)),
                "attempts": len(members),
                "tasks": len(tasks),
                "agent_minutes": sum(item["duration"] for item in members) / 60,
                "wall_minutes": interval_union_seconds(
                    [(item["start"], item["end"]) for item in members]
                )
                / 60,
                "cents": sum(item["cost_cents"] for item in members),
            }
        )

    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for attempt in attempts:
        by_task[attempt["task"]].append(attempt)
    task_rows = []
    for task, members in by_task.items():
        category, smoke = categories.get(task, ("uncategorized", False))
        durations = [item["duration"] for item in members]
        costs = [item["cost_cents"] for item in members]
        passes = sum(item["passed"] for item in members)
        deploy_count = task_deploys[task]
        task_rows.append(
            {
                "task": task,
                "category": category,
                "smoke": smoke,
                "attempts": len(members),
                "deploys": deploy_count,
                "attempts_per_deploy": len(members) / deploy_count if deploy_count else 0.0,
                "median_seconds": statistics.median(durations),
                "p90_seconds": _percentile(durations, 0.9),
                "median_cents": statistics.median(costs),
                "total_cents": sum(costs),
                "agent_minutes_per_deploy": sum(durations) / 60 / deploy_count if deploy_count else 0.0,
                "cents_per_deploy": sum(costs) / deploy_count if deploy_count else 0.0,
                "agent_minutes": sum(durations) / 60,
                "pass_rate": passes / len(members),
                "failed_deploys": task_failed_deploys[task],
                "last_seen": _epoch_iso(max(item["end"] for item in members)),
            }
        )
    total_agent_minutes = sum(row["agent_minutes"] for row in task_rows) or 1.0
    for row in task_rows:
        row["agent_share"] = row["agent_minutes"] / total_agent_minutes
    task_rows.sort(key=lambda row: -row["agent_minutes"])

    by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in task_rows:
        by_category[row["category"]].append(row)
    category_rows = []
    for category, members in by_category.items():
        joint_pass = 1.0
        for row in members:
            joint_pass *= row["pass_rate"]
        category_rows.append(
            {
                "category": category,
                "tasks": [row["task"] for row in members],
                "agent_share": sum(row["agent_share"] for row in members),
                "agent_minutes_per_deploy": sum(row["agent_minutes_per_deploy"] for row in members),
                "cents_per_deploy": sum(row["cents_per_deploy"] for row in members),
                "trajectories_per_deploy": sum(row["attempts_per_deploy"] for row in members),
                # A merged trajectory passes only when every member behavior passes.
                "joint_pass_rate": joint_pass,
            }
        )
    category_rows.sort(key=lambda row: -row["agent_share"])

    current = now or datetime.now(timezone.utc)
    # Whole UTC days: the latest window ends with today, inclusive.
    tomorrow = datetime.combine(current.date() + timedelta(days=1), datetime.min.time(), timezone.utc)
    windows = []
    for label, offset in (("latest", 0), ("previous", 1)):
        window_end = tomorrow - timedelta(days=PREDEPLOY_WINDOW_DAYS * offset)
        window_start = window_end - timedelta(days=PREDEPLOY_WINDOW_DAYS)
        members = [
            summary
            for summary in deploy_summaries
            if window_start <= parse_time(summary["started_at"]) < window_end
        ]

        def median_of(key: str, members: list[dict[str, Any]] = members) -> float | None:
            return statistics.median(item[key] for item in members) if members else None

        windows.append(
            {
                "label": label,
                "start": window_start.date().isoformat(),
                "end": (window_end - timedelta(days=1)).date().isoformat(),
                "deploys": len(members),
                "median_attempts": median_of("attempts"),
                "median_agent_minutes": median_of("agent_minutes"),
                "median_wall_minutes": median_of("wall_minutes"),
                "median_cents": median_of("cents"),
            }
        )
    return {
        "attempts": len(attempts),
        "deploys": len(deploys),
        "attributed_deploys": sum(1 for summary in deploy_summaries if summary["branch"] != "unattributed"),
        "first": _epoch_iso(min(item["start"] for item in attempts)),
        "last": _epoch_iso(max(item["end"] for item in attempts)),
        "tasks": task_rows,
        "categories": category_rows,
        "windows": windows,
    }


def analyze(
    turns: Sequence[Turn],
    deploy_since: str,
    limit: int,
    *,
    descend_records: Sequence[dict[str, Any]] = (),
    descend_window: int = 5,
    predeploy: dict[str, Any] | None = None,
    sources: dict[str, Any] | None = None,
) -> dict[str, Any]:
    all_deploy_attempts = [turn for turn in turns if turn.command == "deploy"]
    all_deploys = [
        turn
        for turn in turns
        if turn.command == "deploy" and turn.status == "completed"
    ]
    deploys = [turn for turn in all_deploys if turn.started_at >= deploy_since][-limit:]
    approval_attempts = [
        turn for turn in all_deploy_attempts if turn.started_at >= deploy_since
    ]
    all_rcas = [
        turn
        for turn in turns
        if turn.command == "rca" and turn.status in {"completed", "diagnosis-ready"}
    ]
    rcas = all_rcas[-limit:]
    deploy = deploy_metrics(deploys)
    if approval_attempts:
        approval_values = [
            approval_turn_values(turn)["Approval guards"] for turn in approval_attempts
        ]
        approval_durations = [
            duration for timing in approval_values for duration in timing.durations
        ]
        approval_row = metric_row(
            "Approval guards",
            sum(timing.runs for timing in approval_values),
            approval_durations,
            sum(timing.wall_seconds for timing in approval_values),
            len(approval_attempts),
        )
        approval_row["description"] = (
            f"Request → decision · {len(approval_durations)} observed across "
            f"{len(approval_attempts)} deploy attempts."
        )
        deploy["steps"] = [
            approval_row if row["step"] == "Approval guards" else row
            for row in deploy["steps"]
        ]
        deploy["approval_observations"] = len(approval_durations)
        deploy["approval_attempts"] = len(approval_attempts)
        deploy["approval_sources"] = [
            {
                "workspace": event.workspace,
                "session_id": event.session_id,
                "request_turn_id": event.request_turn_id,
                "deploy_started_at": event.deploy_started_at,
                "requested_at": event.requested_at,
                "decided_at": event.decided_at,
                "decision": event.decision,
                "duration_minutes": event.duration / 60,
                "request_source": event.request_source,
                "decision_source": event.decision_source,
            }
            for turn in approval_attempts
            for event in turn.approval_events
        ]
    deploy["trend_completed"] = len(all_deploys)
    deploy["trends"] = build_trends(
        all_deploys,
        DEPLOY_REPORT_LABELS,
        deploy_turn_values,
        measurement_fn=deploy_measurement_mode,
    )
    deploy["trends"]["Approval guards"] = build_trends(
        all_deploy_attempts,
        ["Approval guards"],
        approval_turn_values,
        command_kind="attempt",
    )["Approval guards"]
    rca = rca_metrics(rcas)
    rca["trend_completed"] = len(all_rcas)
    rca["trends"] = build_trends(
        all_rcas,
        RCA_LABELS,
        rca_turn_values,
        measurement_fn=rca_measurement_mode,
    )
    return {
        "generated_at": datetime.now().astimezone().isoformat(),
        "definition": (
            "Runs are distinct lifecycle execution bursts per command; overlapping sibling calls count once. "
            "Approval guards run from the assistant's explicit request to the human's approval or rejection, even across turns. "
            "Avg Time is lifecycle start-to-finish "
            "wall clock; Total Time is the union of those lifecycle wall spans per command. "
            "A combined coverage-blackbox call appears in both semantic rows but counts once in Total Runs and is unioned once in group wall clock; old calls containing unrelated gates stay unsplit. "
            "The Total row is the logical deploy start-to-finish wall clock, including a blocked deploy resumed after approval, and never adds parallel branches."
            " Group wall-clock rows union their member lifecycle envelopes; they equal the longest member only when the lanes start together and remain overlapped. "
            "Group wall clocks do not necessarily add to end-to-end because groups can overlap and the deploy includes transitions, fixes, commits, and waits outside classified gates."
        ),
        "trend_definition": (
            "Trend points are calendar buckets calculated from completed command turns, except approval waits, which use every deploy attempt so blocked decisions remain visible. "
            "Every point includes its source turn IDs, observed lifecycle count, and wall-clock span. "
            "Instrumented RCA runs use complete explicit stage events; older RCA runs remain clearly counted as inferred, and partial event sets are flagged as incomplete."
        ),
        "deploy_since": deploy_since,
        "deploy": deploy,
        "rca": rca,
        "descend": descend_metrics(descend_records, descend_window),
        **({"predeploy": predeploy} if predeploy is not None else {}),
        **({"sources": sources} if sources is not None else {}),
        "deploy_runs": [
            {
                "workspace": turn.workspace,
                "started_at": turn.started_at,
                "minutes": deploy_duration(turn) / 60,
            }
            for turn in deploys
        ],
        "rca_runs": [
            {
                "workspace": turn.workspace,
                "started_at": turn.started_at,
                "minutes": turn.duration / 60,
            }
            for turn in rcas
        ],
    }


def format_minutes(value: float) -> str:
    return f"{value:.1f}m"


def render_sequence_legend(workflow: str) -> str:
    if workflow != "deploy":
        return ""
    return (
        '<div class="sequence-legend">'
        "Number = start order · matching numbers start together · group wall = union, not a sum · Total = end-to-end"
        "</div>"
    )


def render_history_note(workflow: str, metrics: dict[str, Any]) -> str:
    historical = metrics.get("historical_unclassified")
    if workflow != "deploy" or not historical or historical["runs"] == 0:
        return ""
    return (
        '<p class="history-note"><strong>Historical data gap — not a deploy step:</strong> '
        f'{historical["runs"]:.1f} unsplit calls/deploy · '
        f'{format_minutes(historical["total_minutes"])} wall clock. '
        "Excluded from stage Runs; included in end-to-end time.</p>"
    )


def render_table(
    title: str, workflow: str, metrics: dict[str, Any], note: str = ""
) -> str:
    rows = []
    for step in metrics["steps"]:
        step_name = html.escape(step["step"], quote=True)
        is_group_summary = step["step"] in DEPLOY_GROUP_SUMMARIES
        display_name = "End-to-end" if step["step"] == "Total" else step_name
        description = html.escape(
            str(step.get("description") or STEP_DESCRIPTIONS[workflow][step["step"]])
        )
        if step.get("incomplete_commands", 0):
            description += html.escape(
                f" · {step['incomplete_commands']} incomplete telemetry."
            )
        if step["step"] == "Total":
            row_class = "metric-row total-row"
        elif is_group_summary:
            row_class = "metric-row group-total-row"
        else:
            row_class = "metric-row"
        stage, badge_class = STAGE_BADGES[workflow][step["step"]]
        stage_name = "end-to-end total" if stage == "Total" else f"stage {stage}"
        badge = (
            f'<span class="sequence-badge {badge_class}" '
            f'aria-label="{stage_name}">{stage}</span>'
        )
        unavailable_cell = (
            '<td class="metric-chart-cell unavailable-cell">'
            '<span class="cell-value">—</span></td>'
        )
        total_time_cell = (
            unavailable_cell
            if step.get("unavailable")
            else (
                '<td class="metric-chart-cell"><span class="cell-metric">'
                f'<span class="cell-value">{format_minutes(step["total_minutes"])}</span>'
                '<span class="percent-delta" data-metric="total_minutes">—</span></span>'
                '<div class="cell-chart" data-key="total_minutes"></div></td>'
            )
        )
        runs_cell = (
            '<td class="wall-only-cell"></td>'
            if is_group_summary
            else unavailable_cell
            if step.get("unavailable")
            else (
                '<td class="metric-chart-cell"><span class="cell-metric">'
                f'<span class="cell-value">{step["runs"]:.1f}</span>'
                '<span class="percent-delta" data-metric="runs">—</span></span>'
                '<div class="cell-chart" data-key="runs"></div></td>'
            )
        )
        avg_cell = (
            '<td class="wall-only-cell"></td>'
            if is_group_summary
            else unavailable_cell
            if step.get("unavailable")
            else (
                '<td class="metric-chart-cell"><span class="cell-metric">'
                f'<span class="cell-value">{format_minutes(step["avg_minutes"])}</span>'
                '<span class="percent-delta" data-metric="avg_minutes">—</span></span>'
                '<div class="cell-chart" data-key="avg_minutes"></div></td>'
            )
        )
        step_cell = (
            '<td><span class="step-label">'
            f'{badge}<span class="sr-only">{step_name}</span></span></td>'
            if is_group_summary
            else (
                '<td><span class="step-label">'
                f'{badge}<span class="step-copy"><span class="step-title">{display_name}</span>'
                f'<span class="step-description">{description}</span></span></span></td>'
            )
        )
        rows.append(
            f'<tr class="{row_class}" data-workflow="{workflow}" data-step="{step_name}"'
            f' data-stage="{html.escape(stage, quote=True)}">'
            f'{step_cell}'
            f'{runs_cell}{avg_cell}'
            f"{total_time_cell}"
            "</tr>"
        )
    note_html = f'<p class="note">{html.escape(note)}</p>' if note else ""
    completion_summary = (
        f"{format_minutes(metrics['end_to_end_minutes'])} end-to-end · "
        f"{metrics['completed']} completed"
        if metrics["completed"]
        else "No completed runs in this data source"
    )
    completion_summary += (
        f" · {metrics.get('instrumented', 0)} instrumented · "
        f"{metrics.get('inferred', metrics['completed'])} historical inferred"
    )
    if metrics.get("incomplete", 0):
        completion_summary += f" · {metrics['incomplete']} incomplete telemetry"
    return (
        '<section class="flow">'
        '<div class="heading">'
        f"<h2>{html.escape(title)}</h2>"
        f"<p>{completion_summary}</p>"
        "</div>"
        f"{render_sequence_legend(workflow)}"
        f'<table aria-label="{html.escape(title)} state timing averages">'
        "<thead><tr><th>Step</th><th>Runs</th><th>Avg Time</th><th>Total Time</th>"
        "</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>{note_html}"
        f"{render_history_note(workflow, metrics)}</section>"
    )


def format_seconds(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 60:
        return f"{value / 60:.1f}m"
    return f"{value:.1f}s"


def render_descend_table(metrics: dict[str, Any]) -> str:
    wall = metrics["run_wall_clock"]
    wall_change = wall["change_percent"]
    wall_change_text = "—" if wall_change is None else f"{wall_change:+.1f}%"
    rows = []
    for step in metrics["steps"]:
        change = step["change_percent"]
        change_text = "—" if change is None else f"{change:+.1f}%"
        rows.append(
            '<tr class="descend-metric-row">'
            f'<td>{html.escape(step["step"])}</td>'
            f'<td>{step["samples"]}</td>'
            f'<td>{format_seconds(step["latest_seconds"])}</td>'
            f'<td>{format_seconds(step["recent_median_seconds"])}</td>'
            f'<td>{format_seconds(step["previous_median_seconds"])}</td>'
            f"<td>{change_text}</td>"
            "</tr>"
        )
    if not rows:
        rows.append(
            '<tr class="descend-metric-row"><td>No completed steps</td>'
            "<td>0</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>"
        )
    summary = (
        f'{wall["completed_runs"]} completed · '
        f'recent {format_seconds(wall["recent_median_seconds"])} · '
        f'previous {format_seconds(wall["previous_median_seconds"])} · '
        f"change {wall_change_text}"
    )
    return (
        '<section class="flow">'
        '<div class="heading"><h2>/descend</h2>'
        f"<p>{summary}</p></div>"
        '<p class="note">Completed main-lane factory events from the checked-in '
        "append-only timing ledger. Negative change is faster.</p>"
        '<div class="table-scroll"><table class="descend-table" aria-label="/descend iteration timing">'
        "<thead><tr><th>Step</th><th>Samples</th><th>Latest</th>"
        "<th>Recent median</th><th>Previous median</th><th>Change</th></tr></thead>"
        f'<tbody>{"".join(rows)}</tbody></table></div></section>'
    )


def render_sources_note(sources: dict[str, Any]) -> str:
    gaps = "".join(f"<li>{html.escape(gap)}</li>" for gap in sources.get("gaps", []))
    return (
        '<section class="flow"><p class="history-note"><strong>Data source:</strong> '
        f'{html.escape(sources["description"])}</p>'
        + (f'<ul class="note source-gaps">{gaps}</ul>' if gaps else "")
        + "</section>"
    )


def render_diagnostics_section(diagnostics: dict[str, Any]) -> str:
    lines = _factory_ledger_module("factory_diagnostics").render_text(diagnostics)
    return (
        '<section class="flow"><h2>Failures, reruns and gaps</h2>'
        '<p class="history-note">From stage/event <code>detail</code> in the factory ledger; '
        "rows recorded before detail existed count toward attempts and gaps only.</p>"
        f'<pre class="note">{html.escape(chr(10).join(lines))}</pre></section>'
    )


def render_predeploy_section(metrics: dict[str, Any]) -> str:
    if not metrics.get("attempts"):
        return (
            '<section class="flow"><div class="heading"><h2>Deploy-path benchmark '
            "trajectories</h2><p>No predeploy attempts recorded</p></div></section>"
        )

    def money(cents: float | None) -> str:
        return "—" if cents is None else f"${cents / 100:.2f}"

    def minutes(value: float | None) -> str:
        return "—" if value is None else format_minutes(value)

    def count(value: float | None) -> str:
        return "—" if value is None else f"{value:.0f}"

    window_rows = "".join(
        "<tr>"
        f'<td>{html.escape(window["label"].title())} {window["start"]} → {window["end"]}</td>'
        f'<td>{window["deploys"]}</td>'
        f'<td>{count(window["median_attempts"])}</td>'
        f'<td>{minutes(window["median_agent_minutes"])}</td>'
        f'<td>{minutes(window["median_wall_minutes"])}</td>'
        f'<td>{money(window["median_cents"])}</td>'
        "</tr>"
        for window in metrics["windows"]
    )
    task_rows = "".join(
        "<tr>"
        f'<td>{html.escape(row["task"])}{" · smoke" if row["smoke"] else ""}</td>'
        f'<td>{html.escape(row["category"])}</td>'
        f'<td>{row["agent_share"] * 100:.1f}%</td>'
        f'<td>{row["deploys"]}</td>'
        f'<td>{row["attempts_per_deploy"]:.2f}</td>'
        f'<td>{format_seconds(row["median_seconds"])}</td>'
        f'<td>{format_minutes(row["agent_minutes_per_deploy"])}</td>'
        f'<td>{money(row["cents_per_deploy"])}</td>'
        f'<td>{row["pass_rate"] * 100:.0f}%</td>'
        f'<td>{row["failed_deploys"]}</td>'
        "</tr>"
        for row in metrics["tasks"]
    )
    category_rows = "".join(
        "<tr>"
        f'<td>{html.escape(row["category"])}</td>'
        f'<td class="wrap-cell">{html.escape(", ".join(row["tasks"]))}</td>'
        f'<td>{row["agent_share"] * 100:.1f}%</td>'
        f'<td>{row["trajectories_per_deploy"]:.2f}</td>'
        f'<td>{format_minutes(row["agent_minutes_per_deploy"])}</td>'
        f'<td>{money(row["cents_per_deploy"])}</td>'
        f'<td>{row["joint_pass_rate"] * 100:.0f}%</td>'
        "</tr>"
        for row in metrics["categories"]
        if len(row["tasks"]) > 1
    )
    return (
        '<section class="flow">'
        '<div class="heading"><h2>Deploy-path benchmark trajectories</h2>'
        f'<p>{metrics["attempts"]} predeploy attempts · {metrics["deploys"]} deploys '
        f'({metrics["attributed_deploys"]} branch-attributed) · '
        f'{metrics["first"][:10]} → {metrics["last"][:10]}</p></div>'
        '<p class="note">Each attempt is one agent trajectory from the checked-in '
        "predeploy ledger (task_attempts.jsonl, suite=predeploy). Deploys are grouped "
        "by the branch-named span ledger, or by time gaps when no branch file exists. "
        "Agent time sums trajectory durations; wall clock unions them.</p>"
        '<div class="table-scroll"><table class="predeploy-table" aria-label="Predeploy cost per deploy window">'
        "<thead><tr><th>Window</th><th>Deploys</th><th>Trajectories</th>"
        "<th>Agent time</th><th>Wall clock</th><th>Cost</th></tr></thead>"
        f"<tbody>{window_rows}</tbody></table></div>"
        '<div class="table-scroll"><table class="predeploy-table" aria-label="Predeploy trajectories by consumption">'
        "<thead><tr><th>Trajectory</th><th>Category</th><th>Agent-time share</th>"
        "<th>Deploys</th><th>Runs/deploy</th>"
        "<th>Median</th><th>Agent time/deploy</th><th>Cost/deploy</th><th>Pass</th>"
        "<th>Failed deploys</th></tr></thead>"
        f"<tbody>{task_rows}</tbody></table></div>"
        '<p class="note">Combination candidates: trajectories that share a deploy '
        "category. Joint pass is the product of member pass rates — the expected pass "
        "rate if their behaviors were asserted in one trajectory.</p>"
        '<div class="table-scroll"><table class="predeploy-table" aria-label="Same-category combination candidates">'
        "<thead><tr><th>Category</th><th>Trajectories</th><th>Agent-time share</th><th>Runs/deploy</th>"
        "<th>Agent time/deploy</th><th>Cost/deploy</th><th>Joint pass</th></tr></thead>"
        f"<tbody>{category_rows}</tbody></table></div></section>"
    )


def render_html(payload: dict[str, Any]) -> str:
    deploy = payload["deploy"]
    deploy_note = (
        "Avg = one run start → finish. Total = wall time spent in that step. "
        "Group wall is the union of its lanes, so it equals the longest lane only "
        "when starts and retries align. The slowest lane can differ per deploy, so "
        "the average group wall need not equal the largest child average. "
        "Group rows do not add to end-to-end: groups can overlap, "
        "and fixes, commits, transitions, and waits can sit outside them. "
        "End-to-end is the full logical /deploy start → finish."
    )
    content = (
        render_sources_note(payload["sources"]) if "sources" in payload else ""
    )
    content += render_table("/deploy", "deploy", deploy, deploy_note) + render_table(
        "/RCA",
        "rca",
        payload["rca"],
        "All times are phase start → next phase start (or command finish).",
    )
    if "descend" in payload:
        content += render_descend_table(payload["descend"])
    if "predeploy" in payload:
        content += render_predeploy_section(payload["predeploy"])
    if payload.get("diagnostics"):
        content += render_diagnostics_section(payload["diagnostics"])
    trend_data = json.dumps(
        {
            "generated_at": payload["generated_at"],
            "deploy": {
                "completed": deploy["trend_completed"],
                "trends": deploy["trends"],
            },
            "rca": {
                "completed": payload["rca"]["trend_completed"],
                "trends": payload["rca"]["trends"],
            },
        },
        separators=(",", ":"),
    ).replace("<", "\\u003c")
    template = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Factory Review</title>
  <style>
    :root { color-scheme: light dark; --fg: light-dark(#17211f, #edf5f2); --muted: light-dark(#68736f, #aab4b0); --border: light-dark(#dfe5e2, #38423f); --bg: light-dark(#ffffff, #101715); --popover: light-dark(#ffffff, #19211f); --hover: light-dark(#f1f6f4, #1a2522); --runs: light-dark(#17745f, #77d4bc); --time: light-dark(#94600f, #efbe68); --up-bg: light-dark(#fff0ed, #3a211d); --up-fg: light-dark(#a73724, #ff9d8d); --down-bg: light-dark(#e9f7f1, #173128); --down-fg: light-dark(#14634f, #77d4bc); --neutral-bg: light-dark(#eff2f1, #26302d); --shadow: light-dark(#13231f2b, #00000066); --group-1-bg: light-dark(#fff0a8, #5b4800); --group-1-fg: light-dark(#684d00, #ffe58a); --group-2-bg: light-dark(#ffd8b0, #66350f); --group-2-fg: light-dark(#7a3700, #ffd0a3); }
    * { box-sizing: border-box; }
    body { background: var(--bg); color: var(--fg); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px 16px; }
    main { display: grid; gap: 26px; margin: 0 auto; max-width: 860px; }
    .range-bar { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
    .range-label { color: var(--muted); font-size: 13px; }
    .range-toggle { background: var(--neutral-bg); border-radius: 8px; display: inline-flex; padding: 3px; }
    .range-button { background: transparent; border: 0; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; padding: 5px 9px; }
    .range-button:hover { color: var(--fg); }
    .range-button[aria-pressed="true"] { background: var(--popover); box-shadow: 0 1px 3px var(--shadow); color: var(--fg); }
    .range-explainer { color: var(--muted); font-size: 11px; }
    .flow { display: grid; gap: 9px; }
    .heading { align-items: baseline; display: flex; flex-wrap: wrap; gap: 8px; }
    h2, h3, p { margin: 0; }
    h2 { font-size: 20px; font-weight: 600; }
    .heading p, .note, .history-note { color: var(--muted); font-size: 13px; }
    .history-note strong { color: var(--fg); font-weight: 600; }
    .sequence-legend { color: var(--muted); font-size: 11px; }
    .sequence-badge { align-items: center; border-radius: 999px; display: inline-flex; flex: 0 0 19px; font-size: 11px; font-weight: 600; height: 19px; justify-content: center; width: 19px; }
    .sequence-badge.stage-neutral, .sequence-badge.stage-special { background: var(--neutral-bg); color: var(--muted); }
    .sequence-badge.stage-special { flex-basis: auto; padding: 0 6px; width: auto; }
    .sequence-badge.parallel-1 { background: var(--group-1-bg); color: var(--group-1-fg); }
    .sequence-badge.parallel-2 { background: var(--group-2-bg); color: var(--group-2-fg); }
    table { border-collapse: collapse; font-variant-numeric: tabular-nums; table-layout: fixed; width: 100%; }
    th, td { border-bottom: 1px solid var(--border); padding: 9px 8px; text-align: right; vertical-align: top; white-space: nowrap; }
    th:first-child, td:first-child { padding-left: 0; text-align: left; white-space: normal; }
    th:last-child, td:last-child { padding-right: 0; }
    th:nth-child(1), td:nth-child(1) { width: 38%; }
    th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { width: 23%; }
    th:nth-child(4), td:nth-child(4) { width: 16%; }
    th { color: var(--muted); font-size: 13px; font-weight: 400; }
    td:not(:first-child) { font-weight: 600; }
    .step-label { align-items: flex-start; display: flex; gap: 7px; }
    .step-copy { display: grid; gap: 2px; min-width: 0; }
    .step-title { font-weight: 500; }
    .step-description { color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.25; }
    .cell-metric { align-items: center; display: inline-flex; gap: 6px; justify-content: flex-end; }
    .cell-value { font-weight: 600; }
    .percent-delta { border-radius: 999px; color: var(--muted); display: inline-block; font-size: 11px; font-weight: 500; min-width: 42px; padding: 2px 5px; text-align: center; }
    .percent-delta.is-up { background: var(--up-bg); color: var(--up-fg); }
    .percent-delta.is-down { background: var(--down-bg); color: var(--down-fg); }
    .percent-delta.is-flat { background: var(--neutral-bg); color: var(--muted); }
    .metric-row td { padding-bottom: 11px; }
    .group-total-row td { background: var(--hover); border-top: 1px solid var(--border); font-weight: 600; padding-bottom: 4px; padding-top: 4px; vertical-align: middle; }
    .group-total-row .cell-chart { margin-top: 2px; }
    .group-total-row .trend-chart { height: 22px; }
    .wall-only-cell { color: var(--muted); vertical-align: middle; }
    .descend-table th:nth-child(1), .descend-table td:nth-child(1) { width: 31%; }
    .descend-table th:nth-child(n+2), .descend-table td:nth-child(n+2) { width: 13.8%; }
    .table-scroll { margin-top: 10px; overflow-x: auto; }
    .predeploy-table { table-layout: auto; }
    .predeploy-table th:nth-child(n), .predeploy-table td:nth-child(n) { width: auto; }
    .predeploy-table td.wrap-cell { min-width: 220px; white-space: normal; }
    .predeploy-table td:first-child { white-space: nowrap; }
    .predeploy-table td, .predeploy-table th { font-size: 13px; padding-left: 6px; padding-right: 6px; }
    .source-gaps { margin: 4px 0 0; padding-left: 18px; }
    .sr-only { clip: rect(0, 0, 0, 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
    .total-row td { border-top: 2px solid var(--border); font-weight: 600; }
    .cell-chart { margin-top: 6px; }
    .mini-chart { min-width: 0; position: relative; }
    .trend-chart { display: block; height: 34px; overflow: visible; width: 100%; }
    .trend-chart .baseline, .trend-chart .guide { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .trend-chart .guide { visibility: hidden; }
    .trend-chart .series-line { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; vector-effect: non-scaling-stroke; }
    .trend-chart.runs .series-line, .trend-chart.runs .point { stroke: var(--runs); }
    .trend-chart.time .series-line, .trend-chart.time .point { stroke: var(--time); }
    .trend-chart .point { fill: var(--popover); stroke-width: 1.7; vector-effect: non-scaling-stroke; }
    .trend-chart .point.is-active { fill: var(--fg); r: 3.3; }
    .trend-chart .hit-area { cursor: crosshair; fill: transparent; pointer-events: all; }
    .chart-tooltip { background: var(--popover); border: 1px solid var(--border); border-radius: 7px; box-shadow: 0 8px 20px var(--shadow); font-size: 11px; font-weight: 400; min-width: 180px; padding: 7px 8px; pointer-events: none; position: absolute; text-align: left; top: 36px; transform: translateX(-50%); white-space: nowrap; z-index: 5; }
    .chart-tooltip[hidden] { display: none; }
    .chart-tooltip strong { display: block; font-size: 12px; font-weight: 600; margin-bottom: 2px; }
    .chart-tooltip span { color: var(--muted); display: block; }
    .sparse { color: var(--muted); font-size: 11px; min-height: 34px; padding-top: 8px; }
    @media (max-width: 560px) {
      body { padding-left: 12px; padding-right: 12px; }
      th, td { font-size: 13px; padding-left: 4px; padding-right: 4px; }
      .cell-metric { align-items: flex-end; flex-direction: column; gap: 2px; }
      .percent-delta { min-width: 38px; padding-left: 3px; padding-right: 3px; }
      .chart-tooltip { min-width: 165px; top: 30px; }
      .trend-chart { height: 28px; }
      th:nth-child(1), td:nth-child(1) { width: 34%; }
      th:nth-child(2), td:nth-child(2), th:nth-child(3), td:nth-child(3) { width: 25%; }
      th:nth-child(4), td:nth-child(4) { width: 16%; }
      .descend-table { min-width: 560px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="range-bar" aria-label="Trend comparison range">
      <span class="range-label">Change by</span>
      <div class="range-toggle">
        <button type="button" class="range-button" data-scale="weekly" aria-pressed="true">Weekly</button>
        <button type="button" class="range-button" data-scale="monthly" aria-pressed="false">Monthly</button>
        <button type="button" class="range-button" data-scale="quarterly" aria-pressed="false">Quarterly</button>
      </div>
      <span id="range-explainer" class="range-explainer" aria-live="polite"></span>
    </div>
    __CONTENT__
  </main>
  <script id="factory-trends" type="application/json">__TREND_DATA__</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById("factory-trends").textContent);
      const rows = [...document.querySelectorAll(".metric-row")];
      const rangeButtons = [...document.querySelectorAll(".range-button")];
      const rangeExplainer = document.getElementById("range-explainer");
      const scaleNames = { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly" };
      const reportDate = new Date(`${data.generated_at.slice(0, 10)}T00:00:00Z`);
      let selectedScale = "weekly";

      const escapeMarkup = (value) => String(value).replace(/[&<>"']/g, (char) => {
        if (char === '"') return "&quot;";
        if (char === "'") return "&#039;";
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char];
      });

      function formatMetric(value, key) {
        return key === "runs" ? value.toFixed(1) : `${value.toFixed(1)}m`;
      }

      function periodEnd(periodStart, scale) {
        const start = new Date(`${periodStart}T00:00:00Z`);
        let naturalEnd;
        if (scale === "weekly") {
          naturalEnd = new Date(start.getTime() + 6 * 86400000);
        } else if (scale === "monthly") {
          naturalEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
        } else {
          naturalEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
        }
        return naturalEnd > reportDate ? reportDate : naturalEnd;
      }

      function dateSpan(start, end) {
        const month = (value) => value.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
        const day = (value) => value.getUTCDate();
        const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
        const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
        if (sameMonth) {
          return `${month(start)} ${day(start)}–${day(end)}, ${end.getUTCFullYear()}`;
        }
        if (sameYear) {
          return `${month(start)} ${day(start)}–${month(end)} ${day(end)}, ${end.getUTCFullYear()}`;
        }
        return `${month(start)} ${day(start)}, ${start.getUTCFullYear()}–${month(end)} ${day(end)}, ${end.getUTCFullYear()}`;
      }

      function pointRange(point, scale) {
        const start = new Date(`${point.period_start}T00:00:00Z`);
        return dateSpan(start, periodEnd(point.period_start, scale));
      }

      function seriesRange(points, scale) {
        if (!points.length) return "No completed commands";
        const start = new Date(`${points[0].period_start}T00:00:00Z`);
        return dateSpan(start, periodEnd(points[points.length - 1].period_start, scale));
      }

      function percentChange(points, key, step) {
        if (points.length < 2) return { text: "—", kind: "na" };
        const previous = points[points.length - 2][key];
        const current = points[points.length - 1][key];
        if (Math.abs(previous) < 0.0001) {
          if (Math.abs(current) < 0.0001) return { text: "0%", kind: "flat" };
          return { text: "new", kind: "up" };
        }
        const percent = ((current - previous) / Math.abs(previous)) * 100;
        if (Math.abs(percent) < 0.5) return { text: "0%", kind: "flat" };
        const rounded = Math.abs(Math.round(percent));
        const magnitude = rounded >= 10000
          ? `${Math.round(rounded / 1000)}k`
          : rounded.toLocaleString("en-US");
        return {
          text: `${percent > 0 ? "+" : "-"}${magnitude}%`,
          kind: percent > 0 ? "up" : "down",
        };
      }

      function chartMarkup(points, key, kind, label, workflow) {
        if (!points.length) {
          return `<div class="mini-chart"><p class="sparse">No completed ${workflow === "deploy" ? "deploys" : "RCAs"}.</p></div>`;
        }
        const width = 200;
        const height = 38;
        const pad = 4;
        const values = points.map((point) => point[key]);
        const low = Math.min(...values);
        const high = Math.max(...values);
        const span = high - low;
        const coords = values.map((value, index) => {
          const x = values.length === 1 ? width / 2 : pad + index * ((width - pad * 2) / (values.length - 1));
          const y = span === 0 ? height / 2 : pad + ((high - value) / span) * (height - pad * 2);
          return [x, y];
        });
        const path = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const pointsMarkup = coords.map(([x, y], index) => `<circle class="point" data-index="${index}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2"/>`).join("");
        const summary = `${label}. ${values.map((value, index) => `${pointRange(points[index], selectedScale)}: ${formatMetric(value, key)}`).join("; ")}`;
        return `<div class="mini-chart" data-key="${key}"><svg class="trend-chart ${kind}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeMarkup(summary)}"><line class="baseline" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"/><line class="guide" x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}"/><polyline class="series-line" points="${path}"/>${pointsMarkup}<rect class="hit-area" x="0" y="0" width="${width}" height="${height}"/></svg><div class="chart-tooltip" hidden></div></div>`;
      }

      function tooltipDetail(point, key, workflow) {
        const measuredCommands = point.instrumented_commands
          + point.inferred_commands
          + point.incomplete_measurement_commands;
        const measurement = measuredCommands
          ? ` · ${point.instrumented_commands} instrumented · ${point.inferred_commands} inferred${point.incomplete_measurement_commands ? ` · ${point.incomplete_measurement_commands} incomplete` : ""}`
          : "";
        const incomplete = point.incomplete_commands
          ? ` · ${point.incomplete_commands} incomplete telemetry`
          : "";
        const commandNoun = workflow === "deploy"
          ? point.command_kind === "attempt"
            ? `${point.commands} deploy attempt${point.commands === 1 ? "" : "s"}`
            : `${point.commands} completed deploy${point.commands === 1 ? "" : "s"}`
          : `${point.commands} completed RCA${point.commands === 1 ? "" : "s"}`;
        if (key === "runs") {
          return `${point.total_runs} lifecycle${point.total_runs === 1 ? "" : "s"} · ${commandNoun}${measurement}${incomplete}`;
        }
        if (key === "avg_minutes") {
          return `${point.duration_samples} start→finish sample${point.duration_samples === 1 ? "" : "s"} · ${point.total_run_minutes.toFixed(1)}m wall clock${measurement}${incomplete}`;
        }
        return `${point.total_wall_minutes.toFixed(1)}m wall clock across ${commandNoun}${measurement}${incomplete}`;
      }

      function attachSnapping(chart, points, workflow) {
        const svg = chart.querySelector(".trend-chart");
        if (!svg || !points.length) return;
        const hitArea = svg.querySelector(".hit-area");
        const guide = svg.querySelector(".guide");
        const circles = [...svg.querySelectorAll(".point")];
        const tooltip = chart.querySelector(".chart-tooltip");
        const key = chart.dataset.key;
        const width = 200;
        const pad = 4;

        function showPoint(event) {
          const plotBox = hitArea.getBoundingClientRect();
          const localX = ((event.clientX - plotBox.left) / plotBox.width) * width;
          const ratio = Math.min(1, Math.max(0, (localX - pad) / (width - pad * 2)));
          const index = points.length === 1 ? 0 : Math.round(ratio * (points.length - 1));
          const point = points[index];
          const circle = circles[index];
          circles.forEach((item) => item.classList.toggle("is-active", item === circle));
          const pointX = Number(circle.getAttribute("cx"));
          guide.setAttribute("x1", String(pointX));
          guide.setAttribute("x2", String(pointX));
          guide.style.visibility = "visible";
          const valueLabel = key === "runs"
            ? `${point.runs.toFixed(1)} runs / command`
            : key === "avg_minutes"
              ? `${point.avg_minutes.toFixed(1)}m / lifecycle`
              : `${point.total_minutes.toFixed(1)}m wall / ${workflow === "deploy" ? "deploy" : "RCA"}`;
          tooltip.innerHTML = `<strong>${escapeMarkup(pointRange(point, selectedScale))}</strong><span>${escapeMarkup(valueLabel)}</span><span>${escapeMarkup(tooltipDetail(point, key, workflow))}</span>`;
          tooltip.hidden = false;
          const chartBox = chart.getBoundingClientRect();
          const desiredCenter = plotBox.left + (pointX / width) * plotBox.width;
          const halfWidth = tooltip.offsetWidth / 2;
          const center = Math.min(
            window.innerWidth - halfWidth - 8,
            Math.max(halfWidth + 8, desiredCenter),
          );
          tooltip.style.left = `${center - chartBox.left}px`;
        }

        hitArea.addEventListener("pointermove", showPoint);
        hitArea.addEventListener("pointerdown", showPoint);
        chart.addEventListener("pointerleave", () => {
          tooltip.hidden = true;
          guide.style.visibility = "hidden";
          circles.forEach((item) => item.classList.remove("is-active"));
        });
      }

      function renderRows() {
        rows.forEach((row) => {
          const workflow = row.dataset.workflow;
          const workflowData = data[workflow];
          const points = workflowData.trends[row.dataset.step][selectedScale];
          row.querySelectorAll(".percent-delta").forEach((element) => {
            const change = percentChange(points, element.dataset.metric, row.dataset.step);
            element.textContent = change.text;
            element.className = `percent-delta${change.kind === "na" ? "" : ` is-${change.kind}`}`;
            element.setAttribute(
              "aria-label",
              change.kind === "na"
                ? `Not enough ${selectedScale} calendar intervals for a change`
                : `${scaleNames[selectedScale]} change from the prior calendar interval: ${change.text}`,
            );
          });
          row.querySelectorAll(".cell-chart").forEach((container) => {
            const key = container.dataset.key;
            const kind = key === "runs" ? "runs" : "time";
            const label = key === "runs"
              ? "Runs / command"
              : key === "avg_minutes"
                ? "Avg time / lifecycle"
                : "Total time / command";
            container.innerHTML = chartMarkup(points, key, kind, label, workflow);
            const chart = container.querySelector(".mini-chart");
            attachSnapping(chart, points, workflow);
          });
        });
        const workflowRanges = ["deploy", "rca"].map((workflow) => {
          const firstStep = workflow === "deploy"
            ? data[workflow].trends.Total
            : Object.values(data[workflow].trends)[0];
          return `/${workflow === "rca" ? "RCA" : "deploy"} ${seriesRange(firstStep[selectedScale], selectedScale)} (${data[workflow].completed} completed)`;
        });
        rangeExplainer.textContent = workflowRanges.join(" · ");
      }

      rangeButtons.forEach((button) => {
        button.addEventListener("click", () => {
          selectedScale = button.dataset.scale;
          rangeButtons.forEach((item) => {
            item.setAttribute("aria-pressed", String(item === button));
          });
          renderRows();
        });
      });
      renderRows();
    })();
  </script>
</body>
</html>
"""
    return template.replace("__CONTENT__", content).replace(
        "__TREND_DATA__", trend_data
    )


def print_summary(payload: dict[str, Any]) -> None:
    for name in ("deploy", "rca"):
        metrics = payload[name]
        label = f"/{name.upper() if name == 'rca' else name}"
        print(
            f"{label} {metrics['end_to_end_minutes']:.1f}m average ({metrics['completed']} completed)"
            if metrics["completed"]
            else f"{label}: no completed runs in this data source"
        )
        print("Step                       Runs  Avg/run  Total")
        for step in metrics["steps"]:
            if step["step"] in DEPLOY_GROUP_SUMMARIES and not step.get("unavailable"):
                print(
                    f"{step['step']:<26} {'—':>4}  {'—':>7}  "
                    f"{step['total_minutes']:>5.1f}m"
                )
                continue
            if step.get("unavailable"):
                print(f"{step['step']:<26} {'—':>4}  {'—':>7}  {'—':>6}")
                continue
            print(
                f"{step['step']:<26} {step['runs']:>4.1f}  "
                f"{step['avg_minutes']:>6.1f}m  {step['total_minutes']:>5.1f}m"
            )
        print()
    descend = payload.get("descend")
    if descend is not None:
        wall = descend["run_wall_clock"]
        change = wall["change_percent"]
        change_text = "—" if change is None else f"{change:+.1f}%"
        print(
            f"/descend {wall['completed_runs']} completed; "
            f"recent {format_seconds(wall['recent_median_seconds'])}; "
            f"change {change_text}"
        )
        print("Step                       Samples  Latest  Recent  Previous  Change")
        for step in descend["steps"]:
            step_change = step["change_percent"]
            step_change_text = "—" if step_change is None else f"{step_change:+.1f}%"
            print(
                f"{step['step']:<26} {step['samples']:>7}  "
                f"{format_seconds(step['latest_seconds']):>6}  "
                f"{format_seconds(step['recent_median_seconds']):>6}  "
                f"{format_seconds(step['previous_median_seconds']):>8}  "
                f"{step_change_text:>6}"
            )
        print()
    predeploy = payload.get("predeploy")
    if predeploy and predeploy.get("attempts"):
        print(
            f"Predeploy trajectories {predeploy['attempts']} attempts across "
            f"{predeploy['deploys']} deploys ({predeploy['first'][:10]} → {predeploy['last'][:10]})"
        )
        print("Trajectory                                Share  Deploys  Runs/dep  Median  Agent/dep  Cost/dep  Pass")
        for row in predeploy["tasks"]:
            print(
                f"{row['task'][:41]:<41} {row['agent_share'] * 100:>4.1f}%  "
                f"{row['deploys']:>7}  {row['attempts_per_deploy']:>8.2f}  "
                f"{format_seconds(row['median_seconds']):>6}  "
                f"{format_minutes(row['agent_minutes_per_deploy']):>9}  "
                f"${row['cents_per_deploy'] / 100:>7.2f}  {row['pass_rate'] * 100:>3.0f}%"
            )
        print()
    diagnostics = payload.get("diagnostics")
    if diagnostics:
        for line in _factory_ledger_module("factory_diagnostics").render_text(diagnostics):
            print(line)
        print()


def self_test() -> None:
    sample = (
        Invocation("1", "Bash", "", "", 0.0, 10.0, True),
        Invocation("2", "Bash", "", "", 1.0, 8.0, True),
        Invocation("3", "Bash", "", "", 20.0, 25.0, False),
    )
    assert retry_runs(sample) == 2
    sample_timing = invocation_timing(sample)
    assert sample_timing.runs == 2
    assert sample_timing.durations == (10.0, 5.0)
    assert sample_timing.wall_seconds == 15.0
    fast_retry = (
        Invocation("fast-1", "Bash", "", "", 0.0, 5.0, True),
        Invocation("fast-2", "Bash", "", "", 5.0, 8.0, False),
    )
    assert retry_runs(fast_retry) == 2
    assert grouped_timing(failure_separated_groups(fast_retry)).runs == 2
    gate = Invocation("4", "Bash", "npm run test:coverage", "", 0.0, 60.0, False)
    assert classify_deploy_gates(gate) == {"unresolved-coverage"}
    traj_gate = Invocation(
        "traj",
        "Bash",
        "bash scripts/check-llm-trajectory-injection-approval.sh",
        "",
        0.0,
        1.0,
        True,
    )
    assert "llm-trajectory-injection-approval" in classify_deploy_gates(traj_gate)
    assert "llm-trajectory-injection-approval" in APPROVAL_GATES
    first_turn = Turn(
        "deploy",
        "first",
        "s1",
        "t1",
        "2026-03-30T10:00:00+00:00",
        120.0,
        "completed",
        "",
        (gate,),
    )
    second_turn = Turn(
        "deploy",
        "second",
        "s2",
        "t2",
        "2026-07-13T10:00:00+00:00",
        240.0,
        "completed",
        "",
        (
            Invocation("5", "Bash", "npm run test:coverage", "", 0.0, 60.0, True),
            Invocation("6", "Bash", "npm run test:coverage", "", 70.0, 190.0, False),
        ),
    )
    deploy_summary = deploy_metrics((first_turn, second_turn))
    assert len(deploy_summary["steps"]) == len(DEPLOY_REPORT_LABELS)
    total_row = deploy_summary["steps"][-1]
    assert total_row["step"] == "Total"
    assert total_row["runs"] == 1.5
    assert total_row["avg_minutes"] == 3.0
    assert total_row["total_minutes"] == 3.0
    trend_labels = DEPLOY_REPORT_LABELS
    trends = build_trends((first_turn, second_turn), trend_labels, deploy_turn_values)
    assert len(trends["Coverage"]["weekly"]) == 2
    assert len(trends["Coverage"]["monthly"]) == 2
    assert len(trends["Coverage"]["quarterly"]) == 2
    latest = trends["Coverage"]["weekly"][-1]
    assert latest["runs"] == 2.0
    assert latest["avg_minutes"] == 1.5
    assert latest["total_runs"] == 2
    assert latest["duration_samples"] == 2
    assert latest["total_run_minutes"] == 3.0
    assert latest["total_wall_minutes"] == 3.0
    assert latest["source_turn_ids"] == ["t2"]
    latest_total = trends["Total"]["weekly"][-1]
    assert latest_total["runs"] == 2.0
    assert latest_total["avg_minutes"] == 4.0
    assert latest_total["total_runs"] == 2
    assert latest_total["duration_samples"] == 1
    assert latest_total["total_run_minutes"] == 4.0
    assert latest_total["total_wall_minutes"] == 4.0
    assert latest_total["total_minutes"] == 4.0

    wall_clock_turn = Turn(
        "deploy",
        "wall-clock",
        "s3",
        "t3",
        "2026-07-14T10:00:00+00:00",
        15.0,
        "completed",
        "",
        (
            Invocation(
                "7",
                "Bash",
                "bash scripts/run-deploy-stage eslint -- test",
                "",
                0.0,
                5.0,
                False,
            ),
            Invocation(
                "8",
                "Bash",
                "bash scripts/run-deploy-stage typescript -- test",
                "",
                10.0,
                15.0,
                False,
            ),
        ),
    )
    wall_clock_values = deploy_turn_values(wall_clock_turn)
    assert wall_clock_values["Static verify"].wall_seconds == 15.0
    assert wall_clock_values["Group 3 wall clock"].wall_seconds == 15.0
    assert wall_clock_values["Total"].wall_seconds == 15.0
    assert wall_clock_values["Code review"].runs == 0

    bundled_turn = Turn(
        "deploy",
        "bundled",
        "s4",
        "t4",
        "2026-07-15T10:00:00+00:00",
        10.0,
        "completed",
        "",
        (
            Invocation(
                "9",
                "Bash",
                "bash scripts/run-deploy-stage eslint -- lint; "
                "bash scripts/run-deploy-stage backend-coverage -- coverage",
                "",
                0.0,
                10.0,
                False,
            ),
        ),
    )
    bundled_values = deploy_turn_values(bundled_turn)
    assert bundled_values[HISTORICAL_UNSPLIT_LABEL].runs == 1
    assert bundled_values[HISTORICAL_UNSPLIT_LABEL].wall_seconds == 10.0
    bundled_metrics = deploy_metrics([bundled_turn])
    assert bundled_metrics["historical_unclassified"]["runs"] == 1.0
    assert bundled_metrics["steps"][-1]["runs"] == 0.0
    assert bundled_values["Static verify"].runs == 0
    assert bundled_values["Coverage"].runs == 0

    rca_wall_clock = Turn(
        "rca",
        "rca-wall-clock",
        "s5",
        "t5",
        "2026-07-16T10:00:00+00:00",
        100.0,
        "completed",
        "",
        (
            Invocation("10", "Bash", "grep trace logs", "", 0.0, 10.0, False),
            Invocation("11", "Bash", "repro fixture", "", 40.0, 45.0, True),
            Invocation("12", "Bash", "repro fixture", "", 45.1, 50.0, False),
            Invocation("13", "Bash", "pytest post-fix", "", 70.0, 80.0, False),
        ),
    )
    rca_timings = rca_state_rows(rca_wall_clock)
    assert [timing.wall_seconds for timing in rca_timings] == [40.0, 30.0, 30.0]
    assert rca_timings[1].runs == 2
    assert sum(timing.wall_seconds for timing in rca_timings) == 100.0

    metrics = {
        "completed": 1,
        "end_to_end_minutes": 2.0,
        "steps": [
            metric_row("Coverage", 1, (60.0,), 60.0, 1),
            metric_row("Group 3 wall clock", 0, (), 60.0, 1),
            metric_row("Total", 1, (60.0,), 60.0, 1),
        ],
        "trend_completed": 2,
        "trends": {
            "Coverage": trends["Coverage"],
            "Group 3 wall clock": trends["Group 3 wall clock"],
            "Total": trends["Total"],
        },
    }
    rca_fixture = {
        **metrics,
        "steps": [metric_row(label, 1, (60.0,), 60.0, 1) for label in RCA_LABELS],
        "trends": {label: trends["Coverage"] for label in RCA_LABELS},
    }
    page = render_html(
        {
            "generated_at": "2026-07-21T12:00:00-07:00",
            "deploy": metrics,
            "rca": rca_fixture,
        }
    )
    assert "Runs" in page and "Avg Time" in page and "Total Time" in page
    assert "Coverage" in page and "1.0m" in page
    assert "cell-chart" in page and "Weekly" in page and "Quarterly" in page
    assert page.count('data-key="total_minutes"') == 6
    assert "inline-trends" not in page and "trend-row" not in page
    assert "range-button" in page and "percent-delta" in page
    assert "trend-button" not in page and "trend-popover" not in page
    assert "sequence-legend" in page
    assert STAGE_BADGES["deploy"]["Static verify"] == ("3", "parallel-1")
    assert STAGE_BADGES["deploy"]["Runtime blackbox"] == ("3", "parallel-1")
    assert STAGE_BADGES["deploy"]["Group 3 wall clock"] == ("3", "parallel-1")
    assert STAGE_BADGES["deploy"]["Code review"] == ("4", "parallel-2")
    assert STAGE_BADGES["deploy"]["Smoke benchmarks"] == ("4", "parallel-2")
    assert STAGE_BADGES["deploy"]["AgentCard lifecycle"] == ("4", "parallel-2")
    assert STAGE_BADGES["deploy"]["Semantic tests"] == ("4", "parallel-2")
    assert STAGE_BADGES["deploy"]["Group 4 wall clock"] == ("4", "parallel-2")
    assert STAGE_BADGES["deploy"]["Production verify"] == ("5", "stage-neutral")
    assert STEP_DESCRIPTIONS["deploy"]["Auto-fix"] == (
        "Formats files and applies lint fixes."
    )
    assert "step-description" in page
    assert "group-total-row" in page and "wall-only-cell" in page
    assert '<span class="sr-only">Group 3 wall clock</span>' in page
    assert '<span class="step-title">Group 3 wall clock</span>' not in page
    assert "n<2" not in page
    assert 'data-stage="3"' in page and 'data-stage="Total"' in page
    assert "Historical data gap — not a deploy step" not in page
    assert page.count('<span class="sequence-badge') == 6
    assert "4→7" not in page and "1–7" not in page
    assert 'addEventListener("pointermove"' in page
    print("factory-review self-test passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        choices=("auto", "conductor", "ledger"),
        default="auto",
        help="auto uses the Conductor DB when present, else the tracked factory ledger",
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_FACTORY_LEDGER)
    parser.add_argument(
        "--telemetry-root",
        action="append",
        type=Path,
        default=None,
        help="extra directory with deploy-runs/ and factory-events.jsonl "
        "(default: .context; repeatable)",
    )
    parser.add_argument("--history-dir", type=Path, default=DEFAULT_HISTORY_DIR)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--deploy-since", default=DEFAULT_DEPLOY_SINCE)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--descend-history", type=Path, default=DEFAULT_DESCEND_HISTORY)
    parser.add_argument("--descend-window", type=int, default=5)
    parser.add_argument(
        "--output-dir", type=Path, default=Path(".context/factory-review")
    )
    parser.add_argument("--open", action="store_true", dest="open_browser")
    parser.add_argument("--self-test", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.limit < 1:
        raise SystemExit("--limit must be positive")
    if args.descend_window < 1:
        raise SystemExit("--descend-window must be positive")
    source = args.source
    if source == "auto":
        source = "conductor" if args.db.exists() else "ledger"
    if source == "conductor":
        turns = load_turns(args.db, args.repo)
        sources = {
            "mode": "conductor",
            "description": f"Conductor transcripts ({args.db}).",
            "gaps": [],
        }
    roots = args.telemetry_root or [DEFAULT_TELEMETRY_ROOT]
    ledger_rows = load_ledger_rows(args.ledger, roots, [remote_main_text(args.ledger)])
    if source != "conductor":
        turns = sorted(
            [*ledger_deploy_turns(ledger_rows), *ledger_rca_turns(ledger_rows)],
            key=lambda turn: turn.started_at,
        )
        sources = {
            "mode": "ledger",
            "description": (
                f"Tracked factory ledger {args.ledger} (working tree and origin/main) "
                "plus unpublished local telemetry in "
                + ", ".join(str(root) for root in roots)
                + ". No Conductor database on this machine."
            ),
            "gaps": [
                "/deploy and /RCA rows include only runs whose stage records and factory "
                "events reached the ledger; older Conductor-only history is not in the repo.",
                "A run without a final outcome event is excluded, not counted as zero.",
            ],
        }
    descend_records = load_descend_factory_events(
        args.descend_history, [remote_main_text(args.descend_history)]
    )
    payload = analyze(
        turns,
        args.deploy_since,
        args.limit,
        descend_records=descend_records,
        descend_window=args.descend_window,
        predeploy=predeploy_consumption(args.history_dir, args.catalog),
        sources=sources,
    )
    payload["diagnostics"] = _factory_ledger_module("factory_diagnostics").analyze_ledger(
        ledger_rows,
        attempts_path=args.history_dir / "task_attempts.jsonl",
        descend_records=descend_records,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = (args.output_dir / "factory-review.json").resolve()
    html_path = (args.output_dir / "factory-review.html").resolve()
    json_path.write_text(json.dumps(payload, indent=2) + "\n")
    html_path.write_text(render_html(payload))
    print_summary(payload)
    print(f"JSON: {json_path}")
    print(f"HTML: {html_path}")
    if args.open_browser:
        webbrowser.open(html_path.as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
