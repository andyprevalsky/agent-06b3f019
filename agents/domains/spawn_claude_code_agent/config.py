"""Spawn-claude-code-agent domain configuration — constants and defaults."""

from __future__ import annotations

import os
from typing import Final

# Temporary kill-switch for the post-run code-agent completion verifier
# (Claude Code + Codex share this path). When set, the sandbox session's
# natural end is the result — no dual-agent verifier LLM pass.
# Values: 1 / true / yes / on
ROSE_DISABLE_CODE_AGENT_VERIFIER_ENV: Final[str] = "ROSE_DISABLE_CODE_AGENT_VERIFIER"


def code_agent_verifier_disabled() -> bool:
    """Return True when the post-run code-agent verifier should be skipped."""
    raw = os.getenv(ROSE_DISABLE_CODE_AGENT_VERIFIER_ENV, "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


# Silence timeout — if no output for this long, Claude Code is "done talking"
SILENCE_TIMEOUT_S: Final[float] = 1.0

# After the autonomous CC path observes silence and begins waiting for the SDK
# exit, require a fresh WebSocket event within this window. Without it, a hung
# CLI (no exit_code, no further events) spins until MAX_RUNTIME_S — seen on
# cuda-kernel k=3 r12 agent 4e1a84b7 (ScheduleWakeup/Bash then 10m+ of only
# progress chips). Progress chips do not refresh last_output_time.
SDK_IDLE_TIMEOUT_S: Final[float] = 180.0  # 3 minutes of no WS events

# Claude Code's Monitor / ScheduleWakeup tools legitimately go quiet on the
# WebSocket while background work continues (cuda k=3 r21 agent ce189356:
# Monitor + ScheduleWakeup then 180s silence → idle kill, 0 artifacts, score
# 0.5). Keep the short default for ordinary hangs, but stretch the idle window
# after those wait tools so productive sessions are not aborted mid-wait.
# Still well below MAX_RUNTIME_S so a truly stuck Monitor cannot burn the full
# budget.
#
# The same stretched window applies while ANY tool is in-flight (tool_use with
# no matching tool_result yet). Long Bash / Write / network calls emit no WS
# events until they finish — cuda k=3 r22 CC#4 was idle-killed mid-Bash at
# 180s despite active work. tool_result restores the short window unless a
# wait tool has armed the post-wait stretch.
SDK_WAIT_TOOL_IDLE_TIMEOUT_S: Final[float] = 900.0  # 15 minutes after wait tools / in-flight
SDK_WAIT_TOOL_NAMES: Final[frozenset[str]] = frozenset({"Monitor", "ScheduleWakeup"})
# Bash (and Task/TaskOutput for backgrounded work) often emit tool_result while
# work continues off-WebSocket. Treat them like wait tools for idle-arming so
# tool_result does not snap idle back to 180s and kill productive sessions
# (cuda k=3 r24 a2 CC: Bash stretch → tool_result → 180s idle kill, 0 artifacts).
SDK_POST_RESULT_STRETCH_TOOL_NAMES: Final[frozenset[str]] = frozenset(
    {"Bash", "Task", "TaskOutput"}
)

# After the SDK emits type=result (CLI declared completion), do not let
# Bash/Task/ScheduleWakeup re-arm the 900s stretch. Healthy sessions exit
# within ~1s of result (cuda k=3 r31 a1); zombie sessions that keep tooling
# after result (r31 a2: result → ScheduleWakeup/Bash → Max runtime, 0
# artifacts) must fall back to the short idle window so the parent can retry
# inside the bench budget instead of burning 2×1800s.
#
# Absolute backstop if stdout keeps refreshing last_output_time after result
# (prevents idle from ever firing): end the monitor this many seconds after
# the *first* SDK result regardless of stretch/idle.
SDK_POST_RESULT_EXIT_GRACE_S: Final[float] = 180.0

# Structured transcript rows (utils/code_transcript.py) are persisted in batches at most
# this often while new events arrive, plus once when monitoring ends. Live
# token streaming reaches viewers over the sandbox ws (`code_agent_delta`);
# the batches are the durable record, so ≤0.5 writes/s per active code agent.
TRANSCRIPT_FLUSH_INTERVAL_S: Final[float] = 2.0

# Maximum runtime before timeout.
# Keep this well below long rose-bench task budgets (e.g. cuda-kernel 4200s).
# A 60m cap let hung Claude Code sessions burn the whole bench with no parent
# recovery (k=3 2026-09-02: 3009s/3721s CC waits → all timeouts). Successful
# code-agent path finishes CC in ~15m; 30m fails hung sessions with headroom.
MAX_RUNTIME_S: Final[int] = 1800  # 30 minutes (matches E2B SANDBOX_TIMEOUT_MS)

# ── Deploy drain / reattach ──
# Same value as BROWSER_DRAIN_YIELD_STATUS: the activity detached from a sandbox
# that is still running and returned the session for the next attempt.
CODE_AGENT_DRAIN_YIELD_STATUS: Final[str] = "yielded_for_deploy_drain"
# Heartbeat detail key carrying the attached session, so a Temporal retry after
# a dead worker reattaches instead of creating a second sandbox.
CODE_SESSION_HEARTBEAT_KEY: Final[str] = "code_session"
DRAIN_CHECK_INTERVAL_S: Final[float] = 1.0
# The retry after a dead worker starts once this passes without a heartbeat, so
# the sandbox ws-servers' REATTACH_LINGER_MS must outlast it.
CODE_ACTIVITY_HEARTBEAT_TIMEOUT_S: Final[int] = 300
# A reattaching attempt closes the previous sandbox and starts over only after
# this many failed handshakes, so one network blip does not discard a live run.
REATTACH_PROBE_ATTEMPTS: Final[int] = 3
REATTACH_PROBE_BACKOFF_S: Final[float] = 2.0

# Fatal error patterns in Claude Code output that should immediately abort the session.
# These are unrecoverable inside a headless sandbox (e.g., OAuth login can't be completed).
FATAL_ERROR_PATTERNS: Final[list[tuple[str, str]]] = [
    (
        "authentication_error",
        "Claude Code authentication failed (401). The user's Claude credentials are invalid or expired. "
        "They need to re-sync their Claude Code credentials.",
    ),
    (
        "Invalid authentication credentials",
        "Claude Code authentication failed. The user's API key or OAuth token is invalid.",
    ),
    (
        "API Error: 401",
        "Claude Code received a 401 from the Anthropic API. The user's credentials need to be refreshed.",
    ),
    (
        "Please run /login",
        "Claude Code is requesting interactive login, which cannot be completed in a sandbox.",
    ),
    (
        "You've hit your limit",
        "Claude Code OAuth credentials are rate-limited. The credential must be rotated until the reset time.",
    ),
    (
        "/rate-limit-options",
        "Claude Code OAuth credentials are rate-limited. The credential must be rotated instead of waiting in the sandbox.",
    ),
    (
        # Anthropic emits this exact wording ("...is too low") in the CLI banner and
        # API error body ("Your credit balance is too low to access the Anthropic API").
        # The substring "Credit balance is too low" covers both; an earlier pattern
        # without "is" silently never matched, so the sandbox looped instead of aborting.
        "redit balance is too low",
        "Claude Code API billing credit balance is too low. Configure healthy Claude Code OAuth credentials "
        "or refill the shared Anthropic API billing account.",
    ),
    (
        "Credit balance too low",
        "Claude Code API billing credit balance is too low. Configure healthy Claude Code OAuth credentials "
        "or refill the shared Anthropic API billing account.",
    ),
    (
        "Add funds: https://platform.claude.com/settings/billing",
        "Claude Code API billing credit balance is too low. Configure healthy Claude Code OAuth credentials "
        "or refill the shared Anthropic API billing account.",
    ),
]

# Suppress PTY echo from triggering silence detection for this window
ECHO_SUPPRESS_S: Final[float] = 1.0

# After this many unchanged outputs, stop calling LLM (output is stale)
MAX_UNCHANGED_OUTPUTS: Final[int] = 3

# E2B sandbox cost: $0.000028/second = 0.0028 cents/second
E2B_COST_CENTS_PER_SECOND: Final[float] = 0.0028

# ── Run target (C14: cloud sandbox vs the user's Mac) ──
CODE_TARGET_CLOUD: Final[str] = "cloud"
CODE_TARGET_LOCAL: Final[str] = "local"
# Error type for a local (Mac) target that cannot start; matches the backend's
# 409 ``code`` so the handler surfaces the exact text as the tool error.
LOCAL_TARGET_UNAVAILABLE_CODE: Final[str] = "LOCAL_TARGET_UNAVAILABLE"
# Reason codes shared with back-end/src/providers/localDevices/messages.ts.
LOCAL_TARGET_NOT_MAC_ORIGIN: Final[str] = "not_mac_origin"
LOCAL_TARGET_DEVICE_DISCONNECTED: Final[str] = "device_disconnected"
# Exact user-facing tool errors (rose-builds-rose.md C14), shown in the chip's
# red failure box. The backend owns the same templates;
# code_agent_local_target.blackbox.py asserts the two never drift.
LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE: Final[str] = (
    "Local runs need an agent started from the Rose Mac app. "
    "Start this agent from the Mac app, or run it in the cloud."
)
LOCAL_TARGET_DISCONNECTED_TEMPLATE: Final[str] = (
    "Can't run locally: the Rose Mac app on {device_name} is closed or disconnected. "
    "Open the Rose Mac app and retry, or run this agent in the cloud."
)
# Only when a Mac-origin agent's device row has no name.
LOCAL_TARGET_UNKNOWN_DEVICE_NAME: Final[str] = "your Mac"
