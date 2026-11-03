"""Configuration for spawn-browser-agent-v3 domain.

Constants, defaults, and environment reads.
"""

import os
from typing import Any, Mapping, Optional

from providers.rose.legacy_adapter import pool_for_model
from utils.llm_timeouts import VERIFIER_ACTIVITY_TIMEOUT_SECONDS
from utils.oai_demo import is_oai_demo_goal, is_oai_demo_mass_agent_task

# External service keys
STEEL_API_KEY = os.environ.get("STEEL_API_KEY", "")

# Agent loop limits
# A user-blocking handoff (payment-card / write-lock approval) resumes the SAME
# task at its prior step count, so the checkout half of a purchase runs on
# whatever budget the pre-approval half left behind. 50 was not enough to reach
# checkout and then enter a card (prod agent
# 7f354640-ffab-4098-b7ae-041ddf246c6f died at "Max iterations reached: 50"
# mid card entry after resuming at step 32). 60 was still short of a sign-in
# ladder where every option fails: the agent spent its budget on the refused
# options and never reached "ask the user". 250 matches the sub-agent budget of
# the reference harnesses (Hermes delegate 250, Claude Code fork 200).
DEFAULT_MAX_ITERATIONS = 250


def _max_iterations_override() -> int | None:
    """The BROWSER_MAX_ITERATIONS override, or None when unset or invalid."""
    raw = os.environ.get("BROWSER_MAX_ITERATIONS", "").strip()
    if raw.isdigit():
        value = int(raw)
        if value > 0:
            return value
    return None


def get_max_iterations() -> int:
    """Resolve the browser-agent step budget for this worker process."""
    return _max_iterations_override() or DEFAULT_MAX_ITERATIONS


MAX_ITERATIONS = get_max_iterations()
MAX_CONSECUTIVE_API_FAILURES = 5
# One attempt, 30 minutes: a browser session cannot be relied on for longer (Steel
# releases it at its 60-minute plan maximum), so the default budget ends at 250
# steps or 30 minutes, whichever comes first. Only an explicit
# BROWSER_MAX_ITERATIONS above this threshold (benchmarks) opts into a longer window.
ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES = 30
STEPS_COVERED_BY_BASE_TIMEOUT = 60
# test-mass-agent-run-0 Fast Mode only. Live Fast Mode checkouts (Blue Bottle)
# keep the 30m budget. Soft-complete + cache hits on the demo finish in
# seconds; 3m is a hard ceiling so Huberman YouTube hangs cannot burn 30m.
ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES_FAST_MODE = 3


def browser_start_to_close_timeout_minutes(
    *,
    fast_mode: bool,
    goal: str = "",
    workflow_instance=None,
) -> int:
    """3m Fast Mode ceiling is demo-only; every other FM browser keeps 30m.

    Polar / high BROWSER_MAX_ITERATIONS runs scale the ceiling with the step
    budget (~30m per 100 steps, matching Odysseys Opus wall-clock at 100 steps).
    """
    demo = is_oai_demo_goal(goal)
    if workflow_instance is not None:
        demo = demo or is_oai_demo_mass_agent_task(workflow_instance)
    if fast_mode and demo:
        return ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES_FAST_MODE
    steps = _max_iterations_override()
    if steps is not None and steps > STEPS_COVERED_BY_BASE_TIMEOUT:
        # 100 steps ≈ 30 minutes upstream; keep a small buffer above that ratio.
        return max(ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES, int(steps * 0.35) + 15)
    return ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES


def skip_browser_network_recording(*, fast_mode: bool, goal: str = "") -> bool:
    """Skip CDP Network.enable only on the demo Fast Mode tree."""
    return bool(fast_mode and is_oai_demo_goal(goal))


HEARTBEAT_TIMEOUT_SECONDS = 120
# A background task heartbeats at this cadence independent of the main loop, so a
# CPU-bound bot-challenge that freezes the page renderer (and every CDP call) for
# 90-260s can't starve the Temporal heartbeat and get the activity killed.
# Must stay comfortably below HEARTBEAT_TIMEOUT_SECONDS.
HEARTBEAT_KEEPALIVE_SECONDS = 15
# Browser activities can commit external writes. Automatic Temporal retries
# restart from scratch and can duplicate those writes, so each activity gets one
# attempt within the full timeout.
MAX_ACTIVITY_ATTEMPTS = 1
# Activity return when a deploy drains its worker (graceful shutdown) or
# supersedes its generation, or the reused provider session is about to expire:
# the browser task checkpointed at a step boundary and the manager restarts it
# from the same step on a live worker/generation/session.
BROWSER_DRAIN_YIELD_STATUS = "yielded_for_deploy_drain"
BROWSER_SESSION_EXPIRING = "browser_session_expiring"
BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS = int(os.getenv("BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS", "45"))
# Terminal disconnect before payment/write-lock return must not block the
# workflow forever when CDP/session.stop() hangs after a dead Kernel session.
BROWSER_DISCONNECT_TIMEOUT_SECONDS = int(os.getenv("BROWSER_DISCONNECT_TIMEOUT_SECONDS", "20"))

# browser-use per-event timeouts. browser-use fetches DOM+screenshot before every
# LLM step via BrowserStateRequestEvent (library default TIMEOUT_BrowserStateRequestEvent
# = 30s; TIMEOUT_NavigateToUrlEvent = 30s; TIMEOUT_ScreenshotEvent = 15s). On a
# Cloudflare/bot-challenge that CPU-freezes the renderer for ~90-260s, that CDP
# fetch hangs, hits the 30s cap, raises TimeoutError, fails the activity, and
# Temporal retries from scratch into an infinite freeze loop (the survival
# heartbeat only keeps the Temporal layer alive — this is browser-use's earlier,
# internal cap). Raise these above the max observed freeze so browser-use WAITS
# the challenge out instead of bailing. setdefault so Fly/local env can override.
BROWSER_STATE_REQUEST_TIMEOUT_SECONDS = 300
NAVIGATE_TO_URL_TIMEOUT_SECONDS = 300
SCREENSHOT_EVENT_TIMEOUT_SECONDS = 120
os.environ.setdefault("TIMEOUT_BrowserStateRequestEvent", str(BROWSER_STATE_REQUEST_TIMEOUT_SECONDS))
os.environ.setdefault("TIMEOUT_NavigateToUrlEvent", str(NAVIGATE_TO_URL_TIMEOUT_SECONDS))
os.environ.setdefault("TIMEOUT_ScreenshotEvent", str(SCREENSHOT_EVENT_TIMEOUT_SECONDS))

# Session init retry settings
SESSION_MAX_WAIT_SECONDS = 900  # 15 minutes max
SESSION_RETRY_INTERVAL_SECONDS = 30
# Transient provider infra failures (unhealthy proxy allocated) reallocate on a
# fresh init, so retry quickly a bounded number of times rather than waiting the
# full rate-limit interval or failing the whole browser run.
SESSION_INIT_TRANSIENT_MAX_ATTEMPTS = 4
SESSION_INIT_TRANSIENT_RETRY_SECONDS = 5

# Claude auth rotation
MAX_CLAUDE_TOKEN_ROTATIONS = 5

# Extract LLM settings
EXTRACT_MAX_CONTENT_LENGTH = 50000
EXTRACT_LLM_MODEL = "openai/gpt-4.1-mini"
EXTRACT_LLM_MAX_TOKENS = 4096
EXTRACT_LLM_TEMPERATURE = 0.1

# Pricing-lookup KEY for the browser-use pool. This is a POOL name, never the
# model that actually ran inference — the pool races several underlying models
# at different prices, and claudeAuth/gptAuth steps run on the user's own
# compute token for $0. Usage rows therefore carry the real `actual_model`
# returned by each LLM call (see `build_browser_llm_usage_items`); this
# constant is only used for (a) `get_model_pricing_with_fallback` pool lookups
# and (b) the last-resort row model when a call reported no `actual_model` at
# all, so the workflow prices those orphan tokens at the browser pool instead
# of falling back to the ROOT agent's cheaper pool.
BROWSER_USE_PRICING_POOL = "rose-1-browser-use"


def browser_pool_for_agent_model(agent_model: Optional[str]) -> str:
    """The Rose pool a browser agent's steps run on: its spawning agent's pool.

    Non-Rose agent models and activities scheduled without a model keep the
    dedicated browser pool.
    """
    return pool_for_model(agent_model or "") or BROWSER_USE_PRICING_POOL

# Verifier settings
# `check_progress` (helpers/llm.py) forces rose-1-ultra + claude_token
# internally — there is no LITE fallback anymore (B2). The model arg is
# preserved here so the call site stays explicit, but it's effectively
# advisory.
VERIFIER_ULTRA_MODEL = "rose-labs/rose-1-ultra"
VERIFIER_ULTRA_TIMEOUT_SECONDS = VERIFIER_ACTIVITY_TIMEOUT_SECONDS

# Write lock approval timeout
WRITE_LOCK_APPROVAL_TIMEOUT_SECONDS = 120

# Browser-provider pricing defaults. Override when contracted pricing differs.
STEEL_COST_CENTS_PER_MS = 100 / 3_600_000  # ~0.00002778
KERNEL_COST_CENTS_PER_MS = float(os.getenv("KERNEL_COST_CENTS_PER_HOUR", "48")) / 3_600_000
BROWSER_USE_COST_CENTS_PER_MS = float(os.getenv("BROWSER_USE_COST_CENTS_PER_HOUR", "2")) / 3_600_000
# Tilion credit prices ($0.002/credit = 0.2 cents). GET /v1/credits `cost` plus
# the premium rate measured from /v1/usage deltas on 2026-10-22 (lane A2): the
# month-to-date model 2/create + 1/min + 1/action + 1/MB direct egress +
# 3/MB premium egress (residential/ISP/mobile: page AND CDP bytes) + 20/solve
# reproduced the wallet to 5 credits in 28,668. Bytes, not minutes, dominate.
TILION_CENTS_PER_CREDIT = 0.2
TILION_COST_CENTS_PER_MS = TILION_CENTS_PER_CREDIT / 60_000
TILION_CREATE_COST_CENTS = 2 * TILION_CENTS_PER_CREDIT
TILION_DIRECT_CREDITS_PER_MB = float(os.getenv("TILION_DIRECT_CREDITS_PER_MB", "1"))
TILION_PREMIUM_CREDITS_PER_MB = float(os.getenv("TILION_RESIDENTIAL_CREDITS_PER_MB", "3"))
TILION_ACTION_CREDITS = 1
TILION_CAPTCHA_CREDITS = 20

# Browser supervisor watchdogs. These must be longer than browser-use's own
# per-event caps because those EventBus requests are not reliably cancellable
# from an outer asyncio.wait_for. If the supervisor preempts BrowserStateRequest
# at 90s while browser-use is still allowed to run for 300s, the underlying
# DOMWatchdog keeps running and later state requests queue behind it. Fire the
# supervisor only after browser-use has had time to complete or fail its event.
BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS = int(
    os.getenv("BROWSER_SUPERVISOR_STEP_TIMEOUT_SECONDS", str(BROWSER_STATE_REQUEST_TIMEOUT_SECONDS + 30))
)
BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS = int(
    os.getenv("BROWSER_SUPERVISOR_ACTION_TIMEOUT_SECONDS", str(NAVIGATE_TO_URL_TIMEOUT_SECONDS + 30))
)
BROWSER_SUPERVISOR_MAX_RECOVERIES = int(os.getenv("BROWSER_SUPERVISOR_MAX_RECOVERIES", "8"))
# A resumed task may reuse a live provider session only while it outlives one
# more supervised step plus teardown (recording finalize + disconnect); the
# provider releases it at its absolute lifetime even with CDP attached. Mirrors
# back-end/src/providers/steel/sessionLifetime.ts BROWSER_SESSION_MIN_REMAINING_MS.
BROWSER_SESSION_MIN_REMAINING_SECONDS = 420
BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS = float(os.getenv("BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS", "5"))

# Soft/optional get_browser_state budget (post-verifier reject screenshot, etc.).
# Healthy IDLE gaps on browser runs sit near ~12s p95; 10s is the agreed soft
# bound. One retry keeps transient CDP blips from dropping the refresh while
# still finishing in << TREE STALL silence (~510s). Do NOT use this for the
# main action-loop fetch — that path still needs the challenge-survival
# BrowserStateRequest budget (90–260s freezes).
BROWSER_STATE_SOFT_TIMEOUT_SECONDS = float(
    os.getenv("BROWSER_STATE_SOFT_TIMEOUT_SECONDS", "10")
)
BROWSER_STATE_SOFT_ATTEMPTS = int(os.getenv("BROWSER_STATE_SOFT_ATTEMPTS", "2"))

# `read_browser_state` replaced free per-turn DOM injection (d5b79a331). Counting
# it against MAX_ITERATIONS burns the action budget on observation: smoke agent
# b4b36b53 spent 16/60 steps on read_browser_state, hit max steps on Submit,
# and never read the visible FCaptcha score (browser-biometrics-webdecoy).
# Observation stays free up to a consecutive cap so a stuck model cannot loop
# forever without advancing the wall-clock action budget.
BUDGET_FREE_BROWSER_ACTIONS = frozenset({"read_browser_state"})
MAX_CONSECUTIVE_BUDGET_FREE_ACTIONS = int(
    os.getenv("BROWSER_MAX_CONSECUTIVE_BUDGET_FREE_ACTIONS", "5")
)
# The browser loop is one planner tool per turn. When the model types a form
# "character by character" (task language + input_text already humanizes a
# full string internally), each keystroke used to consume MAX_ITERATIONS.
# Smoke agent 065aee2c hit max steps mid-message on webdecoy before Submit.
# Refund single-character appends so a field fill is one logical action.
MAX_CONSECUTIVE_KEYSTROKE_CONTINUATIONS = int(
    os.getenv("BROWSER_MAX_CONSECUTIVE_KEYSTROKE_CONTINUATIONS", "128")
)


def _single_printable_char(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 1 and value.isprintable()


def is_keystroke_continuation_action(
    action_name: str,
    action_params: Optional[Mapping[str, Any]] = None,
) -> bool:
    """True for a one-character append into an already-focused field."""
    name = str(action_name or "").strip().lower()
    params = action_params if isinstance(action_params, Mapping) else {}
    if name == "input_text":
        if params.get("clear", True) is not False:
            return False
        return _single_printable_char(params.get("text"))
    if name == "press_key":
        key = params.get("key", params.get("keys"))
        return _single_printable_char(key)
    return False


def adjust_iteration_after_action(
    *,
    iteration: int,
    action_name: str,
    consecutive_budget_free: int,
    action_params: Optional[Mapping[str, Any]] = None,
    consecutive_keystroke_free: int = 0,
    action_executed: bool = True,
) -> tuple[int, int, int]:
    """Refund a step for unexecuted actions, observations and keystroke tools.

    Returns ``(new_iteration, new_consecutive_budget_free,
    new_consecutive_keystroke_free)``. After the matching consecutive cap,
    further calls consume budget so the loop still terminates.
    """
    name = str(action_name or "").strip().lower()
    if not action_executed or name in BUDGET_FREE_BROWSER_ACTIONS:
        consecutive = int(consecutive_budget_free) + 1
        if consecutive <= MAX_CONSECUTIVE_BUDGET_FREE_ACTIONS:
            return max(0, int(iteration) - 1), consecutive, 0
        return int(iteration), consecutive, 0
    if is_keystroke_continuation_action(name, action_params):
        consecutive_keystroke = int(consecutive_keystroke_free) + 1
        if consecutive_keystroke <= MAX_CONSECUTIVE_KEYSTROKE_CONTINUATIONS:
            return max(0, int(iteration) - 1), 0, consecutive_keystroke
        return int(iteration), 0, consecutive_keystroke
    return int(iteration), 0, 0

# Verifier DOM checkpoints retained across the browser activity (evaluate
# always-on preserved_evidence + pre-write approval snapshots). Bounded so
# long sessions cannot unbounded-grow verifier prompts; 20 covers multi-item
# cart flows that must checkpoint each listing before navigating away.
VERIFIER_CHECKPOINT_MAX = int(os.getenv("VERIFIER_CHECKPOINT_MAX", "20"))

# MIME type mappings for file downloads
MIME_TYPE_MAP = {
    "pdf": "application/pdf",
    "csv": "text/csv",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "zip": "application/zip",
    "json": "application/json",
    "txt": "text/plain",
}
