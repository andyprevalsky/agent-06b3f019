"""Configuration for spawn-browser-agent-v3 domain.

Constants, defaults, and environment reads.
"""

import os

from utils.llm_timeouts import VERIFIER_ACTIVITY_TIMEOUT_SECONDS

# External service keys
STEEL_API_KEY = os.environ.get("STEEL_API_KEY", "")

# Agent loop limits
MAX_ITERATIONS = 50
MAX_CONSECUTIVE_API_FAILURES = 5
ACTIVITY_START_TO_CLOSE_TIMEOUT_MINUTES = 30
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
BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS = int(os.getenv("BROWSER_RECORDING_FINALIZE_TIMEOUT_SECONDS", "45"))

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

# Rose API model name
ROSE_BROWSER_USE_MODEL = "rose-labs/rose-1-browser-use"

# Canonical pool name that browser-agent LLM usage is priced against. Browser
# steps race through the rose-1-browser-use pool, NOT the parent agent's pool,
# so every emitted usage row must carry this model — otherwise the workflow
# falls back to the root model and prices those tokens at the wrong rate.
BROWSER_USE_PRICING_POOL = "rose-1-browser-use"

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

# Action loop delay between iterations (seconds)
ACTION_LOOP_DELAY_SECONDS = 0.5

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
BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS = float(os.getenv("BROWSER_WARMUP_ACTION_TIMEOUT_SECONDS", "5"))

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
